// H3 offline tests: fmt round trip on the golden DSL cases, condition evaluation, interpreter control flow
// (seq / if / repeat / until / timeout / interrupt / adjust / expect -> surprise) on a fake bot with fake skills.
'use strict'
const fs = require('fs')
const path = require('path')
const assert = require('assert')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const { parseStmt, parseTool, parseCond, parseExpect } = require('../dsl/parse')
const { fmtStmt, fmtCond, fmtExpect } = require('../dsl/fmt')
const { evalCond, snapshot, unmet } = require('../dsl/cond')
const { Interpreter } = require('../dsl/run')
const C = require('../skills/common')

let n = 0
const tests = []
const t = (name, fn) => tests.push([name, fn])

t('fmt round trip on golden cases', () => {
  const lines = fs.readFileSync(path.join(__dirname, '..', '..', 'spec', 'golden', 'dsl.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
  let k = 0
  for (const c of lines) {
    if (!c.ok) continue
    const P = { stmt: [parseStmt, fmtStmt], tool: [parseTool, fmtStmt], cond: [parseCond, fmtCond], expect: [parseExpect, fmtExpect] }[c.kind]
    if (!P) continue
    const a = P[0](c.src)
    const src2 = P[1](a.ast)
    const b = P[0](src2)
    assert.ok(b.ok, `${c.src} -> ${src2}: ${b.error}`)
    assert.deepStrictEqual(b.ast, a.ast, `${c.src} -> ${src2}`)
    k++
  }
  assert.ok(k > 80, `only ${k} cases`)
})

t('conditions: absolute, relative, flags, and/or/not', () => {
  const vals = { hp: 20, have: 3, y: 64 }
  const env = { metric: m => vals[m], flag: f => f === 'night' }
  const c = parseCond('have(oak_log)>=+4 & hp>=~-4').ast
  const base = snapshot(c, env)
  assert.strictEqual(evalCond(c, env, base), false)
  vals.have = 7; vals.hp = 17
  assert.strictEqual(evalCond(c, env, base), true)
  vals.hp = 15
  assert.strictEqual(evalCond(c, env, base), false)
  assert.strictEqual(evalCond(parseCond('night & !(y<0 | rain)').ast, env), true)
  const e = parseExpect('have(oak_log)>=+8, y<0 in 30s').ast
  const b2 = snapshot(e.conds, env)
  vals.have = 9
  assert.deepStrictEqual(unmet(e, env, b2), [{ cond: 'have(oak_log)>=+8', actual: '+2' }, { cond: 'y<0', actual: 64 }])
})

// ---------------------------------------------------------------- fake bot
function fakeBot() {
  const bot = new EventEmitter()
  bot.username = 'T'
  bot.entity = { position: new Vec3(0.5, 64, 0.5), yaw: 0, height: 1.8, metadata: [] }
  bot.entities = {}
  bot.players = {}
  bot.health = 20; bot.food = 20; bot.foodSaturation = 5
  bot.time = { timeOfDay: 1000 }
  const slots = new Array(46).fill(null)
  bot.inventory = { slots, items: () => slots.filter(Boolean), emptySlotCount: () => slots.slice(9, 45).filter(x => !x).length }
  bot.give = (name, c) => { const h = slots.find(x => x && x.name === name); if (h) { h.count += c; return } const i = slots.findIndex((x, k) => k >= 9 && !x); slots[i] = { name, count: c, slot: i } }
  bot.blockAt = () => null
  bot.pathfinder = { stop() {}, setGoal() {} }
  bot.stopDigging = () => {}; bot.clearControlStates = () => {}; bot.deactivateItem = () => {}
  return bot
}
function fakeSenses() {
  const evs = []
  const memory = { routines: [], save() {}, places: [], notes: [] }
  return { evs, memory, t: () => 0, push(e) { evs.push(e); return e }, seen: new Set() }
}
const skills = {
  wait: async (ctx, a) => { await ctx.sleep(a.dur.dur * 1000); return {} },
  craft: async (ctx, a) => { ctx.bot.give(a.item.name, a.n ?? 1); return {} },
  mine: async (ctx, a) => {
    ctx.total = ctx.args.n ?? 1
    while (ctx.done < (ctx.args.n ?? 1)) { await ctx.sleep(30); ctx.bot.give('cobblestone', 1); ctx.done++ }
    return {}
  },
  chop: async () => { throw new C.Fail('no_target_known', 'no tree seen') },
  stop: async () => ({}),
}
const run = (it, src, expect) => it.start(src, { expect })

t('interpreter: ok, failed, seq partial, if, repeat', async () => {
  const bot = fakeBot(), s = fakeSenses()
  const it = new Interpreter(bot, s, { skills })
  let r = await run(it, 'craft stick n=4')
  assert.strictEqual(r.status, 'ok'); assert.deepStrictEqual(r.gained, { stick: 4 })
  r = await run(it, 'chop n=2')
  assert.strictEqual(r.status, 'failed'); assert.strictEqual(r.cause, 'no_target_known')
  r = await run(it, 'seq[craft stick; chop; craft stick]')
  assert.strictEqual(r.status, 'partial'); assert.match(r.detail, /step 2\/3 `chop` failed: no tree seen/)
  r = await run(it, 'if(have(stick)>=5) craft torch else chop')
  assert.strictEqual(r.status, 'ok'); assert.deepStrictEqual(r.gained, { torch: 1 })
  r = await run(it, 'repeat(3) craft stick n=2')
  assert.deepStrictEqual(r.gained, { stick: 6 })
  r = await run(it, 'brew awkward')
  assert.strictEqual(r.cause, 'invalid')
  r = await run(it, 'mine oak_plank')
  assert.strictEqual(r.status, 'failed'); assert.strictEqual(r.cause, 'invalid'); assert.match(r.detail, /did you mean/)
  it.close()
})

t('interpreter: until, timeout (partial), interrupt, adjust, expect surprise', async () => {
  const bot = fakeBot(), s = fakeSenses()
  const it = new Interpreter(bot, s, { skills })
  let r = await run(it, 'mine stone n=100 until(have(cobblestone)>=+3)')
  assert.strictEqual(r.status, 'ok'); assert.strictEqual(r.cause, 'interrupted_until'); assert.ok(r.gained.cobblestone >= 3 && r.gained.cobblestone < 8, JSON.stringify(r))
  r = await run(it, 'mine stone n=100 timeout=1s')
  assert.strictEqual(r.status, 'partial'); assert.strictEqual(r.cause, 'timeout')
  r = await run(it, 'wait 1s', 'have(diamond)>=+1, hp>=~-2 in 5s')
  const sur = s.evs.filter(e => e.kind === 'surprise')
  assert.strictEqual(sur.length, 1); assert.deepStrictEqual(sur[0].unmet, [{ cond: 'have(diamond)>=+1', actual: '+0' }])
  const p = run(it, 'wait 30s')
  await C.sleep(100)
  assert.strictEqual(it.running().src, 'wait 30s')
  const st = await run(it, 'stop')
  r = await p
  assert.strictEqual(r.status, 'interrupted'); assert.strictEqual(r.cause, 'interrupted_by_model')
  assert.strictEqual(st.status, 'ok')
  const p2 = run(it, 'mine stone n=100')
  await C.sleep(50)
  assert.ok(it.adjust({ set: { n: 2 } }).ok)
  r = await p2
  assert.strictEqual(r.status, 'ok'); assert.ok(r.gained.cobblestone >= 2 && r.gained.cobblestone <= 3)
  const p3 = run(it, 'wait 30s')
  await C.sleep(50)
  it.adjust({ until: parseCond('have(stick)>=+1').ast })
  bot.give('stick', 1)
  r = await p3
  assert.strictEqual(r.cause, 'interrupted_until'); assert.ok(r.dur_s < 2)
  // death aborts
  const p4 = run(it, 'wait 30s')
  await C.sleep(50); bot.emit('death')
  r = await p4
  assert.strictEqual(r.cause, 'died')
  it.close()
})

;(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); n++ } catch (e) { console.error('FAIL', name, '\n', e.stack); process.exit(1) }
  }
  console.log(`interp tests: ${n} passed`)
  process.exit(0)
})()
