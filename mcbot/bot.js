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
const { createPlanner, SMELT } = require('./planner')

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d }
const LLM = arg('llm', 'http://127.0.0.1:8080')
let goal = arg('goal', 'iron_pickaxe') // "goal <item> [n]" -> B2 planner target; free text otherwise
let paused = false
let following = null // player name in follow mode (bot follows, fights hostiles nearby, no LLM)

const SYSTEM = `You control a Minecraft survival bot. Each turn you get the state and answer with ONE action.
Actions:
collect <block> - walk to nearest block of that type, mine it, pick up drops
craft <item> - craft one item (some need a crafting_table nearby)
place <crafting_table|furnace> - put it on the ground
smelt <item> - put that item in a nearby furnace with fuel, wait, take the result
attack <mob> - fight nearest mob of that type
flee <mob> - run away from that mob
eat <food> - eat food
explore <north|south|east|west|down> - walk 20 blocks (or dig 10 down) to find new things
come player - walk to the player
wait 1 - do nothing
The Plan line lists the next steps computed from recipes to reach the goal.
Rules: attack hostile mobs that are close if health is high; flee if health is low. Eat when food is low.
Usually do the "Recommended action" unless danger, hunger or the goal says otherwise. If an action failed, choose something different. If nothing useful is visible, explore.
Answer only: <action> <arg>`

