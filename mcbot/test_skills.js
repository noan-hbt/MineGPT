// B3 — one RCON-scripted test per skill. Needs the MC server (start-mc.ps1) with RCON on; no LLM needed.
// Builds a sky arena at x=3000 z=3000 (y=199 platform), far from the player, resets it before each test.
//   node test_skills.js              all tests
//   node test_skills.js gather smelt only those
//   node test_skills.js --skip mine  all but those
// Temporarily changes difficulty (fight) and time (sleep), restored afterwards.
'use strict'
const mineflayer = require('mineflayer')
const { pathfinder, Movements } = require('mineflayer-pathfinder')
const collectBlock = require('mineflayer-collectblock').plugin
const { Vec3 } = require('vec3')
const fs = require('fs')
const path = require('path')
const { createSkills } = require('./skills')
const rcon = require('./rcon')

const NAME = 'LFMtest', BUDDY = 'LFMbuddy'
const X = 3000, Y = 200, Z = 3000, R = 28 // bedrock platform at Y-1 (undiggable: the bot can't fall off), radius R
const sleep = ms => new Promise(r => setTimeout(r, ms))

let bot, buddy, S, r, mcData
const unreachable = new Map()
const env = {
  isUnreachable: p => (unreachable.get(`${p.x},${p.y},${p.z}`) || 0) > Date.now(),
  markUnreachable: p => unreachable.set(`${p.x},${p.y},${p.z}`, Date.now() + 60000),
  home: null,
}
const inv = () => { const c = {}; for (const it of bot.inventory.items()) c[it.name] = (c[it.name] || 0) + it.count; return c }
const cmd = async c => { const out = await r.cmd(c); if (/Unknown|Incorrect|Expected|Invalid/i.test(out)) throw new Error(`RCON "${c}" -> ${out}`); return out }
const at = (dx, dy, dz) => `${X + dx} ${Y + dy} ${Z + dz}`
// small pause after world edits so the bot's client has the block updates before the skill scans
const set = async (dx, dy, dz, b) => { await cmd(`setblock ${at(dx, dy, dz)} ${b}`); await sleep(250) }
const fill = async (a, b, block) => { await cmd(`fill ${at(...a)} ${at(...b)} ${block}`); await sleep(250) }
const assert = (c, msg) => { if (!c) throw new Error(msg) }
const waitFor = async (f, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (f()) return true; await sleep(100) } return f() }

// run fn with a temporary difficulty, then restore the server's one
async function withDifficulty(d, fn) {
  const before = (await r.cmd('difficulty')).match(/is (\w+)/)?.[1]?.toLowerCase() || 'peaceful'
  try { await cmd('difficulty ' + d); return await fn() } finally { await cmd('difficulty ' + before) }
}

async function reset() {
  bot.pathfinder.setGoal(null)
  await cmd(`kill @e[type=!player,x=${X},y=${Y},z=${Z},distance=..60]`)
  await fill([-R, 0, -R], [R, 7, R], 'air')
  await fill([-R, 8, -R], [R, 15, R], 'air')
  await fill([-R, -4, -R], [R, -2, R], 'air')
  await fill([-R, -1, -R], [R, -1, R], 'bedrock')
  await cmd(`clear ${NAME}`)
  await cmd(`effect clear ${NAME}`)
  await cmd(`effect give ${NAME} instant_health 1 10 true`)
  await cmd(`effect give ${NAME} saturation 1 20 true`)
  await cmd(`tp ${NAME} ${at(0, 0, 0)} 0 0`)
  unreachable.clear()
  env.home = null
  await waitFor(() => bot.entity.position.distanceTo(new Vec3(X + 0.5, Y, Z + 0.5)) < 1.5, 5000)
  await sleep(800)
  await waitFor(() => bot.entity.onGround, 3000)
}

