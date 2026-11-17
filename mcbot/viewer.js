// Browser spectator view of a bot (remote watching through the Tailscale funnel, see HANDOFF "Remote access").
// Joins as an invisible spectator player "Viewer", follows the target with RCON tp, serves prismarine-viewer.
//   node viewer.js [--target auto|EVAL|LFM|...] [--port 3007] [--view 6]
// auto = first online player from AUTO_ORDER, else any player that is not a human listed in HUMANS.
// Open http://127.0.0.1:3007 (or the funnel URL). Third-person orbit camera: drag to rotate, wheel to zoom.
'use strict'
const mineflayer = require('mineflayer')
const { mineflayer: startViewer } = require('prismarine-viewer')
const rcon = require('./rcon')

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d }
const NAME = arg('name', 'Viewer')
const TARGET = arg('target', 'auto')
const PORT = +arg('port', 3007)
const AUTO_ORDER = ['EVAL', 'LFM', 'B5RUN']
const HUMANS = ['ZeiK_0', 'Judge', 'Tester']

let r = null
async function cmd(c) {
  try {
    if (!r) r = await rcon.connect()
    return await r.cmd(c)
  } catch (e) {
    try { r?.close() } catch {}
    r = null
    return ''
  }
}

const bot = mineflayer.createBot({
  host: arg('host', 'localhost'), port: +arg('mcport', 25565), username: NAME,
  version: arg('version', '1.21.11'), auth: 'offline',
})

function pickTarget() {
  const online = Object.keys(bot.players).filter(n => n !== NAME)
  if (TARGET !== 'auto') return online.includes(TARGET) ? TARGET : null
  return AUTO_ORDER.find(n => online.includes(n)) || online.find(n => !HUMANS.includes(n)) || null
}

let current = null
bot.once('spawn', async () => {
  await cmd(`gamemode spectator ${NAME}`)
  startViewer(bot, { port: PORT, firstPerson: false, viewDistance: +arg('view', 6) })
  console.log(`[viewer] http://127.0.0.1:${PORT}  (target: ${TARGET})`)
  setInterval(async () => {
    const t = pickTarget()
    if (t !== current) { console.log(`[viewer] following ${t || '(nobody)'}`); current = t }
    if (!t) return
    // Stand a bit behind/above the target so the orbit camera frames it.
    await cmd(`execute as ${NAME} at ${t} run tp @s ~-3 ~2 ~-3 facing entity ${t}`)
  }, 1000)
})

bot.on('kicked', reason => console.log('[viewer] kicked:', JSON.stringify(reason)))
bot.on('error', e => console.log('[viewer] error:', e.message))
bot.on('end', () => { console.log('[viewer] disconnected'); process.exit(1) }) // run-viewer.ps1 restarts
