// B6 — RCON evaluation bench. Runs bot.js (bot "EVAL", fresh memory) through scripted scenarios on untouched
// terrain and scores it. Needs the MC server (start-mc.ps1, RCON on) and the LLM server under test.
//   node eval.js --model lfm3-base                     all scenarios, 1 trial, LLM at http://127.0.0.1:8080
//   node eval.js --model x --llm http://127.0.0.1:8081 --only iron,home --trials 3
//   node eval.js --report                              table of every saved run (evals/*.json)
// One bot at a time: do not run it next to another bot session (RAM, single LLM slot, shared time/difficulty).
// Scenarios:
//   iron    empty inventory, peaceful, frozen day: time to iron_pickaxe (timeout 15 min)
//   night   empty inventory, normal difficulty, starts late afternoon, time runs: alive at dawn?
//   home    sethome, bot killed, teleported 60 m away, restarted with goal "go back home": back within 5 m?
//   orders  10 chat commands from player "Judge" (command level; natural-language orders come with B7)
'use strict'
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const mineflayer = require('mineflayer')
const rcon = require('./rcon')

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d }
const LLM = arg('llm', 'http://127.0.0.1:8080')
const BOT = 'EVAL', JUDGE = 'Judge'
const DIR = path.join(__dirname, 'evals')
const STATE = path.join(DIR, 'state.json')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const now = () => Date.now()
fs.mkdirSync(DIR, { recursive: true })

let r // RCON
const cmd = async c => {
  const out = await r.cmd(c)
  if (/Unknown|Incorrect|Expected|Invalid/i.test(out)) throw new Error(`RCON "${c}" -> ${out}`)
  return out
}

// ---------- world helpers ----------
// Each scenario run gets a fresh spot (never reused: the bot cuts trees and digs). Ring far from spawn and from
// test_skills.js (3000,3000) / the player's base. Ocean spots fail spreadplayers -> skipped.
function nextSpot() {
  const s = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { next: 0 }
  const n = s.next++
  fs.writeFileSync(STATE, JSON.stringify(s))
  return { n, x: 20000 + (n % 20) * 1500, z: 20000 + Math.floor(n / 20) * 1500 }
}