// ---------- tests: each returns the skill result; throws on failed assertion ----------
const T = {
  async gather() {
    for (const [dx, dz] of [[4, 0], [6, 2], [-5, 3], [2, -7]]) await set(dx, 0, dz, 'oak_log')
    await sleep(500)
    const res = await S.gather('oak_log', 3)
    assert((inv().oak_log || 0) >= 3, 'expected >=3 oak_log, have ' + (inv().oak_log || 0) + ': ' + res)
    return res
  },
  async gather_tier() {
    await fill([3, 0, -1], [4, 1, 1], 'stone')
    let res = await S.gather('stone', 1, 8000)
    assert(!inv().cobblestone, 'mined stone without a pickaxe?')
    assert(/better tool/.test(res), 'expected "need a better tool", got ' + res)
    await cmd(`give ${NAME} wooden_pickaxe`)
    await sleep(300)
    res = await S.gather('stone', 4)
    assert((inv().cobblestone || 0) >= 4, 'expected 4 cobblestone, have ' + (inv().cobblestone || 0) + ': ' + res)
    return res
  },
  async mine_visible() {
    await fill([5, 0, -1], [7, 2, 1], 'stone')
    await set(6, 1, 0, 'iron_ore')
    await cmd(`give ${NAME} stone_pickaxe`)
    const res = await S.mineOre('iron_ore', 1, 30000)
    assert(inv().raw_iron >= 1, 'no raw_iron: ' + res)
    return res
  },
  async mine_hidden() {
    // real terrain: random surface spot near the arena, must dig down and strip-mine to find iron
    await cmd(`give ${NAME} iron_pickaxe`)
    await cmd(`give ${NAME} cooked_beef 16`)
    await cmd(`effect give ${NAME} resistance 120 4 true`)
    await cmd(`effect give ${NAME} night_vision 120 0 true`)
    await cmd(`spreadplayers ${X + 200 + Math.floor(Math.random() * 400)} ${Z + 200} 0 30 false ${NAME}`)
    await sleep(3000)
    const res = await S.mineOre('iron_ore', 1, 120000)
    assert(inv().raw_iron >= 1, 'no raw_iron: ' + res)
    return res
  },
  async craft() {
    await cmd(`give ${NAME} oak_planks 5`)
    await sleep(300)
    let res = await S.craft('stick', 2)
    assert(inv().stick === 8, 'expected 8 sticks, have ' + inv().stick)
    res = await S.craft('wooden_pickaxe')
    assert(res === 'needs crafting_table', 'expected needs crafting_table, got ' + res)
    await set(8, 0, 0, 'crafting_table')
    await cmd(`give ${NAME} oak_planks 3`)
    await sleep(300)
    res = await S.craft('wooden_pickaxe')
    assert(inv().wooden_pickaxe === 1, 'no wooden_pickaxe: ' + res)
    return res
  },
  async place_open() {
    await cmd(`give ${NAME} crafting_table`)
    await sleep(300)
    assert(S.canPlace(), 'canPlace false on a flat platform')
    const res = await S.place('crafting_table')
    assert(bot.findBlock({ matching: mcData.blocksByName.crafting_table.id, maxDistance: 5 }), 'no table placed: ' + res)
    return res
  },
  async place_shaft() {
    // 1x1 vertical shaft (what "explore down" digs): no free cell -> must dig a wall cell first
    await fill([-5, 0, -5], [5, 4, 5], 'stone')
    await fill([0, 0, 0], [0, 4, 0], 'air')
    await cmd(`give ${NAME} crafting_table`)
    await cmd(`give ${NAME} wooden_pickaxe`)
    await sleep(500)
    assert(!S.findPlaceSpot(), 'expected no open spot in a shaft')
    assert(S.canPlace(), 'canPlace should count a diggable wall')
    const res = await S.place('crafting_table')
    assert(bot.findBlock({ matching: mcData.blocksByName.crafting_table.id, maxDistance: 3 }), 'no table placed: ' + res)
    return res
  },
  async smelt() {
    await set(3, 0, 0, 'furnace')
    await cmd(`give ${NAME} raw_iron 2`)
    await cmd(`give ${NAME} coal 1`)
    await sleep(300)
    const res = await S.smelt('raw_iron')
    assert(inv().iron_ingot === 2, 'expected 2 iron_ingot: ' + res)
    assert(!inv().raw_iron, 'raw_iron left')
    return res
  },
  async eat() {
    await cmd(`give ${NAME} bread 4`)
    // peaceful refills hunger by itself: the hunger effect only sticks on easy
    const low = await withDifficulty('easy', async () => {
      await cmd(`effect give ${NAME} hunger 20 250 true`)
      const ok = await waitFor(() => bot.food <= 16, 15000)
      await cmd(`effect clear ${NAME} hunger`)
      return ok
    })
    assert(low, 'hunger effect did not lower food')
    const f0 = bot.food
    const res = await S.eat('bread')
    assert(bot.food > f0, `food did not go up (${f0} -> ${bot.food}): ${res}`)
    return res
  },
  async fight() {
    return withDifficulty('easy', async () => {
      await cmd(`give ${NAME} iron_sword`)
      await cmd(`effect give ${NAME} resistance 30 4 true`)
      await cmd(`summon husk ${at(4, 0, 0)}`)
      await sleep(800)
      const res = await S.fight('husk')
      await sleep(500)
      assert(!bot.nearestEntity(e => e.name === 'husk'), 'husk still alive: ' + res)
      return res
    })
  },
  async flee() {
    return withDifficulty('easy', async () => {
      await cmd(`summon husk ${at(3, 0, 0)} {NoAI:1b}`)
      await cmd(`damage ${NAME} 13`)
      await sleep(800)
      assert(bot.health <= 8, 'damage did not apply, hp ' + bot.health)
      assert(S.danger(), 'danger() should be true at low hp next to a husk')
      const res = await S.flee('husk')
      const h = bot.nearestEntity(e => e.name === 'husk')
      assert(h && h.position.distanceTo(bot.entity.position) >= 10, 'still close: ' + res)
      return res
    })
  },
  async shelter() {
    await fill([-1, -4, -1], [1, -1, 1], 'dirt')
    await cmd(`give ${NAME} wooden_shovel`)
    await sleep(500)
    const res = await S.buildShelter()
    assert(S.inShelter(), 'not in shelter: ' + res)
    return res
  },
  async sleep() {
    const t0 = +(await r.cmd('time query daytime')).match(/(\d+)/)[1]
    try {
      await cmd(`give ${NAME} red_bed`)
      await cmd('time set 13000')
      await sleep(800)
      const res = await S.sleep(2000)
      assert(bot.isSleeping || /slept/.test(res), 'not sleeping: ' + res)
      if (bot.isSleeping) await bot.wake()
      return res
    } finally { await cmd(`time set ${t0}`) }
  },
  async farm() {
    for (const dx of [3, 4, 5]) {
      await set(dx, -1, 2, 'farmland')
      await set(dx, 0, 2, 'wheat[age=7]')
    }
    await set(6, -1, 2, 'farmland')
    await set(6, 0, 2, 'wheat[age=2]') // not mature: must stay
    await cmd(`give ${NAME} wheat_seeds 2`)
    await sleep(500)
    const res = await S.farm()
    assert((inv().wheat || 0) >= 3, 'expected 3 wheat: ' + res)
    assert(bot.blockAt(new Vec3(X + 6, Y, Z + 2)).name === 'wheat', 'immature wheat was harvested')
    assert(/replanted [1-9]/.test(res), 'nothing replanted: ' + res)
    return res
  },
  async store() {
    await set(4, 0, 0, 'chest')
    await cmd(`give ${NAME} cobblestone 20`)
    await cmd(`give ${NAME} stone_pickaxe`)
    await cmd(`give ${NAME} bread 3`)
    await sleep(400)
    const res = await S.storeInChest()
    const i = inv()
    assert(!i.cobblestone, 'cobblestone not stored: ' + res)
    assert(i.stone_pickaxe && i.bread, 'tool/food should be kept')
    return res
  },
  async home() {
    env.home = new Vec3(X + 15, Y, Z - 12)
    const res = await S.goHome()
    assert(bot.entity.position.distanceTo(env.home) <= 3.5, 'not home: ' + res)
    return res
  },
  async explore() {
    const res = await S.explore('north')
    assert(bot.entity.position.z < Z - 15, 'did not move north: ' + res)
    return res
  },
  async explore_down() {
    await fill([-2, -4, -2], [2, -1, 2], 'dirt')
    await cmd(`give ${NAME} wooden_shovel`)
    await sleep(300)
    const res = await S.explore('down', 15000)
    assert(bot.entity.position.y <= Y - 3, 'did not go down: ' + res)
    return res
  },
  async come() {
    await cmd(`tp ${BUDDY} ${at(-10, 0, 8)}`)
    await sleep(1000)
    const res = await S.come(BUDDY)
    assert(buddy.entity.position.distanceTo(bot.entity.position) <= 3.5, 'not next to buddy: ' + res)
    return res
  },
  async follow() {
    await cmd(`tp ${BUDDY} ${at(-6, 0, 0)}`)
    await sleep(1000)
    // buddy walks away while we follow
    buddy.setControlState('forward', true)
    buddy.look(Math.PI / 2, 0, true) // yaw pi/2 = west
    const p = S.follow(BUDDY, 5000)
    await sleep(2500)
    buddy.setControlState('forward', false)
    const res = await p
    assert(/^ok/.test(res), res)
    return res
  },
}

