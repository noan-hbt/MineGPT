// Minecraft bot driven by local LFM3-1.7B (llama.cpp server, start-game.ps1).
// Loop (B5, hierarchical): reflexes (code) > current task (a skill+arg, repeated without the LLM while the plan step
//       holds) > LLM decider, asked only when there is no task, it ended/failed, or an event fired (control.js).
//       The LLM picks ONE skill+arg (grammar limited to options valid right now and not banned).
// In-game chat: "goal <text>" sets the goal, "stop" pauses, "go" resumes, "come" brings the bot to you.
//
// Usage: node bot.js [--host localhost] [--port 25565] [--name LFM] [--llm http://127.0.0.1:8080]

const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const collectBlock = require('mineflayer-collectblock').plugin
const { Vec3 } = require('vec3')
const L = require('./logger')
const { createPlanner, SMELT } = require('./planner')
const { createSkills, HOSTILE, FOOD, BUILD, CROPS } = require('./skills')
const fs = require('fs')

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d }
const LLM = arg('llm', 'http://127.0.0.1:8080')
const { createMemory } = require('./memory')
const { createController, planCost } = require('./control')
const { createChat, slotCount } = require('./chat')
// B5: task persistence + bans + progress watchdog (control.js)
const C = createController()
// B4: long-term memory (memory/<name>.json). Episode summaries come from the LLM (code fallback inside memory.js)
const M = createMemory(arg('name', 'LFM'), { summarize: summarizeEpisode })
// goal: --goal wins, else resume the remembered task, else default
// --goals a,b,c: queue several goals (a first); each one resumes the next when done (B4 task stack)
for (const g of (arg('goals', '') || '').split(',').map(x => x.trim()).filter(Boolean).reverse()) M.pushGoal(g)
// true = a remembered task is resumed (computed before setGoal pushes the default goal)
const RESUMED = !!M.goal() && !arg('goal', null) && !arg('goals', null)
let goal = arg('goal', null) || M.goal() || 'iron_pickaxe' // "goal <item> [n]" -> B2 planner target; free text otherwise
let paused = false
let following = null // player name in follow mode (bot follows, fights hostiles nearby, no LLM)

const SYSTEM = `You control a Minecraft survival bot. Each turn you get the state and answer with ONE action.
Actions:
collect <block> - walk to the nearest blocks of that type, mine a few, pick up drops
goto <ore|crafting_table|furnace> - walk back to a place you remember (ore vein, or a station you placed)
mine <ore> - dig down to where that ore is and tunnel until you find and mine it
craft <item> - craft one item (some need a crafting_table nearby)
place <crafting_table|furnace|chest> - put it on the ground
smelt <item> - put that item in a nearby furnace with fuel, wait, take the result
attack <mob> - fight nearest mob of that type (stops if health gets low)
flee <mob> - run away from hostile mobs
eat <food> - eat food
shelter here - dig into the ground and close the hole (safe for the night)
sleep bed - sleep in a bed (night only)
farm crops - harvest ripe crops nearby and replant
store chest - put spare items in a chest
home base - walk back to the base
explore <north|south|east|west|down|up> - walk 24 blocks (or dig 10 down, or climb to the surface) to find new things
come player - walk to the player
wait 1 - do nothing
The Plan line lists the next steps computed from recipes to reach the goal. Home/Remembered/Chest/Earlier lines are your memory.
Rules: attack hostile mobs that are close if health is high; flee if health is low. Eat when food is low.
Usually do the "Recommended action" unless danger, hunger or the goal says otherwise. If an action failed, choose something different. If nothing useful is visible, explore.
Answer only: <action> <arg>`

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