const HOSTILE = new Set(['zombie', 'skeleton', 'creeper', 'spider', 'husk', 'drowned', 'stray', 'witch', 'enderman', 'slime', 'cave_spider', 'zombie_villager', 'pillager', 'phantom', 'bogged'])
const FOOD = new Set(['apple', 'bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'baked_potato', 'carrot', 'beef', 'porkchop', 'chicken', 'mutton', 'sweet_berries', 'melon_slice', 'cookie', 'cooked_cod', 'cooked_salmon', 'cod', 'salmon', 'potato', 'rabbit', 'cooked_rabbit'])
const CRAFT_CANDIDATES = ['stick', 'crafting_table', 'wooden_pickaxe', 'wooden_axe', 'wooden_sword', 'stone_pickaxe', 'stone_axe', 'stone_sword', 'furnace', 'torch', 'chest', 'iron_pickaxe', 'iron_sword']
const TIER = { wooden_pickaxe: 1, stone_pickaxe: 2, iron_pickaxe: 3, diamond_pickaxe: 4, netherite_pickaxe: 5, golden_pickaxe: 1 }
const SMELT_IN = new Set(Object.values(SMELT))
const NEEDS_TIER = { stone: 1, cobblestone: 1, coal_ore: 1, copper_ore: 2, iron_ore: 2, deepslate: 1, deepslate_coal_ore: 1, deepslate_iron_ore: 2, deepslate_copper_ore: 2, diamond_ore: 3, deepslate_diamond_ore: 3, gold_ore: 3, furnace: 1 }

const bot = mineflayer.createBot({
  host: arg('host', 'localhost'), port: +arg('port', 25565), username: arg('name', 'LFM'),
  version: arg('version', '1.21.11'), auth: 'offline',
})
bot.loadPlugin(pathfinder)
bot.loadPlugin(collectBlock)

let mcData, interestingIds, rareIds, commonIds, P
let target = null, targetDone = false, exploreCount = 0
const history = [] // [{a, r}] last actions + results
const stats = { n: 0, lat: [] }

bot.once('spawn', () => {
  mcData = require('minecraft-data')(bot.version)
  P = createPlanner(mcData)
  setGoal(goal)
  const mv = new Movements(bot)
  mv.allowSprinting = true
  bot.pathfinder.setMovements(mv)
  bot.pathfinder.thinkTimeout = 10000
  bot.collectBlock.movements = mv
  interestingIds = mcData.blocksArray.filter(b => /_log$/.test(b.name) || b.name in NEEDS_TIER ||
    /_ore$/.test(b.name) || ['sand', 'gravel', 'clay', 'crafting_table', 'furnace', 'melon', 'pumpkin', 'sweet_berry_bush', 'wheat'].includes(b.name)).map(b => b.id)
  const COMMON = new Set(['stone', 'cobblestone', 'deepslate', 'sand', 'gravel'].map(n => mcData.blocksByName[n].id))
  commonIds = interestingIds.filter(id => COMMON.has(id))
  rareIds = interestingIds.filter(id => !COMMON.has(id))
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
  if (msg.startsWith('goal ')) { setGoal(msg.slice(5)); bot.chat('New goal: ' + goal + (target ? ` (target ${target.n} ${target.item})` : '')) }
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

// ---------- goal -> planner target (B2) ----------
// "iron_pickaxe", "3 torch", "get an iron pickaxe" -> {item, n}; null if no item named
function parseTarget(text) {
  const w = text.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean)
  for (let i = 0; i < w.length; i++) for (const k of [3, 2, 1]) {
    const name = w.slice(i, i + k).join('_')
    if (i + k <= w.length && mcData.itemsByName[name]) return { item: name, n: Math.max(1, parseInt(w[i - 1]) || 1) }
  }
  return null
}
function setGoal(text) {
  goal = text
  target = mcData ? parseTarget(text) : null
  targetDone = false
  if (target) L.event('target', target)
}
const DIRS = ['north', 'east', 'south', 'west']
// plan step -> concrete action string (may be invalid if the world disagrees; the LLM then picks)
function stepToAction(s, blocks, tier, y) {
  if (s.do === 'collect') {
    const b = s.blocks.find(b => blocks[b] !== undefined && (NEEDS_TIER[b] || 0) <= tier)
    if (b) return `collect ${b}`
    const underground = s.blocks.some(b => /_ore$|^deepslate/.test(b))
    return underground && y > 20 ? 'explore down' : `explore ${DIRS[Math.floor(exploreCount / 3) % 4]}`
  }
  if (s.do === 'smelt') return `smelt ${s.input}`
  return `${s.do} ${s.item}`
}

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
// stations farther than this are ignored: re-placing a table (4 planks) beats a long path back underground
const STATION_RANGE = 12
// blocks a collect failed on (no path / timeout): hidden from scans for a while so the plan moves on
const unreachable = new Map() // "x,y,z" -> expiry ms
const UNREACHABLE_MS = 5 * 60 * 1000
const isUnreachable = pos => {
  const k = `${pos.x},${pos.y},${pos.z}`, t = unreachable.get(k)
  if (t && t < Date.now()) unreachable.delete(k)
  return !!t && t >= Date.now()
}
let collectTarget = null
const nearTable = (d = STATION_RANGE) => bot.findBlock({ matching: mcData.blocksByName.crafting_table.id, maxDistance: d })

function observe() {
  const p = bot.entity.position
  const inv = invCounts()
  const tier = pickTier(inv)
  // nearest distance per interesting block type
  const blocks = {}
  // two passes: underground the N nearest blocks are all stone, which used to hide ores and the crafting table
  const scan = (ids, dist, count) => {
    for (const pos of bot.findBlocks({ matching: ids, maxDistance: dist, count })) {
      if (isUnreachable(pos)) continue
      const name = bot.blockAt(pos).name
      const d = Math.round(pos.distanceTo(p))
      if (!(name in blocks) || d < blocks[name]) blocks[name] = d
    }
  }
  scan(rareIds, 32, 400)
  scan(commonIds, 16, 40)
  for (const st of ['crafting_table', 'furnace']) if (blocks[st] > STATION_RANGE) delete blocks[st]
  const collectable = Object.keys(blocks).filter(n => (NEEDS_TIER[n] || 0) <= tier && !['crafting_table', 'furnace'].includes(n))
  // B2: recipe plan from the real inventory, recomputed every tick
  const plan = target ? P.plan(target.item, target.n, { inv, near: blocks }) : null
  const planCrafts = plan ? plan.steps.filter(s => s.do === 'craft').map(s => s.item) : []
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
  const craftable = [...new Set([...planCrafts, ...plankCands, ...CRAFT_CANDIDATES])].filter(n => {
    const it = mcData.itemsByName[n]
    if (!it || !bot.recipesFor(it.id, null, 1, table || null).length) return false
    if (planCrafts.includes(n)) return true // the plan wants it: skip the "already have enough" filters
    if (n.endsWith('_planks') && (inv[n] || 0) >= 16) return false
    if (n === 'stick' && (inv.stick || 0) >= 8) return false
    if (n === 'crafting_table' && (inv.crafting_table || table)) return false
    if (n.includes('pickaxe') && (TIER[n] || 0) <= tier) return false
    if (/_(axe|sword)$/.test(n) && inv[n]) return false
    if (['furnace', 'chest'].includes(n) && (inv[n] || blocks[n] !== undefined)) return false
    return true
  })
  const foods = Object.keys(inv).filter(n => FOOD.has(n))
  const placeable = ['crafting_table', 'furnace'].filter(n => inv[n] && !(blocks[n] <= 16))
  const furnaceNear = blocks.furnace !== undefined
  const hasFuel = inv.coal || inv.charcoal || Object.keys(inv).some(n => n.endsWith('_planks') || n.endsWith('_log'))
  const smeltable = furnaceNear && hasFuel ? Object.keys(inv).filter(n => SMELT_IN.has(n)) : []

  const mobTxt = Object.entries(mobs).map(([n, d]) => `${n}${HOSTILE.has(n) ? '(hostile)' : ''} ${d}m`).join(', ') || 'none'
  const blkTxt = Object.entries(blocks).sort((a, b) => a[1] - b[1]).map(([n, d]) => `${n} ${d}m`).join(', ') || 'none'
  const invTxt = Object.entries(inv).map(([n, c]) => `${n} x${c}`).join(', ') || 'empty'
  const histTxt = history.slice(-4).map(h => `${h.a} -> ${h.r}`).join('; ') || 'none'
  const tod = bot.time.timeOfDay
  const threat = Object.entries(mobs).filter(([n, d]) => HOSTILE.has(n) && d <= 6).sort((a, b) => a[1] - b[1])[0]
  if (plan?.done && !targetDone) { targetDone = true; bot.chat(`Goal reached: ${target.n} ${target.item}`); L.event('target_done', target) }
  const planNext = !plan ? 'pursue the goal' : plan.done ? 'wait 1' : plan.error ? `explore ${DIRS[Math.floor(exploreCount / 3) % 4]}`
    : stepToAction(plan.steps[0], blocks, tier, Math.floor(p.y))
  const next = threat ? (bot.health > 8 && threat[0] !== 'creeper' ? `attack ${threat[0]}` : `flee ${threat[0]}`)
    : bot.food < 14 && foods.length ? `eat ${foods[0]}`
    : planNext
  const planTxt = !plan ? 'none (free-text goal)' : plan.done ? 'goal reached' : plan.error ? 'unknown: ' + plan.error
    : plan.steps.slice(0, 4).map(P.fmt).join(' > ') + (plan.steps.length > 4 ? ` (+${plan.steps.length - 4})` : '')
  const text = `Goal: ${goal}
Time: ${tod < 12500 ? 'day' : 'night'}. Health ${Math.round(bot.health)}/20, food ${bot.food}/20.
Nearby blocks: ${blkTxt}.
Mobs: ${mobTxt}.
Inventory: ${invTxt}.
Can craft now: ${craftable.join(', ') || 'nothing'}. Crafting table nearby: ${table ? 'yes' : 'no'}. Furnace nearby: ${furnaceNear ? 'yes' : 'no'}.
Plan: ${planTxt}.
Recent actions: ${histTxt}.
Recommended action: ${next}.`

  // grammar: only options valid right now
  // ban an action that just failed 3 times in a row (small model tends to loop)
  const last3 = history.slice(-3)
  const banned = last3.length === 3 && last3.every(h => h.a === last3[0].a && !h.r.startsWith('ok')) ? last3[0].a : null
  const fightable = Object.keys(mobs).filter(n => n !== 'player')
  const opts = { // verb -> allowed args (empty list = verb unavailable)
    collect: collectable, craft: craftable, place: placeable, smelt: smeltable,
    attack: fightable, flee: fightable.filter(n => HOSTILE.has(n)),
    eat: bot.food < 20 ? foods : [], explore: ['north', 'south', 'east', 'west', ...(p.y > -50 ? ['down'] : [])],
    come: mobs.player ? ['player'] : [], wait: ['1'],
  }
  // focus: with an active plan and no danger, only plan-relevant collect/craft stay in the grammar.
  // Without it the 1.7B ignores "explore down" and mines whatever ore is visible (coal/copper loops, 19% hint follow).
  const focus = !!(plan && !plan.done && !plan.error && !threat)
  if (focus) {
    const wantBlocks = new Set(plan.steps.filter(s => s.do === 'collect').flatMap(s => s.blocks))
    opts.collect = opts.collect.filter(b => wantBlocks.has(b))
    opts.craft = opts.craft.filter(c => planCrafts.includes(c))
    opts.come = []; opts.wait = []
  }
  if (banned) { const [v, a] = banned.split(' '); opts[v] = opts[v].filter(x => x !== a) }
  const grammar = 'root ::= ' + Object.entries(opts).filter(([, xs]) => xs.length)
    .map(([v, xs]) => `"${v} " (${xs.map(x => JSON.stringify(x)).join(' | ')})`).join(' | ')
  // structured state for the decision log (B1) — same info as `text`, machine-readable
  const state = {
    goal, pos: [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)], dim: bot.game.dimension,
    hp: Math.round(bot.health), food: bot.food, time: tod, night: tod >= 12500,
    blocks, mobs, inv, tier, craftable, table: !!table, furnace: furnaceNear, history: history.slice(-4),
    target, focus, plan: plan && { done: plan.done, error: plan.error, steps: plan.steps.map(P.fmt) },
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
    const pos = bot.findBlocks({ matching: mcData.blocksByName[name].id, maxDistance: 32, count: 64 }).find(q => !isUnreachable(q))
    const b = pos && bot.blockAt(pos)
    if (!b) return `no reachable ${name} found`
    collectTarget = b.position
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
  async place(name = 'crafting_table') {
    const item = bot.inventory.items().find(i => i.name === name)
    if (!item) return `no ${name} in inventory`
    const p = bot.entity.position.floored()
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [2, 0], [0, 2]]) {
      const ground = bot.blockAt(p.offset(dx, -1, dz))
      const above = bot.blockAt(p.offset(dx, 0, dz))
      if (ground && ground.boundingBox === 'block' && above && above.name === 'air') {
        await bot.equip(item, 'hand')
        await bot.placeBlock(ground, new Vec3(0, 1, 0))
        return `ok placed ${name}`
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
    if (dir === 'down') {
      const y0 = Math.floor(bot.entity.position.y)
      await bot.pathfinder.goto(new goals.GoalY(y0 - 10))
      return `ok now at y ${Math.floor(bot.entity.position.y)}`
    }
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
  async smelt(input) {
    const fb = bot.findBlock({ matching: mcData.blocksByName.furnace.id, maxDistance: STATION_RANGE })
    if (!fb) return 'no furnace nearby'
    if (fb.position.distanceTo(bot.entity.position) > 3)
      await bot.pathfinder.goto(new goals.GoalNear(fb.position.x, fb.position.y, fb.position.z, 2))
    const inv = invCounts()
    const n = Math.min(inv[input] || 0, 8)
    if (!n) return `no ${input}`
    const fuel = ['coal', 'charcoal'].find(f => inv[f]) || Object.keys(inv).find(k => k.endsWith('_planks'))
      || Object.keys(inv).find(k => k.endsWith('_log') && k !== input)
    if (!fuel) return 'no fuel'
    const before = invCounts()
    const f = await bot.openFurnace(bot.blockAt(fb.position))
    try {
      if (!f.fuelItem()) await f.putFuel(mcData.itemsByName[fuel].id, null, Math.min(inv[fuel], /coal/.test(fuel) ? Math.ceil(n / 8) : Math.ceil(n / 1.5)))
      await f.putInput(mcData.itemsByName[input].id, null, n)
      const end = Date.now() + n * 10500 + 3000
      while (Date.now() < end && (f.outputItem()?.count || 0) < n) await sleep(1000)
      if (f.outputItem()) await f.takeOutput()
      if (f.inputItem()) await f.takeInput() // leftovers back to inventory: keeps the planner's view honest
    } finally { f.close() }
    const d = invDelta(before, invCounts())
    const got = Object.entries(d).filter(([k, v]) => v > 0 && k !== input).map(([k, v]) => `+${v} ${k}`)
    return got.length ? 'ok ' + got.join(' ') : 'nothing smelted'
  },
  async wait() { await sleep(1000); return 'ok' },
}
const TIMEOUT = { collect: 25000, craft: 15000, place: 5000, attack: 12000, flee: 6000, eat: 5000, explore: 30000, come: 20000, wait: 2000, smelt: 110000 }

async function run(act, a) {
  collectTarget = null
  try { return await withTimeout(ACTIONS[act](a), TIMEOUT[act]) }
  catch (e) {
    if (act === 'collect' && collectTarget) {
      unreachable.set(`${collectTarget.x},${collectTarget.y},${collectTarget.z}`, Date.now() + UNREACHABLE_MS)
      try { bot.collectBlock.cancelTask() } catch {}
    }
    return 'failed: ' + e.message.split('\n')[0].slice(0, 60)
  }
}

// hint is a concrete valid action ("collect stone"), not advice like "pursue the goal" / "explore to find trees"
const hintIsAction = obs => { const [v, a] = obs.hint.split(' '); return obs.hint.split(' ').length === 2 && !!obs.options[v]?.includes(a) }

// run an action, push it to history and log it (B1). source: llm | user | reflex | hint
async function act(text, source, extra = {}) {
  const [verb, a] = text.split(/\s+/)
  if (verb === 'explore') exploreCount++
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
      require('fs').writeFileSync(__dirname + `/last_obs${bot.username === 'LFM' ? '' : '_' + bot.username}.txt`, obs.text + '\n\n' + obs.grammar + '\n')
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
