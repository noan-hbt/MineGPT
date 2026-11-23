// H3 scripted live runs: every DSL family on the real server, in an arena built by RCON at (3000,100,3000)
// (stone floor y=99 over a stone block down to y=85, cleared above). Each case = RCON setup + one statement (or a
// turn) + checks on its result event. Logs data/own/<date>/<session>_live.jsonl (states + events, checked by
// spec/tools/validate.py).
//   node test/live.js [--only name1,name2] [--name LFM] [--lock] [--sim N]
// --lock: H4 MineSim lockstep, the frozen server is stepped by the bot (bot/sim/lockstep.js), as fast as possible.
// Needs the local server (start-mc.ps1) with RCON. Restores the gamerules it changes.
'use strict'
const LOCK = process.argv.includes('--lock')
const clock = LOCK ? require('../sim/clock').installManual() : null // before mineflayer
const fs = require('fs')
const path = require('path')
const mineflayer = require('mineflayer')
const { pathfinder, Movements } = require('mineflayer-pathfinder')
const { Senses } = require('../state')
const { render } = require('../render')
const { Interpreter } = require('../dsl/run')
const { Turns } = require('../turns')
const rcon = require('../rcon')
const C = require('../skills/common')

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d }
const NAME = arg('name', 'LFM')
const ONLY = arg('only', null) ? new Set(arg('only').split(',')) : null
// --sim N: run on MineSim instance N (bot/sim/instance.js, started if down) instead of the main server
const SIM = arg('sim', null)
let SRV = { host: '127.0.0.1', port: 25565, rcon: {} }
const rconConnect = () => rcon.connect(SRV.rcon)
const X = 3000, Y = 200, Z = 3000
const at = (dx, dy, dz) => `${X + dx} ${Y + dy} ${Z + dz}`
const P = (dx, dy, dz) => `(${X + dx},${Y + dy},${Z + dz})`

// ---------------------------------------------------------------- checks
const want = (status, cause) => ev => ev.status !== status ? `status ${ev.status} (want ${status})` : cause && ev.cause !== cause ? `cause ${ev.cause} (want ${cause})` : null
const gained = (item, min = 1, max = Infinity) => ev => { const g = (ev.gained || {})[item] || 0; return g < min || g > max ? `gained ${item} ${g} (want ${min}..${max})` : null }
const detail = re => ev => re.test(ev.detail || '') ? null : `detail "${ev.detail}" !~ ${re}`
const all = (...fs) => (ev, h) => { for (const f of fs) { const e = f(ev, h); if (e) return e } return null }
const y = v => (ev, h) => Math.floor(h.bot.entity.position.y) === v ? null : `y=${Math.floor(h.bot.entity.position.y)} (want ${v})`

