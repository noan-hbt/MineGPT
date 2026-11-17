// H3 DSL interpreter: runs one statement at a time on a mineflayer bot through the skills (bot/skills/).
//   const it = new Interpreter(bot, senses)
//   it.start('mine iron_ore n=3', {expect: 'have(raw_iron)>=+3 in 60s'})   // aborts the running statement first
//   it.adjust({set: {n: 5}, until: COND}) ; it.stop() ; it.running() ; it.expectInfo()
// Every started statement ends with exactly one `result` event (events.schema.json): status ok|partial|failed|
// interrupted, gained/lost (inventory diff), cause from the closed set, detail for the model. `until(cond)` stops a
// statement with status ok (cause interrupted_until); `timeout=` fails it (partial when some work was done);
// `expect:` is checked when the statement ends or its duration passes, each unmet condition -> one `surprise` event.
'use strict'
const { parseStmt, parseExpect, catalog } = require('./parse')
const { fmtStmt, fmtCond, fmtExpect } = require('./fmt')
const { evalCond, snapshot, unmet } = require('./cond')
const C = require('../skills/common')
const P = require('../state/perceive')

const POLL_MS = 200
const DEFAULT_TIMEOUT = 120
// seconds; null = none (the verb ends by itself, by until() or by stop)
const TIMEOUTS = { follow: 1800, avoid: null, wait: null, fight: 300, mine: 300, chop: 300, strip_mine: 600,
  branch_mine: 1200, dig: 600, break: 300, explore: 300, fish: 600, sleep: 60, descend: 300, ascend: 300, harvest: 300,
  breed: 180, smelt: 900, blast: 900, smoke: 900, place: 300, collect: 120, shield: 60, flee: 120, give: 120 }

class Scope {
  constructor(parent, onAbort) {
    this.parent = parent; this.onAbort = onAbort; this.reason = null; this.children = new Set()
    this.promise = new Promise((_, rej) => { this._rej = rej })
    this.promise.catch(() => {})
    if (parent) { parent.children.add(this); if (parent.reason) this._cascade(parent.reason) }
  }
  abort(kind, extra = {}) {
    if (this.reason) return
    this._cascade({ kind, scope: this, ...extra })
    if (this.onAbort) this.onAbort(this.reason)
  }
  _cascade(reason) {
    if (this.reason) return
    this.reason = reason
    this._rej(new C.Abort(reason))
    for (const c of this.children) c._cascade(reason)
  }
  dispose() { if (this.parent) this.parent.children.delete(this) }
}

class Interpreter {
  constructor(bot, senses, { skills = require('../skills'), log = () => {} } = {}) {
    this.bot = bot; this.senses = senses; this.skills = skills; this.log = log
    this.task = null; this.seq = 0; this.keep = null; this.lastOrder = null; this.avoid = new Map()
    this.env = makeEnv(this)
    bot.on('death', () => { if (this.task) this.task.scope.abort('died') })
    bot.on('chat', (from, text) => { if (from !== bot.username && bot.players[from]) this.lastOrder = { from, text, at: Date.now() } })
    this.alerted = new Map()
    this.watch = setInterval(() => this.avoidTick(), 500)
  }
  close() { clearInterval(this.watch); this.stop('shutdown') }

  // `avoid` watcher: facts only, an event when an avoided kind comes within its radius (once per entity per 10 s)
  avoidTick() {
    if (!this.avoid.size || !this.bot.entity) return
    const me = this.bot.entity.position
    for (const e of Object.values(this.bot.entities)) {
      const r = this.avoid.get(e.name)
      if (!r || !e.position) continue
      const d = e.position.distanceTo(me)
      if (d > r || Date.now() - (this.alerted.get(e.id) || 0) < 10000) continue
      this.alerted.set(e.id, Date.now())
      this.push({ kind: 'interrupt', detail: `${C.entRef(e)} within ${Math.round(d)}m (avoid ${e.name} radius=${r})` })
    }
  }

  idle() { return !this.task }
  running() {
    const t = this.task
    return t ? { src: t.src, ast: t.ast, started_t: t.started_t, ...(t.progress ? { progress: t.progress } : {}) } : null
  }
  expectInfo() {
    const t = this.task || this.lastTask
    if (!t || !t.expect || t.expectChecked) return null
    return { src: t.expectSrc, deadline_t: t.started_t + t.expect.within * 1000 }
  }