async function pos(name) {
  const out = await r.cmd(`data get entity ${name} Pos`)
  const m = out.match(/\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/)
  return m ? { x: +m[1], y: +m[2], z: +m[3] } : null
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
async function count(item) { // RCON: count an item in the bot's inventory without removing it
  const out = await r.cmd(`clear ${BOT} ${item} 0`)
  return +(out.match(/Found (\d+)/)?.[1] || 0)
}

// world rules for a scenario (restored by restoreWorld)
let saved = null
async function setWorld({ difficulty = 'peaceful', time = 1000, advance = false }) {
  if (!saved) {
    saved = {
      difficulty: (await r.cmd('difficulty')).match(/is (\w+)/)?.[1]?.toLowerCase() || 'peaceful',
      advance: /true/.test(await r.cmd('gamerule advance_time')),
    }
  }
  await cmd('difficulty ' + difficulty)
  await cmd('gamerule advance_time ' + advance)
  await cmd('time set ' + time)
  await cmd('weather clear')
}
async function restoreWorld() {
  if (!saved) return
  await r.cmd('difficulty ' + saved.difficulty)
  await r.cmd('gamerule advance_time ' + saved.advance)
  await r.cmd('time set 1000')
  saved = null
}

// Put the (offline) player BOT on a fresh spot with an empty inventory, full health, no memory:
// a short client joins, gets teleported/cleared by RCON, quits; bot.js then spawns where it left.
async function prepareBot(spot) {
  fs.rmSync(path.join(__dirname, 'memory', BOT + '.json'), { force: true })
  const c = mineflayer.createBot({ host: 'localhost', port: 25565, username: BOT, version: '1.21.11', auth: 'offline' })
  c.on('error', () => {})
  await new Promise((res, rej) => { c.once('spawn', res); c.once('kicked', rej); setTimeout(() => rej(new Error('prepare: spawn timeout')), 30000) })
  try {
    await cmd(`gamemode survival ${BOT}`)
    let placed = false
    for (let k = 0; k < 6 && !placed; k++) {
      const s = k ? nextSpot() : spot
      const out = await r.cmd(`spreadplayers ${s.x} ${s.z} 1 40 false ${BOT}`)
      placed = /Spread/i.test(out) && !/Could not/i.test(out)
      if (placed) { // spreadplayers accepts ocean/coral/mangrove spots: reject if water at the feet or just below
        await sleep(500)
        const tests = [`block ~ ~ ~ minecraft:water`, `block ~ ~-1 ~ minecraft:water`,
          `biome ~ ~ ~ #minecraft:is_ocean`, `biome ~ ~ ~ #minecraft:is_beach`, `biome ~ ~ ~ #minecraft:is_river`]
        for (const t of tests) {
          const w = await r.cmd(`execute at ${BOT} if ${t}`)
          if (/passed/i.test(w)) { placed = false; console.log(`[eval] spot ${s.x} ${s.z} rejected (${t}), next`); break }
        }
      }
      if (placed) Object.assign(spot, s)
    }
    if (!placed) throw new Error('prepare: no land spot found')
    await cmd(`clear ${BOT}`)
    await cmd(`effect clear ${BOT}`)
    await cmd(`effect give ${BOT} instant_health 1 10 true`)
    await cmd(`effect give ${BOT} saturation 1 20 true`)
    await sleep(1500)
    spot.start = await pos(BOT)
  } finally { c.quit(); await sleep(2000) }
}

// ---------- bot process + decision log ----------
// Starts bot.js, follows its JSONL decision log (B1) and exposes counters + events.
function startBot(extra = []) {
  const child = spawn(process.execPath, ['--max-old-space-size=2048', 'bot.js', '--name', BOT, '--llm', LLM, ...extra], { cwd: __dirname })
  const b = { child, log: null, events: [], decisions: 0, llm: 0, ok: 0, deaths: 0, out: '', exited: false }
  let off = 0
  const onOut = d => {
    b.out = (b.out + d).slice(-4000)
    const m = String(d).match(/\[log\] (.+\.jsonl)/)
    if (m) b.log = m[1].trim()
  }
  child.stdout.on('data', onOut); child.stderr.on('data', onOut)
  child.on('exit', () => { b.exited = true })
  b.poll = () => { // read new log lines
    if (!b.log || !fs.existsSync(b.log)) return
    const buf = fs.readFileSync(b.log)
    if (buf.length <= off) return
    const end = buf.lastIndexOf(10) + 1
    if (end <= off) return
    for (const line of buf.toString('utf8', off, end).split('\n')) {
      if (!line.trim()) continue
      let rec; try { rec = JSON.parse(line) } catch { continue }
      if (rec.kind === 'decision') { b.decisions++; if (rec.source === 'llm') b.llm++; if (rec.ok) b.ok++ }
      else if (rec.kind === 'event') { b.events.push(rec); if (rec.type === 'death') b.deaths++ }
    }
    off = end
  }
  b.has = type => b.events.some(e => e.type === type)
  b.stop = async () => { if (!b.exited) { child.kill(); for (let i = 0; i < 50 && !b.exited; i++) await sleep(100) } b.poll() }
  b.stats = () => ({ actions: b.decisions, llm_calls: b.llm, ok_rate: b.decisions ? +(b.ok / b.decisions).toFixed(2) : 0, deaths: b.deaths })
  return b
}
async function waitSpawn(b, ms = 60000) {
  const end = now() + ms
  while (now() < end) { b.poll(); if (b.log && b.events.length + b.decisions > 0) return; if (b.exited) break; await sleep(250) }
  if (!b.log) throw new Error('bot did not start: ' + b.out.slice(-300))
}
// poll until f() is truthy, the bot exits or the timeout hits
async function until(b, f, ms, every = 1000) {
  const end = now() + ms
  while (now() < end) { b.poll(); const v = await f(); if (v) return v; if (b.exited) return false; await sleep(every) }
  return false
}

// Judge: a creative player that sends the chat orders and reads the bot's replies
async function judge() {
  const j = mineflayer.createBot({ host: 'localhost', port: 25565, username: JUDGE, version: '1.21.11', auth: 'offline' })
  j.on('error', () => {})
  j.replies = []
  j.on('chat', (u, m) => { if (u === BOT) j.replies.push({ t: now(), m }) })
  await new Promise((res, rej) => { j.once('spawn', res); setTimeout(() => rej(new Error('judge: spawn timeout')), 30000) })
  await cmd(`gamemode creative ${JUDGE}`)
  j.say = async (m, wait = 300) => { j.chat(m); await sleep(wait) }
  j.reply = async (re, ms = 8000, since = now()) => {
    const end = now() + ms
    while (now() < end) { const x = j.replies.find(y => y.t >= since && re.test(y.m)); if (x) return x.m; await sleep(200) }
    return null
  }
  j.near = async (d = 6) => { await cmd(`execute at ${BOT} run spreadplayers ~${d} ~ 1 2 false ${JUDGE}`).catch(() => cmd(`tp ${JUDGE} ${BOT}`)); await sleep(800) }
  return j
}

// ---------- scenarios ----------
// Each returns { pass, score (0..1), secs, ...details }. score is what the report averages.
const SCENARIOS = {
  async iron(spot) {
    await setWorld({ difficulty: 'peaceful', time: 1000 })
    await prepareBot(spot)
    const b = startBot(['--goal', 'iron_pickaxe'])
    try {
      await waitSpawn(b)
      const t0 = now()
      const done = await until(b, () => b.has('target_done'), 15 * 60000, 2000)
      const secs = Math.round((now() - t0) / 1000)
      const have = await count('iron_pickaxe').catch(() => 0)
      const pass = !!done && have > 0
      // steps reached on the way, for partial credit
      const tiers = ['wooden_pickaxe', 'stone_pickaxe', 'furnace', 'iron_ingot', 'iron_pickaxe']
      const got = []
      for (const t of tiers) if (await count(t).catch(() => 0) > 0) got.push(t)
      return { pass, score: pass ? 1 : got.length / tiers.length * 0.8, secs: pass ? secs : null, reached: got, ...b.stats() }
    } finally { await b.stop() }
  },

  async night(spot) {
    // 9000 = late afternoon: ~2.5 min of day left, then a full night (~8 min) with hostiles
    await setWorld({ difficulty: 'normal', time: 9000, advance: true })
    await prepareBot(spot)
    const b = startBot(['--goal', 'iron_pickaxe'])
    try {
      await waitSpawn(b)
      const t0 = now()
      const daytime = async () => +((await r.cmd('time query daytime')).match(/(\d+)/)?.[1] || 0)
      await until(b, async () => { const t = await daytime(); return t >= 23500 || t < 9000 }, 13 * 60000, 3000)
      const health = await r.cmd(`data get entity ${BOT} Health`).then(o => +(o.match(/([\d.]+)f/)?.[1] || 0)).catch(() => 0)
      const pass = b.deaths === 0 && !b.exited
      return { pass, score: pass ? 0.7 + 0.3 * health / 20 : 0, secs: Math.round((now() - t0) / 1000), health, ...b.stats() }
    } finally { await b.stop(); await restoreWorld() }
  },

  async home(spot) {
    await setWorld({ difficulty: 'peaceful', time: 1000 })
    await prepareBot(spot)
    const j = await judge()
    let b = startBot(['--goal', 'iron_pickaxe'])
    try {
      await waitSpawn(b)
      await j.near(); await j.say('stop'); await j.reply(/paused/)
      await j.say('sethome')
      const set = await j.reply(/home set at (-?\d+) (-?\d+) (-?\d+)/)
      if (!set) return { pass: false, score: 0, why: 'sethome not acknowledged' }
      const [, hx, hy, hz] = set.match(/(-?\d+) (-?\d+) (-?\d+)/).map(Number)
      const home = { x: hx + 0.5, y: hy, z: hz + 0.5 }
      await b.stop() // restart test: home must come from memory/EVAL.json
      await cmd(`spreadplayers ${hx + 60} ${hz} 1 3 false ${BOT}`)
      await sleep(1000)
      const away = await pos(BOT)
      b = startBot(['--goal', 'go back home'])
      await waitSpawn(b)
      const t0 = now()
      let best = Infinity
      const back = await until(b, async () => { const p = await pos(BOT); if (p) best = Math.min(best, dist(p, home)); return best <= 5 }, 3 * 60000, 1500)
      const start = away ? Math.round(dist(away, home)) : null
      return { pass: !!back, score: back ? 1 : start ? Math.max(0, 1 - best / start) * 0.5 : 0,
        secs: back ? Math.round((now() - t0) / 1000) : null, start_dist: start, best_dist: Math.round(best), ...b.stats() }
    } finally { await b.stop(); j.quit() }
  },

  async orders(spot) {
    await setWorld({ difficulty: 'peaceful', time: 1000 })
    await prepareBot(spot)
    const j = await judge()
    const b = startBot(['--goal', 'wait for orders'])
    const results = []
    const target = async (msg, ms) => {
      const n = b.events.filter(e => e.type === 'target_done').length
      await j.say(msg)
      return until(b, () => b.events.filter(e => e.type === 'target_done').length > n, ms, 1000)
    }
    // [order, check] — check returns truthy when the bot obeyed
    const ORDERS = [
      ['where', async () => j.reply(/I'm at -?\d+ -?\d+ -?\d+/, 8000, now() - 500)],
      ['stop', async () => j.reply(/paused/, 8000, now() - 500)],
      ['go', async () => j.reply(/autonomous mode/, 8000, now() - 500)],
      ['come', async () => {
        await cmd(`execute at ${BOT} run spreadplayers ~14 ~ 1 2 false ${JUDGE}`).catch(() => {})
        await sleep(800); await j.say('come', 0)
        return until(b, async () => { const a = await pos(BOT), c = await pos(JUDGE); return a && c && dist(a, c) < 4 }, 45000)
      }],
      ['goal 3 oak_log', null, 3 * 60000],
      ['goal 1 crafting_table', null, 2 * 60000],
      ['goal 4 stick', null, 2 * 60000],
      ['sethome', async () => j.reply(/home set at/, 8000, now() - 500)],
      ['tasks', async () => j.reply(/^tasks:/, 8000, now() - 500)],
      ['goal 1 wooden_pickaxe', null, 3 * 60000],
    ]
    try {
      await waitSpawn(b)
      await j.near()
      for (const [msg, check, ms] of ORDERS) {
        const t0 = now()
        let ok
        try {
          if (check) { if (msg !== 'come') await j.say(msg); ok = !!(await check()) }
          else ok = !!(await target(msg, ms))
        } catch (e) { ok = false }
        results.push({ order: msg, ok, secs: Math.round((now() - t0) / 1000) })
        console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`)
        if (b.exited) break
      }
      const passed = results.filter(x => x.ok).length
      return { pass: passed === ORDERS.length, score: passed / ORDERS.length, passed, orders: results, ...b.stats() }
    } finally { await b.stop(); j.quit() }
  },
}

// ---------- report ----------
function report() {
  const runs = fs.readdirSync(DIR).filter(f => /^run_.*\.json$/.test(f)).map(f => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')))
  if (!runs.length) return console.log('no runs in ' + DIR)
  const by = {}
  for (const run of runs) for (const s of run.scenarios) {
    const k = run.model; (by[k] ||= {}); (by[k][s.name] ||= []).push(s)
  }
  const names = Object.keys(SCENARIOS)
  const med = a => { const v = a.filter(x => x != null).sort((p, q) => p - q); return v.length ? v[Math.floor(v.length / 2)] : null }
  console.log('| model | ' + names.join(' | ') + ' | mean |')
  console.log('|---|' + names.map(() => '---|').join('') + '---|')
  for (const [model, sc] of Object.entries(by)) {
    const cells = [], means = []
    for (const n of names) {
      const rs = sc[n]
      if (!rs) { cells.push('—'); continue }
      const mean = rs.reduce((a, x) => a + (x.score || 0), 0) / rs.length
      means.push(mean)
      const pass = rs.filter(x => x.pass).length
      const t = med(rs.map(x => x.secs))
      cells.push(`${mean.toFixed(2)} (${pass}/${rs.length}${t != null ? `, ${t}s` : ''})`)
    }
    const m = means.length ? (means.reduce((a, x) => a + x, 0) / means.length).toFixed(2) : '—'
    console.log(`| ${model} | ${cells.join(' | ')} | ${m} |`)
  }
  console.log('\ncell = mean score (passed/trials, median seconds of passed runs)')
}

// ---------- main ----------
async function main() {
  if (process.argv.includes('--report')) return report()
  const model = arg('model', null)
  if (!model) { console.log('usage: node eval.js --model <label> [--llm url] [--only a,b] [--trials n] | --report'); process.exit(1) }
  const only = (arg('only', '') || '').split(',').filter(Boolean)
  const names = only.length ? only : Object.keys(SCENARIOS)
  for (const n of names) if (!SCENARIOS[n]) throw new Error('unknown scenario ' + n)
  const trials = +arg('trials', 1)
  let served = null
  try { served = (await (await fetch(LLM + '/v1/models')).json()).data?.[0]?.id } catch { throw new Error('LLM not reachable at ' + LLM) }
  r = await rcon.connect()
  const run = { model, llm: LLM, served, started: new Date().toISOString(), git: null, scenarios: [] }
  try { run.git = require('child_process').execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim() } catch {}
  const file = path.join(DIR, `run_${run.started.replace(/[:.]/g, '-').slice(0, 19)}_${model.replace(/\W+/g, '_')}.json`)
  console.log(`[eval] model=${model} (${served}) scenarios=${names.join(',')} trials=${trials}`)
  try {
    for (let t = 0; t < trials; t++) for (const name of names) {
      const spot = nextSpot()
      const t0 = now()
      console.log(`[eval] ${name} #${t + 1} at ${spot.x} ${spot.z}`)
      let res
      try { res = await SCENARIOS[name](spot) } catch (e) { res = { pass: false, score: 0, error: e.message } }
      await restoreWorld().catch(() => {})
      res = { name, trial: t + 1, spot: { x: spot.x, z: spot.z }, wall: Math.round((now() - t0) / 1000), ...res }
      run.scenarios.push(res)
      fs.writeFileSync(file, JSON.stringify(run, null, 1)) // saved after each scenario
      const { orders, ...short } = res
      console.log('[eval] ' + JSON.stringify(short))
    }
  } finally { await restoreWorld().catch(() => {}); r.close() }
  console.log('[eval] saved ' + file)
  report()
}
main().catch(e => { console.error('[eval] fatal', e.message); process.exit(1) })
