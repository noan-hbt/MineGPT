// GOAP planner (plan/goap.js) on fake worlds: plans are valid sequences (simulated with the same recipe data).
'use strict'
const assert = require('assert')
const G = require('../plan/goap')
const { parseCond } = require('../dsl/parse')

const world = (inv, known = {}, st = []) => ({ inv, known: b => known[b] ?? null, station: s => st.includes(s) })
const srcs = p => p.steps.map(s => s.src)
let n = 0
const t = (name, f) => { f(); n++ }

t('craft only: diamond sword from diamonds', () => {
  const p = G.planGoal([{ opts: ['diamond_sword'], n: 1 }], world({ diamond: 47, stick: 1 }, {}, ['crafting_table']))
  assert.deepStrictEqual(srcs(p), ['craft diamond_sword n=1'])
})

t('already true -> no steps', () => {
  const p = G.planGoal([{ opts: ['torch'], n: 4 }], world({ torch: 9 }))
  assert.ok(p.ok); assert.strictEqual(p.steps.length, 0)
})

t('torches from nothing: logs, table placed before the 3x3 craft, pickaxe before coal', () => {
  const p = G.planGoal([{ opts: ['torch'], n: 8 }], world({}, { oak_log: 10, coal_ore: 20 }))
  const s = srcs(p)
  assert.ok(p.ok, p.error)
  assert.ok(s[0].startsWith('mine oak_log'))
  assert.ok(s.indexOf('place crafting_table') < s.indexOf('craft wooden_pickaxe n=1'))
  assert.ok(s.indexOf('craft wooden_pickaxe n=1') < s.findIndex(x => x.startsWith('mine coal_ore')))
  assert.strictEqual(s[s.length - 1], 'craft torch n=8')
  assert.ok(!p.steps.some(x => x.unseen))
})

t('iron pickaxe: stone pickaxe before iron ore, furnace placed before smelting', () => {
  const p = G.planGoal([{ opts: ['iron_pickaxe'], n: 1 }], world({}, { oak_log: 10, stone: 5, iron_ore: 30 }))
  const s = srcs(p)
  assert.ok(p.ok, p.error)
  assert.ok(s.indexOf('craft stone_pickaxe n=1') < s.findIndex(x => x.startsWith('mine iron_ore')))
  assert.ok(s.indexOf('place furnace') < s.findIndex(x => x.startsWith('smelt raw_iron')))
  assert.strictEqual(s[s.length - 1], 'craft iron_pickaxe n=1')
})

t('unseen source -> explore step first', () => {
  const p = G.planGoal([{ opts: ['coal'], n: 2 }], world({ wooden_pickaxe: 1 }))
  assert.deepStrictEqual(srcs(p), ['explore prefer=coal_ore', 'mine coal_ore n=2'])
})

t('placed forms are not sources (no wall_torch / tripwire)', () => {
  const p = G.planGoal([{ opts: ['torch'], n: 4 }], world({}))
  assert.ok(!srcs(p).some(x => /wall_torch/.test(x)))
})

t('alternatives are distinct and cheapest first', () => {
  const a = G.alternatives([{ opts: ['torch'], n: 8 }], world({}, { oak_log: 10, coal_ore: 20 }))
  assert.ok(a.length >= 2)
  assert.ok(a[0].cost <= a[1].cost)
  assert.notDeepStrictEqual(srcs(a[0]), srcs(a[1]))
  // the alternative's choice survives a replan through its force map
  const again = G.planGoal([{ opts: ['torch'], n: 8 }], world({}, { oak_log: 10, coal_ore: 20 }), { force: a[1].force })
  assert.deepStrictEqual(srcs(again), srcs(a[1]))
})

t('goalsOf: have & have, rejects | and other metrics', () => {
  const ids = v => v.tag ? ['oak_planks', 'birch_planks'] : [v.name]
  const g = G.goalsOf(parseCond('have(torch)>=8 & have(tag:planks)>3').ast, ids)
  assert.deepStrictEqual(g.goals, [{ opts: ['torch'], n: 8, rel: false }, { opts: ['oak_planks', 'birch_planks'], n: 4, rel: false }])
  assert.ok(!G.goalsOf(parseCond('have(torch)>=8 | have(stick)>=1').ast, ids).ok)
  assert.ok(!G.goalsOf(parseCond('hp>=10').ast, ids).ok)
})

console.log(`plan tests: ${n} passed`)
