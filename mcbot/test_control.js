// B5 controller tests (offline). node test_control.js
'use strict'
const assert = require('assert')
const { createController, planCost, stepKey } = require('./control')

let t = 0
const now = () => t
const plan = (...steps) => ({ steps, done: false })
const P1 = plan({ do: 'collect', item: 'raw_iron', n: 3, blocks: ['iron_ore'] }, { do: 'smelt', item: 'iron_ingot', n: 3 }, { do: 'craft', item: 'iron_pickaxe' })
const obs = (o = {}) => ({ goal: 'iron_pickaxe', hp: 20, night: false, threat: null, plan: P1, options: { collect: ['iron_ore'], explore: ['north'] }, ...o })
let pass = 0
const test = (name, f) => { t = 0; f(); pass++; console.log('ok  ' + name) }

test('planCost / stepKey', () => {
  assert.strictEqual(planCost(P1), 7)
  assert.strictEqual(planCost({ done: true, steps: [] }), 0)
  assert.strictEqual(planCost(null), null)
  assert.strictEqual(stepKey(P1), 'collect:raw_iron')
})

test('repeatable task continues without LLM, one-shot ends', () => {
  const C = createController({ now })
  C.start('collect iron_ore', 'llm', obs())
  assert.strictEqual(C.next(obs()).why, 'not run')
  C.start('collect iron_ore', 'llm', obs())
  C.done('collect iron_ore', 'ok raw_iron+1', { cost: 4, goal: 'iron_pickaxe' })
  assert.strictEqual(C.next(obs()).action, 'collect iron_ore')
  C.done('collect iron_ore', 'ok raw_iron+1', { cost: 3, goal: 'iron_pickaxe' })
  assert.strictEqual(C.next(obs()).action, 'collect iron_ore')
  C.start('craft stick', 'llm', obs()); C.done('craft stick', 'ok', {})
  assert.strictEqual(C.next(obs()).why, 'done')
})

test('task ends on failure, events, step change, max runs', () => {
  const C = createController({ now })
  const run = (r, o = obs()) => { C.start('collect iron_ore', 'llm', obs()); C.done('collect iron_ore', r, {}); return C.next(o).why }
  assert.strictEqual(run('failed: timeout'), 'failed')
  assert.strictEqual(run('ok', obs({ threat: ['zombie', 4] })), 'event: danger')
  assert.strictEqual(run('ok', obs({ night: true })), 'event: night')
  assert.strictEqual(run('ok', obs({ goal: '3 torch' })), 'event: new goal')
  assert.strictEqual(run('ok', obs({ hp: 15 })), 'event: hurt')
  assert.strictEqual(run('ok', obs({ plan: plan({ do: 'smelt', item: 'iron_ingot', n: 3 }) })), 'plan step changed')
  assert.strictEqual(run('ok', obs({ options: { explore: ['north'] } })), 'no longer valid')
  C.start('collect iron_ore', 'llm', obs())
  let r
  for (let i = 0; i < 10; i++) { C.done('collect iron_ore', 'ok', {}); r = C.next(obs()); if (!r.action) break }
  assert.strictEqual(r.why, 'max runs')
})

test('non-consecutive failures get banned, ban expires', () => {
  const C = createController({ now })
  for (const [a, r] of [['collect iron_ore', 'failed: timeout'], ['explore north', 'ok'], ['collect iron_ore', 'failed: timeout'], ['explore east', 'ok']])
    assert.ok(!C.done(a, r, {}).banned)
  assert.strictEqual(C.done('collect iron_ore', 'failed: timeout', {}).banned, 'collect iron_ore')
  assert.ok(C.isBanned('collect iron_ore'))
  assert.deepStrictEqual(C.banned(), ['collect iron_ore'])
  t += 5 * 60 * 1000 + 1
  assert.ok(!C.isBanned('collect iron_ore'))
})

test('watchdog: ok actions without plan progress -> stuck, ban top action', () => {
  const C = createController({ now })
  let out
  for (let i = 0; i < 20; i++) { out = C.done(i % 4 ? 'collect sand' : 'explore north', 'ok sand+1', { cost: 5, goal: 'g', gained: 1 }) }
  assert.ok(!out.stuck) // first call set best=5 (progress), then 19 without
  out = C.done('collect sand', 'ok', { cost: 5, goal: 'g' })
  assert.ok(out.stuck, 'stuck after 20 no-progress actions')
  assert.strictEqual(out.stuck.top, 'collect sand')
  assert.ok(C.isBanned('collect sand'))
  assert.ok(!C.done('collect stone', 'ok', { cost: 4, goal: 'g' }).stuck)
})

test('watchdog: progress resets, setback (death) does not count as stuck forever', () => {
  const C = createController({ now })
  C.done('a x', 'ok', { cost: 3, goal: 'g' })
  C.done('died x', 'ok', { cost: 12, goal: 'g' }) // setback -> best = 12
  for (let i = 0; i < 10; i++) C.done('b y', 'ok', { cost: 12, goal: 'g' })
  assert.ok(!C.done('c z', 'ok', { cost: 11, goal: 'g' }).stuck)
})

test('free-text goal: item gains count as progress, unless the same action repeats', () => {
  const C = createController({ now })
  let stuck = false
  for (let i = 0; i < 40 && !stuck; i++) stuck = !!C.done('collect sand', 'ok sand+1', { goal: 'build a house', gained: 1 }).stuck
  assert.ok(stuck)
  const D = createController({ now })
  for (let i = 0; i < 40; i++) assert.ok(!D.done(['collect sand', 'collect oak_log', 'craft stick'][i % 3], 'ok', { goal: 'x', gained: 1 }).stuck)
})

console.log(`\n${pass} tests passed`)
