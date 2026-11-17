// B4 — long-term memory. One JSON file per bot (mcbot/memory/<name>.json), survives restarts.
//   home        base position (chat "sethome", or the first crafting table the bot places)
//   tasks       goal stack: tasks[0] = current goal; a new goal pushes the old one, a finished goal pops it
//   places      remembered stations / ores / beds: { iron_ore: [[x,y,z,t], ...], furnace: [...], ... }
//   chests      "x,y,z" -> { item: count } (what the bot put there)
//   deaths      last deaths [{ pos, t, cause, last }]
//   episodes    journal: one short summary every EPISODE_N actions (LLM if available, code fallback)
// prompt() builds a short "Memory:" text (a few lines, << 2k tokens) for the observation.
'use strict'
const fs = require('fs')
const path = require('path')

const EPISODE_N = 20
const MAX_PER_KIND = 12
const MERGE_DIST = 4 // same ore vein / same station
const MAX_EPISODES = 30, MAX_DEATHS = 10, MAX_TASKS = 6

const key = p => `${p[0]},${p[1]},${p[2]}`
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const arr = p => Array.isArray(p) ? p.slice(0, 3).map(Math.floor) : [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)]
// compass direction from a to b ("12m north-east, 5 up")
function where(from, to) {
  const dx = to[0] - from[0], dz = to[2] - from[2], dy = to[1] - from[1]
  const h = Math.round(Math.hypot(dx, dz))
  const ns = dz < -h * 0.38 ? 'north' : dz > h * 0.38 ? 'south' : ''
  const ew = dx > h * 0.38 ? 'east' : dx < -h * 0.38 ? 'west' : ''
  const dir = [ns, ew].filter(Boolean).join('-') || 'here'
  const v = Math.abs(dy) >= 4 ? `, ${Math.abs(dy)} ${dy > 0 ? 'up' : 'down'}` : ''
  return `${h}m ${dir}${v}`
}