// ---------------------------------------------------------------- cases
// reset: clear inventory, kill drops + test mobs, tp to the center facing south. keep: no reset.
const CASES = [
  { name: 'goto_pos', act: `goto ${P(8, 0, 0)}`, check: want('ok') },
  { name: 'name_place', act: `name_place spot at=${P(-5, 0, -5)}`, check: want('ok'), keep: true },
  { name: 'goto_place', act: 'goto @spot', check: all(want('ok'), detail(/@spot/)) },
  { name: 'goto_no_path', act: `goto ${P(0, 40, 0)}`, check: want('failed', 'no_path') },
  { name: 'goto_unknown_place', act: 'goto @nowhere', check: all(want('failed', 'no_target_known'), detail(/known: @spot/)) },
  { name: 'mine_stone', setup: ['give LFM stone_pickaxe'], act: 'mine stone n=2', expect: 'have(cobblestone)>=+2 in 30s', check: all(want('ok'), gained('cobblestone', 2, 3)) },
  { name: 'mine_missing_tool', setup: [`setblock ${at(3, 0, 0)} iron_ore`], act: 'mine iron_ore', check: want('failed', 'missing_tool') },
  { name: 'mine_tool_too_weak', setup: [`setblock ${at(3, 0, 0)} iron_ore`, 'give LFM wooden_pickaxe'], act: 'mine iron_ore', check: all(want('failed', 'tool_too_weak'), detail(/stone_pickaxe/)) },
  { name: 'mine_ore_ok', setup: [`setblock ${at(3, 0, 0)} iron_ore`, 'give LFM stone_pickaxe'], act: 'mine iron_ore', check: all(want('ok'), gained('raw_iron')) },
  { name: 'mine_unknown', act: 'mine diamond_ore', check: want('failed', 'no_target_known') },
  { name: 'chop', setup: [`setblock ${at(-6, -1, 6)} grass_block`, `place feature minecraft:oak ${at(-6, 0, 6)}`], act: 'chop n=1', expect: 'have(tag:logs)>=+3 in 60s', check: all(want('ok'), gained('oak_log', 3)) },
  { name: 'craft_planks', setup: ['give LFM oak_log 4'], act: 'craft oak_planks n=8', check: all(want('ok'), gained('oak_planks', 8, 8)) },
  { name: 'craft_sticks', act: 'craft stick n=4', check: all(want('ok'), gained('stick', 4, 4)), keep: true },
  { name: 'craft_no_table', act: 'craft wooden_pickaxe', check: want('failed', 'no_target_known'), keep: true },
  { name: 'craft_table', act: 'craft crafting_table', check: gained('crafting_table', 1, 1), keep: true, setup: ['give LFM oak_planks 4'] },
  { name: 'place_table', act: `place crafting_table at=${P(2, 0, 2)}`, check: want('ok'), keep: true },
  { name: 'craft_with_table', act: 'craft wooden_pickaxe', check: all(want('ok'), gained('wooden_pickaxe', 1, 1)), keep: true },
  { name: 'craft_missing', act: 'craft iron_pickaxe', check: all(want('failed', 'missing_items'), detail(/iron_ingot x3/)), keep: true },
  { name: 'smelt', setup: [`setblock ${at(-2, 0, 2)} furnace`, 'give LFM raw_iron 2', 'give LFM coal 1'], act: 'smelt raw_iron n=2', expect: 'have(iron_ingot)>=+2 in 40s', check: all(want('ok'), gained('iron_ingot', 2, 2)) },
  { name: 'smelt_no_fuel', setup: [`setblock ${at(-2, 0, 2)} furnace`, 'give LFM raw_iron 1'], act: 'smelt raw_iron', check: want('failed', 'missing_items') },
  { name: 'place_list', setup: ['give LFM cobblestone 8', 'give LFM stone_pickaxe'], act: `place cobblestone at=[${P(4, 0, -4)},${P(5, 0, -4)},${P(6, 0, -4)},${P(5, 1, -4)}]`, check: all(want('ok'), detail(/4 placed/)) },
  { name: 'break_one', act: `break at=${P(4, 0, -4)}`, check: all(want('ok'), gained('cobblestone', 1, 1)), keep: true },
  { name: 'dig_box', act: `dig (${P(5, 0, -4)},${P(6, 1, -4)})`, check: all(want('ok'), gained('cobblestone', 3, 3)), keep: true },
  { name: 'use_door', setup: [`setblock ${at(-4, 0, -2)} oak_door[half=lower,facing=east]`, `setblock ${at(-4, 1, -2)} oak_door[half=upper,facing=east]`], act: `use on=${P(-4, 0, -2)}`, check: all(want('ok'), detail(/open=true/)) },
  { name: 'eat_full', setup: ['give LFM bread 2'], act: 'eat', check: want('failed', 'server_refused') },
  { name: 'eat_hungry', setup: ['effect give LFM hunger 4 250'], pre: 4500, act: 'eat bread', check: all(want('ok'), detail(/food \d+ -> \d+/)), keep: true },
  { name: 'fight_pig', setup: [`summon pig ${at(4, 0, 4)} {NoAI:1b}`, 'give LFM iron_sword'], pre: 800, turn: 'act: seq[equip iron_sword; fight #pig]\nexpect: have(porkchop)>=+1 in 20s', check: all(want('ok'), gained('porkchop')) },
  { name: 'shoot_pig', setup: [`summon pig ${at(0, 0, 8)} {NoAI:1b}`, 'give LFM bow', 'give LFM arrow 8'], pre: 800, act: 'shoot #pig n=2', check: want('ok') },
  { name: 'flee_zombie', setup: [`summon zombie ${at(3, 0, 0)} {NoAI:1b,PersistenceRequired:1b}`], pre: 800, act: 'flee #zombie dist=10', check: want('ok') },
  { name: 'until', act: 'wait 20s until(have(diamond)>=1)', during: [1500, 'give LFM diamond'], check: all(want('ok', 'interrupted_until'), (ev) => ev.dur_s < 5 ? null : `dur ${ev.dur_s}`) },
  { name: 'timeout', act: 'wait 10s timeout=1s', check: want('failed', 'timeout') },
  { name: 'interrupt', act: 'wait 30s', during: [1000, h => h.interp.start('stop')], check: want('interrupted', 'interrupted_by_model') },
  { name: 'adjust', setup: ['give LFM stone_pickaxe'], act: 'mine stone n=10', during: [300, h => h.interp.adjust({ set: { n: 1 } })], check: all(want('ok'), gained('cobblestone', 1, 2)) },
  { name: 'expect_surprise', turn: 'act: wait 1s\nexpect: have(diamond)>=+1 in 3s', check: (ev, h) => h.events.some(e => e.kind === 'surprise' && /have\(diamond\)/.test(e.unmet[0].cond)) ? null : 'no surprise event' },
  { name: 'invalid_turn', turn: 'act: mine oak_plank', check: (ev, h) => h.events.some(e => e.kind === 'invalid_output') ? null : 'no invalid_output event', noResult: true },
  { name: 'routine', setup: ['give LFM oak_log 1'], turn: 'act: save_routine sticks seq[craft oak_planks n=4; craft stick n=4]', then: 'routine sticks', check: all(want('ok'), gained('stick', 4, 4)) },
  { name: 'if_else', act: 'if(have(diamond)>=1) say "rich" else wait 1s', check: all(want('ok')) },
  { name: 'repeat', setup: ['give LFM oak_log 2'], act: 'repeat(2) craft oak_planks n=4', check: gained('oak_planks', 8, 8) },
  { name: 'store', setup: [`setblock ${at(2, 0, -2)} chest`, 'give LFM cobblestone 10'], act: `store chest=${P(2, 0, -2)} filter=cobblestone`, check: all(want('ok'), (ev, h) => h.senses.chests.size ? null : 'chest not remembered') },
  { name: 'take', act: `take cobblestone n=3 chest=${P(2, 0, -2)}`, check: all(want('ok'), gained('cobblestone', 3, 3)), keep: true },
  { name: 'drop_collect', setup: ['give LFM cobblestone 2'], act: 'seq[drop cobblestone n=2; wait 1s; collect cobblestone]', check: all(want('ok')) },
  { name: 'pillar', setup: ['give LFM dirt 5'], act: 'pillar 3 block=dirt', check: all(want('ok'), y(Y + 3)) },
  { name: 'descend', setup: ['give LFM stone_pickaxe'], act: `descend to_y=${Y - 5}`, check: all(want('ok'), y(Y - 5)) },
  { name: 'strip_mine', act: 'strip_mine east len=4', check: want('ok'), keep: true },
  { name: 'ascend', setup: ['give LFM dirt 32'], act: 'ascend', check: all(want('ok')), keep: true },
  { name: 'bridge', setup: ['give LFM cobblestone 8', `tp LFM ${X + 15} ${Y} ${Z} -90 0`], act: 'bridge east 3 block=cobblestone', check: all(want('ok'), (ev, h) => Math.floor(h.bot.entity.position.x) === X + 18 ? null : `x=${Math.floor(h.bot.entity.position.x)}`) },
  { name: 'explore', act: 'explore dir=north radius=10', check: want('ok') },
  { name: 'wander', act: 'wander radius=6', check: want('ok') },
  { name: 'look', setup: [`summon cow ${at(0, 0, 5)} {NoAI:1b}`], pre: 800, act: 'look #cow', check: want('ok') },
  { name: 'harvest', setup: [`setblock ${at(-3, -1, -6)} farmland`, `setblock ${at(-3, 0, -6)} wheat[age=7]`], act: 'harvest wheat n=1', check: all(want('ok'), gained('wheat', 1, 1)) },
  { name: 'bonemeal', setup: [`setblock ${at(-4, -1, -6)} farmland`, `setblock ${at(-4, 0, -6)} wheat[age=0]`, 'give LFM bone_meal 4'], act: `bonemeal ${P(-4, 0, -6)}`, check: all(want('ok'), detail(/age 0 -> [1-7]/)) },
  { name: 'plant', setup: [`setblock ${at(-5, -1, -6)} farmland`, `setblock ${at(-5, 0, -6)} air`, 'give LFM wheat_seeds 2'], act: `plant wheat_seeds at=${P(-5, -1, -6)}`, check: want('ok') },
  { name: 'shear', setup: [`summon sheep ${at(3, 0, 3)} {NoAI:1b}`, 'give LFM shears'], pre: 800, act: 'shear sheep', check: all(want('ok'), (ev) => Object.keys(ev.gained || {}).some(k => k.endsWith('_wool')) ? null : 'no wool') },
  { name: 'milk', setup: [`summon cow ${at(-3, 0, 3)} {NoAI:1b}`, 'give LFM bucket'], pre: 800, act: 'milk cow', check: gained('milk_bucket', 1, 1) },
  { name: 'breed', setup: [`summon cow ${at(-3, 0, 4)} {NoAI:1b}`, `summon cow ${at(-4, 0, 4)} {NoAI:1b}`, 'give LFM wheat 2'], pre: 800, act: 'breed cow', check: want('ok') },
  { name: 'equip_best', setup: ['give LFM leather_helmet', 'give LFM iron_helmet', 'give LFM diamond_sword', 'give LFM stone_sword'], act: 'equip_best', check: (ev, h) => h.bot.inventory.slots[5] && h.bot.inventory.slots[5].name === 'iron_helmet' && h.bot.heldItem && h.bot.heldItem.name === 'diamond_sword' ? null : 'wrong gear' },
  { name: 'sleep', setup: [`setblock ${at(-8, 0, 0)} red_bed[part=foot,facing=west]`, `setblock ${at(-9, 0, 0)} red_bed[part=head,facing=west]`, 'time set 18000'], act: 'sleep', check: want('ok'), after: ['time set 1000'] },
  { name: 'enchant', setup: [`setblock ${at(6, 0, 6)} enchanting_table`, 'give LFM lapis_lazuli 3', 'give LFM iron_pickaxe', 'xp add LFM 30 levels'], act: 'enchant iron_pickaxe level=1', check: want('ok') },
  { name: 'repair', setup: [`setblock ${at(-6, 0, -2)} anvil`, 'give LFM iron_pickaxe[damage=200] 2', 'xp add LFM 30 levels'], act: 'repair iron_pickaxe', check: want('ok') },
  { name: 'say_note_forget', turn: 'act: say "H3 live test"\nnote: arena at 3000 200 3000', then: 'forget spot', check: want('ok') },
  { name: 'obey_no_order', act: 'obey', check: want('failed', 'no_target_known') },
  { name: 'avoid', act: 'avoid zombie radius=6', check: want('ok'), after: [] },
  { name: 'tools', setup: ['give LFM oak_log 3', 'give LFM stone_pickaxe'], turn: 'tool: recipe iron_pickaxe\ntool: where stone n=2\ntool: loot iron_ore\ntool: simulate craft iron_pickaxe', noResult: true,
    check: (ev, h) => { const a = h.answers || []; if (a.length !== 4) return `${a.length} answers`; if (!/iron_ingot x3/.test(a[0])) return a[0]; if (!/stone \(/.test(a[1])) return a[1]; if (!/stone_pickaxe/.test(a[2])) return a[2]; if (!/missing iron_ingot/.test(a[3])) return a[3]; return null } },
  { name: 'tools2', keep: true, pre_act: `name_place spot2 at=${P(-5, 0, -5)}`, turn: 'tool: inv\ntool: mob_info zombie\ntool: path_cost @spot2\ntool: recall arena', noResult: true,
    check: (ev, h) => { const a = h.answers || []; if (!/oak_log x3/.test(a[0])) return a[0]; if (!/rotten_flesh/.test(a[1])) return a[1]; if (!/path found/.test(a[2])) return a[2]; if (!/arena/.test(a[3])) return a[3]; return null } },
]

// ---------------------------------------------------------------- runner
async function main() {
  if (SIM != null) {
    const s = await require('../sim/instance').start(+SIM)
    SRV = { host: s.host, port: s.port, rcon: { port: s.rconPort, password: s.password } }
    console.log(`MineSim instance ${SIM}: port ${s.port}`)
  }
  const r = await rconConnect()
  const lock = LOCK ? new (require('../sim/lockstep').Lockstep)(clock, r) : null
  const real0 = LOCK ? clock.realNow() : Date.now()
  const cmd = async c => { const out = await r.cmd(c); if (/Unknown|Incorrect|Invalid|Expected|No entity|No player|Could not/i.test(out)) console.log(`  rcon "${c}": ${out}`); return out }
  const restore = [`gamerule spawn_monsters ${(await r.cmd('gamerule spawn_monsters')).match(/(true|false)/)[1]}`]
  await cmd('gamerule spawn_monsters false')

  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16)
  const session = `${stamp}_${NAME}_live`
  const DATA = path.resolve(__dirname, '..', '..', 'data', 'own')
  const dir = path.join(DATA, session.slice(0, 10))
  fs.mkdirSync(dir, { recursive: true })
  const logFile = path.join(dir, session + '.jsonl')
  const log = fs.createWriteStream(logFile)
  const write = o => log.write(JSON.stringify(o) + '\n')

  const bot = mineflayer.createBot({ host: SRV.host, port: SRV.port, username: NAME, version: '1.21.11', ...(LOCK ? { checkTimeoutInterval: 30000 * 1000 } : {}) })
  bot.loadPlugin(pathfinder)
  await new Promise((res, rej) => { bot.once('spawn', res); bot.once('kicked', rej); bot.once('error', rej) })
  const mv = C.makeMovements(bot)
  bot.pathfinder.setMovements(mv); bot.pathfinder.thinkTimeout = 5000
  await cmd(`gamemode survival ${NAME}`)
  await cmd(`tp ${NAME} ${at(0, 0, 0)}`)
  await C.sleep(3000)
  await bot.waitForChunksToLoad() // a fresh sim world still generates the arena chunks after the tp
  if (LOCK) await lock.start()
  // arena
  await cmd(`fill ${X - 15} ${Y - 15} ${Z - 15} ${X + 15} ${Y - 1} ${Z + 15} stone`)
  await cmd(`fill ${X - 15} ${Y} ${Z - 15} ${X + 15} ${Y + 12} ${Z + 15} air`)
  await cmd(`fill ${X + 16} ${Y - 15} ${Z - 15} ${X + 22} ${Y + 12} ${Z + 15} air`)
  await C.sleep(1500)
  const wet = bot.findBlocks({ matching: b => b.name === 'water' || b.name === 'lava', maxDistance: 20, count: 50 }).filter(p => p.y >= Y)
  if (wet.length) console.log('arena: liquid above the floor at', wet.slice(0, 5).map(p => `${p}`).join(' '))
  const senses = new Senses(bot, { session, dataDir: path.join(dir, session + '_mem') }) // throwaway memory, not the bot's real one
  const interp = new Interpreter(bot, senses, { log: write })
  const turns = new Turns({ bot, senses, interp })
  write({ type: 'session', session, bot: NAME, live_test: true, start: new Date().toISOString() })

  const reset = async () => {
    interp.avoid.clear(); mv.entitiesToAvoid.clear()
    await cmd(`clear ${NAME}`); await cmd(`effect clear ${NAME}`); await cmd(`effect give ${NAME} saturation 1 20 true`); await cmd(`xp set ${NAME} 0 levels`)
    await cmd(`kill @e[type=!player,x=${X},y=${Y},z=${Z},distance=..40]`)
    await cmd(`tp ${NAME} ${at(0, 0, 0)} 0 0`)
    await cmd(`fill ${X - 15} ${Y} ${Z - 15} ${X + 15} ${Y + 12} ${Z + 15} air`)
    await cmd(`fill ${X - 15} ${Y - 15} ${Z - 15} ${X + 15} ${Y - 1} ${Z + 15} stone replace air`)
    await C.sleep(600)
  }

  const results = []
  for (const c of CASES) {
    if (ONLY && !ONLY.has(c.name)) continue
    if (!c.keep || ONLY) await reset()
    for (const s of c.setup || []) await cmd(s)
    await C.sleep(c.pre || 500)
    if (c.pre_act) await interp.start(c.pre_act) // setup done through the bot itself (e.g. memory)
    senses.build({ call: 'decision' }) // drain setup events
    const h = { bot, senses, interp, events: [], answers: null }
    const t0 = Date.now()
    let ev = null, err = null
    try {
      const timer = c.during ? setTimeout(() => typeof c.during[1] === 'function' ? c.during[1](h) : cmd(c.during[1]), c.during[0]) : null
      if (c.turn) {
        const out = await turns.apply(c.turn, 'decision')
        h.answers = out.answers || null
        if (out.done) ev = await out.done
      } else ev = await interp.start(c.act, { expect: c.expect || null })
      if (c.then) ev = await interp.start(c.then)
      clearTimeout(timer)
      await C.sleep(c.expect || /expect/.test(c.turn || '') ? 300 : 100)
      const st = senses.build({ call: 'decision', running: interp.running(), expect: interp.expectInfo() })
      h.events = st.events
      render(st) // must not throw
      write({ type: 'call', call_id: results.length + 1, kind: 'decision', model: null, state: st, sheet_version: 'live-test', output: c.turn || c.act })
      if (!ev && !c.noResult) err = 'no result event'
      else err = c.check(ev || {}, h)
    } catch (e) { err = 'exception: ' + e.stack }
    for (const s of c.after || []) await cmd(s)
    const pass = !err
    results.push({ name: c.name, pass })
    write({ type: 'case', name: c.name, pass, err, result: ev, ms: Date.now() - t0 })
    console.log(`${pass ? 'PASS' : 'FAIL'} ${c.name.padEnd(18)} ${ev ? `${ev.status}${ev.cause ? ' ' + ev.cause : ''} ${ev.dur_s}s | ${(ev.detail || '').slice(0, 90)}` : (h.answers || []).join(' || ').slice(0, 120)}${err ? '\n     -> ' + err : ''}`)
    if (!bot.entity || bot.health <= 0) { await C.sleep(1500); await cmd(`tp ${NAME} ${at(0, 0, 0)}`) }
  }
  for (const s of restore) await cmd(s)
  await reset()
  const npass = results.filter(x => x.pass).length
  write({ type: 'end', pass: npass, total: results.length })
  const realS = ((LOCK ? clock.realNow() : Date.now()) - real0) / 1000
  console.log(`\n${npass}/${results.length} passed; log ${logFile}; real ${realS.toFixed(1)} s${LOCK ? `, ${lock.ticks} ticks stepped (${(lock.ticks / realS).toFixed(0)} tps)` : ''}`)
  if (LOCK) await lock.stop()
  interp.close(); r.close()
  log.end(() => { bot.quit(); (LOCK ? clock.realSetTimeout : setTimeout)(() => process.exit(npass === results.length ? 0 : 1), 500) })
}

main().catch(e => {
  console.error(e)
  if (!LOCK) process.exit(2)
  rconConnect().then(async r => { await r.cmd('tick rate 20'); await r.cmd('tick unfreeze') }).finally(() => process.exit(2))
})
