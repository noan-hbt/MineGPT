// H4 MineSim server instances: own headless vanilla servers for lockstep runs (a frozen server cannot host a
// human player). Instance n lives in mcserver-sim/<n>/ (gitignored), game port 25600+n, RCON 25700+n, flat world,
// fixed seed, view/simulation distance 4, random RCON password. Files copied from mcserver/ (jar + extracted
// libraries/versions, eula).
//   node sim/instance.js create <n> | start <n> | stop <n> | status [n] | rm <n>
//   const { info, start } = require('./sim/instance'); const s = await start(0) // {n, port, rconPort, password}
'use strict'
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')
const rcon = require('../rcon')

const ROOT = path.join(__dirname, '..', '..')
const SRC = path.join(ROOT, 'mcserver')
const BASE = path.join(ROOT, 'mcserver-sim')
const JAVA = process.env.MC_JAVA || path.join(process.env.LOCALAPPDATA || '', 'Packages', 'Microsoft.4297127D64EC6_8wekyb3d8bbwe',
  'LocalCache', 'Local', 'runtime', 'java-runtime-delta', 'windows-x64', 'java-runtime-delta', 'bin', 'java.exe')

const dir = n => path.join(BASE, String(n))
const PROPS = (n, password) => ({
  'server-port': 25600 + n, 'enable-rcon': true, 'rcon.port': 25700 + n, 'rcon.password': password,
  'online-mode': false, 'level-name': 'world', 'level-type': 'minecraft\\:flat', 'level-seed': 1,
  'generate-structures': false, 'view-distance': 4, 'simulation-distance': 4, 'spawn-protection': 0,
  'difficulty': 'easy', 'gamemode': 'survival', 'max-players': 4, 'sync-chunk-writes': false,
  'enable-status': true, 'motd': `MineSim ${n}`, 'broadcast-rcon-to-ops': false, 'management-server-port': 0,
})

function readProps(f) {
  const p = {}
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) { const m = line.match(/^([^#=]+)=(.*)$/); if (m) p[m[1].trim()] = m[2].trim() }
  return p
}

function info(n) {
  const f = path.join(dir(n), 'server.properties')
  if (!fs.existsSync(f)) throw new Error(`sim instance ${n} not created (node sim/instance.js create ${n})`)
  const p = readProps(f)
  return { n, dir: dir(n), host: '127.0.0.1', port: +p['server-port'], rconPort: +p['rcon.port'], password: p['rcon.password'] }
}

function create(n) {
  const d = dir(n)
  if (fs.existsSync(path.join(d, 'server.properties'))) return info(n)
  fs.mkdirSync(d, { recursive: true })
  for (const f of ['server.jar', 'eula.txt']) fs.copyFileSync(path.join(SRC, f), path.join(d, f))
  for (const sub of ['libraries', 'versions']) fs.cpSync(path.join(SRC, sub), path.join(d, sub), { recursive: true })
  const props = PROPS(n, crypto.randomBytes(9).toString('hex'))
  fs.writeFileSync(path.join(d, 'server.properties'), Object.entries(props).map(([k, v]) => `${k}=${v}`).join('\n') + '\n')
  return info(n)
}

async function ping(n) {
  try { const s = info(n); const r = await rcon.connect({ port: s.rconPort, password: s.password }); await r.cmd('list'); r.close(); return true } catch { return false }
}

// start (create if needed) and wait until RCON answers; returns info. Already running: returns at once.
async function start(n, { mem = '1G', timeoutMs = 180000 } = {}) {
  const s = create(n)
  if (await ping(n)) return s
  if (!fs.existsSync(JAVA)) throw new Error(`java not found: ${JAVA} (set MC_JAVA)`)
  const out = fs.openSync(path.join(s.dir, 'stdout.log'), 'a')
  const p = spawn(JAVA, [`-Xms${mem}`, `-Xmx${mem}`, '-jar', 'server.jar', 'nogui'], { cwd: s.dir, detached: true, stdio: ['ignore', out, out], windowsHide: true })
  p.unref()
  fs.writeFileSync(path.join(s.dir, 'pid'), String(p.pid))
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (p.exitCode != null) throw new Error(`sim ${n}: java exited ${p.exitCode}, see ${path.join(s.dir, 'stdout.log')}`)
    if (await ping(n)) return s
    await new Promise(res => setTimeout(res, 1000))
  }
  throw new Error(`sim ${n}: RCON not up after ${timeoutMs / 1000} s`)
}

async function stop(n) {
  const s = info(n)
  try { const r = await rcon.connect({ port: s.rconPort, password: s.password }); await r.cmd('tick unfreeze').catch(() => {}); await r.cmd('stop'); r.close() } catch { return false }
  for (let i = 0; i < 60 && await ping(n); i++) await new Promise(res => setTimeout(res, 1000))
  return true
}

function rm(n) { fs.rmSync(dir(n), { recursive: true, force: true }) }

module.exports = { info, create, start, stop, ping, rm, dir }

if (require.main === module) {
  const [cmd, a] = process.argv.slice(2)
  const n = a == null ? 0 : +a
  const run = {
    create: async () => { const s = create(n); return `${s.dir} port ${s.port} rcon ${s.rconPort}` },
    start: async () => { const s = await start(n); return `sim ${n} up: port ${s.port} rcon ${s.rconPort}` },
    stop: async () => (await stop(n)) ? `sim ${n} stopped` : `sim ${n} not running`,
    status: async () => {
      const ns = a != null ? [n] : fs.existsSync(BASE) ? fs.readdirSync(BASE).filter(x => /^\d+$/.test(x)).map(Number) : []
      return (await Promise.all(ns.map(async k => `sim ${k}: ${await ping(k) ? 'up' : 'down'} (port ${info(k).port})`))).join('\n') || 'no instance'
    },
    rm: async () => { if (await ping(n)) throw new Error(`sim ${n} is running, stop it first`); rm(n); return `sim ${n} removed` },
  }[cmd]
  if (!run) { console.log('usage: node sim/instance.js create|start|stop|status|rm <n>'); process.exit(1) }
  run().then(m => console.log(m), e => { console.error(e.message); process.exit(1) })
}
