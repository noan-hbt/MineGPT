// Minimal Minecraft RCON client (B3/B6 test harness). Reads host/port/password from mcserver/server.properties.
//   const r = await require('./rcon').connect(); await r.cmd('time set day'); r.close()
'use strict'
const net = require('net')
const fs = require('fs')
const path = require('path')

function props() {
  let f = path.join(__dirname, '..', 'mcserver', 'server.properties')
  if (!fs.existsSync(f)) { // git worktree copy (longrun from ../localai-xxx): use the main checkout's server
    try {
      const common = require('child_process').execSync('git rev-parse --git-common-dir', { cwd: __dirname }).toString().trim()
      f = path.join(path.resolve(__dirname, common), '..', 'mcserver', 'server.properties')
    } catch {}
  }
  const p = {}
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([^#=]+)=(.*)$/)
    if (m) p[m[1].trim()] = m[2].trim()
  }
  return p
}

function connect({ host = '127.0.0.1', port, password } = {}) {
  const p = props()
  port = port || +p['rcon.port'] || 25575
  password = password || p['rcon.password']
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host)
    let buf = Buffer.alloc(0), id = 0
    const pending = new Map() // id -> {resolve, reject, chunks}
    const send = (type, body) => {
      const n = ++id
      const b = Buffer.from(body, 'utf8')
      const pkt = Buffer.alloc(14 + b.length)
      pkt.writeInt32LE(10 + b.length, 0); pkt.writeInt32LE(n, 4); pkt.writeInt32LE(type, 8)
      b.copy(pkt, 12)
      sock.write(pkt)
      return n
    }
    // every request times out (10 s): a dead socket must not leave callers (viewer tp loop) waiting forever
    const request = (type, body) => new Promise((res, rej) => {
      if (sock.destroyed) return rej(new Error('RCON closed'))
      const n = send(type, body)
      const t = setTimeout(() => { pending.delete(n); rej(new Error('RCON timeout')) }, 10000)
      pending.set(n, { res: v => { clearTimeout(t); res(v) }, rej: e => { clearTimeout(t); rej(e) } })
    })
    sock.on('data', d => {
      buf = Buffer.concat([buf, d])
      while (buf.length >= 4) {
        const len = buf.readInt32LE(0)
        if (buf.length < len + 4) break
        const rid = buf.readInt32LE(4)
        const body = buf.toString('utf8', 12, len + 2)
        buf = buf.subarray(len + 4)
        if (rid === -1) { for (const p of pending.values()) p.rej(new Error('RCON auth failed')); pending.clear(); continue }
        const p = pending.get(rid)
        if (p) { pending.delete(rid); p.res(body) }
      }
    })
    sock.on('close', () => { for (const p of pending.values()) p.rej(new Error('RCON closed')); pending.clear() })
    sock.on('error', e => { for (const p of pending.values()) p.rej(e); pending.clear(); reject(e) })
    sock.once('connect', async () => {
      try {
        await request(3, password)
        // one request in flight: the vanilla RCON thread parses one packet per socket read, so pipelined
        // packets (lockstep driver + test commands on one connection) get split/merged and it drops the client
        let chain = Promise.resolve()
        resolve({
          cmd: c => { const p = chain.then(() => request(2, c.replace(/^\//, ''))); chain = p.catch(() => {}); return p },
          close: () => sock.end(),
        })
      } catch (e) { reject(e) }
    })
  })
}

module.exports = { connect }

if (require.main === module) {
  connect().then(async r => { console.log(await r.cmd(process.argv.slice(2).join(' ') || 'list')); r.close() })
    .catch(e => { console.error(e.message); process.exit(1) })
}
