// Minecraft bot driven by local LFM3-1.7B (llama.cpp server, start-game.ps1).
// Loop: observe -> ask LLM for ONE high-level action (grammar limited to options valid right now)
//       -> execute it with Mineflayer (pathfinder / collectblock) -> repeat.
// In-game chat: "goal <text>" sets the goal, "stop" pauses, "go" resumes, "come" brings the bot to you.
//
// Usage: node bot.js [--host localhost] [--port 25565] [--name LFM] [--llm http://127.0.0.1:8080]

const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const collectBlock = require('mineflayer-collectblock').plugin
const { Vec3 } = require('vec3')
const L = require('./logger')

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d }
const LLM = arg('llm', 'http://127.0.0.1:8080')
let goal = arg('goal', 'gather wood, craft a wooden pickaxe, then get stone and craft stone tools')
let paused = false
let following = null // player name in follow mode (bot follows, fights hostiles nearby, no LLM)

const SYSTEM = `You control a Minecraft survival bot. Each turn you get the state and answer with ONE action.
Actions:
collect <block> - walk to nearest block of that type, mine it, pick up drops
craft <item> - craft one item (some need a crafting_table nearby)
place crafting_table - put a crafting table on the ground
attack <mob> - fight nearest mob of that type
flee <mob> - run away from that mob
eat <food> - eat food
explore <north|south|east|west> - walk 20 blocks to find new things
come player - walk to the player
wait 1 - do nothing
Progression: logs -> planks -> crafting_table -> place it -> sticks -> wooden_pickaxe -> stone -> stone_pickaxe.
Rules: attack hostile mobs that are close if health is high; flee if health is low. Eat when food is low.
Usually do the "Recommended action" unless danger, hunger or the goal says otherwise. If an action failed, choose something different. If nothing useful is visible, explore.
Answer only: <action> <arg>`

