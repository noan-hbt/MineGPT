// Records the prismarine viewer page (viewer.js, :3007) to an mp4: headless Chrome + CDP screencast + ffmpeg.
//   node record.js [--url http://127.0.0.1:3007] [--seconds 300] [--out recordings/x.mp4] [--size 1280x720]
// Frames arrive only when the page changes; each one is kept with its timestamp and ffmpeg's concat demuxer
// replays them at the real pace. Stops after --seconds, or on SIGINT/SIGTERM (then encodes what it has).
'use strict'
const fs = require('fs')
const path = require('path')
const http = require('http')
const { spawn, spawnSync } = require('child_process')
const WebSocket = require('ws')

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d }
const URL_ = arg('url', 'http://127.0.0.1:3007')
const SECONDS = +arg('seconds', 300)
const OUT = path.resolve(arg('out', path.join(__dirname, 'recordings', `rec_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.mp4`)))
const [W, H] = arg('size', '1280x720').split('x').map(Number)
const PORT = 9333
const CHROME = arg('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe')
const FFMPEG = arg('ffmpeg', 'ffmpeg')

const frames = path.join(path.dirname(OUT), path.basename(OUT, '.mp4') + '_frames')
fs.mkdirSync(frames, { recursive: true })
const profile = fs.mkdtempSync(path.join(require('os').tmpdir(), 'rec-chrome-'))
const sleep = ms => new Promise(r => setTimeout(r, ms))
const getJson = (p, method = 'GET') => new Promise((res, rej) => {
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method }, r => {
    let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)) } catch (e) { rej(e) } })
  })
  req.on('error', rej); req.end()
})

async function main() {
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    `--window-size=${W},${H}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--no-first-run', '--mute-audio', 'about:blank'], { stdio: 'ignore' })
  let tab
  for (let i = 0; i < 40 && !tab; i++) { await sleep(250); try { tab = (await getJson('/json/list')).find(t => t.type === 'page') } catch {} }
  if (!tab) throw new Error('chrome did not start')
  const ws = new WebSocket(tab.webSocketDebuggerUrl, { perMessageDeflate: false })
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
  let id = 0
  const pending = new Map()
  const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
  const list = [] // { file, t }
  ws.on('message', raw => {
    const m = JSON.parse(raw)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return }
    if (m.method === 'Page.screencastFrame') {
      const { data, sessionId, metadata } = m.params
      const file = path.join(frames, `f${String(list.length).padStart(6, '0')}.jpg`)
      fs.writeFileSync(file, Buffer.from(data, 'base64'))
      list.push({ file, t: metadata.timestamp || Date.now() / 1000 })
      ws.send(JSON.stringify({ id: ++id, method: 'Page.screencastFrameAck', params: { sessionId } }))
    }
  })
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
  await send('Page.enable')
  await send('Page.navigate', { url: URL_ })
  await sleep(4000) // let the viewer load chunks
  await send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: W, maxHeight: H, everyNthFrame: 1 })
  console.log(`[rec] recording ${URL_} for ${SECONDS}s -> ${OUT}`)

  let stop
  const done = new Promise(r => { stop = r })
  setTimeout(stop, SECONDS * 1000)
  process.on('SIGINT', stop); process.on('SIGTERM', stop)
  await done
  try { await Promise.race([send('Page.stopScreencast'), sleep(2000)]) } catch {}
  ws.close(); chrome.kill()
  if (!list.length) throw new Error('no frames captured')

  // concat list with real durations (last frame held 1 s)
  const lines = []
  for (let i = 0; i < list.length; i++) {
    const dur = i + 1 < list.length ? Math.max(0.001, list[i + 1].t - list[i].t) : 1
    lines.push(`file '${list[i].file.replace(/\\/g, '/')}'`, `duration ${dur.toFixed(3)}`)
  }
  lines.push(`file '${list[list.length - 1].file.replace(/\\/g, '/')}'`)
  const listFile = path.join(frames, 'list.txt')
  fs.writeFileSync(listFile, lines.join('\n'))
  const span = (list[list.length - 1].t - list[0].t).toFixed(0)
  console.log(`[rec] ${list.length} frames over ${span}s, encoding...`)
  const r = spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-vf', `fps=20,scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', OUT], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error('ffmpeg failed')
  fs.rmSync(frames, { recursive: true, force: true })
  try { fs.rmSync(profile, { recursive: true, force: true }) } catch {}
  console.log(`[rec] saved ${OUT}`)
  process.exit(0)
}
main().catch(e => { console.error('[rec] fatal', e.message); process.exit(1) })
