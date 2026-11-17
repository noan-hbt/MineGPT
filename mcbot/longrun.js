// B4 long live session (unattended). Runs bot.js in a restart loop + a spectator "Tester" player that
// sends the chat commands of the B4 checklist, kills the bot once (restart test), and records everything.
// Usage: node longrun.js [minutes=60] [--name X] [--goals a,b,c]
// Extra args go to bot.js. --goals is only passed on the first start (restarts resume the remembered task stack).
'use strict'
const { spawn } = require('child_process')
const fs = require('fs')
const mineflayer = require('mineflayer')
const rcon = require('./rcon')

const MIN = +(process.argv[2] || 60)
const t0 = Date.now()
const el = () => ((Date.now() - t0) / 60000).toFixed(1).padStart(5) + 'm'
const EV = __dirname + '/longrun_events.log', BOTLOG = __dirname + '/longrun_bot.log'
fs.writeFileSync(EV, ''); fs.writeFileSync(BOTLOG, '')
const ev = s => { const l = `${el()} ${s}`; console.log(l); fs.appendFileSync(EV, l + '\n') }

let child = null, stopping = false, restarts = 0
const EXTRA = process.argv.slice(3)
const gi = EXTRA.indexOf('--goals'), RESTART_ARGS = gi < 0 ? EXTRA : EXTRA.filter((_, i) => i !== gi && i !== gi + 1)
function startBot() {
  const args = restarts ? RESTART_ARGS : EXTRA
  child = spawn(process.execPath, ['--max-old-space-size=2048', 'bot.js', ...args], { cwd: __dirname })
  const out = d => fs.appendFileSync(BOTLOG, d)
  child.stdout.on('data', out); child.stderr.on('data', out)
  child.on('exit', code => {
    ev(`[bot] exited code=${code}`)
    if (!stopping) { restarts++; setTimeout(startBot, 5000) }
  })
  ev('[bot] started pid ' + child.pid)
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
const at = async m => { const w = t0 + m * 60000 - Date.now(); if (w > 0) await sleep(w) }

async function main() {
  try { const r = await rcon.connect(); ev('[rcon] difficulty: ' + await r.cmd('difficulty')); r.close() } catch (e) { ev('[rcon] ' + e.message) }
  startBot()
  await sleep(20000)
  const T = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'Tester', version: '1.21.11', auth: 'offline' })
  T.on('chat', (u, m) => { if (u !== 'Tester') ev(`<${u}> ${m}`) })
  T.on('kicked', r => ev('[tester] kicked ' + r))
  T.on('error', e => ev('[tester] error ' + e.message))
  await new Promise(r => T.once('spawn', r))
  try { const r = await rcon.connect(); await r.cmd('gamemode spectator Tester'); r.close() } catch (e) { ev('[rcon] ' + e.message) }
  const say = m => { ev(`> ${m}`); T.chat(m) }

  await at(1); say('tasks'); await sleep(3000); say('memory')
  await at(2); say('goal 3 torch'); await sleep(3000); say('tasks')
  await at(MIN * 0.33); say('tasks'); say('sethome')
  await at(MIN * 0.33 + 1); ev('[test] killing bot (restart test)'); child.kill()
  await at(MIN * 0.33 + 2); say('tasks'); await sleep(3000); say('memory')
  await at(MIN * 0.66); say('memory')
  await at(MIN - 0.5); say('tasks'); await sleep(3000); say('memory')
  await at(MIN)
  stopping = true; child.kill(); T.quit()
  ev(`[done] restarts=${restarts}`)
  setTimeout(() => process.exit(0), 3000)
}
main().catch(e => { ev('[fatal] ' + e.stack); stopping = true; child?.kill(); process.exit(1) })
