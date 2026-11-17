// Situation sheet renderer v1: structured state (spec/state.schema.json) -> plain text, 12 sections, stable -> volatile.
//   const { render } = require('./render') ; render(state, { prev, budgets }) -> { text, sections: [{name, stamp, text, same}] }
// Each section header carries a content stamp (`## MEMORY [3fa2]`). Diff mode (opts.prev = stamps of the previous
// render): unchanged stable sections (1-9) are replaced by `## NAME [stamp] unchanged`; 10-12 are always present.
// Facts only, never advice. Positions are written in DSL syntax so the model can copy them into actions.
//
// CLI:
//   node render.js <state.json>                      print the sheet
//   node render.js --log <session.jsonl> [--every N] JSONL {call_id, full: {name: text}, diff: {name: text}} per call
'use strict'
const crypto = require('crypto')
const catalog = require('../spec/catalog.json')
const { cooked } = require('./state/afford')

const VERSION = 'r1'
const ORDER = ['MANUAL', 'MEMORY', 'MAP', 'EPISODE', 'GOALS', 'LEDGER', 'BODY', 'INVENTORY', 'AFFORDANCES', 'SURROUNDINGS', 'EVENTS', 'NOW']
const ALWAYS = new Set(['SURROUNDINGS', 'EVENTS', 'NOW'])
// max items per list (truncate oldest / farthest first); measured and tuned in H2 with eval/sheet_tokens.py
const BUDGETS = { notes: 40, places: 40, routines: 20, map_cells: 40, minimap: 7, deaths: 10, goals_done: 15, plan: 20,
  ledger_agg: 30, ledger_recent: 15, craftable: 60, soon: 20, blocks: 40, entities: 25, events: 40, chests: 10 }

// ---------------------------------------------------------------- helpers
const P = p => `(${p.join(',')})`
// stable sections (1-9) use coarse ages (minutes) so their text, hence the KV-cache prefix, changes rarely
let COARSE = false
function ago(t, now) {
  if (t == null) return '?'
  if (COARSE) {
    const m = Math.floor(Math.max(0, now - t) / 60000)
    return m < 1 ? '<1m ago' : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m ago`
  }
  const s = Math.max(0, Math.round((now - t) / 1000))
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s ago` : `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, '0')}m ago`
}
function dur(s) {
  s = Math.round(s)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}
const DIR = { north: 'N', north_east: 'NE', east: 'E', south_east: 'SE', south: 'S', south_west: 'SW', west: 'W', north_west: 'NW', here: 'here' }
const d = x => DIR[x] || x || '?'
const counts = c => Object.entries(c || {}).map(([k, v]) => `${k} x${v}`).join(', ') || '-'
const signed = c => Object.entries(c || {}).map(([k, v]) => `${k} ${v >= 0 ? '+' : ''}${v}`).join(', ')
function cap(list, n, what = 'more') {
  if (list.length <= n) return list
  return [...list.slice(0, n), `(+${list.length - n} ${what})`]
}
const stamp = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 4)

