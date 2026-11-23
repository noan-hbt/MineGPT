// AST -> canonical DSL source (spec/dsl.md section 5). Used for result/surprise texts, saved routines and logs.
// Round trip: parseStmt(fmtStmt(ast)).ast deep-equals ast (tested in test/interp.js).
'use strict'
const { catalog } = require('./parse')

function fmtValue(v) {
  if (typeof v === 'number') return String(v)
  if (v == null) return '?'
  if (v.name !== undefined) return v.name
  if (v.tag !== undefined) return 'tag:' + v.tag
  if (v.place !== undefined) return '@' + v.place
  if (v.entity !== undefined) return '#' + v.entity + (v.ref !== undefined ? '.' + v.ref : '')
  if (v.dur !== undefined) return v.dur % 3600 === 0 && v.dur ? v.dur / 3600 + 'h' : v.dur % 60 === 0 && v.dur ? v.dur / 60 + 'm' : v.dur + 's'
  if (v.text !== undefined) return JSON.stringify(v.text)
  if (v.pos) return '(' + v.pos.join(',') + ')'
  if (v.box) return '(' + v.box.map(fmtValue).join(',') + ')'
  if (v.list) return '[' + v.list.map(fmtValue).join(',') + ']'
  if (v.op) return fmtStmt(v)
  return JSON.stringify(v)
}

function fmtCond(c, top = true) {
  if (c.or) { const s = c.or.map(x => fmtCond(x, false)).join(' | '); return top ? s : '(' + s + ')' }
  if (c.and) return c.and.map(x => fmtCond(x, false)).join(' & ')
  if (c.not) return '!' + (c.not.flag || c.not.metric ? fmtCond(c.not, false) : '(' + fmtCond(c.not) + ')')
  if (c.flag) return c.flag
  const m = c.arg !== undefined ? `${c.metric}(${fmtValue(c.arg)})` : c.metric
  const v = c.rel ? (c.value < 0 ? '~' + c.value : '+' + c.value) : String(c.value)
  return `${m}${c.cmp}${v}`
}

function fmtExpect(e) { return e.conds.map(c => fmtCond(c)).join(', ') + ' in ' + fmtValue({ dur: e.within }) }

function fmtCall(n) {
  const spec = catalog.verbs[n.verb] || catalog.tools[n.verb] || { args: [], kw: {} }
  const out = [n.verb]
  const pos = new Set(spec.args.map(a => a.name))
  let tail = null
  for (const a of spec.args) {
    if (!(a.name in n.args)) continue
    if (a.type === 'stmt') tail = fmtStmt(n.args[a.name])
    else if (a.type === 'cond') out.push(fmtCond(n.args[a.name]))
    else out.push(fmtValue(n.args[a.name]))
  }
  for (const [k, v] of Object.entries(n.args)) if (!pos.has(k)) out.push(`${k}=${fmtValue(v)}`)
  if (tail) out.push(tail)
  return out.join(' ')
}

function fmtStmt(n) {
  let s
  switch (n.op) {
    case 'call': s = fmtCall(n); break
    case 'seq': s = 'seq[' + n.body.map(fmtStmt).join('; ') + ']'; break
    case 'if': return `if(${fmtCond(n.cond)}) ${fmtStmt(n.then)}` + (n.else ? ' else ' + fmtStmt(n.else) : '')
    case 'repeat': return `repeat(${n.n}) ${fmtStmt(n.body)}`
    case 'routine': return 'routine ' + n.name
    default: return JSON.stringify(n)
  }
  return n.until ? `${s} until(${fmtCond(n.until)})` : s
}

module.exports = { fmtValue, fmtCond, fmtExpect, fmtStmt }
