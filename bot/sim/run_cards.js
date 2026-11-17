// H4 scenario-card runner (notes/scenario-cards.md). Runs cards x seeds on a MineSim instance with a policy:
//   node sim/run_cards.js [--sim 0] [--lock] [--only id1,id2|area.] [--seeds 1,2] [--policy script|mind] [--name LFM]
//     mind: [--llm http://127.0.0.1:8080] [--max-tokens 1024] [--model id] [--key-env OPENAI_API_KEY (remote API)]
//       [--codex low|medium (Codex CLI as the model, --model optional)] (llama-server running; DBG_MIND=1 prints each turn)
// policy script = the card's reference solution (validates that the card is solvable and the judge agrees).
// One `episode` record per run in data/own/<day>/<stamp>_<name>_cards.jsonl (+ the usual call/result records).
'use strict'
const LOCK = process.argv.includes('--lock')
const clock = LOCK ? require('./clock').installManual() : null // before mineflayer
if (LOCK) require('./clock').patchPathfinder(clock)
const fs = require('fs')
const path = require('path')
const mineflayer = require('mineflayer')
const { pathfinder, Movements } = require('mineflayer-pathfinder')
const { Senses } = require('../state')
const { Memory } = require('../state/memory')
const { MentalMap } = require('../state/map')
const { Ledger } = require('../state/ledger')
const { Interpreter } = require('../dsl/run')
const { Turns } = require('../turns')
const rcon = require('../rcon')
const C = require('../skills/common')
const K = require('./cards')

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d }
const NAME = arg('name', 'LFM')
const SIM = +arg('sim', 0)
const POLICY = arg('policy', 'script')
const ONLY = arg('only', null)
const SEEDS = arg('seeds', null) ? arg('seeds').split(',').map(Number) : null
const ORIGIN = { x: 3000, y: 200, z: 3000 }
const JUDGE_EVERY = 20 // ticks

