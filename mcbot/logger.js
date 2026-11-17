// Decision logger (ROADMAP B1): one JSONL file per bot session in mcbot/logs/.
// Each line = one record. Record kinds:
//   session  - once at start: bot/model config, system prompt (so the dataset can rebuild the exact prompt)
//   decision - one per tick: obs (structured + text), valid options, hint, chosen action, source, result, timings, state after
//   event    - death, respawn, chat command, mode change...
// Writes are synchronous appends (tiny lines, ~1 tick/s) so nothing is lost if the process crashes.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const DIR = path.join(__dirname, 'logs')
fs.mkdirSync(DIR, { recursive: true })

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) // 2026-11-17T04-12-33
const session = stamp + '_' + crypto.randomBytes(2).toString('hex')
const file = path.join(DIR, `${session}.jsonl`)
let tick = 0

function write(rec) {
  try { fs.appendFileSync(file, JSON.stringify({ ts: Date.now(), session, ...rec }) + '\n') }
  catch (e) { console.log('[log] write failed:', e.message) }
}

// "ok ..." = success; "<mob> gone/killed" = attack success. Everything else = failure.
const isOk = res => /^ok\b/.test(res) || /gone\/killed$/.test(res)

module.exports = {
  file, session,
  hash: s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 10),
  start(info) { write({ kind: 'session', ...info }) },
  decision(rec) { write({ kind: 'decision', tick: ++tick, ok: isOk(rec.result || ''), ...rec }) },
  event(type, data = {}) { write({ kind: 'event', type, ...data }) },
  isOk,
}
