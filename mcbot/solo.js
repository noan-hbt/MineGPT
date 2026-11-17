// LLM-alone run: bot.js --llm-only on a fresh land spot, recorded from the viewer, stopped after N minutes.
//   node solo.js [--minutes 5] [--goal iron_pickaxe] [--name SOLO] [--no-record]
// Needs: llama-server (:8080), MC server + RCON, viewer.js running (it follows any non-human bot).
// Output: logs/<session>.jsonl (bot decisions) + recordings/solo_<time>.mp4 + a short summary.
'use strict'
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const mineflayer = require('mineflayer')
const rcon = require('./rcon')

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d }
const MIN = +arg('minutes', 5)
const GOAL = arg('goal', 'iron_pickaxe')
const BOT = arg('name', 'SOLO')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const STATE = path.join(__dirname, 'evals', 'state.json') // shared spot counter with eval.js (never reuse a spot)

function nextSpot() {
  const s = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { next: 0 }
  const n = s.next++
  fs.writeFileSync(STATE, JSON.stringify(s))
  return { x: 20000 + (n % 20) * 1500, z: 20000 + Math.floor(n / 20) * 1500 }
}

async function prepare(r) {
  fs.rmSync(path.join(__dirname, 'memory', BOT + '.json'), { force: true })
  const c = mineflayer.createBot({ host: 'localhost', port: 25565, username: BOT, version: '1.21.11', auth: 'offline' })
  c.on('error', () => {})
  await new Promise((res, rej) => { c.once('spawn', res); setTimeout(() => rej(new Error('spawn timeout')), 30000) })
  try {
    await r.cmd(`gamemode survival ${BOT}`)
    for (let k = 0; k < 12; k++) {
      const s = nextSpot()
      const out = await r.cmd(`spreadplayers ${s.x} ${s.z} 1 40 false ${BOT}`)
      if (!/Spread/i.test(out) || /Could not/i.test(out)) continue
      await sleep(800)
      let bad = null
      for (const t of ['block ~ ~ ~ minecraft:water', 'block ~ ~-1 ~ minecraft:water', 'biome ~ ~ ~ #minecraft:is_ocean',
        'biome ~ ~ ~ #minecraft:is_beach', 'biome ~ ~ ~ #minecraft:is_river'])
        if (/passed/i.test(await r.cmd(`execute at ${BOT} if ${t}`))) { bad = t; break }
      if (bad) { console.log(`[solo] spot ${s.x} ${s.z} rejected (${bad})`); continue }
      console.log(`[solo] spot ${s.x} ${s.z}`)
      await r.cmd(`clear ${BOT}`)
      await r.cmd(`effect give ${BOT} instant_health 1 10 true`)
      await r.cmd(`effect give ${BOT} saturation 1 20 true`)
      return
    }
    throw new Error('no land spot found')
  } finally { c.quit(); await sleep(2000) }
}

async function main() {
  const r = await rcon.connect()
  await r.cmd('time set 1000'); await r.cmd('weather clear')
  await prepare(r)
  r.close()
  const out = fs.openSync(path.join(__dirname, `solo_${BOT}.log`), 'w')
  const bot = spawn(process.execPath, ['--max-old-space-size=2048', 'bot.js', '--name', BOT, '--goal', GOAL, '--llm-only', '--no-chat', ...(process.argv.includes('--history') ? ['--history'] : [])],
    { cwd: __dirname, stdio: ['ignore', out, out] })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const recFile = path.join(__dirname, 'recordings', `solo_${stamp}.mp4`)
  let rec = null
  if (!process.argv.includes('--no-record')) {
    await sleep(6000) // bot joins, viewer switches to it
    rec = spawn(process.execPath, ['record.js', '--seconds', String(MIN * 60), '--out', recFile], { cwd: __dirname, stdio: 'inherit' })
  }
  console.log(`[solo] ${BOT} running ${MIN} min, goal ${GOAL}, --llm-only`)
  await sleep(MIN * 60000 + (rec ? 0 : 6000))
  bot.kill()
  if (rec) await new Promise(res => rec.on('exit', res))
  // summary from the bot's decision log
  const logLine = fs.readFileSync(path.join(__dirname, `solo_${BOT}.log`), 'utf8').match(/\[log\] (.+\.jsonl)/)
  if (logLine) {
    const recs = fs.readFileSync(logLine[1].trim(), 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    const d = recs.filter(x => x.kind === 'decision')
    const inv = {}
    for (const x of d) for (const [k, v] of Object.entries(x.after?.inv_delta || {})) inv[k] = (inv[k] || 0) + v
    const verbs = {}
    for (const x of d) verbs[x.action] = (verbs[x.action] || 0) + 1
    console.log(`[solo] log ${logLine[1].trim()}`)
    console.log(`[solo] ${d.length} actions, ok ${d.filter(x => String(x.result).startsWith('ok')).length}, deaths ${recs.filter(x => x.type === 'death').length}`)
    console.log('[solo] top actions: ' + Object.entries(verbs).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k} x${v}`).join(', '))
    const c = d.filter(x => x.ctx)
    if (c.length) console.log(`[solo] context: last prompt ${c[c.length - 1].ctx.prompt_n + c[c.length - 1].ctx.cache_n} tok, median new ${c.map(x => x.ctx.prompt_n).sort((a, b) => a - b)[c.length >> 1]} tok/turn, median llm ${d.map(x => x.llm_ms).filter(Boolean).sort((a, b) => a - b)[c.length >> 1]} ms`)
    console.log('[solo] inventory gained: ' + (Object.entries(inv).filter(([, v]) => v > 0).map(([k, v]) => `${k} +${v}`).join(', ') || 'nothing'))
  }
  if (rec) console.log(`[solo] video ${recFile}`)
  process.exit(0)
}
main().catch(e => { console.error('[solo] fatal', e.message); process.exit(1) })
