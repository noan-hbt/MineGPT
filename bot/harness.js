// H2 live harness: connect a mineflayer bot, build the full structured state every call tick, render the sheet,
// log everything to data/own/<date>/<session>.jsonl. No model yet (H3+): actions come from a scripted TEST driver
// (drive.js) or chat commands, only to make the state move. The driver is not a policy and is never trained on.
//
//   node harness.js [--name LFM] [--host 127.0.0.1] [--port 25565] [--hz 2] [--minutes 1] [--drive wander|idle]
//
// Chat commands (test hooks, also logged as chat events): goal <text> | note <text> | place <name> | plan a | b |
//   follow | come | stop | wander | done
'use strict'
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const mineflayer = require('mineflayer')
const { pathfinder, Movements } = require('mineflayer-pathfinder')
const { Senses } = require('./state')
const { render, VERSION } = require('./render')
const { Driver } = require('./drive')

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d }
const NAME = arg('name', 'LFM')
const HZ = +arg('hz', 2)
const MINUTES = +arg('minutes', 1)
const DRIVE = arg('drive', 'wander')
const DATA = path.resolve(__dirname, '..', 'data', 'own')
const FULL_EVERY = 10 // full re-render sent every N calls (else diff), as the mind loop will do

const stampNow = () => new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16)
const session = `${stampNow()}_${NAME}`
const dir = path.join(DATA, session.slice(0, 10))
fs.mkdirSync(dir, { recursive: true })
const logFile = path.join(dir, session + '.jsonl')
const log = fs.createWriteStream(logFile, { flags: 'a' })
const write = o => log.write(JSON.stringify(o) + '\n')
console.log('session', session, '->', logFile)

const bot = mineflayer.createBot({ host: arg('host', '127.0.0.1'), port: +arg('port', 25565), username: NAME, version: '1.21.11', hideErrors: false })
bot.loadPlugin(pathfinder)
bot.loadPlugin(require('mineflayer-collectblock').plugin)

let senses, driver, timer, callId = 0, lastStamps = null, stopping = false
const stats = { calls: 0, build_ms: 0, render_ms: 0, full_chars: 0, diff_chars: 0, events: 0, max_full: 0 }

bot.once('spawn', () => {
  senses = new Senses(bot, { session, dataDir: DATA })
  const mv = new Movements(bot)
  mv.canDig = true; mv.allow1by1towers = true
  bot.pathfinder.setMovements(mv)
  bot.pathfinder.thinkTimeout = 10000
  driver = new Driver(bot, senses, DRIVE)
  write({ type: 'session', session, bot: NAME, version: bot.version, renderer: VERSION, hz: HZ, drive: DRIVE, start: new Date().toISOString() })
  bot.on('chat', (from, msg) => { if (from !== bot.username) command(from, msg) })
  timer = setInterval(tick, 1000 / HZ)
  driver.start()
  setTimeout(stop, MINUTES * 60000)
})

function tick() {
  if (stopping || !bot.entity) return
  try {
    const t0 = performance.now()
    const running = driver.running()
    const call = running ? 'monitor' : 'decision'
    const state = senses.build({ call, running, expect: null })
    const t1 = performance.now()
    const full = render(state)
    const useDiff = lastStamps && callId % FULL_EVERY !== 0
    const sent = useDiff ? render(state, { prev: lastStamps }) : full
    lastStamps = full.stamps
    const t2 = performance.now()
    const id = ++callId
    write({ type: 'call', call_id: id, kind: call, model: null, state, sheet_version: VERSION, mode: useDiff ? 'diff' : 'full',
      prompt_hash: crypto.createHash('sha1').update(sent.text).digest('hex').slice(0, 12),
      chars: Object.fromEntries(full.sections.map(s => [s.name, s.text.length])), sent_chars: sent.text.length,
      output: null, parsed: null, latency_ms: { build: +(t1 - t0).toFixed(1), render: +(t2 - t1).toFixed(1) } })
    if (id % 5 === 1) fs.writeFileSync(path.join(dir, session + '.sheet.txt'), full.text)
    stats.calls++; stats.build_ms += t1 - t0; stats.render_ms += t2 - t1; stats.events += state.events.length
    stats.full_chars += full.text.length; stats.diff_chars += sent.text.length; stats.max_full = Math.max(stats.max_full, full.text.length)
  } catch (e) { console.error('tick error', e.stack); write({ type: 'error', where: 'tick', error: String(e.stack) }) }
}

function command(from, msg) {
  const m = msg.trim().match(/^(\w+)\s*(.*)$/)
  if (!m) return
  const [, c, rest] = m
  const me = bot.players[from] && bot.players[from].entity
  switch (c) {
    case 'goal': senses.memory.goal('push', rest, 'player', from); senses.push({ kind: 'goal', op: 'push', text: rest }); break
    case 'done': senses.memory.goal('done'); break
    case 'note': senses.memory.note(rest); senses.push({ kind: 'note', text: rest }); break
    case 'plan': senses.memory.setPlan(rest.split('|').map(s => s.trim()).filter(Boolean)); break
    case 'place': if (/^[a-z0-9_]+$/.test(rest)) senses.memory.namePlace(rest, (me || bot.entity).position.toArray(), `named by ${from}`); break
    case 'follow': case 'come': case 'stop': case 'wander': driver.order(c, from); break
  }
}

function stop() {
  if (stopping) return
  stopping = true
  clearInterval(timer)
  if (driver) driver.stop()
  if (senses) senses.save()
  const n = stats.calls || 1
  const summary = { type: 'end', calls: stats.calls, events: stats.events, build_ms_avg: +(stats.build_ms / n).toFixed(1),
    render_ms_avg: +(stats.render_ms / n).toFixed(1), full_chars_avg: Math.round(stats.full_chars / n), full_chars_max: stats.max_full,
    sent_chars_avg: Math.round(stats.diff_chars / n), ledger: senses ? senses.ledger.state().agg : [] }
  write(summary)
  console.log(JSON.stringify(summary))
  log.end(() => { bot.quit(); setTimeout(() => process.exit(0), 500) })
}

bot.on('kicked', r => { console.error('kicked', r); write({ type: 'error', where: 'kicked', error: String(r) }) })
bot.on('error', e => { console.error('error', e.message); write({ type: 'error', where: 'bot', error: e.message }) })
bot.on('end', () => { if (!stopping) { console.error('disconnected'); stop() } })
process.on('SIGINT', stop)