const HOSTILE = new Set(['zombie', 'skeleton', 'creeper', 'spider', 'husk', 'drowned', 'stray', 'witch', 'enderman', 'slime', 'cave_spider', 'zombie_villager', 'pillager', 'phantom', 'bogged'])
const FOOD = new Set(['apple', 'bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'baked_potato', 'carrot', 'beef', 'porkchop', 'chicken', 'mutton', 'sweet_berries', 'melon_slice', 'cookie', 'cooked_cod', 'cooked_salmon', 'cod', 'salmon', 'potato', 'rabbit', 'cooked_rabbit'])
const CRAFT_CANDIDATES = ['stick', 'crafting_table', 'wooden_pickaxe', 'wooden_axe', 'wooden_sword', 'stone_pickaxe', 'stone_axe', 'stone_sword', 'furnace', 'torch', 'chest', 'iron_pickaxe', 'iron_sword']
const TIER = { wooden_pickaxe: 1, stone_pickaxe: 2, iron_pickaxe: 3, diamond_pickaxe: 4, netherite_pickaxe: 5, golden_pickaxe: 1 }
const NEEDS_TIER = { stone: 1, cobblestone: 1, coal_ore: 1, copper_ore: 2, iron_ore: 2, deepslate: 1, deepslate_coal_ore: 1, deepslate_iron_ore: 2, deepslate_copper_ore: 2, diamond_ore: 3, deepslate_diamond_ore: 3, gold_ore: 3, furnace: 1 }

const bot = mineflayer.createBot({
  host: arg('host', 'localhost'), port: +arg('port', 25565), username: arg('name', 'LFM'),
  version: arg('version', '1.21.11'), auth: 'offline',
})
bot.loadPlugin(pathfinder)
bot.loadPlugin(collectBlock)

let mcData, interestingIds
const history = [] // [{a, r}] last actions + results
const stats = { n: 0, lat: [] }

bot.once('spawn', () => {
  mcData = require('minecraft-data')(bot.version)
  const mv = new Movements(bot)
  mv.allowSprinting = true
  bot.pathfinder.setMovements(mv)
  bot.pathfinder.thinkTimeout = 10000
  bot.collectBlock.movements = mv
  interestingIds = mcData.blocksArray.filter(b => /_log$/.test(b.name) || b.name in NEEDS_TIER ||
    ['sand', 'gravel', 'crafting_table', 'melon', 'pumpkin', 'sweet_berry_bush'].includes(b.name)).map(b => b.id)
  console.log(`[bot] spawned (${bot.version}) at ${bot.entity.position.floored()} | goal: ${goal}`)
  bot.chat('LFM3 bot online. Chat: goal <text> | stop | go | come')
  L.start({ bot: bot.username, mc: bot.version, llm: LLM, goal, system: SYSTEM, system_hash: L.hash(SYSTEM),
    sampling: { temperature: 0, top_k: 1, max_tokens: 16, thinking: false }, pos: snap().pos })
  console.log('[log] ' + L.file)
  loop()
})

bot.on('chat', (user, msg) => {
  if (user === bot.username) return
  const cmd = msg.split(' ')[0]
  if (['goal', 'stop', 'go', 'follow', 'where', 'help', 'come'].includes(cmd)) L.event('chat_cmd', { user, msg })
  else L.event('chat', { user, msg })
  if (msg.startsWith('goal ')) { goal = msg.slice(5); bot.chat('New goal: ' + goal) }
  else if (msg === 'stop') { paused = true; following = null; bot.pathfinder.setGoal(null); bot.chat('paused') }
  else if (msg === 'go') { paused = false; following = null; bot.pathfinder.setGoal(null); bot.chat('autonomous mode, goal: ' + goal) }
  else if (msg === 'follow') { following = user; bot.chat(`following ${user} (say go to let me work alone)`) }
  else if (msg === 'where') { const p = bot.entity.position.floored(); bot.chat(`I'm at ${p.x} ${p.y} ${p.z}`) }
  else if (msg === 'help') bot.chat('goal <text> | go | stop | follow | come | where')
  else if (msg === 'come') act('come player', 'user').then(r => console.log('[come] ' + r))
})
bot.on('kicked', r => { console.log('[bot] kicked', r); L.event('kicked', { reason: String(r).slice(0, 200) }) })
bot.on('error', e => { console.log('[bot] error', e.message); L.event('error', { msg: e.message.slice(0, 200) }) })
bot.on('end', () => { console.log('[bot] disconnected'); L.event('end'); process.exit(0) })
let dead = false
bot.on('death', () => {
  dead = true
  console.log('[bot] died')
  L.event('death', { ...snap(), last: history.slice(-3) })
  history.push({ a: 'died', r: 'respawned' })
  try { bot.collectBlock.cancelTask() } catch {}
  bot.pathfinder.setGoal(null); bot.clearControlStates()
})
bot.on('spawn', () => { if (dead) { dead = false; console.log('[bot] respawned'); L.event('respawn', snap()) } })

// ---------- observation ----------
const invCounts = () => {
  const c = {}
  for (const it of bot.inventory.items()) c[it.name] = (c[it.name] || 0) + it.count
  return c
}
const pickTier = inv => Math.max(0, ...Object.keys(inv).map(n => TIER[n] || 0))
// small state snapshot (state after an action, events)
const snap = () => {
  const p = bot.entity?.position
  return { pos: p ? [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)] : null, hp: Math.round(bot.health ?? 0), food: bot.food ?? 0, inv: invCounts() }
}
const invDelta = (a, b) => {
  const d = {}
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const x = (b[k] || 0) - (a[k] || 0); if (x) d[k] = x }
  return d
}
const nearTable = (d = 32) => bot.findBlock({ matching: mcData.blocksByName.crafting_table.id, maxDistance: d })

