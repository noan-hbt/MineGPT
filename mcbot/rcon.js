// Minimal Minecraft RCON client (B3/B6 test harness). Reads host/port/password from mcserver/server.properties.
//   const r = await require('./rcon').connect(); await r.cmd('time set day'); r.close()
'use strict'
const net = require('net')
const fs = require('fs')
const path = require('path')

function props() {
  const f = path.join(__dirname, '..', 'mcserver', 'server.properties')
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
    const request = (type, body) => new Promise((res, rej) => { pending.set(send(type, body), { res, rej }) })
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
    sock.on('error', e => { for (const p of pending.values()) p.rej(e); pending.clear(); reject(e) })
    sock.once('connect', async () => {
      try {
        await request(3, password)
        resolve({
          cmd: c => request(2, c.replace(/^\//, '')),
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
