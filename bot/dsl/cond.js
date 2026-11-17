// Condition evaluation (spec/dsl.md 3-4) against an environment:
//   env.metric(name, arg) -> number ; env.flag(name) -> boolean
// Relative values (+N / ~N) compare against a baseline taken when the statement starts: base = snapshot(cond, env).
'use strict'
const { fmtCond, fmtValue } = require('./fmt')

const keyOf = c => c.arg !== undefined ? `${c.metric}(${fmtValue(c.arg)})` : c.metric

// every metric leaf of a condition (or a list of conditions)
function leaves(c, out = []) {
  if (Array.isArray(c)) { for (const x of c) leaves(x, out); return out }
  if (!c) return out
  if (c.or) leaves(c.or, out)
  else if (c.and) leaves(c.and, out)
  else if (c.not) leaves(c.not, out)
  else if (c.metric) out.push(c)
  return out
}

// baseline values for the relative leaves
function snapshot(c, env) {
  const base = {}
  for (const l of leaves(c)) if (l.rel && !(keyOf(l) in base)) base[keyOf(l)] = env.metric(l.metric, l.arg)
  return base
}

const CMP = { '<': (a, b) => a < b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '>=': (a, b) => a >= b,
  '==': (a, b) => a === b, '!=': (a, b) => a !== b }

function evalCond(c, env, base = {}) {
  if (c.or) return c.or.some(x => evalCond(x, env, base))
  if (c.and) return c.and.every(x => evalCond(x, env, base))
  if (c.not) return !evalCond(c.not, env, base)
  if (c.flag) return !!env.flag(c.flag)
  const v = env.metric(c.metric, c.arg)
  const ref = c.rel ? (base[keyOf(c)] ?? 0) + c.value : c.value
  return CMP[c.cmp](v, ref)
}

// what to report as "actual" for an unmet condition: the delta for relative ones (+2 / -3), the value otherwise
function actual(c, env, base = {}) {
  if (c.flag) return !!env.flag(c.flag)
  if (c.metric) {
    const v = env.metric(c.metric, c.arg)
    if (!c.rel) return round(v)
    const d = round(v - (base[keyOf(c)] ?? 0))
    return (d >= 0 ? '+' : '') + d
  }
  return evalCond(c, env, base)
}
const round = x => typeof x === 'number' ? Math.round(x * 10) / 10 : x

// check an expectation; returns the unmet list [{cond, actual}] (empty = met)
function unmet(expect, env, base) {
  return expect.conds.filter(c => !evalCond(c, env, base)).map(c => ({ cond: fmtCond(c), actual: actual(c, env, base) }))
}

module.exports = { evalCond, snapshot, unmet, actual, leaves, keyOf }