  // start a statement (source text or AST). Returns a promise of the result event.
  start(stmt, { expect = null } = {}) {
    let ast = stmt
    if (typeof stmt === 'string') {
      const r = parseStmt(stmt)
      if (!r.ok) return Promise.resolve(this.push({ kind: 'result', status: 'failed', stmt, dur_s: 0, cause: 'invalid', detail: r.error }))
      ast = r.ast
    }
    let exp = expect
    if (typeof expect === 'string') {
      const r = parseExpect(expect)
      if (!r.ok) return Promise.resolve(this.push({ kind: 'result', status: 'failed', stmt: fmtStmt(ast), dur_s: 0, cause: 'invalid', detail: 'expect: ' + r.error }))
      exp = r.ast
    }
    if (ast.op === 'call' && ast.verb === 'stop') {
      const had = this.task ? this.task.src : null
      this.stop('stop')
      return Promise.resolve(this.push({ kind: 'result', status: 'ok', stmt: 'stop', dur_s: 0, detail: had ? `stopped \`${had}\`` : 'nothing was running' }))
    }
    if (this.task) this.stop('replaced by a new action')
    return this.runTask(ast, exp)
  }

  stop(why = 'stop') { if (this.task) this.task.scope.abort('model', { why }) }

  // monitor adjust: {set: {k: v}, until: COND} on the running statement (top level)
  adjust(adj) {
    const t = this.task
    if (!t) return { ok: false, error: 'nothing is running' }
    if (!t.top) return { ok: false, error: 'adjust applies to a verb or a seq' }
    if (adj.set) {
      if (t.ast.op !== 'call') return { ok: false, error: 'adjust k=v only applies to a single verb' }
      Object.assign(t.ast.args, adj.set)
      if (adj.set.timeout) t.top.setTimeout(adj.set.timeout.dur)
    }
    if (adj.until) { t.ast.until = adj.until; t.top.setUntil(adj.until) }
    t.src = fmtStmt(t.ast)
    this.push({ kind: 'interrupt', detail: `adjusted: now \`${t.src}\`` })
    return { ok: true }
  }

  push(ev) { return this.senses ? this.senses.push(ev) : { t: 0, ...ev } }