let mcData, interestingIds, rareIds, commonIds, P, S
// base position: memory (B4); migrate the old home.json once
const HOME_FILE = __dirname + '/home.json'
if (!M.home) try { const h = JSON.parse(fs.readFileSync(HOME_FILE, 'utf8')); M.setHome([h.x, h.y, h.z]) } catch {}
let home = M.home && new Vec3(...M.home)
const setHome = p => { M.setHome(p); home = new Vec3(...M.home) }
let target = null, targetDone = false, exploreCount = 0
const history = [] // [{a, r}] last actions + results
let doing = null // action running right now (B7 chat context)
let SLOTS = 1 // llama-server slots; >= 2: decider on slot 0, chat + episode summaries on slot 1 (keeps the decider's prompt cache)
slotCount(LLM).then(n => { SLOTS = n; console.log(`[llm] ${n} slot(s)`) })
const stats = { n: 0, lat: [] }

bot.once('spawn', () => {
  mcData = require('minecraft-data')(bot.version)
  P = createPlanner(mcData)
  setGoal(goal)
  const mv = new Movements(bot)
  mv.allowSprinting = true
  mv.liquidCost = 8 // swimming = slow, breaks digging, drowns: go around water when possible
  bot.pathfinder.setMovements(mv)
  bot.pathfinder.thinkTimeout = 10000
  bot.collectBlock.movements = mv
  interestingIds = mcData.blocksArray.filter(b => /_log$/.test(b.name) || b.name in NEEDS_TIER ||
    /_ore$/.test(b.name) || ['sand', 'gravel', 'clay', 'crafting_table', 'furnace', 'chest', 'melon', 'pumpkin', 'sweet_berry_bush', 'wheat'].includes(b.name)).map(b => b.id)
  const COMMON = new Set(['stone', 'cobblestone', 'deepslate', 'sand', 'gravel'].map(n => mcData.blocksByName[n].id))
  commonIds = interestingIds.filter(id => COMMON.has(id))
  rareIds = interestingIds.filter(id => !COMMON.has(id))
  S = createSkills(bot, mcData, {
    isUnreachable, markUnreachable: p => unreachable.set(`${p.x},${p.y},${p.z}`, Date.now() + UNREACHABLE_MS),
    get home() { return home },
    keep: () => new Set(target ? P.plan(target.item, target.n, { inv: invCounts() }).steps.flatMap(st => [st.item, st.input, st.fuel]).filter(Boolean) : []),
    onStore: (p, items) => M.stored(p, items),
  })
  const resumed = RESUMED
  if (home) console.log(`[mem] home ${M.home} (${M.where(snap().pos, M.home)}), ${M.data.actions} past actions, session #${M.data.sessions}`)
  console.log(`[bot] spawned (${bot.version}) at ${bot.entity.position.floored()} | goal: ${goal}`)
  bot.chat(resumed ? `back online, resuming: ${goal}` + (home ? ` (home ${M.where(snap().pos, M.home)})` : '') : 'LFM3 bot online. Chat: goal <text> | stop | go | come')
  L.start({ bot: bot.username, mc: bot.version, llm: LLM, goal, system: SYSTEM, system_hash: L.hash(SYSTEM),
    sampling: { temperature: 0, top_k: 1, max_tokens: 16, thinking: false }, pos: snap().pos })
  console.log('[log] ' + L.file)
  loop()
})

const COMMANDS = ['goal', 'stop', 'go', 'follow', 'where', 'help', 'come', 'sethome', 'tasks', 'memory']
// exact chat commands (fast path, no LLM). quiet = no confirmation in chat (B7: the LLM already answered)
function command(user, msg, quiet = false) {
  const tell = t => { if (!quiet) bot.chat(t) }
  if (msg.startsWith('goal ')) { C.drop(); setGoal(msg.slice(5)); tell('New goal: ' + goal + (target ? ` (target ${target.n} ${target.item})` : '')) }
  else if (msg === 'stop') { C.drop(); paused = true; following = null; bot.pathfinder.setGoal(null); tell('paused') }
  else if (msg === 'go') { paused = false; following = null; bot.pathfinder.setGoal(null); tell('autonomous mode, goal: ' + goal) }
  else if (msg === 'follow') { following = user; tell(`following ${user} (say go to let me work alone)`) }
  else if (msg === 'where') { const p = bot.entity.position.floored(); bot.chat(`I'm at ${p.x} ${p.y} ${p.z}`) }
  else if (msg === 'sethome') {
    setHome(bot.entity.position)
    tell(`home set at ${home.x} ${home.y} ${home.z}`)
  }
  else if (msg === 'tasks') bot.chat('tasks: ' + (M.data.tasks.map(t => t.goal).join(' > ') || 'none'))
  else if (msg === 'memory') M.prompt(snap().pos, []).split('\n').filter(Boolean).forEach(l => bot.chat(l.slice(0, 250)))
  else if (msg === 'help') bot.chat('goal <text> | go | stop | follow | come | where | sethome | tasks | memory | or just talk to me')
  else if (msg === 'come') act('come player', 'user').then(r => console.log('[come] ' + r))
  else return false
  return true
}

