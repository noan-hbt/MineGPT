// H4 MineSim: virtual clock for the bot process. The server runs at `/tick rate R`; everything on the bot side
// (mineflayer physics 50 ms loop, dig timers, pathfinder timeouts, our skills' sleeps/timeouts) is wall-clock based.
// Instead of patching each one, scale time process-wide: performance.now / Date.now run k times faster and
// setTimeout / setInterval delays are divided by k. k = R / 20, recalibrated from the server's world age
// (`update_time` every 20 ticks) so the bot follows the server's real tick rate, not the requested one.
//   const clock = require('./sim/clock').install()   // BEFORE requiring mineflayer
//   clock.follow(bot)                                 // after createBot: k follows the server
// Limits: a timer already scheduled keeps its real delay when k changes; Node timers are >= 1 ms and Windows
// wakes ~every 1-16 ms, so physics runs in bursts (pass maxCatchupTicks to createBot).
'use strict'
const perf = require('perf_hooks').performance
const RealDate = Date

// `new Date()` does not go through Date.now: replace the constructor too (mineflayer clickWindow compares
// `new Date() - bot.lastDigTime`; mixing real and virtual time there blocked crafts for ~20 s in lockstep)
function patchDate(nowMs) {
  function VDate(...a) {
    if (!new.target) return new RealDate(nowMs()).toString()
    return a.length ? new RealDate(...a) : new RealDate(nowMs())
  }
  VDate.prototype = RealDate.prototype
  Object.setPrototypeOf(VDate, RealDate)
  VDate.now = () => Math.floor(nowMs())
  global.Date = VDate
}

let installed = null

function install({ speed = 1 } = {}) {
  if (installed) return installed
  const realNow = perf.now.bind(perf)
  const realDateNow = RealDate.now
  const realST = global.setTimeout, realSI = global.setInterval
  let k = speed, baseReal = realNow(), baseVirt = baseReal
  const dateOffset = realDateNow() - baseReal // virtual Date.now = virtual perf time + this offset
  const vnow = () => baseVirt + (realNow() - baseReal) * k

  perf.now = vnow
  patchDate(() => vnow() + dateOffset)
  const scaled = (real) => function (fn, ms, ...args) { return real(fn, Math.max(0, (+ms || 0) / k), ...args) }
  global.setTimeout = scaled(realST)
  global.setInterval = scaled(realSI)

  const clock = {
    get speed() { return k },
    setSpeed(nk) { if (!(nk > 0)) return; baseVirt = vnow(); baseReal = realNow(); k = nk },
    now: vnow,
    realNow,
    realSetTimeout: realST,
    // k follows the measured server tick rate: ages from `time` events (every 20 server ticks).
    follow(bot, { alpha = 0.5, onRate } = {}) {
      let last = null
      clock.serverTps = null
      bot.on('time', () => {
        const age = bot.time.age, t = realNow()
        if (last && age > last.age && t > last.t) {
          const tps = (age - last.age) / ((t - last.t) / 1000)
          // jump on a big change (tick rate command), smooth the jitter otherwise
          const jump = clock.serverTps == null || Math.abs(tps - clock.serverTps) > 0.25 * clock.serverTps
          clock.serverTps = jump ? tps : clock.serverTps * (1 - alpha) + tps * alpha
          clock.setSpeed(clock.serverTps / 20)
          if (onRate) onRate(clock.serverTps)
        }
        last = { age, t }
      })
      return clock
    },
  }
  installed = clock
  return clock
}

// Lockstep (option C): virtual time only moves when the driver calls advance(ms). setTimeout/setInterval go to
// a virtual timer queue; performance.now / Date.now return the virtual time. Real timers stay available
// (clock.realSetTimeout) for code that must wait in real time (driver, guards).
//   const clock = require('./sim/clock').installManual()   // BEFORE requiring mineflayer
//   await clock.advance(50)                                 // one game tick on the bot side
function installManual() {
  if (installed) return installed
  const realNow = perf.now.bind(perf)
  const realST = global.setTimeout, realCT = global.clearTimeout, realCI = global.clearInterval
  const dateOffset = RealDate.now() - realNow()
  let vt = realNow(), seq = 0
  const queue = [] // VTimer, unsorted (small)

  class VTimer {
    constructor(fn, ms, args, repeat) { this.fn = fn; this.ms = Math.max(1, +ms || 0); this.args = args; this.repeat = repeat; this.alive = true; this._ref = true; this.arm() }
    arm() { this.due = vt + this.ms; this.seq = ++seq; queue.push(this) }
    ref() { this._ref = true; return this } unref() { this._ref = false; return this } hasRef() { return this._ref }
    refresh() { this.cancel(); this.alive = true; this.arm(); return this }
    cancel() { this.alive = false; const i = queue.indexOf(this); if (i >= 0) queue.splice(i, 1) }
    [Symbol.toPrimitive]() { return this.seq }
  }
  perf.now = () => vt
  patchDate(() => vt + dateOffset)
  global.setTimeout = (fn, ms, ...args) => new VTimer(fn, ms, args, false)
  global.setInterval = (fn, ms, ...args) => new VTimer(fn, ms, args, true)
  const clear = real => t => { if (t instanceof VTimer) t.cancel(); else if (t != null) real(t) }
  global.clearTimeout = clear(realCT)
  global.clearInterval = clear(realCI)
  const yieldIO = () => new Promise(r => setImmediate(r))

  const clock = {
    manual: true,
    now: () => vt,
    realNow,
    realSetTimeout: realST,
    get pending() { return queue.length },
    // run every timer due within (vt, vt+ms] in due order; yield to the event loop after each so promise
    // continuations can schedule further timers inside the same window.
    async advance(ms) {
      const target = vt + ms
      for (;;) {
        let next = null
        for (const t of queue) if (t.due <= target && (!next || t.due < next.due || (t.due === next.due && t.seq < next.seq))) next = t
        if (!next) break
        queue.splice(queue.indexOf(next), 1)
        vt = Math.max(vt, next.due)
        if (next.repeat) next.arm(); else next.alive = false
        try { next.fn(...next.args) } catch (e) { process.nextTick(() => { throw e }) }
        await yieldIO()
      }
      vt = target
      await yieldIO()
    },
  }
  installed = clock
  return clock
}

// Lockstep: mineflayer-pathfinder's A* budgets its work with performance.now() (40 ms per tick, 5 s total). With a
// frozen virtual clock a whole search (even a hopeless one) ran inside one tick: no game time passed while the
// bot "thought", unlike live. During compute(), time = virtual time at entry + real time spent computing, so the
// per-tick budget is real CPU time and the total timeout counts game ticks, as in a live run.
function patchPathfinder(clock) {
  const AStar = require('mineflayer-pathfinder/lib/astar')
  const orig = AStar.prototype.compute
  AStar.prototype.compute = function () {
    const v = perf.now, vt0 = v(), r0 = clock.realNow()
    perf.now = () => vt0 + (clock.realNow() - r0)
    try { return orig.call(this) } finally { perf.now = v }
  }
}

module.exports = { install, installManual, patchPathfinder }