function observe() {
  const p = bot.entity.position
  const inv = invCounts()
  const tier = pickTier(inv)
  // nearest distance per interesting block type
  const blocks = {}
  for (const pos of bot.findBlocks({ matching: interestingIds, maxDistance: 24, count: 400 })) {
    const name = bot.blockAt(pos).name
    const d = Math.round(pos.distanceTo(p))
    if (!(name in blocks) || d < blocks[name]) blocks[name] = d
  }
  const collectable = Object.keys(blocks).filter(n => (NEEDS_TIER[n] || 0) <= tier && n !== 'crafting_table')
  // mobs within 16 blocks
  const mobs = {}
  for (const e of Object.values(bot.entities)) {
    if (e === bot.entity || !e.name || e.type === 'object' || e.type === 'orb' || e.name === 'item') continue
    const d = e.position.distanceTo(p)
    if (d > 16) continue
    const n = e.type === 'player' ? 'player' : e.name
    if (!(n in mobs) || d < mobs[n]) mobs[n] = Math.round(d)
  }
  // craftable now (with nearby table if any), hiding items we already have enough of
  const table = nearTable()
  const logs = Object.keys(inv).filter(n => n.endsWith('_log'))
  const plankCands = logs.map(l => l.replace(/_log$/, '_planks')).filter(n => mcData.itemsByName[n])
  const craftable = [...plankCands, ...CRAFT_CANDIDATES].filter(n => {
    if (n.endsWith('_planks') && (inv[n] || 0) >= 16) return false
    if (n === 'stick' && (inv.stick || 0) >= 8) return false
    if (n === 'crafting_table' && (inv.crafting_table || table)) return false
    if (n.includes('pickaxe') && (TIER[n] || 0) <= tier) return false
    if (/_(axe|sword)$/.test(n) && inv[n]) return false
    if (['furnace', 'chest'].includes(n) && inv[n]) return false
    const it = mcData.itemsByName[n]
    return it && bot.recipesFor(it.id, null, 1, table || null).length > 0
  })
  const foods = Object.keys(inv).filter(n => FOOD.has(n))
  const canPlaceTable = !!inv.crafting_table && !nearTable(16)

  const mobTxt = Object.entries(mobs).map(([n, d]) => `${n}${HOSTILE.has(n) ? '(hostile)' : ''} ${d}m`).join(', ') || 'none'
  const blkTxt = Object.entries(blocks).sort((a, b) => a[1] - b[1]).map(([n, d]) => `${n} ${d}m`).join(', ') || 'none'
  const invTxt = Object.entries(inv).map(([n, c]) => `${n} x${c}`).join(', ') || 'empty'
  const histTxt = history.slice(-4).map(h => `${h.a} -> ${h.r}`).join('; ') || 'none'
  const tod = bot.time.timeOfDay
  const planks = Object.keys(inv).filter(n => n.endsWith('_planks')).reduce((s, n) => s + inv[n], 0)
  const nLogs = logs.reduce((s, n) => s + inv[n], 0)
  const logBlock = Object.keys(blocks).find(n => n.endsWith('_log'))
  const getPlanks = n => planks >= n ? null : nLogs ? `craft ${plankCands[0]}` : logBlock ? `collect ${logBlock}` : 'explore to find trees'
  const getTable = () => table ? null : canPlaceTable ? 'place crafting_table' : inv.crafting_table ? 'explore a bit' : getPlanks(4) || 'craft crafting_table'
  const getSticks = () => (inv.stick || 0) >= 2 ? null : getPlanks(2) || 'craft stick'
  const threat = Object.entries(mobs).filter(([n, d]) => HOSTILE.has(n) && d <= 6).sort((a, b) => a[1] - b[1])[0]
  const next = threat ? (bot.health > 8 && threat[0] !== 'creeper' ? `attack ${threat[0]}` : `flee ${threat[0]}`)
    : bot.food < 14 && foods.length ? `eat ${foods[0]}`
    : tier >= 2 ? 'pursue the goal'
    : tier === 1 || (inv.cobblestone || 0) >= 3 ? ((inv.cobblestone || 0) < 3 ? (blocks.stone !== undefined ? 'collect stone' : 'explore to find stone')
      : getSticks() || getTable() || 'craft stone_pickaxe')
    : getTable() || getSticks() || getPlanks(3) || 'craft wooden_pickaxe'
  const text = `Goal: ${goal}
Time: ${tod < 12500 ? 'day' : 'night'}. Health ${Math.round(bot.health)}/20, food ${bot.food}/20.
Nearby blocks: ${blkTxt}.
Mobs: ${mobTxt}.
Inventory: ${invTxt}.
Can craft now: ${craftable.join(', ') || 'nothing'}. Crafting table nearby: ${table ? 'yes' : 'no'}.
Recent actions: ${histTxt}.
Recommended action: ${next}.`

  // grammar: only options valid right now
  // ban an action that just failed 3 times in a row (small model tends to loop)
  const last3 = history.slice(-3)
  const banned = last3.length === 3 && last3.every(h => h.a === last3[0].a && !h.r.startsWith('ok')) ? last3[0].a : null
  const fightable = Object.keys(mobs).filter(n => n !== 'player')
  const opts = { // verb -> allowed args (empty list = verb unavailable)
    collect: collectable, craft: craftable, place: canPlaceTable ? ['crafting_table'] : [],
    attack: fightable, flee: fightable.filter(n => HOSTILE.has(n)),
    eat: bot.food < 20 ? foods : [], explore: ['north', 'south', 'east', 'west'],
    come: mobs.player ? ['player'] : [], wait: ['1'],
  }
  if (banned) { const [v, a] = banned.split(' '); opts[v] = opts[v].filter(x => x !== a) }
  const grammar = 'root ::= ' + Object.entries(opts).filter(([, xs]) => xs.length)
    .map(([v, xs]) => `"${v} " (${xs.map(x => JSON.stringify(x)).join(' | ')})`).join(' | ')
  // structured state for the decision log (B1) — same info as `text`, machine-readable
  const state = {
    goal, pos: [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)], dim: bot.game.dimension,
    hp: Math.round(bot.health), food: bot.food, time: tod, night: tod >= 12500,
    blocks, mobs, inv, tier, craftable, table: !!table, history: history.slice(-4),
  }
  const options = Object.fromEntries(Object.entries(opts).filter(([, xs]) => xs.length))
  return { text, grammar, state, options, hint: next, banned }
}