// B7: any other message -> LLM chat (async, own llama-server slot when there are 2+). Disable with --no-chat.
const chat = process.argv.includes('--no-chat') ? null : createChat({
  llm: LLM, name: arg('name', 'LFM'), slot: () => SLOTS > 1 ? 1 : null,
  context: () => {
    const s = snap(), tod = bot.time?.timeOfDay ?? 0
    return { ...s, night: tod >= 12500 && tod < 23500, paused, following, goal, tasks: M.data.tasks.map(t => t.goal),
      doing: doing || (C.task ? `${C.task.action} (task, run ${C.task.runs})` : history.at(-1) ? `last: ${history.at(-1).a} -> ${history.at(-1).r}` : null),
      memory: s.pos ? M.prompt(s.pos, []) : '' }
  },
  say: t => { for (let i = 0; i < t.length; i += 250) bot.chat(t.slice(i, i + 250)) },
  log: rec => L.event('chat_reply', rec),
  onIntent: (intent, a, user) => {
    if (intent === 'get') {
      const t = parseTarget(a)
      if (!t) { bot.chat(`(je ne connais pas l'objet "${a}")`); return }
      command(user, `goal ${t.n} ${t.item}`, true)
    }
    else if (intent === 'stop') command(user, 'stop', true)
    else if (intent === 'resume') command(user, 'go', true)
    else if (intent === 'follow') command(user, 'follow', true)
    else if (intent === 'come') command(user, 'come', true)
    else if (intent === 'set_home') command(user, 'sethome', true)
    else if (intent === 'go_home') { paused = false; following = null; act('home base', 'user').then(r => console.log('[home] ' + r)) }
  },
})