// ---------------------------------------------------------------- 1 MANUAL (static, generated from the catalog)
let manualCache = null
function manual() {
  if (manualCache) return manualCache
  const sig = (name, v) => [name, ...(v.args || []).map(a => `<${a.name}>`), ...Object.keys(v.kw || {}).map(k => `[${k}=]`)].join(' ')
  const fam = {}
  for (const [n, v] of Object.entries(catalog.verbs)) (fam[v.family] = fam[v.family] || []).push(sig(n, v))
  const tools = Object.entries(catalog.tools).map(([n, v]) => sig(n, v))
  manualCache = [
    `MineGPT harness ${VERSION}. You read this sheet and answer with tagged lines (tag: content).`,
    'decision turn: think:* then either 1-4 tool: lines (results come back, continue) or a final turn:',
    '  plan:? act: <stmt> expect: <cond, cond in DUR> note:* say:? goal:? ask:?',
    'monitor turn (an action is running): think:? then one of: continue | adjust: k=v [until(cond)] | interrupt: <stmt> + expect:',
    'stmt: verb positional... key=value... [until(cond)] [timeout=DUR] ; seq[a; b] ; if(cond) a else b ; repeat(n) a ; routine name',
    'values: id, tag:x, @place, #kind.id, #player.Name, (x,y,z) or (~dx,~dy,~dz), ((x,y,z),(x,y,z)), [a,b], 30s, "text"',
    'cond: flags (night, sky, inv_full, ...) and comparisons (hp<8, have(x)>=+4, dist(t)<5, y<20) with & | ! ( )',
    'goal: push <text> | replace <text> | done | fail <reason> ; plan: step | step | ...',
    'verbs:',
    ...Object.entries(fam).map(([f, l]) => `  ${f}: ${l.join(' ; ')}`),
    `tools: ${tools.join(' ; ')}`,
    'sheet: times are relative to now; dist in blocks; dir N=-z E=+x; slice rows go north->south, columns west->east.',
  ].join('\n')
  return manualCache
}

// ---------------------------------------------------------------- sections
function memory(s, now, B) {
  const m = s.memory || {}
  const out = []
  const notes = (m.notes || []).slice(-B.notes).reverse()
  out.push(`notes (${(m.notes || []).length}, newest first):`)
  out.push(...(notes.length ? notes.map(n => `- ${n.key ? `[${n.key}] ` : ''}${n.text} (${ago(n.t, now)})`) : ['- none']))
  const places = m.places || []
  out.push(`places (${places.length}):`)
  out.push(...(places.length ? cap(places.map(p => `- @${p.name} ${P(p.pos)}${p.dimension && p.dimension !== 'overworld' ? ' ' + p.dimension : ''}${p.what ? ': ' + p.what : ''}${p.seen_t != null ? ` (seen ${ago(p.seen_t, now)})` : ''}`), B.places) : ['- none']))
  const r = m.routines || []
  out.push(`routines (${r.length}):`)
  out.push(...(r.length ? cap(r.map(x => `- ${x.name} = ${x.src} (runs ${x.runs || 0}, ok ${x.ok || 0})`), B.routines) : ['- none']))
  return out.join('\n')
}

const BIOME_CHAR = new Map()
function biomeChar(b) {
  if (!b) return '-'
  if (!BIOME_CHAR.has(b)) {
    const used = new Set(BIOME_CHAR.values())
    const base = b.replace(/^(old_growth_|windswept_|snowy_|frozen_|deep_|dark_|lukewarm_|warm_|cold_|stony_|sparse_|flower_|bamboo_|sunflower_|ice_|eroded_|wooded_)/, '')
    const c = [base[0], b[0], ...'abcdefghijklmnopqrstuvwxyz0123456789'].find(x => !used.has(x))
    BIOME_CHAR.set(b, c || '*')
  }
  return BIOME_CHAR.get(b)
}