  async runTask(ast, expect) {
    const bot = this.bot
    const scope = new Scope(null, () => C.halt(bot))
    const task = { id: ++this.seq, ast, src: fmtStmt(ast), scope, started: Date.now(),
      started_t: this.senses ? this.senses.t() : 0, progress: null, expect,
      expectSrc: expect ? fmtExpect(expect) : null, origin: bot.entity.position.floored() }
    if (bot.isSleeping && !(ast.op === 'call' && ast.verb === 'sleep')) { try { await bot.wake() } catch {} }
    task.base = expect ? snapshot(expect.conds, this.env) : {}
    this.task = task
    const before = P.allCounts(bot)
    let timer = null
    if (expect) timer = setTimeout(() => this.checkExpect(task, false), expect.within * 1000)
    let r
    try {
      r = await this.exec(ast, scope, task, true)
    } catch (e) {
      if (e instanceof C.Abort) r = abortResult(e.reason, task, null)
      else { r = { status: 'failed', cause: 'unreachable', detail: 'internal error: ' + String(e.message).slice(0, 120) }; this.log({ type: 'error', where: 'interp', error: String(e.stack) }) }
    }
    scope.dispose()
    if (this.task === task) this.task = null
    this.lastTask = task
    const after = P.allCounts(bot)
    const gained = {}, lost = {}
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const d = (after[k] || 0) - (before[k] || 0)
      if (d > 0) gained[k] = d; else if (d < 0) lost[k] = -d
    }
    const ev = this.push({ kind: 'result', status: r.status, stmt: task.src, dur_s: Math.round((Date.now() - task.started) / 100) / 10,
      ...(Object.keys(gained).length ? { gained } : {}), ...(Object.keys(lost).length ? { lost } : {}),
      ...(r.cause ? { cause: r.cause } : {}), ...(r.detail ? { detail: r.detail } : {}) })
    if (expect && !task.expectChecked) {
      clearTimeout(timer)
      if (r.cause !== 'interrupted_by_model') this.checkExpect(task, true)
      else task.expectChecked = true
    }
    return ev
  }

  checkExpect(task, atEnd) {
    if (task.expectChecked) return
    task.expectChecked = true
    const miss = unmet(task.expect, this.env, task.base)
    if (miss.length) this.push({ kind: 'surprise', expect: task.expectSrc, unmet: miss, ...(atEnd ? {} : { detail: 'deadline passed, action still running' }) })
  }

  // run a node inside `parent`; returns {status, cause?, detail?}. Abort of an outer scope propagates (throws).
  async exec(node, parent, task, top = false) {
    switch (node.op) {
      case 'call': case 'seq': return this.scoped(node, parent, task, top)
      case 'if': {
        if (evalCond(node.cond, this.env)) return this.exec(node.then, parent, task)
        if (node.else) return this.exec(node.else, parent, task)
        return { status: 'ok', detail: `if(${fmtCond(node.cond)}) was false, nothing done` }
      }
      case 'repeat': {
        for (let i = 0; i < node.n; i++) {
          task.progress = `${i + 1}/${node.n}`
          const r = await this.exec(node.body, parent, task)
          if (r.status === 'failed' || r.status === 'interrupted') return { ...r, status: i ? 'partial' : r.status, detail: `round ${i + 1}/${node.n}: ${r.detail || r.cause}` }
        }
        return { status: 'ok' }
      }
      case 'routine': {
        const mem = this.senses && this.senses.memory
        const rt = mem && mem.routines.find(x => x.name === node.name)
        if (!rt) return { status: 'failed', cause: 'invalid', detail: `no routine '${node.name}' (saved: ${mem ? mem.routines.map(x => x.name).join(', ') || 'none' : 'none'})` }
        const p = parseStmt(rt.src)
        if (!p.ok) return { status: 'failed', cause: 'invalid', detail: `routine ${node.name} no longer parses: ${p.error}` }
        rt.runs = (rt.runs || 0) + 1
        const r = await this.exec(p.ast, parent, task)
        if (r.status === 'ok') rt.ok = (rt.ok || 0) + 1
        mem.save()
        return r
      }
    }
    return { status: 'failed', cause: 'invalid', detail: `unknown statement ${node.op}` }
  }

  // call / seq with their own scope: until(), timeout, abort handling
  async scoped(node, parent, task, top) {
    const bot = this.bot
    const sc = new Scope(parent, () => C.halt(bot))
    if (top) task.top = sc
    const timers = []
    let until = node.until || null, base = until ? snapshot(until, this.env) : {}
    sc.setUntil = c => { until = c; base = snapshot(c, this.env) }
    let tmo = null
    sc.setTimeout = s => { if (tmo) clearTimeout(tmo); tmo = s ? setTimeout(() => sc.abort('timeout', { after: s }), s * 1000) : null }
    if (node.op === 'call') {
      const t = node.args.timeout ? node.args.timeout.dur : (node.verb in TIMEOUTS ? TIMEOUTS[node.verb] : DEFAULT_TIMEOUT)
      sc.setTimeout(t)
    } else if (node.args && node.args.timeout) sc.setTimeout(node.args.timeout.dur)
    const poll = setInterval(() => {
      if (until && !sc.reason) { try { if (evalCond(until, this.env, base)) sc.abort('until', { cond: fmtCond(until) }) } catch {} }
    }, POLL_MS)
    timers.push(poll)
    const ctx = node.op === 'call' ? this.ctx(node, sc, task) : null
    try {
      if (until && evalCond(until, this.env, base)) return { status: 'ok', cause: 'interrupted_until', detail: `until(${fmtCond(until)}) was already true` }
      if (node.op === 'seq') return await this.runSeq(node, sc, task)
      const fn = this.skills[node.verb]
      if (!fn) return { status: 'failed', cause: 'invalid', detail: `${node.verb} is not implemented in this harness version` }
      const r = (await fn(ctx, node.args)) || {}
      return { status: r.status || 'ok', ...(r.cause ? { cause: r.cause } : {}), ...(r.detail ? { detail: r.detail } : {}) }
    } catch (e) {
      if (e instanceof C.Abort && e.reason.scope === sc) return abortResult(e.reason, task, ctx)
      if (e instanceof C.Abort) throw e
      if (sc.reason && sc.reason.scope !== sc) throw new C.Abort(sc.reason) // outer abort surfaced as a skill error
      if (sc.reason) return abortResult(sc.reason, task, ctx)
      if (e instanceof C.Fail) {
        const partial = ctx && ctx.done > 0
        return { status: partial ? 'partial' : 'failed', cause: e.cause, detail: (partial && ctx.total ? `${ctx.done}/${ctx.total} done, then ` : '') + (e.detail || e.message) }
      }
      this.log({ type: 'error', where: 'skill ' + (node.verb || node.op), error: String(e.stack) })
      return { status: 'failed', cause: 'unreachable', detail: `${node.verb || node.op}: ${String(e.message).slice(0, 140)}` }
    } finally {
      for (const t of timers) clearInterval(t)
      if (tmo) clearTimeout(tmo)
      sc.dispose()
      if (ctx) ctx.closed = true
    }
  }

  async runSeq(node, sc, task) {
    const n = node.body.length
    for (let i = 0; i < n; i++) {
      task.progress = `step ${i + 1}/${n}`
      const r = await this.exec(node.body[i], sc, task)
      if (r.status === 'failed' || r.status === 'interrupted') {
        return { status: i ? 'partial' : r.status, ...(r.cause ? { cause: r.cause } : {}),
          detail: `step ${i + 1}/${n} \`${fmtStmt(node.body[i])}\` ${r.status}: ${r.detail || r.cause}` }
      }
    }
    return { status: 'ok' }
  }

  ctx(node, sc, task) {
    const self = this
    const ctx = {
      bot: this.bot, senses: this.senses, interp: this, verb: node.verb, args: node.args, origin: task.origin,
      scope: sc, done: 0, total: 0,
      wait: p => Promise.race([p, sc.promise]),
      sleep: ms => Promise.race([C.sleep(ms), sc.promise]),
      check: () => { if (sc.reason) throw new C.Abort(sc.reason) },
      progress: s => { task.progress = s },
      // run a nested statement inside this verb (skills composing other skills)
      run: async src => {
        const r = parseStmt(src)
        if (!r.ok) throw new C.Fail('invalid', r.error)
        const res = await self.exec(r.ast, sc, task)
        if (res.status === 'failed') throw new C.Fail(res.cause || 'unreachable', res.detail)
        return res
      },
    }
    return ctx
  }
}