// ---------- LLM ----------
async function decide(obs) {
  const body = {
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: obs.text }],
    max_tokens: 16, temperature: 0, top_k: 1, repeat_penalty: 1.0,
    chat_template_kwargs: { enable_thinking: false }, reasoning_format: 'none',
    grammar: obs.grammar, cache_prompt: true,
  }
  const t0 = performance.now()
  const r = await fetch(LLM + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`LLM HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
  const data = await r.json()
  const ms = performance.now() - t0
  return { ms, text: data.choices[0].message.content.replace('<think></think>', '').trim() }
}

// ---------- actions ----------
const sleep = ms => new Promise(r => setTimeout(r, ms))
function withTimeout(p, ms) {
  let t
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms) })])
    .finally(() => { clearTimeout(t); bot.pathfinder.setGoal(null); bot.clearControlStates() })
}
const nearestEntity = name => bot.nearestEntity(e => (name === 'player' ? e.type === 'player' : e.name === name) && e !== bot.entity)

const ACTIONS = {
  async collect(name) {
    const b = bot.findBlock({ matching: mcData.blocksByName[name].id, maxDistance: 32 })
    if (!b) return `no ${name} found`
    const before = invCounts()
    await bot.collectBlock.collect(b, { ignoreNoPath: false })
    const after = invCounts()
    const got = Object.keys(after).filter(n => (after[n] || 0) > (before[n] || 0)).map(n => `+${after[n] - (before[n] || 0)} ${n}`)
    return got.length ? 'ok ' + got.join(' ') : 'mined but nothing picked up'
  },
  async craft(name) {
    const it = mcData.itemsByName[name]
    let table = nearTable()
    let recipe = bot.recipesFor(it.id, null, 1, null)[0]
    if (!recipe) {
      if (!table) return 'needs crafting_table'
      recipe = bot.recipesFor(it.id, null, 1, table)[0]
      if (!recipe) return 'missing ingredients'
      if (table.position.distanceTo(bot.entity.position) > 4)
        await bot.pathfinder.goto(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2))
      table = nearTable(5)
      if (!table) return 'could not reach crafting_table'
    } else table = null
    await bot.craft(recipe, 1, table)
    return `ok crafted ${name}`
  },
  async place() {
    const item = bot.inventory.items().find(i => i.name === 'crafting_table')
    if (!item) return 'no crafting_table in inventory'
    const p = bot.entity.position.floored()
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [2, 0], [0, 2]]) {
      const ground = bot.blockAt(p.offset(dx, -1, dz))
      const above = bot.blockAt(p.offset(dx, 0, dz))
      if (ground && ground.boundingBox === 'block' && above && above.name === 'air') {
        await bot.equip(item, 'hand')
        await bot.placeBlock(ground, new Vec3(0, 1, 0))
        return 'ok placed crafting_table'
      }
    }
    return 'no free spot'
  },
  async attack(name) {
    const end = Date.now() + 10000
    while (Date.now() < end) {
      const e = nearestEntity(name)
      if (!e || !e.isValid) return `${name} gone/killed`
      const sword = bot.inventory.items().find(i => i.name.endsWith('_sword'))
      if (sword && bot.heldItem?.name !== sword.name) await bot.equip(sword, 'hand')
      if (e.position.distanceTo(bot.entity.position) > 3) {
        bot.pathfinder.setGoal(new goals.GoalFollow(e, 2), true)
        await sleep(250)
        continue
      }
      await bot.lookAt(e.position.offset(0, e.height * 0.8, 0), true)
      bot.attack(e)
      await sleep(600)
    }
    return 'still fighting'
  },
  async flee(name) {
    const e = nearestEntity(name)
    if (!e) return `${name} not seen`
    bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalFollow(e, 16)), true)
    await sleep(4000)
    return `ok now ${Math.round(e.position.distanceTo(bot.entity.position))}m away`
  },
  async eat(name) {
    const it = bot.inventory.items().find(i => i.name === name)
    if (!it) return `no ${name}`
    await bot.equip(it, 'hand')
    await bot.consume()
    return `ok food ${bot.food}/20`
  },
  async explore(dir) {
    const [dx, dz] = { north: [0, -20], south: [0, 20], east: [20, 0], west: [-20, 0] }[dir]
    const p = bot.entity.position
    await bot.pathfinder.goto(new goals.GoalNearXZ(p.x + dx, p.z + dz, 3))
    return 'ok arrived'
  },
  async come() {
    const e = nearestEntity('player')
    if (!e) return 'no player visible'
    await bot.pathfinder.goto(new goals.GoalNear(e.position.x, e.position.y, e.position.z, 2))
    return 'ok next to player'
  },
  async wait() { await sleep(1000); return 'ok' },
}
const TIMEOUT = { collect: 25000, craft: 15000, place: 5000, attack: 12000, flee: 6000, eat: 5000, explore: 20000, come: 20000, wait: 2000 }

async function run(act, a) {
  try { return await withTimeout(ACTIONS[act](a), TIMEOUT[act]) }
  catch (e) { return 'failed: ' + e.message.split('\n')[0].slice(0, 60) }
}

// hint is a concrete valid action ("collect stone"), not advice like "pursue the goal" / "explore to find trees"
const hintIsAction = obs => { const [v, a] = obs.hint.split(' '); return obs.hint.split(' ').length === 2 && !!obs.options[v]?.includes(a) }

// run an action, push it to history and log it (B1). source: llm | user | reflex | hint
async function act(text, source, extra = {}) {
  const [verb, a] = text.split(/\s+/)
  const before = snap()
  const t0 = performance.now()
  const result = await run(verb, a)
  const dur_ms = Math.round(performance.now() - t0)
  history.push({ a: text, r: result })
  if (history.length > 20) history.shift()
  const after = snap()
  L.decision({ source, action: text, verb, arg: a, result, dur_ms, ...extra,
    after: { pos: after.pos, hp: after.hp, food: after.food, inv_delta: invDelta(before.inv, after.inv), died: dead } })
  return result
}

// ---------- main loop ----------
async function loop() {
  await sleep(1500) // let chunks load
  while (true) {
    if (paused || dead || !bot.entity || bot.health <= 0) { await sleep(500); continue }
    if (following) {
      const p = bot.players[following]?.entity
      const foe = bot.nearestEntity(e => HOSTILE.has(e.name) && e.position.distanceTo(bot.entity.position) < 6)
      if (foe) { console.log(`[follow] defending vs ${foe.name}: ${await act('attack ' + foe.name, 'reflex', { mode: 'follow' })}`); continue }
      if (p && !bot.pathfinder.isMoving() && p.position.distanceTo(bot.entity.position) > 3)
        bot.pathfinder.setGoal(new goals.GoalFollow(p, 2), true)
      await sleep(500)
      continue
    }
    let line
    try {
      const obs = observe()
      require('fs').writeFileSync(__dirname + '/last_obs.txt', obs.text + '\n\n' + obs.grammar + '\n')
      const { ms, text } = await decide(obs)
      const t0 = performance.now()
      const res = await act(text, 'llm', { llm_ms: Math.round(ms), obs: obs.state, obs_text: obs.text, options: obs.options,
        grammar: obs.grammar, hint: obs.hint, banned: obs.banned, followed_hint: hintIsAction(obs) ? obs.hint === text : null })
      stats.n++; stats.lat.push(ms)
      const s = [...stats.lat].sort((x, y) => x - y)
      line = `#${stats.n} llm ${ms.toFixed(0)}ms (med ${s[s.length >> 1].toFixed(0)}) | ${text.padEnd(28)} | ${((performance.now() - t0) / 1000).toFixed(1)}s ${res} | hp ${Math.round(bot.health)} food ${bot.food}`
    } catch (e) {
      line = '[loop] ' + e.message
      await sleep(2000)
    }
    console.log(line)
  }
}
