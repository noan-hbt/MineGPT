// node test_planner.js — offline checks for the B2 planner (no server needed)
const assert = require('assert')
const mcData = require('minecraft-data')('1.21.11')
const P = require('./planner').createPlanner(mcData)

const show = (t, n, ctx) => {
  const r = P.plan(t, n, ctx)
  console.log(`\n${t} x${n} ${JSON.stringify(ctx?.inv || {})}${r.error ? ' ERROR ' + r.error : ''}`)
  r.steps.forEach((s, i) => console.log(`  ${i + 1}. ${P.fmt(s)}`))
  return r
}

// 1. iron_pickaxe from empty inventory
let r = show('iron_pickaxe', 1, { inv: {}, near: { oak_log: 5 } })
assert(!r.error)
const order = r.steps.map(P.fmt)
const idx = re => order.findIndex(s => re.test(s))
assert(idx(/^collect \d+ oak_log/) === 0, 'starts with logs')
assert(idx(/place crafting_table/) < idx(/craft wooden_pickaxe/), 'table before wooden pickaxe')
assert(idx(/craft wooden_pickaxe/) < idx(/collect \d+ cobblestone/), 'wooden pickaxe before stone')
assert(idx(/craft stone_pickaxe/) < idx(/collect \d+ raw_iron/), 'stone pickaxe before iron')
assert(idx(/place furnace/) < idx(/smelt 3 raw_iron/), 'furnace before smelting')
assert(idx(/smelt 3 raw_iron/) < idx(/craft iron_pickaxe/), 'ingots before pickaxe')
assert(order[order.length - 1] === 'craft iron_pickaxe')
assert(r.steps.find(s => s.item === 'raw_iron').blocks.includes('iron_ore'))

// 2. already have it -> done
r = show('iron_pickaxe', 1, { inv: { iron_pickaxe: 1 } })
assert(r.done)

// 3. mid-progress: has stone_pickaxe + table nearby -> no wood tools re-planned
r = show('iron_pickaxe', 1, { inv: { stone_pickaxe: 1, stick: 4, cobblestone: 8 }, near: { crafting_table: 3, iron_ore: 10 } })
assert(!r.steps.some(s => /wooden_pickaxe|stone_pickaxe/.test(s.item)))
assert(!r.steps.some(s => s.do === 'place' && s.item === 'crafting_table'))
assert(r.steps[0].do === 'collect' && r.steps[0].item === 'raw_iron')

// 4. wood variant follows inventory
r = show('crafting_table', 1, { inv: { birch_log: 2 } })
assert(r.steps.every(s => !/oak/.test(s.item)), 'uses birch, not oak')
assert.strictEqual(P.pickWood({ birch_log: 2 }, {}), 'birch')

// 5. misc targets resolve without error
for (const t of ['torch', 'furnace', 'stone_sword', 'chest', 'bread', 'iron_sword', 'shield', 'bucket', 'glass']) assert(!show(t, 1, { inv: {} }).error, t)
r = show('diamond_pickaxe', 1, { inv: {} })
assert(r.steps.some(s => s.do === 'craft' && s.item === 'iron_pickaxe'), 'diamond needs iron pickaxe first')

console.log('\nOK planner tests passed')