function createMemory(name, { dir = path.join(__dirname, 'memory'), summarize = null } = {}) {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${name}.json`)
  const empty = () => ({ version: 1, home: null, tasks: [], places: {}, chests: {}, deaths: [], episodes: [], actions: 0, sessions: 0 })
  let d = empty()
  try { d = { ...d, ...JSON.parse(fs.readFileSync(file, 'utf8')) } } catch {}
  d.sessions++
  let dirty = true, window = [], summarizing = false

  function save() {
    if (!dirty) return
    try { fs.writeFileSync(file + '.tmp', JSON.stringify(d)); fs.renameSync(file + '.tmp', file); dirty = false }
    catch (e) { console.log('[mem] save failed:', e.message) }
  }
  const timer = setInterval(save, 10000); timer.unref?.()
  const touch = () => { dirty = true }

  // ---- places ----
  function see(kind, p) {
    p = arr(p)
    const list = d.places[kind] ||= []
    const near = list.find(q => dist(q, p) <= MERGE_DIST)
    if (near) { near[3] = Date.now(); return false }
    list.push([...p, Date.now()])
    if (list.length > MAX_PER_KIND) { list.sort((a, b) => b[3] - a[3]); list.length = MAX_PER_KIND } // keep most recent
    touch(); return true
  }
  function forget(kind, p) {
    p = arr(p)
    const list = d.places[kind]; if (!list) return
    const i = list.findIndex(q => dist(q, p) <= 1)
    if (i >= 0) { list.splice(i, 1); touch() }
    if (kind === 'chest') { delete d.chests[key(p)]; touch() }
  }
  // nearest remembered place of a kind: [x,y,z] or null
  function nearest(kind, from, maxD = Infinity) {
    from = arr(from)
    let best = null, bd = maxD
    for (const q of d.places[kind] || []) { const x = dist(q, from); if (x <= bd) { bd = x; best = q.slice(0, 3) } }
    return best
  }
  // drop remembered places whose block is gone (chunk loaded, within r). blockName(pos) -> name | null if unloaded
  function verify(from, blockName, r = 12, match = (kind, n) => n === kind || n === 'deepslate_' + kind || (kind === 'bed' && /_bed$/.test(n))) {
    from = arr(from)
    for (const [kind, list] of Object.entries(d.places))
      for (const q of [...list]) {
        if (dist(q, from) > r) continue
        const n = blockName(q)
        if (n && !match(kind, n)) forget(kind, q)
      }
  }

  // ---- chests ----
  function stored(p, items) {
    p = arr(p); see('chest', p)
    const c = d.chests[key(p)] ||= {}
    for (const [k, v] of Object.entries(items)) c[k] = (c[k] || 0) + v
    touch()
  }
  function took(p, items) {
    const c = d.chests[key(arr(p))]; if (!c) return
    for (const [k, v] of Object.entries(items)) { c[k] = (c[k] || 0) - v; if (c[k] <= 0) delete c[k] }
    touch()
  }

  // ---- home / tasks ----
  function setHome(p) { d.home = arr(p); touch(); save() }
  const goal = () => d.tasks[0]?.goal ?? null
  // new goal: the unfinished current one goes under it (resumed when the new one is done)
  function pushGoal(g) {
    if (goal() === g) return
    d.tasks = [{ goal: g, t: Date.now() }, ...d.tasks.filter(t => t.goal !== g)].slice(0, MAX_TASKS)
    touch(); save()
  }
  // current goal finished -> returns the goal to resume (or null)
  function popGoal() { d.tasks.shift(); touch(); save(); return goal() }
  function replaceGoal(g) { d.tasks[0] = { goal: g, t: Date.now() }; touch(); save() }

  // ---- deaths ----
  function died(p, cause, last) {
    d.deaths.push({ pos: arr(p), t: Date.now(), cause, last })
    if (d.deaths.length > MAX_DEATHS) d.deaths.shift()
    touch(); save()
  }

  // ---- episodes ----
  // call after every action. Every EPISODE_N actions a summary is added (async, never blocks the loop)
  function action(a, result, inv_delta) {
    d.actions++; touch()
    window.push({ a, r: String(result).slice(0, 50), inv: inv_delta })
    if (window.length < EPISODE_N || summarizing) return
    const w = window; window = []
    summarizing = true
    episode(w).finally(() => { summarizing = false })
  }
  function codeSummary(w) {
    const ok = w.filter(x => /^ok\b|gone\/killed$/.test(x.r)).length
    const gain = {}
    for (const x of w) for (const [k, v] of Object.entries(x.inv || {})) gain[k] = (gain[k] || 0) + v
    const g = Object.entries(gain).filter(([, v]) => v > 0).map(([k, v]) => `${k} +${v}`).slice(0, 6).join(', ')
    const top = Object.entries(w.reduce((m, x) => (m[x.a.split(' ')[0]] = (m[x.a.split(' ')[0]] || 0) + 1, m), {}))
      .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} x${v}`).join(', ')
    return `${ok}/${w.length} actions ok (${top})` + (g ? `; got ${g}` : '')
  }
  async function episode(w) {
    let text = codeSummary(w)
    if (summarize) {
      try { const s = await summarize(w, goal()); if (s) text = s.trim().replace(/\s+/g, ' ').slice(0, 200) } catch {}
    }
    d.episodes.push({ t: Date.now(), goal: goal(), text, code: codeSummary(w) })
    if (d.episodes.length > MAX_EPISODES) d.episodes.shift()
    touch(); save()
    return text
  }
  const flush = () => window.length ? episode(window.splice(0)) : Promise.resolve(null)

  // ---- prompt text ----
  // only what helps the next decision: home, nearest few remembered things, chest contents, last episode, recent death
  function prompt(from, wanted = []) {
    from = arr(from)
    const lines = []
    if (d.home) lines.push(`Home: ${where(from, d.home)}.`)
    const kinds = [...new Set([...wanted, 'crafting_table', 'furnace', 'bed', 'chest'])]
    const known = []
    for (const k of kinds) {
      const q = nearest(k, from, 200)
      if (q && dist(q, from) > 6) known.push(`${k} ${where(from, q)}`)
    }
    if (known.length) lines.push(`Remembered: ${known.slice(0, 5).join('; ')}.`)
    const chests = Object.entries(d.chests).filter(([, c]) => Object.keys(c).length)
    if (chests.length) {
      const [k, c] = chests.map(([k, c]) => [k.split(',').map(Number), c]).sort((a, b) => dist(a[0], from) - dist(b[0], from))[0]
      lines.push(`Chest (${where(from, k)}): ${Object.entries(c).slice(0, 8).map(([n, v]) => `${n} x${v}`).join(', ')}.`)
    }
    const ep = d.episodes[d.episodes.length - 1]
    if (ep) lines.push(`Earlier: ${ep.text}`)
    const dth = d.deaths[d.deaths.length - 1]
    if (dth && Date.now() - dth.t < 30 * 60 * 1000) lines.push(`Died recently (${dth.cause}) ${where(from, dth.pos)}.`)
    return lines.join('\n')
  }

  return {
    file, get data() { return d }, save, close() { clearInterval(timer); save() },
    see, forget, nearest, verify, stored, took, setHome, goal, pushGoal, popGoal, replaceGoal, died,
    action, flush, prompt, where,
    get home() { return d.home },
  }
}

module.exports = { createMemory, where, EPISODE_N }