function map(s, now, B) {
  const m = s.map || {}
  const cs = m.cell || 16
  const p0 = (s.surroundings || {}).pos || [0, 0, 0]
  const bx = Math.floor(p0[0] / cs), bz = Math.floor(p0[2] / cs)
  const pos = [bx * cs + cs / 2, p0[1], bz * cs + cs / 2] // distances from your cell's center: stable while in the cell
  const cells = m.cells || []
  const out = []
  const R = B.minimap
  const byKey = new Map(cells.map(c => [`${c.cx},${c.cz}`, c]))
  out.push(`grid of ${cs}x${cs} columns around you (${2 * R + 1}x${2 * R + 1}, north up): letter = biome (UPPER = visited), - = seen biome unknown, ? = never seen, @ = you`)
  const legend = new Map()
  for (let z = bz - R; z <= bz + R; z++) {
    let row = ''
    for (let x = bx - R; x <= bx + R; x++) {
      const c = byKey.get(`${x},${z}`)
      if (x === bx && z === bz) { row += '@'; continue }
      if (!c) { row += '?'; continue }
      const ch = biomeChar(c.biome)
      if (c.biome) legend.set(ch, c.biome)
      row += c.visited ? ch.toUpperCase() : ch
    }
    out.push('  ' + row)
  }
  if (legend.size) out.push('  biomes: ' + [...legend].map(([k, v]) => `${k}=${v}`).join(', '))
  const rel = c => {
    const x0 = c.cx * cs, z0 = c.cz * cs
    const dx = x0 + cs / 2 - pos[0], dz = z0 + cs / 2 - pos[2]
    return { txt: `x${x0}..${x0 + cs - 1} z${z0}..${z0 + cs - 1}`, dist: Math.round(Math.hypot(dx, dz)), dir: d(dirOf(dx, dz)) }
  }
  const notable = cells.filter(c => Object.keys(c.resources || {}).length || (c.structures || []).length || (c.dangers || []).length)
  out.push(`known cells with resources / structures / dangers (${notable.length}, nearest first, dist from your cell x${bx * cs}..${bx * cs + cs - 1} z${bz * cs}..${bz * cs + cs - 1}):`)
  out.push(...(notable.length ? cap(notable.map(c => {
    const r = rel(c)
    const parts = [`- ${r.txt} ${r.dist}m ${r.dir}${c.biome ? ' ' + c.biome : ''}${c.surface_y != null ? ' surface y' + c.surface_y : ''}${c.visited ? ' visited' : ''} seen ${ago(c.seen_t, now)}`]
    if (Object.keys(c.resources || {}).length) parts.push(Object.entries(c.resources).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(', '))
    if ((c.structures || []).length) parts.push('structures: ' + c.structures.join(', '))
    if ((c.dangers || []).length) parts.push('dangers: ' + c.dangers.join(', '))
    return parts.join(' | ')
  }), B.map_cells, 'farther cells') : ['- none']))
  const r10 = x => Math.max(10, Math.round(x / 10) * 10)
  out.push('unexplored: ' + ((m.frontier || []).map(f => `${d(f.dir)} ~${r10(f.dist)}m`).join(', ') || '-'))
  out.push('to places (straight line): ' + ((m.costs || []).map(c => `${c.to} ~${r10(c.dist)}m ~${r10(c.eta_s)}s`).join(', ') || '-'))
  return out.join('\n')
}
function dirOf(dx, dz) {
  if (Math.abs(dx) < 0.5 && Math.abs(dz) < 0.5) return 'here'
  const a = Math.atan2(dz, dx)
  return ['east', 'south_east', 'south', 'south_west', 'west', 'north_west', 'north', 'north_east'][((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8]
}

function episode(s, now, B) {
  const e = s.episode || {}
  const out = [`summary${e.summary_t != null ? ` (written ${ago(e.summary_t, now)})` : ''}: ${e.summary || '(none yet)'}`]
  const deaths = e.deaths || []
  out.push(`deaths this session: ${deaths.length}`)
  out.push(...cap(deaths.slice().reverse().map(x => `- ${ago(x.t, now)} at ${P(x.pos)}: ${x.cause}`), B.deaths))
  const g = e.goals_done || []
  out.push(`goals finished: ${g.length ? '' : 'none'}`)
  out.push(...cap(g.slice().reverse().map(x => `- ${x.status} "${x.text}" ${ago(x.t, now)}`), B.goals_done))
  return out.join('\n').replace(/: \n/g, ':\n')
}

function goals(s, now, B) {
  const g = s.goals || {}
  const st = g.stack || []
  const out = [`goal stack (top = current): ${st.length ? '' : 'empty'}`.trimEnd()]
  st.forEach((x, i) => out.push(`${i + 1}. ${x.text} (from ${x.source}${x.from ? ' ' + x.from : ''}, ${ago(x.t, now)})`))
  const plan = g.plan || []
  out.push(`plan: ${plan.length ? '' : 'none'}`.trimEnd())
  out.push(...cap(plan.map(p => `[${p.done ? 'x' : ' '}] ${p.step}`), B.plan))
  return out.join('\n')
}

function result(e, now) {
  const parts = [`${ago(e.t, now)} ${e.status} \`${e.stmt}\` in ${dur(e.dur_s)}`]
  if (e.gained && Object.keys(e.gained).length) parts.push('gained ' + counts(e.gained))
  if (e.lost && Object.keys(e.lost).length) parts.push('lost ' + counts(e.lost))
  if (e.cause) parts.push('cause ' + e.cause)
  if (e.detail) parts.push(e.detail)
  return parts.join(' | ')
}

function ledger(s, now, B) {
  const l = s.ledger || {}
  const agg = l.agg || []
  const out = [`attempts by action (${agg.length}, most recent first):`]
  out.push(...(agg.length ? cap(agg.map(a => {
    const st = ['ok', 'partial', 'failed', 'interrupted'].filter(k => a[k]).map(k => `${k} ${a[k]}`).join(', ')
    const c = Object.entries(a.causes || {}).map(([k, v]) => `${k} ${v}`).join(', ')
    return `- ${a.key}: ${st}${c ? ` (${c})` : ''}, last ${ago(a.last_t, now)}`
  }), B.ledger_agg) : ['- none']))
  const rec = (l.recent || []).slice(-B.ledger_recent).reverse()
  out.push(`last results (newest first):`)
  out.push(...(rec.length ? rec.map(e => '- ' + result(e, now)) : ['- none']))
  return out.join('\n')
}

function body(s) {
  const b = s.body || {}
  const out = [`hp ${b.hp}/20, food ${b.food}/20, saturation ${b.sat ?? '?'}, xp level ${b.xp ?? 0}, armor ${b.armor ?? 0}${b.air != null && b.air < 300 ? `, air ${b.air}/300` : ''}`]
  out.push('effects: ' + ((b.effects || []).map(e => `${e.name} ${e.amp + 1} (${dur(e.dur_s)})`).join(', ') || 'none'))
  const w = b.worn || {}
  out.push(`held: ${b.held || 'nothing'}, offhand: ${b.offhand || 'nothing'}, worn: ${['head', 'chest', 'legs', 'feet'].map(k => w[k] || '-').join(' / ')}`)
  out.push('durability: ' + ((b.tools || []).map(t => `${t.name} ${t.dur}/${t.max}${t.enchants ? ' [' + t.enchants.join(', ') + ']' : ''}`).join(', ') || 'none'))
  return out.join('\n')
}

const TOOL_RE = /(_pickaxe|_axe|_shovel|_hoe|_sword|_spear|_helmet|_chestplate|_leggings|_boots|^bow$|^crossbow$|^shears$|^flint_and_steel$|^fishing_rod$|^shield$|^trident$|^mace$|_bucket$|^bucket$|^compass$|^clock$|^spyglass$|^brush$)/
const ORE_RE = /^(raw_|.*_ingot$|.*_nugget$|coal$|charcoal$|diamond$|emerald$|lapis_lazuli$|redstone$|quartz$|netherite_scrap$|amethyst_shard$|.*_ore$|ancient_debris$)/
function inventory(s, now, B) {
  const inv = s.inventory || {}
  const a = s.affordances || {}
  const edible = new Set(a.edible || []), place = new Set(a.placeable || [])
  const groups = { tools: [], ores: [], food: [], blocks: [], misc: [] }
  for (const [k, v] of Object.entries(inv.items || {}).sort()) {
    const g = TOOL_RE.test(k) ? 'tools' : ORE_RE.test(k) ? 'ores' : edible.has(k) ? 'food' : place.has(k) ? 'blocks' : 'misc'
    groups[g].push(`${k} x${v}`)
  }
  const out = Object.entries(groups).map(([g, l]) => `${g}: ${l.join(', ') || '-'}`)
  out.push(`free slots: ${inv.free_slots ?? '?'}/36`)
  const ch = inv.chests || []
  out.push(`known chests: ${ch.length ? '' : 'none'}`.trimEnd())
  out.push(...cap(ch.map(c => `- ${c.at}: ${counts(c.items)}${c.seen_t != null ? ` (seen ${ago(c.seen_t, now)})` : ''}`), B.chests))
  return out.join('\n')
}

function affordances(s, now, B) {
  const a = s.affordances || {}
  const out = []
  const cr = a.craftable || []
  const by = st => cr.filter(c => (c.station || 'hand') === st)
  out.push(`craftable now by hand (2x2): ${cap(by('hand').map(c => `${c.item} x${c.max}`), B.craftable).join(', ') || 'nothing'}`)
  out.push(`craftable now at a crafting_table (3x3): ${cap(by('crafting_table').map(c => `${c.item} x${c.max}`), B.craftable).join(', ') || 'nothing'}`)
  const soon = a.craftable_soon || []
  out.push(`one or two steps away: ${soon.length ? '' : 'nothing'}`.trimEnd())
  out.push(...cap(soon.map(x => `- ${x.item}: missing ${counts(x.missing)}${x.steps ? ' (makeable from inventory)' : ''}`), B.soon))
  out.push('smeltable: ' + ((a.smeltable || []).map(i => `${i} -> ${[...new Set(cooked(i).map(c => c.out))].join('/') || '?'}`).join(', ') || 'nothing'))
  out.push('edible: ' + ((a.edible || []).join(', ') || 'nothing'))
  out.push('placeable: ' + ((a.placeable || []).join(', ') || 'nothing'))
  out.push('stations seen nearby: ' + ((a.stations || []).map(x => `${x.kind} ${P(x.pos)}`).join(', ') || 'none'))
  return out.join('\n')
}

function clock(tod) {
  const ph = tod < 12000 ? ['day', 12000, 'dusk'] : tod < 13000 ? ['dusk', 13000, 'night'] : tod < 23000 ? ['night', 23000, 'dawn'] : ['dawn', 24000, 'day']
  return `${ph[0]}, ${ph[2]} in ${dur((ph[1] - tod) / 20)}`
}

function surroundings(s, now, B) {
  const u = s.surroundings || {}
  const out = []
  out.push(`pos ${P(u.pos)} in ${u.dimension || 'overworld'}, biome ${u.biome || '?'}, facing ${u.facing || '?'}`)
  out.push(`day ${u.day ?? '?'}, time ${u.time} (${clock(u.time || 0)}), weather ${u.weather || 'clear'}, light ${u.light ?? '?'}, ${u.sky ? 'open sky' : 'no sky above'}`)
  out.push('flags: ' + ((u.flags || []).join(', ') || 'none'))
  const sl = u.slice
  if (sl && sl.layers) {
    const [sx, , sz] = sl.size, o = sl.origin
    const hx = (sx - 1) / 2, hz = (sz - 1) / 2
    const base = sl.y_from != null ? sl.y_from : o[1] // y of the first (bottom) layer; default = feet level
    out.push(`local slice: x${o[0] - hx}..${o[0] + hx} (west->east), z${o[2] - hz}..${o[2] + hz} (north->south), top layer first, legend: ${Object.entries(sl.legend).map(([k, v]) => `${k}=${v}`).join(' ')}`)
    for (let i = sl.layers.length - 1; i >= 0; i--) {
      const y = base + i
      out.push(`  y${y}${y === o[1] ? ' (feet)' : ''}${y === o[1] + 1 ? ' (head)' : ''}:`)
      for (const row of sl.layers[i]) out.push('    ' + row)
    }
  }
  const bl = u.blocks || []
  out.push(`blocks of interest within 32 that you have seen (nearest first, ${bl.length}):`)
  const vy = b => { const dy = b.pos[1] - (u.pos || b.pos)[1]; return dy === 0 ? '' : dy > 0 ? ` ${dy} above` : ` ${-dy} below` }
  out.push(...(bl.length ? cap(bl.map(b => `- ${b.name}${b.n > 1 ? ' x' + b.n : ''} ${P(b.pos)} ${b.dist}m ${d(b.dir)}${vy(b)}${b.visible ? '' : ' (seen before, not in sight now)'}`), B.blocks) : ['- none']))
  const en = u.entities || []
  // hostiles, dropped items and anything within 16 one per line; farther passive mobs grouped by kind
  const solo = en.filter(e => e.hostile || e.item || e.dist <= 16)
  const grouped = new Map()
  for (const e of en) if (!solo.includes(e)) {
    const k = e.ref.split('.')[0]
    if (!grouped.has(k)) grouped.set(k, [])
    grouped.get(k).push(e)
  }
  const lvl = e => e.dy == null ? '' : e.dy === 0 ? ' same level' : e.dy > 0 ? ` ${e.dy} above` : ` ${-e.dy} below`
  const lines = solo.map(e => e.item ? `- ${e.ref} dropped ${e.item} x${e.count} ${e.dist}m ${d(e.dir)}${lvl(e)}`
    : `- ${e.ref} ${e.dist}m ${d(e.dir)}${lvl(e)}${e.hostile ? ' HOSTILE' : ''}${e.approaching ? ' approaching' : ''}${e.hp != null ? ` hp ${e.hp}` : ''}${e.held ? ' holding ' + e.held : ''}`)
  for (const [k, l] of grouped) {
    const dirs = [...new Set(l.map(e => d(e.dir)))].join('/')
    lines.push(l.length === 1 ? `- ${l[0].ref} ${l[0].dist}m ${d(l[0].dir)}${lvl(l[0])}` : `- ${k} x${l.length} ${l[0].dist}-${l[l.length - 1].dist}m ${dirs} (nearest ${l[0].ref})`)
  }
  out.push(`entities within 48 (${en.length}):`)
  out.push(...(lines.length ? cap(lines, B.entities) : ['- none']))
  const pl = u.players || []
  out.push('players: ' + (pl.map(p => `${p.name} ${p.dist}m ${d(p.dir)}${p.held ? ' holding ' + p.held : ''}`).join(', ') || 'none'))
  return out.join('\n')
}

function event(e, now) {
  const t = ago(e.t, now)
  switch (e.kind) {
    case 'result': return 'result ' + result(e, now).replace(t + ' ', '') + ` (${t})`
    case 'gain': return `${t} gained ${signed(e.items)}${e.why ? ` during \`${e.why}\`` : ''}`
    case 'loss': return `${t} lost ${counts(e.items)}${e.why ? ` during \`${e.why}\`` : ''}`
    case 'damage': return `${t} took ${e.amount} damage from ${e.source || 'unknown'}, hp now ${e.hp}`
    case 'death': return `${t} DIED at ${P(e.pos)}: ${e.cause}${e.lost && Object.keys(e.lost).length ? ' (dropped ' + counts(e.lost) + ')' : ''}`
    case 'respawn': return `${t} respawned${e.pos ? ' at ' + P(e.pos) : ''}`
    case 'chat': return `${t} ${e.whisper ? 'whisper from' : 'chat'} <${e.from}> ${e.text}`
    case 'sound': return `${t} heard ${e.name}${e.dist != null ? ` ${e.dist}m ${d(e.dir)}` : ''}`
    case 'entity_appear': return `${t} ${e.ref} appeared ${e.dist}m ${d(e.dir)}`
    case 'entity_leave': return `${t} ${e.ref} left (last ${e.dist}m ${d(e.dir)})`
    case 'time': return `${t} it is now ${e.what}`
    case 'weather': return `${t} weather now ${e.what || '?'}`
    case 'surprise': return `${t} SURPRISE: expected \`${e.expect}\` but ${e.unmet.map(u => `${u.cond} -> actual ${u.actual}`).join('; ')}`
    case 'interrupt': return `${t} interrupted${e.detail ? ': ' + e.detail : ''}`
    case 'goal': return `${t} goal ${e.op || ''} ${e.text || ''}`.trimEnd()
    case 'note': return `${t} noted: ${e.text || ''}`
    case 'tool_answer': return `${t} tool ${e.tool}: ${e.answer}`
    case 'invalid_output': return `${t} YOUR OUTPUT WAS INVALID: ${e.error}`
    case 'reflex': return `${t} reflex ${e.what}${e.detail ? ': ' + e.detail : ''}`
    case 'mind': return `${t} mind says: ${e.text}`
    case 'strategist': return `${t} strategist says: ${e.text}`
    case 'order': return `${t} order: ${e.text || JSON.stringify(e)}`
    default: return `${t} ${e.kind} ${JSON.stringify(e)}`
  }
}

function events(s, now, B) {
  const ev = (s.events || []).slice().sort((a, b) => a.t - b.t)
  const shown = ev.length > B.events ? ev.slice(-B.events) : ev
  const out = [`since your last call (${ev.length}, oldest first):`]
  if (ev.length > shown.length) out.push(`(${ev.length - shown.length} older events dropped)`)
  out.push(...(shown.length ? shown.map(e => '- ' + event(e, now)) : ['- nothing']))
  return out.join('\n')
}

function nowSection(s, now) {
  const n = s.now || {}
  const out = []
  if (n.running) out.push(`running: \`${n.running.src}\` for ${dur((now - n.running.started_t) / 1000)}${n.running.progress ? ', progress ' + n.running.progress : ''}`)
  else out.push('running: nothing (idle)')
  if (n.expect) out.push(`your expectation: \`${n.expect.src}\`${n.expect.deadline_t != null ? `, deadline in ${dur(Math.max(0, n.expect.deadline_t - now) / 1000)}` : ''}`)
  out.push(`this is a ${n.call || 'decision'} call, ${n.since_last_ms ?? '?'} ms since the previous call`)
  return out.join('\n')
}

const SECTIONS = { MANUAL: () => manual(), MEMORY: memory, MAP: map, EPISODE: episode, GOALS: goals, LEDGER: ledger,
  BODY: body, INVENTORY: inventory, AFFORDANCES: affordances, SURROUNDINGS: surroundings, EVENTS: events, NOW: nowSection }

// prev: {NAME: stamp} of the previous render sent to the model (diff mode), or null for a full render
function render(state, { prev = null, budgets = {} } = {}) {
  const B = { ...BUDGETS, ...budgets }
  const now = state.meta.t
  const sections = ORDER.map(name => {
    COARSE = !ALWAYS.has(name)
    const body = SECTIONS[name](state, now, B)
    COARSE = false
    const st = stamp(body)
    const same = !!prev && !ALWAYS.has(name) && prev[name] === st
    const text = same ? `## ${name} [${st}] unchanged` : `## ${name} [${st}]\n${body}`
    return { name, stamp: st, text, same }
  })
  return { version: VERSION, text: sections.map(s => s.text).join('\n\n') + '\n', sections, stamps: Object.fromEntries(sections.map(s => [s.name, s.stamp])) }
}

module.exports = { render, manual, VERSION, ORDER, BUDGETS }

if (require.main === module) {
  const fs = require('fs')
  const a = process.argv.slice(2)
  const li = a.indexOf('--log')
  if (li < 0) {
    const st = JSON.parse(fs.readFileSync(a[0] || `${__dirname}/../spec/golden/state_example.json`, 'utf8'))
    process.stdout.write(render(st).text)
  } else {
    const every = +(a[a.indexOf('--every') + 1] || 1) || 1
    const readline = require('readline')
    const rl = readline.createInterface({ input: fs.createReadStream(a[li + 1]) })
    let prev = null, i = 0
    rl.on('line', line => {
      if (!line.includes('"state"')) return
      const o = JSON.parse(line)
      if (!o.state) return
      const full = render(o.state)
      const diff = prev ? render(o.state, { prev }) : full
      prev = full.stamps
      if (i++ % every) return
      const sec = r => Object.fromEntries(r.sections.map(s => [s.name, s.text]))
      process.stdout.write(JSON.stringify({ call_id: o.call_id, kind: o.kind, full: sec(full), diff: sec(diff) }) + '\n')
    })
  }
}