async function main() {
  const files = K.list().filter(f => !ONLY || ONLY.split(',').some(o => path.basename(f, '.json') === o || K.load(f).id === o || K.load(f).id.startsWith(o)))
  const cards = files.map(K.load)
  if (!cards.length) throw new Error('no card matches')
  const s = await require('./instance').start(SIM)
  console.log(`MineSim ${SIM} port ${s.port}; ${cards.length} card(s), policy ${POLICY}${LOCK ? ', lockstep' : ''}`)
  const r = await rcon.connect({ port: s.rconPort, password: s.password })
  const lock = LOCK ? new (require('./lockstep').Lockstep)(clock, r) : null
  const real = () => LOCK ? clock.realNow() : Date.now()
  const real0 = real()
  const cmd = async c => {
    const out = await r.cmd(c)
    if (/Unknown|Incorrect|Invalid|Expected|No player|Could not|Unable|not a valid|Too many|Malformed|Failed/i.test(out)) console.log(`  rcon "${c.slice(0, 140)}": ${out}`)
    return out
  }
  const gametime = async () => +(await r.cmd('time query gametime')).match(/(\d+)/)[1]

  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16)
  const session = `${stamp}_${NAME}_cards`
  const dir = path.resolve(__dirname, '..', '..', 'data', 'own', session.slice(0, 10))
  fs.mkdirSync(dir, { recursive: true })
  const logFile = path.join(dir, session + '.jsonl')
  const log = fs.createWriteStream(logFile)
  const write = o => log.write(JSON.stringify(o) + '\n')
  write({ type: 'session', session, bot: NAME, cards: true, policy: POLICY, lockstep: LOCK, start: new Date().toISOString() })

  // the bot and everything bound to it; rebuilt if the bot gets disconnected (the runner then goes on with the
  // next episode instead of failing every later one with "No player was found")
  let bot, mv, senses, interp, turns, lost = null
  // server death messages ("LFM was slain by Zombie"), kept per episode for the record
  let deathMsgs = []
  // what the bot says in chat this episode, for `said` checks (the server echoes the bot's own messages)
  let said = []
  const connect = async () => {
    bot = mineflayer.createBot({ host: s.host, port: s.port, username: NAME, version: '1.21.11', ...(LOCK ? { checkTimeoutInterval: 30000 * 1000 } : {}) })
    bot.loadPlugin(pathfinder)
    await new Promise((res, rej) => { bot.once('spawn', res); bot.once('kicked', rej); bot.once('error', rej) })
    lost = null
    const me = bot
    me.on('end', reason => { if (bot === me) lost = lost || `disconnected (${reason})` })
    me.on('kicked', reason => { if (bot === me) lost = `kicked: ${typeof reason === 'string' ? reason : reason && reason.value != null ? reason.value : JSON.stringify(reason)}` })
    me.on('error', e => { if (bot === me) lost = lost || `error: ${e.message}` })
    if (process.env.DBG_HP) { let h = 20; bot.on('health', () => { if (bot.health !== h) console.log(`  HP ${h} -> ${bot.health} at ${bot.entity.position} fire=${bot.entity.onFire}`); h = bot.health }); bot.on('entityHurt', e => { if (e === bot.entity) console.log('  HURT', bot.entity.position.toString()) }) }
    mv = C.makeMovements(bot)
    bot.pathfinder.setMovements(mv); bot.pathfinder.thinkTimeout = 5000
    await cmd(`op ${NAME}`) // not needed by the bot; keeps `tick` etc. usable from a client if debugging
    await cmd(`tp ${NAME} ${ORIGIN.x} ${ORIGIN.y} ${ORIGIN.z}`)
    await C.sleep(3000)
    await bot.waitForChunksToLoad()
    bot.on('chat', (user, msg) => { if (user === NAME) said.push(msg) })
    bot.on('messagestr', (msg, pos) => { if (pos !== 'chat' && msg.startsWith(NAME + ' ') && !msg.includes('<')) deathMsgs.push(msg) })
    senses = new Senses(bot, { session, dataDir: path.join(dir, session + '_mem') })
    interp = new Interpreter(bot, senses, { log: write })
    turns = new Turns({ bot, senses, interp })
  }
  const reconnect = async why => {
    console.log(`  bot lost (${why}): reconnecting`)
    write({ type: 'reconnect', why })
    try { interp.close() } catch {}
    try { bot.removeAllListeners(); bot.quit() } catch {}
    if (LOCK) await lock.pause()
    await C.sleep(2000)
    await connect()
    if (LOCK) await lock.start()
  }
  // the server's view: is the bot still a connected player?
  const online = async () => (await r.cmd('list')).split(':').slice(1).join(':').split(',').map(x => x.trim()).includes(NAME)
  await connect()
  if (LOCK) await lock.start()
  const mind = POLICY === 'mind' ? new (require('./mind').Mind)({ url: arg('llm', 'http://127.0.0.1:8080'), maxTokens: +arg('max-tokens', 1024),
    model: arg('model', null), key: arg('key-env', null) ? process.env[arg('key-env')] : null, codex: arg('codex', null),
    hold: LOCK ? fn => lock.hold(fn) : fn => fn(), setT: LOCK ? clock.realSetTimeout : setTimeout, write }) : null

  // a fresh mind per episode (throwaway memory): same Senses listeners, new stores
  const freshMind = ep => {
    const mem = path.join(dir, session + '_mem', `${ep.id}_${ep.seed}`)
    senses.memory = new Memory(`${mem}/memory/${NAME}.json`, senses.t0)
    senses.map = new MentalMap(`${mem}/memory/${NAME}.map.json`, senses.t0)
    senses.ledger = new Ledger(); senses.chests = new Map(); senses.pending = []; senses.seen = new Set(); senses.near = new Map()
    senses.prevCounts = null; senses.prevHp = null; senses.hurtBy = null
    interp.avoid.clear(); mv.entitiesToAvoid.clear()
  }

  const results = []
  for (const card of cards) {
    const queue = [...(SEEDS || card.seeds || [1])], retried = new Set()
    while (queue.length) {
      const seed = queue.shift()
      if (lost || !(await online())) await reconnect(lost || 'not in the player list')
      const ep = K.expand(card, seed, ORIGIN)
      const plan = K.compile(ep, NAME)
      const judge = new K.Judge(r, ep, NAME, plan)
      const inDim = c => `execute in ${plan.dim} run ${c}`
      interp.stop('episode')
      // ---- setup
      for (const c of plan.reset) await cmd(c)
      await C.sleep(150) // a few ticks in the holding cell's water: any fire is out
      for (const c of plan.world) await cmd(/^(fill|setblock|place|summon)/.test(c) ? inDim(c) : c)
      for (const c of plan.build) await cmd(/^(fill|setblock|place|summon|item replace block)/.test(c) ? inDim(c) : c)
      for (const c of plan.player) await cmd(c)
      bot.setQuickBarSlot(plan.held)
      await drainFood(plan.food, cmd, judge)
      await C.sleep(500)
      freshMind(ep)
      for (const st of plan.mind.dsl) await interp.start(st)
      if (plan.mind.notes.length) await turns.apply(plan.mind.notes.map(n => `note: ${n}`).join('\n'), 'decision')
      senses.build({ call: 'decision' }) // drain setup events
      for (const c of plan.scores) await cmd(c)
      // ---- episode
      deathMsgs = []
      said = judge.chat = []
      const t0 = await gametime(), realStart = real()
      const tick = async () => (await gametime()) - t0
      const fired = new Set(), reached = {}
      let outcome = null, decisions = 0, err = null
      const fire = async (e, i) => {
        fired.add(i)
        if (e.chat) { senses.push({ kind: 'chat', from: e.chat.from, text: ep.text(e.chat.text) }); write({ type: 'card_event', at: await tick(), chat: e.chat }) }
        if (e.rcon) await cmd(inDim(ep.rcon(e.rcon)))
        if (e.summon) for (const c of K.compile({ ...ep, build: [], entities: [e.summon] }, NAME).build) await cmd(inDim(c))
      }
      const step = async () => { // timeline + judge; returns an outcome or null
        const t = await tick()
        if (ep.order && !fired.has('order') && t >= (ep.order.at_tick || 0)) { fired.add('order'); senses.push({ kind: 'chat', from: ep.order.from || 'Noan', text: ep.text(ep.order.text) }) }
        for (const [i, e] of ep.timeline.entries()) {
          if (fired.has(i) && e.once !== false) continue
          if (e.at_tick != null ? t >= e.at_tick : await judge.eval(e.when)) await fire(e, i)
        }
        for (const m of ep.milestones) if (!(m.name in reached) && await judge.eval(m.check)) reached[m.name] = t
        if (await judge.eval(ep.fail)) return 'fail'
        const end = ep.success_when === 'end' // survival cards: success is judged only when the time is up
        if (!end && await judge.eval(ep.success)) return 'success'
        if (t >= ep.limits.ticks || (ep.limits.decisions != null && decisions >= ep.limits.decisions)) {
          return end ? (await judge.eval(ep.success) ? 'success' : 'fail') : 'timeout'
        }
        return null
      }
      let stop = false
      const watcher = (async () => {
        while (!stop && !outcome) {
          if (lost) { outcome = 'error'; err = err || `bot ${lost}`; interp.stop('episode_end'); break }
          const o = await step()
          if (o && !outcome) { outcome = o; interp.stop('episode_end') }
          if (!outcome) await C.sleep(JUDGE_EVERY * 50)
        }
      })()
      try {
        if (POLICY === 'script') {
          for (const st of ep.solution) {
            if (outcome) break
            decisions++
            const ev = await interp.start(ep.text(st))
            // the bot's inventory model vs the server's truth, for every item the judge counts
            const desync = {}
            for (const it of haveItems(ep)) {
              const mine = botCount(bot, it), server = await judge.value({ have: it })
              if (mine !== server) desync[it] = { bot: mine, server }
            }
            if (Object.keys(desync).length) console.log(`  desync after "${ep.text(st)}": ${JSON.stringify(desync)}`)
            write({ type: 'card_step', id: ep.id, seed, stmt: ep.text(st), result: ev, desync })
          }
          // end-judged cards: the script is done but the episode runs to its time limit (the watcher ends it)
          if (ep.success_when === 'end') while (!outcome) await C.sleep(JUDGE_EVERY * 50)
          if (!outcome) { const o = await step(); outcome = outcome || o } // final judgement after the last statement
          // the script finished: give the world 2 s (drops, smelting...) then judge once more
          if (!outcome) { await C.sleep(2000); const o = await step(); outcome = outcome || o || 'fail' }
        } else if (POLICY === 'mind') {
          { const o = await step(); outcome = outcome || o } // deliver the order before the first decision
          while (!outcome) {
            decisions++
            const { r: tr, done } = await mind.decide({ senses, interp, turns, bot, ep })
            const ev = done ? await done : null
            write({ type: 'card_step', id: ep.id, seed, policy: 'mind', stmt: ev ? ev.stmt : null, result: ev })
            if (process.env.DBG_MIND && ev) console.log(`  -> ${ev.status}${ev.cause ? ' ' + ev.cause : ''} | ${ev.stmt} | ${(ev.detail || '').slice(0, 160)}`)
            if (!ev && !outcome) await C.sleep(500)
            if (decisions >= (ep.limits.decisions ?? Infinity) && !outcome) { const o = await step(); outcome = outcome || o || 'timeout' }
          }
        } else throw new Error(`unknown policy ${POLICY} (script | mind)`)
      } catch (e) { err = e.stack; outcome = 'error' }
      stop = true; await watcher
      const ticks = await tick()
      const rec = { type: 'episode', id: ep.id, seed, params: ep.params, policy: POLICY, outcome, ticks, solution_ticks: ep.solution_ticks,
        real_s: +((real() - realStart) / 1000).toFixed(1), decisions, milestones: reached,
        died: await judge.value({ died: true }), death_msgs: deathMsgs, damage: await judge.value({ damage_taken: {} }),
        judge: await judge.explain(ep.success), err }
      write(rec)
      // an episode cut by a lost bot says nothing about the policy: run it again once (after the reconnect)
      if (lost && !retried.has(seed)) { retried.add(seed); queue.unshift(seed); console.log(`  ${ep.id}#${seed}: bot lost (${lost}), episode will be rerun`); continue }
      results.push(rec)
      console.log(`${outcome === 'success' ? 'PASS' : 'FAIL'} ${`${ep.id}#${seed}`.padEnd(34)} ${outcome.padEnd(7)} ${String(ticks).padStart(5)} ticks ${rec.real_s}s ${JSON.stringify(ep.params)}${outcome !== 'success' ? ' judge ' + JSON.stringify(rec.judge) : ''}${err ? '\n     ' + err.split('\n')[0] : ''}`)
    }
  }
  const ok = results.filter(x => x.outcome === 'success').length
  write({ type: 'end', pass: ok, total: results.length, ...(mind ? { mind: mind.stats } : {}) })
  if (mind) console.log(`mind: ${JSON.stringify(mind.stats)}`)
  const realS = (real() - real0) / 1000
  console.log(`\n${ok}/${results.length} episodes succeeded; log ${logFile}; real ${realS.toFixed(1)} s${LOCK ? `, ${lock.ticks} ticks (${(lock.ticks / realS).toFixed(0)} tps)` : ''}`)
  if (LOCK) await lock.stop()
  interp.close(); r.close()
  log.end(() => { bot.quit(); (LOCK ? clock.realSetTimeout : setTimeout)(() => process.exit(ok === results.length ? 0 : 1), 500) })
}