bot.on('chat', (user, msg) => {
  if (user === bot.username) return
  const cmd = msg.split(' ')[0]
  const isCmd = COMMANDS.includes(cmd) && (cmd === 'goal' ? msg.length > 5 : msg === cmd)
  L.event(isCmd ? 'chat_cmd' : 'chat', { user, msg })
  if (isCmd) command(user, msg)
  else if (chat) chat.handle(user, msg)
})
bot.on('kicked', r => { console.log('[bot] kicked', r); L.event('kicked', { reason: String(r).slice(0, 200) }) })
bot.on('error', e => { console.log('[bot] error', e.message); L.event('error', { msg: e.message.slice(0, 200) }) })
bot.on('end', () => { console.log('[bot] disconnected'); L.event('end'); M.close(); process.exit(0) })
process.on('SIGINT', () => { M.close(); process.exit(0) })
let dead = false
bot.on('death', () => {
  dead = true
  console.log('[bot] died')
  L.event('death', { ...snap(), last: history.slice(-3) })
  const foe = bot.nearestEntity(e => HOSTILE.has(e.name) && e.position.distanceTo(bot.entity.position) < 8)
  M.died(bot.entity.position, foe ? foe.name : 'unknown', history.slice(-3).map(h => h.a))
  history.push({ a: 'died', r: 'respawned' })
  C.drop()
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
// remember=true (chat / startup): the goal goes on top of the task stack; the previous one resumes when it is done
function setGoal(text, remember = true) {
  goal = text
  if (remember) M.pushGoal(text)
  target = mcData ? parseTarget(text) : null
  targetDone = false
  if (target) L.event('target', target)
}
const DIRS = ['north', 'east', 'south', 'west']
// explore direction: changes every 3 explores (and when the watchdog fires); banned directions are skipped
const exploreDir = () => { for (let k = 0; k < 4; k++) { const a = `explore ${DIRS[(Math.floor(exploreCount / 3) + k) % 4]}`; if (!C.isBanned(a)) return a } return 'explore down' }
const GOTO_RANGE = 128 // remembered ores farther than this are not worth the walk
const STATION_GOTO = 64 // remembered crafting table / furnace
const MEM_KINDS = new Set(['crafting_table', 'furnace', 'chest'])
// plan step blocks -> the base ore name for "mine <ore>" (deepslate_iron_ore -> iron_ore)
const oreOf = blocks => blocks.map(b => b.replace(/^deepslate_/, '')).find(b => /_ore$/.test(b))
// plan step -> concrete action string (may be invalid if the world disagrees; the LLM then picks)
function stepToAction(s, blocks, tier, y) {
  // B5: banned actions are skipped (visible ore that times out -> walk to a remembered vein / dig for another one)
  if (s.do === 'collect') {
    const b = s.blocks.find(b => blocks[b] !== undefined && (NEEDS_TIER[b] || 0) <= tier && !C.isBanned(`collect ${b}`))
    if (b) return `collect ${b}`
    const ore = oreOf(s.blocks)
    if (ore && (NEEDS_TIER[ore] || 0) <= tier) {
      const alt = [M.nearest(ore, bot.entity.position, GOTO_RANGE) && `goto ${ore}`, `mine ${ore}`].filter(a => a && !C.isBanned(a))[0]
      if (alt) return alt
    }
    if (!ore && !S.underSky() && bot.entity.position.y < 100 && !C.isBanned('explore up')) return 'explore up' // wood/sand/... are on the surface
    return exploreDir()
  }
  if (s.do === 'smelt') return `smelt ${s.input}`
  // placing failed again and again (no room, server refuses): walk back to the remembered one instead (B4 memory)
  if (s.do === 'place' && C.isBanned(`place ${s.item}`) && M.nearest(s.item, bot.entity.position, STATION_GOTO) && !C.isBanned(`goto ${s.item}`)) return `goto ${s.item}`
  return `${s.do} ${s.item}`
}

// ores the plan still has to collect (base names)
const planOresAll = plan => plan && !plan.error ? plan.steps.filter(s => s.do === 'collect').map(s => oreOf(s.blocks)).filter(Boolean) : []

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
      if (/_ore$/.test(name)) M.see(name.replace(/^deepslate_/, ''), pos) // B4: remember ore veins + stations
      else if (MEM_KINDS.has(name)) M.see(name, pos)
      if (!(name in blocks) || d < blocks[name]) blocks[name] = d
    }
  }
  scan(rareIds, 32, 400)
  scan(commonIds, 16, 40)
  M.verify(p, q => bot.blockAt(new Vec3(q[0], q[1], q[2]))?.name ?? null, 12) // forget mined ores / broken stations
  for (const st of ['crafting_table', 'furnace']) if (blocks[st] > STATION_RANGE) delete blocks[st]
  const collectable = Object.keys(blocks).filter(n => (NEEDS_TIER[n] || 0) <= tier && !MEM_KINDS.has(n))
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
  const placeable = S.canPlace() ? ['crafting_table', 'furnace', 'chest'].filter(n => inv[n] && !(blocks[n] <= 16)) : []
  const furnaceNear = blocks.furnace !== undefined
  const hasFuel = inv.coal || inv.charcoal || Object.keys(inv).some(n => n.endsWith('_planks') || n.endsWith('_log'))
  const smeltable = furnaceNear && hasFuel ? Object.keys(inv).filter(n => SMELT_IN.has(n)) : []

  const mobTxt = Object.entries(mobs).map(([n, d]) => `${n}${HOSTILE.has(n) ? '(hostile)' : ''} ${d}m`).join(', ') || 'none'
  const blkTxt = Object.entries(blocks).sort((a, b) => a[1] - b[1]).map(([n, d]) => `${n} ${d}m`).join(', ') || 'none'
  const invTxt = Object.entries(inv).map(([n, c]) => `${n} x${c}`).join(', ') || 'empty'
  const histTxt = history.slice(-4).map(h => `${h.a} -> ${h.r}`).join('; ') || 'none'
  const tod = bot.time.timeOfDay
  const threat = Object.entries(mobs).filter(([n, d]) => HOSTILE.has(n) && d <= 6).sort((a, b) => a[1] - b[1])[0]
  const night = tod >= 12500 && tod < 23500
  const peaceful = bot.game.difficulty === 'peaceful'
  const bedBlock = bot.findBlock({ matching: b => b.name.endsWith('_bed'), maxDistance: 24 })
  if (bedBlock) M.see('bed', bedBlock.position)
  const bedNear = !!bedBlock || Object.keys(inv).some(n => n.endsWith('_bed'))
  const sheltered = S.inShelter()
  const canShelter = night && !peaceful && !sheltered && !bedNear && (BUILD.some(b => inv[b]) || tier >= 1)
  const ripe = !!bot.findBlock({ maxDistance: 16, matching: b => CROPS[b.name] && b.getProperties().age >= CROPS[b.name].age })
  const chestOk = !!bot.findBlock({ matching: mcData.blocksByName.chest.id, maxDistance: 16 }) || !!inv.chest
  const invFull = bot.inventory.items().length >= 30
  const farFromHome = home && home.distanceTo(p) > 16
  if (plan?.done && !targetDone) {
    targetDone = true; bot.chat(`Goal reached: ${target.n} ${target.item}`); L.event('target_done', target)
    const prev = M.popGoal() // B4 task stack: resume the goal that was interrupted
    if (prev) { setGoal(prev, false); bot.chat('resuming: ' + prev) }
  }
  const planNext = !plan ? 'pursue the goal' : plan.done ? 'wait 1' : plan.error ? exploreDir()
    : stepToAction(plan.steps[0], blocks, tier, Math.floor(p.y))
  let next = threat ? (bot.health > 8 && threat[0] !== 'creeper' ? `attack ${threat[0]}` : `flee ${threat[0]}`)
    : bot.food < 14 && foods.length ? `eat ${foods[0]}`
    : night && bedNear && !peaceful ? 'sleep bed'
    : canShelter ? 'shelter here'
    : invFull && chestOk ? 'store chest'
    : planNext
  if (C.isBanned(next)) next = exploreDir() // B5: never recommend a banned action
  const planTxt = !plan ? 'none (free-text goal)' : plan.done ? 'goal reached' : plan.error ? 'unknown: ' + plan.error
    : plan.steps.slice(0, 4).map(P.fmt).join(' > ') + (plan.steps.length > 4 ? ` (+${plan.steps.length - 4})` : '')
  const memTxt = M.prompt(p, [...new Set(planOresAll(plan))].filter(o => blocks[o] === undefined && blocks['deepslate_' + o] === undefined)) // only ores not in view
  const text = `Goal: ${goal}
${memTxt ? memTxt + '\n' : ''}Time: ${night ? 'night' : 'day'}${sheltered ? ' (in shelter)' : ''}. Health ${Math.round(bot.health)}/20, food ${bot.food}/20.
Nearby blocks: ${blkTxt}.
Mobs: ${mobTxt}.
Inventory: ${invTxt}.
Can craft now: ${craftable.join(', ') || 'nothing'}. Crafting table nearby: ${table ? 'yes' : 'no'}. Furnace nearby: ${furnaceNear ? 'yes' : 'no'}.
Plan: ${planTxt}.
Recent actions: ${histTxt}.
Recommended action: ${next}.`

  // grammar: only options valid right now
  // ban an action that just failed 3 times in a row (small model tends to loop)
  // B5: actions banned by the controller (failed 3x in the last 12 actions, or no progress) leave the grammar
  const banned = C.banned()
  const fightable = Object.keys(mobs).filter(n => n !== 'player')
  // mine: ores the plan needs that we can harvest but don't see (visible ones go through collect)
  const planOres = plan && !plan.error ? plan.steps.filter(s => s.do === 'collect').map(s => oreOf(s.blocks)).filter(Boolean) : []
  const minable = [...new Set(planOres)].filter(o => (NEEDS_TIER[o] || 0) <= tier && blocks[o] === undefined && blocks['deepslate_' + o] === undefined)
  // goto: remembered (B4) but not visible -> walk back to the vein instead of digging blind
  const gotoable = minable.filter(o => M.nearest(o, p, GOTO_RANGE))
  // + stations the plan wants to place, remembered within STATION_GOTO (walking back beats a refused / wasted placement)
  if (plan && !plan.error) for (const st of plan.steps.filter(x => x.do === 'place').map(x => x.item))
    if (MEM_KINDS.has(st) && blocks[st] === undefined && M.nearest(st, p, STATION_GOTO)) gotoable.push(st)
  const opts = { // verb -> allowed args (empty list = verb unavailable)
    collect: collectable, goto: gotoable, mine: minable, craft: craftable, place: placeable, smelt: smeltable,
    attack: fightable, flee: fightable.filter(n => HOSTILE.has(n)),
    eat: bot.food < 20 ? foods : [],
    shelter: canShelter ? ['here'] : [], sleep: night && bedNear ? ['bed'] : [], farm: ripe ? ['crops'] : [],
    store: chestOk && bot.inventory.items().length >= 20 ? ['chest'] : [], home: farFromHome ? ['base'] : [],
    explore: ['north', 'south', 'east', 'west', ...(p.y > -50 ? ['down'] : []), ...(S.underSky() ? [] : ['up'])],
    come: mobs.player ? ['player'] : [], wait: ['1'],
  }
  // focus: with an active plan and no danger, only plan-relevant collect/craft stay in the grammar.
  // Without it the 1.7B ignores "explore down" and mines whatever ore is visible (coal/copper loops, 19% hint follow).
  const focus = !!(plan && !plan.done && !plan.error && !threat)
  if (focus) {
    const wantBlocks = new Set(plan.steps.filter(s => s.do === 'collect').flatMap(s => s.blocks))
    opts.collect = opts.collect.filter(b => wantBlocks.has(b))
    opts.craft = opts.craft.filter(c => planCrafts.includes(c))
    opts.come = []; opts.wait = []; opts.farm = []; opts.home = []
  }
  for (const b of banned) { const [v, a] = b.split(' '); if (opts[v]) opts[v] = opts[v].filter(x => x !== a) }
  if (!Object.values(opts).some(xs => xs.length)) opts.wait = ['1'] // never an empty grammar
  const grammar = 'root ::= ' + Object.entries(opts).filter(([, xs]) => xs.length)
    .map(([v, xs]) => `"${v} " (${xs.map(x => JSON.stringify(x)).join(' | ')})`).join(' | ')
  // structured state for the decision log (B1) — same info as `text`, machine-readable
  const state = {
    goal, pos: [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)], dim: bot.game.dimension,
    hp: Math.round(bot.health), food: bot.food, time: tod, night: tod >= 12500,
    blocks, mobs, inv, tier, craftable, table: !!table, furnace: furnaceNear, history: history.slice(-4),
    sheltered, home: home && [home.x, home.y, home.z], memory: memTxt,
    target, focus, banned, task: C.task && { id: C.task.id, action: C.task.action, runs: C.task.runs }, plan: plan && { done: plan.done, error: plan.error, steps: plan.steps.map(P.fmt) },
  }
  const options = Object.fromEntries(Object.entries(opts).filter(([, xs]) => xs.length))
  // how many blocks one "collect X" should mine: what the plan still needs (capped), else 2
  const collectN = {}
  if (plan && !plan.error) for (const st of plan.steps) if (st.do === 'collect') for (const b of st.blocks) collectN[b] ??= Math.min(st.n, 4)
  return { text, grammar, state, options, hint: next, banned, threat, night, sheltered, foods, collectN,
    goal, hp: Math.round(bot.health), plan } // goal/hp/plan: B5 task context (control.js)
}

