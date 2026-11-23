// H2 tests: renderer snapshot on the golden state, diff mode, affordances, ledger, memory (no server needed).
// node test/state.js            -> check (exit 1 on failure)
// node test/state.js --update   -> rewrite spec/golden/sheet_example.txt (review the diff before committing)
'use strict'
const fs = require('fs')
const path = require('path')
const assert = require('assert')
const { render } = require('../render')
const { affordances } = require('../state/afford')
const { Ledger, keyOf } = require('../state/ledger')
const { Memory } = require('../state/memory')

const G = path.join(__dirname, '..', '..', 'spec', 'golden')
const state = JSON.parse(fs.readFileSync(path.join(G, 'state_example.json'), 'utf8'))
const snap = path.join(G, 'sheet_example.txt')
let n = 0
const t = (name, fn) => { fn(); n++ }

t('render snapshot', () => {
  const r = render(state)
  if (process.argv.includes('--update')) fs.writeFileSync(snap, r.text)
  assert.strictEqual(r.text, fs.readFileSync(snap, 'utf8').replace(/\r\n/g, '\n'), 'sheet differs from spec/golden/sheet_example.txt (run with --update and review)')
  assert.deepStrictEqual(r.sections.map(s => s.name), ['MANUAL', 'MEMORY', 'MAP', 'EPISODE', 'GOALS', 'LEDGER', 'BODY', 'INVENTORY', 'AFFORDANCES', 'SURROUNDINGS', 'EVENTS', 'NOW'])
})

t('diff mode collapses unchanged stable sections only', () => {
  const full = render(state)
  const s2 = JSON.parse(JSON.stringify(state))
  s2.meta.t += 500; s2.body.hp = 6
  const d = render(s2, { prev: full.stamps })
  const same = d.sections.filter(s => s.same).map(s => s.name)
  assert.ok(same.includes('MANUAL') && same.includes('MEMORY') && same.includes('INVENTORY'), same.join())
  assert.ok(!same.includes('BODY'), 'BODY changed')
  for (const a of ['SURROUNDINGS', 'EVENTS', 'NOW']) assert.ok(!same.includes(a), a + ' always sent')
  assert.match(d.text, /## MEMORY \[[0-9a-f]{4}\] unchanged/)
})

t('affordances from recipes.json', () => {
  const a = affordances({ raw_iron: 4, cobblestone: 52, coal: 9, oak_planks: 6, stick: 5, bread: 6 })
  const c = Object.fromEntries(a.craftable.map(x => [x.item, x]))
  assert.strictEqual(c.furnace.max, 6); assert.strictEqual(c.furnace.station, 'crafting_table')
  assert.strictEqual(c.torch.max, 20); assert.strictEqual(c.torch.station, undefined)
  const ip = a.craftable_soon.find(x => x.item === 'iron_pickaxe')
  assert.deepStrictEqual(ip, { item: 'iron_pickaxe', missing: { iron_ingot: 3 }, steps: 2 })
  assert.deepStrictEqual(a.smeltable, ['cobblestone', 'raw_iron'])
  assert.deepStrictEqual(a.edible, ['bread'])
  const chest = affordances({ oak_planks: 6 }).craftable_soon.find(x => x.item === 'chest')
  assert.deepStrictEqual(chest.missing, { 'tag:planks': 2 })
})

t('ledger keys and aggregation', () => {
  assert.strictEqual(keyOf('mine iron_ore n=3 near=@vein'), 'mine iron_ore')
  assert.strictEqual(keyOf('chop n=2'), 'chop')
  assert.strictEqual(keyOf('attack #zombie.417'), 'attack #zombie.417')
  assert.strictEqual(keyOf('seq[chop; craft stick]'), 'seq')
  const l = new Ledger()
  l.add({ t: 1, kind: 'result', status: 'failed', stmt: 'mine iron_ore n=3', dur_s: 2, cause: 'no_path' })
  l.add({ t: 2, kind: 'result', status: 'ok', stmt: 'chop', dur_s: 2 })
  l.add({ t: 3, kind: 'result', status: 'failed', stmt: 'mine iron_ore', dur_s: 2, cause: 'no_path' })
  const a = l.state().agg
  assert.strictEqual(a[0].key, 'mine iron_ore'); assert.strictEqual(a[0].failed, 2); assert.strictEqual(a[0].causes.no_path, 2)
  assert.strictEqual(l.state().recent.length, 3)
})

t('memory goals / places / notes', () => {
  const m = new Memory(null, Date.now())
  m.goal('push', 'iron pickaxe'); m.goal('push', 'bring bread', 'player', 'Noan'); m.goal('done')
  m.note('lava west', 'lava'); m.note('lava east', 'lava'); m.namePlace('home', [1.5, 64, -2.2], 'hut')
  const s = m.state()
  assert.deepStrictEqual(s.goals.stack.map(g => g.text), ['iron pickaxe'])
  assert.strictEqual(s.episode.goals_done[0].text, 'bring bread')
  assert.deepStrictEqual(s.memory.notes.map(x => x.text), ['lava east'])
  assert.deepStrictEqual(s.memory.places[0].pos, [1, 64, -3])
})

console.log(`state tests: ${n} passed`)