function abortResult(reason, task, ctx) {
  const part = ctx && ctx.done > 0
  switch (reason.kind) {
    case 'until': return { status: 'ok', cause: 'interrupted_until', detail: `until(${reason.cond}) became true` + (ctx && ctx.total ? `, ${ctx.done}/${ctx.total} done` : '') }
    case 'timeout': return { status: part ? 'partial' : 'failed', cause: 'timeout', detail: `no result after ${reason.after}s` + (ctx && ctx.total ? `, ${ctx.done}/${ctx.total} done` : '') }
    case 'died': return { status: 'failed', cause: 'died', detail: 'the bot died during the action' }
    case 'danger': return { status: 'interrupted', cause: 'danger', detail: reason.why || 'danger' }
    default: return { status: 'interrupted', cause: 'interrupted_by_model', detail: reason.why || 'stopped' }
  }
}

// ---------------------------------------------------------------- condition environment on the live bot
const HOSTILE = P.HOSTILE
function makeEnv(it) {
  const bot = it.bot
  return {
    metric(m, arg) {
      switch (m) {
        case 'hp': return bot.health
        case 'food': return bot.food
        case 'sat': return bot.foodSaturation || 0
        case 'xp': return bot.experience ? bot.experience.level : 0
        case 'armor': return P.body(bot, bot.registry).armor
        case 'air': return bot.oxygenLevel != null ? Math.round(bot.oxygenLevel * 15) : 300
        case 'y': return Math.floor(bot.entity.position.y)
        case 'light': { const b = bot.blockAt(bot.entity.position.floored(), false); return b ? Math.max(b.light || 0, b.skyLight || 0) : 0 }
        case 'time': return bot.time.timeOfDay
        case 'free_slots': return bot.inventory.emptySlotCount()
        case 'hostile': { const e = C.nearest(bot, x => HOSTILE.has(x.name)); return e ? Math.round(e.position.distanceTo(bot.entity.position) * 10) / 10 : 999 }
        case 'have': return C.count(bot, C.idsOf(arg, 'item'))
        case 'dist': {
          const fake = { bot, senses: it.senses, origin: it.task ? it.task.origin : bot.entity.position.floored() }
          const r = C.tryResolve(fake, arg)
          return r ? Math.round(r.pos.distanceTo(bot.entity.position) * 10) / 10 : 999
        }
      }
      return 0
    },
    flag(f) {
      const tod = bot.time.timeOfDay
      const e = bot.entity
      switch (f) {
        case 'night': return tod >= 13000 && tod < 23000
        case 'day': return !(tod >= 13000 && tod < 23000)
        case 'rain': return !!bot.isRaining
        case 'thunder': return bot.thunderState > 0
        case 'inv_full': return bot.inventory.emptySlotCount() === 0
        case 'idle': return !it.task
        case 'in_water': return !!e.isInWater
        case 'in_lava': return !!e.isInLava
        case 'on_fire': return !!(e.metadata && typeof e.metadata[0] === 'number' && (e.metadata[0] & 1))
        case 'sky': return P.seesSky(bot)
      }
      return false
    },
  }
}

module.exports = { Interpreter, Scope, TIMEOUTS, catalog }