function makeBot(name) {
  const b = mineflayer.createBot({ host: 'localhost', port: 25565, username: name, version: '1.21.11', auth: 'offline' })
  return new Promise((res, rej) => { b.once('spawn', () => res(b)); b.once('error', rej); b.once('kicked', k => rej(new Error('kicked ' + k))) })
}

async function main() {
  const args = process.argv.slice(2)
  const skip = args.includes('--skip')
  const names = args.filter(a => a !== '--skip')
  const todo = Object.keys(T).filter(n => !names.length || (skip ? !names.includes(n) : names.includes(n)))
  r = await rcon.connect()
  await cmd(`forceload add ${X - 48} ${Z - 48} ${X + 48} ${Z + 48}`)
  bot = await makeBot(NAME)
  if (todo.some(n => n === 'come' || n === 'follow')) buddy = await makeBot(BUDDY)
  mcData = require('minecraft-data')(bot.version)
  bot.loadPlugin(pathfinder); bot.loadPlugin(collectBlock)
  const mv = new Movements(bot)
  mv.allowSprinting = true
  mv.liquidCost = 8
  bot.pathfinder.setMovements(mv)
  bot.pathfinder.thinkTimeout = 10000
  S = createSkills(bot, mcData, env)
  await cmd(`gamemode survival ${NAME}`)
  const results = []
  for (const name of todo) {
    let res, ok = false, err = null
    const t0 = Date.now()
    try {
      await reset()
      res = await T[name]()
      ok = true
    } catch (e) { err = e.message }
    const s = ((Date.now() - t0) / 1000).toFixed(1)
    results.push({ name, ok, s: +s, res, err })
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name.padEnd(13)} ${s.padStart(5)}s  ${ok ? res : err}`)
  }
  await reset()
  await cmd(`forceload remove ${X - 48} ${Z - 48} ${X + 48} ${Z + 48}`)
  const pass = results.filter(x => x.ok).length
  console.log(`\n${pass}/${results.length} passed`)
  const out = path.join(__dirname, 'logs', `skills_test_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify(results, null, 1))
  bot.quit(); buddy?.quit(); r.close()
  setTimeout(() => process.exit(pass === results.length ? 0 : 1), 500)
}
main().catch(e => { console.error(e); process.exit(2) })