// ---------- LLM ----------
async function decide(obs) {
  const body = {
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: obs.text }],
    max_tokens: 16, temperature: 0, top_k: 1, repeat_penalty: 1.0,
    chat_template_kwargs: { enable_thinking: false }, reasoning_format: 'none',
    grammar: obs.grammar, cache_prompt: true,
  }
  if (SLOTS > 1) body.id_slot = 0
  const t0 = performance.now()
  const r = await fetch(LLM + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`LLM HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
  const data = await r.json()
  const ms = performance.now() - t0
  return { ms, text: data.choices[0].message.content.replace('<think></think>', '').trim() }
}

// B4 episode summary: one sentence from the last ~20 actions (runs async, every 20 actions)
async function summarizeEpisode(w, g) {
  const lines = w.map(x => `${x.a} -> ${x.r}`).join('\n')
  const body = {
    messages: [{ role: 'system', content: 'Summarize what a Minecraft bot did in ONE short sentence (max 25 words): what it achieved, what failed, where it is in its goal. No preamble.' },
      { role: 'user', content: `Goal: ${g}\nActions:\n${lines}` }],
    max_tokens: 60, temperature: 0, chat_template_kwargs: { enable_thinking: false }, reasoning_format: 'none', cache_prompt: false,
  }
  if (SLOTS > 1) body.id_slot = 1
  const r = await fetch(LLM + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) })
  if (!r.ok) return null
  return (await r.json()).choices[0].message.content.replace(/<think>[\s\S]*?<\/think>/, '').trim()
}

// ---------- actions ----------
const sleep = ms => new Promise(r => setTimeout(r, ms))
function withTimeout(p, ms) {
  let t
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms) })])
    .finally(() => { clearTimeout(t); bot.pathfinder.setGoal(null); bot.clearControlStates() })
}

// verb -> B3 skill (skills.js). Every skill has its own budget/retries; TIMEOUT is only a safety net.
let collectN = {}
const ACTIONS = {
  collect: name => S.gather(name, collectN[name] || 2),
  mine: ore => S.mineOre(ore),
  goto: gotoPlace,
  craft: name => S.craft(name),
  place: name => S.place(name || 'crafting_table'),
  smelt: input => S.smelt(input),
  attack: name => S.fight(name),
  flee: name => S.flee(name),
  eat: name => S.eat(name),
  shelter: () => S.buildShelter(),
  sleep: () => S.sleep(),
  farm: () => S.farm(),
  store: () => S.storeInChest(),
  home: () => S.goHome(),
  explore: dir => S.explore(dir, dir === 'up' ? 40000 : 20000),
  come: () => S.come('player'),
  async wait(n) { await sleep(1000 * (+n || 1)); return 'ok' },
  // reflex only (not in the grammar): swim straight up until we can breathe
  async surface() {
    bot.pathfinder.setGoal(null)
    bot.setControlState('jump', true)
    const t = Date.now()
    while (Date.now() - t < 7000 && bot.entity.isInWater && bot.oxygenLevel < 20) await sleep(200)
    bot.setControlState('jump', false)
    return bot.oxygenLevel >= 15 || !bot.entity.isInWater ? `ok oxygen ${bot.oxygenLevel}` : `failed: still underwater (oxygen ${bot.oxygenLevel})`
  },
}
const TIMEOUT = { collect: 55000, mine: 75000, craft: 20000, place: 15000, attack: 20000, flee: 12000, eat: 8000, shelter: 35000,
  sleep: 50000, farm: 50000, store: 30000, home: 55000, goto: 65000, explore: 45000, come: 30000, wait: 10000, surface: 9000, smelt: 110000 }

// walk to a remembered place (B4). Arrival: the ore shows up in the next scan and "collect" takes over
async function gotoPlace(kind) {
  const q = M.nearest(kind, bot.entity.position, GOTO_RANGE)
  if (!q) return `nothing remembered for ${kind}`
  const err = await S.goto(new goals.GoalNear(q[0], q[1], q[2], 3), 60000)
  const d = Math.round(bot.entity.position.distanceTo(new Vec3(q[0], q[1], q[2])))
  if (d <= 4) return `ok at ${kind}`
  if (err && err !== 'timeout') { M.forget(kind, q); return `failed: ${err}, forgot it` }
  return `ok on the way, ${d}m left`
}

async function run(act, a) {
  if (!ACTIONS[act]) return `unknown action ${act}`
  try { return await withTimeout(ACTIONS[act](a), TIMEOUT[act]) }
  catch (e) {
    try { bot.collectBlock.cancelTask() } catch {}
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
  doing = text
  const result = await run(verb, a).finally(() => { doing = null })
  const dur_ms = Math.round(performance.now() - t0)
  history.push({ a: text, r: result })
  if (history.length > 20) history.shift()
  const after = snap()
  const inv_delta = invDelta(before.inv, after.inv)
  L.decision({ source, action: text, verb, arg: a, result, dur_ms, ...extra,
    after: { pos: after.pos, hp: after.hp, food: after.food, inv_delta, died: dead } })
  M.action(text, result, inv_delta)
  // B5: bans + progress watchdog (cost = what the plan still needs after this action)
  const cost = target ? planCost(P.plan(target.item, target.n, { inv: after.inv })) : null
  const ctl = C.done(text, result, { cost, goal, gained: Object.values(inv_delta).filter(v => v > 0).length })
  if (ctl.banned) { console.log(`[ctl] banned ${ctl.banned} (failed 3x recently)`); L.event('ban', { action: ctl.banned, why: 'failures' }) }
  if (ctl.stuck) {
    exploreCount += 3 // next explore goes another way
    console.log(`[ctl] no progress: banned ${ctl.stuck.top} (escalation ${ctl.stuck.escalations})`)
    L.event('stuck', { ...ctl.stuck, cost })
  }
  // first crafting table placed = home, if none was set
  if (!home && verb === 'place' && a === 'crafting_table' && L.isOk(result)) { setHome(bot.entity.position); bot.chat(`home set here (${home})`) }
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
      collectN = obs.collectN
      // reflexes (code, no LLM): survive first. The LLM decides everything else.
      const reflex = bot.entity.isInWater && bot.oxygenLevel < 12 ? 'surface up'
        : obs.threat && (bot.health <= 8 || obs.threat[0] === 'creeper') ? `flee ${obs.threat[0]}`
        : bot.health <= 10 && bot.food < 20 && obs.foods.length && !obs.threat ? `eat ${obs.foods[0]}`
        : obs.night && obs.sheltered && !obs.threat ? 'wait 5'
        : null
      if (reflex) {
        const res = await act(reflex, 'reflex', { obs: obs.state, hint: obs.hint })
        console.log(`[reflex] ${reflex.padEnd(28)} | ${res} | hp ${Math.round(bot.health)} food ${bot.food}`)
        continue
      }
      // B5: the current task goes on without the LLM while its plan step holds (collect/mine repeats)
      const cont = C.next(obs)
      if (cont.action) {
        const t1 = performance.now()
        const res = await act(cont.action, 'task', { obs: obs.state, obs_text: obs.text, options: obs.options, hint: obs.hint,
          task: { id: cont.task.id, run: cont.task.runs + 1 } })
        console.log(`   task#${cont.task.id} run ${cont.task.runs} | ${cont.action.padEnd(28)} | ${((performance.now() - t1) / 1000).toFixed(1)}s ${res} | hp ${Math.round(bot.health)} food ${bot.food}`)
        continue
      }
      if (cont.task) L.event('task_end', { id: cont.task.id, action: cont.task.action, runs: cont.task.runs, why: cont.why })
      fs.writeFileSync(__dirname + `/last_obs${bot.username === 'LFM' ? '' : '_' + bot.username}.txt`, obs.text + '\n\n' + obs.grammar + '\n')
      const { ms, text } = await decide(obs)
      const t0 = performance.now()
      const task = C.start(text, 'llm', obs)
      const res = await act(text, 'llm', { llm_ms: Math.round(ms), obs: obs.state, obs_text: obs.text, options: obs.options,
        grammar: obs.grammar, hint: obs.hint, banned: obs.banned, followed_hint: hintIsAction(obs) ? obs.hint === text : null,
        task: { id: task.id, run: 1, after: cont.why } })
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
