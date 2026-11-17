// B4 offline test: memory.js persists across a "restart" (new instance on the same file). node test_memory.js
'use strict'
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createMemory } = require('./memory')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-'))
;(async () => {
  let m = createMemory('T', { dir, summarize: async w => `did ${w.length} things` })
  m.setHome([0, 64, 0])
  m.pushGoal('iron_pickaxe')
  m.pushGoal('3 torch') // interrupt
  m.see('iron_ore', [40, 16, -30]); m.see('iron_ore', [41, 16, -30]) // same vein -> 1 entry
  m.see('furnace', [2, 64, 1])
  m.stored([1, 64, 0], { cobblestone: 40, coal: 3 })
  for (let i = 0; i < 20; i++) m.action('collect stone', 'ok mined 2', { cobblestone: 2 })
  await new Promise(r => setTimeout(r, 50))
  m.close()

  // restart
  m = createMemory('T', { dir })
  const d = m.data
  assert.deepStrictEqual(d.home, [0, 64, 0])
  assert.strictEqual(m.goal(), '3 torch')
  assert.strictEqual(d.places.iron_ore.length, 1)
  assert.deepStrictEqual(m.nearest('iron_ore', [0, 64, 0]), [40, 16, -30])
  assert.strictEqual(m.nearest('iron_ore', [0, 64, 0], 10), null)
  assert.strictEqual(d.episodes.length, 1)
  assert.strictEqual(d.episodes[0].text, 'did 20 things')
  assert.strictEqual(d.sessions, 2)
  assert.strictEqual(m.popGoal(), 'iron_pickaxe') // torch done -> resume pickaxe
  // verify: the ore block is now stone -> forgotten; furnace still there -> kept
  m.verify([38, 16, -28], q => q[0] === 40 ? 'stone' : 'furnace', 12)
  assert.strictEqual(m.nearest('iron_ore', [0, 0, 0]), null)
  const txt = m.prompt([10, 64, 10], ['iron_ore'])
  console.log(txt)
  assert(/Home: 14m north-west/.test(txt), txt)
  assert(/Chest .*cobblestone x40/.test(txt), txt)
  assert(/Earlier: did 20 things/.test(txt), txt)
  m.close()
  fs.rmSync(dir, { recursive: true, force: true })
  console.log('memory: all tests pass')
})().catch(e => { console.error(e); process.exit(1) })
