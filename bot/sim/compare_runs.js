// Fidelity guard: compare two run_cards.js logs (e.g. x1 vs lockstep) card by card.
//   node sim/compare_runs.js <a.jsonl> <b.jsonl>   (or --latest A_NAME B_NAME: newest logs with those --name)
// Per card: pass count, ticks mean/sd, damage mean, deaths; flags cards where the two runs disagree.
'use strict'
const fs = require('fs')
const path = require('path')

const DATA = path.resolve(__dirname, '..', '..', 'data', 'own')
function latest(name) {
  const files = []
  for (const d of fs.readdirSync(DATA)) {
    const p = path.join(DATA, d)
    if (!fs.statSync(p).isDirectory()) continue
    for (const f of fs.readdirSync(p)) if (f.endsWith(`_${name}_cards.jsonl`)) files.push(path.join(p, f))
  }
  if (!files.length) throw new Error(`no log for --name ${name}`)
  return files.sort((x, y) => path.basename(x).localeCompare(path.basename(y))).pop()
}
const args = process.argv.slice(2)
const [fa, fb] = args[0] === '--latest' ? [latest(args[1]), latest(args[2])] : args
if (!fa || !fb) { console.error('usage: compare_runs.js a.jsonl b.jsonl | --latest NAME_A NAME_B'); process.exit(2) }

const load = f => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(o => o.type === 'episode')
const A = load(fa), B = load(fb)
const label = f => (JSON.parse(fs.readFileSync(f, 'utf8').split('\n')[0]).lockstep ? 'lock' : 'x1') + ':' + path.basename(f, '.jsonl').slice(17)
const la = label(fa), lb = label(fb)

const mean = xs => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN
const sd = xs => { const m = mean(xs); return xs.length > 1 ? Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1)) : 0 }
const group = eps => eps.reduce((m, e) => ((m[e.id] = m[e.id] || []).push(e), m), {})
const ga = group(A), gb = group(B)
const ids = [...new Set([...Object.keys(ga), ...Object.keys(gb)])].sort()

const stats = eps => {
  const t = eps.map(e => e.ticks), d = eps.map(e => e.damage || 0)
  return { n: eps.length, pass: eps.filter(e => e.outcome === 'success').length, tm: mean(t), ts: sd(t), dm: mean(d), deaths: eps.filter(e => e.died).length }
}
const f1 = x => Number.isNaN(x) ? '-' : x.toFixed(0)
console.log(`A = ${la}  (${fa})\nB = ${lb}  (${fb})\n`)
console.log('card'.padEnd(30) + 'pass A/B'.padEnd(12) + 'ticks A (sd)'.padEnd(16) + 'ticks B (sd)'.padEnd(16) + 'dmg A/B'.padEnd(12) + 'die A/B'.padEnd(9) + 'flags')
const flagged = []
for (const id of ids) {
  const a = stats(ga[id] || []), b = stats(gb[id] || [])
  const flags = []
  if (!a.n || !b.n) { flagged.push(id); console.log(id.padEnd(30) + `missing in ${!a.n ? 'A' : 'B'}`); continue }
  if (a.pass !== b.pass) flags.push('OUTCOME')
  if (a.deaths !== b.deaths) flags.push('DEATHS')
  // ticks: differ by > 20% and more than 2 judge periods (40 ticks), beyond the seed spread
  const dt = Math.abs(a.tm - b.tm)
  if (dt > 40 && dt > 0.2 * Math.max(a.tm, b.tm) && dt > a.ts + b.ts) flags.push('TICKS')
  if (Math.abs(a.dm - b.dm) >= 20) flags.push('DAMAGE') // damage_taken is in tenths of half hearts: 20 = 1 heart
  // per seed outcome mismatches
  const seeds = (ga[id] || []).map(e => e.seed)
  const mism = seeds.filter(s => { const x = (ga[id] || []).find(e => e.seed === s), y = (gb[id] || []).find(e => e.seed === s); return y && x.outcome !== y.outcome })
  if (mism.length) flags.push(`seeds ${mism.join(',')}`)
  if (flags.length) flagged.push(id)
  console.log(id.padEnd(30) + `${a.pass}/${a.n} ${b.pass}/${b.n}`.padEnd(12) + `${f1(a.tm)} (${f1(a.ts)})`.padEnd(16) + `${f1(b.tm)} (${f1(b.ts)})`.padEnd(16) +
    `${a.dm.toFixed(1)}/${b.dm.toFixed(1)}`.padEnd(12) + `${a.deaths}/${b.deaths}`.padEnd(9) + flags.join(' '))
}
const tot = eps => ({ pass: eps.filter(e => e.outcome === 'success').length, n: eps.length, ticks: eps.reduce((s, e) => s + e.ticks, 0), real: eps.reduce((s, e) => s + (e.real_s || 0), 0) })
const ta = tot(A), tb = tot(B)
console.log(`\ntotal A ${ta.pass}/${ta.n}, ${ta.ticks} ticks, ${ta.real.toFixed(0)} s episode time | B ${tb.pass}/${tb.n}, ${tb.ticks} ticks, ${tb.real.toFixed(0)} s`)
console.log(flagged.length ? `${flagged.length} card(s) flagged: ${flagged.join(', ')}` : 'no card flagged')