// items counted by `have` checks anywhere in the card's judge
function haveItems(ep) {
  const out = new Set()
  const walk = k => { if (!k || typeof k !== 'object') return; if (k.have) out.add(k.have); for (const v of Object.values(k)) if (typeof v === 'object') walk(v) }
  walk(ep.success); walk(ep.fail); for (const m of ep.milestones) walk(m.check)
  return [...out]
}
// same scope as the judge: main + hotbar + armor + offhand (not the cursor, not the crafting grid)
function botCount(bot, it) {
  const tag = it.startsWith('#') ? require('../../spec/names.json').item_tags[it.slice(1).replace('minecraft:', '')] || [] : null
  const match = i => tag ? tag.includes(i.name) : i.name === it.replace('minecraft:', '')
  let n = 0
  for (let s = 5; s <= 45; s++) { const i = bot.inventory.slots[s]; if (i && match(i)) n += i.count }
  return n
}

// no command sets food: drain it with a strong hunger effect, reading foodLevel each tick, down to the target
async function drainFood(food, cmd, judge) {
  const bot = judge.bot
  if (food.target >= 20) { await cmd(`effect give ${bot} saturation 1 20 true`); return }
  await cmd(`effect give ${bot} saturation 1 20 true`) // start from 20/20 so the drain is reproducible
  await C.sleep(100)
  for (let i = 0; i < 400; i++) {
    const f = await judge.num('foodLevel')
    if (f <= food.target) break
    await cmd(`effect clear ${bot} hunger`); await cmd(`effect give ${bot} hunger 1 ${f - food.target > 3 ? 120 : 30} true`)
    await C.sleep(50)
  }
  await cmd(`effect clear ${bot} hunger`)
}

main().catch(e => {
  console.error(e)
  if (!LOCK) process.exit(2)
  require('./instance').start(SIM).then(s => rcon.connect({ port: s.rconPort, password: s.password }))
    .then(async r => { await r.cmd('tick rate 20'); await r.cmd('tick unfreeze') }).finally(() => process.exit(2))
})
