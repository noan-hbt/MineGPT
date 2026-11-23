// Attempt ledger (anti-repetition): every result event, aggregated by "verb + main argument".
// Pure (no mineflayer): ledger.add(resultEvent) ; ledger.state() -> state.ledger
'use strict'
const { parseStmt, catalog } = require('../dsl/parse')

const RECENT = 30

// "mine iron_ore n=3 near=@vein" -> "mine iron_ore" (verb + first positional arg of the catalog) ;
// composites -> "seq" / "if" / "repeat" ; unparsable -> first word
function keyOf(stmt) {
  const r = parseStmt(stmt)
  if (!r.ok) return String(stmt).trim().split(/[\s[(]/)[0]
  const ast = r.ast
  if (ast.op !== 'call') return ast.op
  const pos = (catalog.verbs[ast.verb] || {}).args || []
  const first = pos.length ? ast.args[pos[0].name] : undefined
  return first !== undefined ? `${ast.verb} ${show(first)}` : ast.verb
}

function show(v) {
  if (v == null || typeof v !== 'object') return String(v)
  if (v.name) return v.name
  if (v.tag) return 'tag:' + v.tag
  if (v.place) return '@' + v.place
  if (v.entity) return '#' + v.entity + (v.ref ? '.' + v.ref : '')
  if (v.pos) return '(' + v.pos.join(',') + ')'
  return JSON.stringify(v)
}

class Ledger {
  constructor() { this.agg = new Map(); this.recent = [] }

  add(ev) {
    if (ev.kind !== 'result') return
    const key = keyOf(ev.stmt)
    const a = this.agg.get(key) || { key, ok: 0, partial: 0, failed: 0, interrupted: 0, causes: {}, last_t: 0 }
    a[ev.status]++
    if (ev.cause) a.causes[ev.cause] = (a.causes[ev.cause] || 0) + 1
    a.last_t = ev.t
    this.agg.delete(key); this.agg.set(key, a) // most recent last
    this.recent.push(ev)
    if (this.recent.length > RECENT) this.recent.shift()
  }

  state() {
    return { agg: [...this.agg.values()].reverse().map(a => ({ ...a, causes: { ...a.causes } })), recent: [...this.recent] }
  }

  toJSON() { return this.state() }
  static from(s) { const l = new Ledger(); for (const a of (s.agg || []).slice().reverse()) l.agg.set(a.key, { ...a }); l.recent = [...(s.recent || [])]; return l }
}

module.exports = { Ledger, keyOf }
