// Planner <-> live bot: the world callbacks (inventory, known blocks, stations) and the `achieve` verb, a small
// behaviour-tree executor: plan -> run the first step -> replan, until the goal holds, a step fails twice or the
// plan stops making progress. Every failure comes back to the model as a normal result (the model arbitrates).
'use strict'
const C = require('../skills/common')
const { Fail } = C
const P = require('../state/perceive')
const G = require('./goap')

// every natural source block the planner may ask about (block ids resolved per registry, once)
let SOURCES = null
const sourceIds = reg => SOURCES || (SOURCES = [...new Set([...G._dropSrc.values()].flat())].map(n => reg.blocksByName[n]).filter(Boolean).map(b => b.id))

// one block scan per plan (a findBlocks per block kind cost ~70 ms x ~150 kinds = 10 s with the event loop blocked:
// the server dropped the bot). Nearest candidates per kind, visibility checked lazily (seen set or a ray).
function liveWorld(ctx) {
  const bot = ctx.bot, me = bot.entity.position
  const byName = new Map()
  for (const p of bot.findBlocks({ matching: sourceIds(bot.registry), maxDistance: 48, count: 200000 })) {
    const n = bot.blockAt(p, false)?.name
    if (!n) continue
    const l = byName.get(n) || byName.set(n, []).get(n)
    if (l.length < 64) l.push(p)
  }
  const seen = ctx.senses ? ctx.senses.seen : new Set()
  const memo = new Map()
  return {
    inv: P.allCounts(bot),
    known: b => {
      if (memo.has(b)) return memo.get(b)
      const ps = (byName.get(b) || []).sort((p, q) => p.distanceTo(me) - q.distanceTo(me))
      let d = null, rays = 8
      for (const p of ps) {
        if (seen.has(C.k3(p)) || (rays-- > 0 && C.canSee(bot, p))) { d = Math.round(p.distanceTo(me)); break }
      }
      memo.set(b, d)
      return d
    },
    station: s => C.knownBlocks(ctx, [s], { radius: 32, max: 1 }).length > 0,
    // dropped items lying within 16 blocks (what `collect` reaches)
    dropped: item => Object.values(bot.entities).filter(e => e.name === 'item' && e.position.distanceTo(me) <= 16)
      .reduce((s, e) => { const d = e.getDroppedItem && e.getDroppedItem(); return s + (d && d.name === item ? d.count : 0) }, 0),
  }
}

// `place X` from the plan -> a free spot next to the bot (air on solid ground, not the bot's own column): the
// default spot in front can hold the station placed just before
const INTERACTIVE = /table|furnace|smoker|chest|barrel|anvil|door|gate|bed|shulker|hopper|lectern|loom|stonecutter|grindstone|enchanting|brewing|cartography|smithing|composter|bell|trapdoor/
function placeSpot(bot) {
  const f = bot.entity.position.floored()
  // same level first; never on top of a block that opens a window (a click on a table opens it instead of placing)
  for (const dy of [0, -1, 1]) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]) {
      const p = f.offset(dx, dy, dz)
      const cur = bot.blockAt(p, false), below = bot.blockAt(p.offset(0, -1, 0), false), above = bot.blockAt(p.offset(0, 1, 0), false)
      if (cur && cur.boundingBox === 'empty' && !/water|lava/.test(cur.name) && below && below.boundingBox === 'block' && !INTERACTIVE.test(below.name) && above && above.boundingBox === 'empty')
        return `(${p.x},${p.y},${p.z})`
    }
  }
  return null
}

// cond AST -> absolute goals [{opts, n}] (relative +N goals are taken from the counts at `inv`)
function absGoals(cond, inv) {
  const g = G.goalsOf(cond, v => C.idsOf(v, 'item'))
  if (!g.ok) return g
  const sum = opts => opts.reduce((s, o) => s + (inv[o] || 0), 0)
  return { ok: true, goals: g.goals.map(x => ({ opts: x.opts, n: x.rel ? sum(x.opts) + x.n : x.n })) }
}
const met = (goals, inv) => goals.every(g => g.opts.reduce((s, o) => s + (inv[o] || 0), 0) >= g.n)

// tool: plan <goal>
function planTool(ctx, a) {
  const w = liveWorld(ctx)
  const g = absGoals(a.goal, w.inv)
  if (!g.ok) return g.error
  if (met(g.goals, w.inv)) return 'goal already true'
  return G.alternatives(g.goals, w).map((p, i) => G.fmtPlan(p, String(i + 1))).join(' | ')
}

const MAX_STEPS = 60
async function achieve(ctx, a) {
  const bot = ctx.bot
  const g = absGoals(a.goal, P.allCounts(bot))
  if (!g.ok) throw new Fail('invalid', g.error)
  const goals = g.goals
  const done = [], fails = {}
  let force = null, prev = null, stall = 0
  const tail = p => p && p.ok ? `; rest of plan: ${p.steps.slice(1, 6).map(s => s.src).join('; ')}${p.steps.length > 6 ? '; ...' : ''}` : ''
  const hist = () => done.length ? `after ${done.length} step(s) (${done.slice(-4).join('; ')})` : 'before any step'
  for (let i = 0; i < MAX_STEPS; i++) {
    ctx.check()
    const w = liveWorld(ctx)
    if (met(goals, w.inv)) return { detail: `goal reached in ${done.length} step(s)${done.length ? ': ' + done.join('; ') : ''}`.slice(0, 400) }
    let p
    if (force === null) {
      const alts = G.alternatives(goals, w)
      p = alts[Math.max(0, (a.via ?? 1) - 1)] || alts[0]
      force = p.ok ? p.force : {}
    } else p = G.planGoal(goals, w, { force })
    if (!p.ok) throw new Fail(/source/.test(p.error) ? 'no_target_known' : 'missing_items', `no plan ${hist()}: ${p.error}`)
    const step = p.steps[0].src
    ctx.total = done.length + p.steps.length
    ctx.progress(`step ${done.length + 1}/${done.length + p.steps.length}: ${step}`)
    // no progress = same first step again with the same inventory (explore gets 3 tries to reveal its block)
    const sig = step + '|' + JSON.stringify(w.inv)
    stall = sig === prev ? stall + 1 : 0
    prev = sig
    if (stall >= (step.startsWith('explore') ? 3 : 2)) throw new Fail(step.startsWith('explore') ? 'no_target_known' : 'unreachable', `stuck ${hist()}: \`${step}\` changes nothing${tail(p)}`)
    let run = step
    if (/^place \S+$/.test(step)) { const at = placeSpot(bot); if (at) run = `${step} at=${at}` }
    let r
    try { r = await ctx.run(run) } catch (e) {
      if (!(e instanceof Fail)) throw e
      fails[step] = (fails[step] || 0) + 1
      if (fails[step] >= 2 || e.cause === 'inventory_full') throw new Fail(e.cause, `step \`${step}\` failed ${hist()}: ${e.detail || e.message}${tail(p)}`.slice(0, 500))
      continue // replan: the world changed or another option is now cheaper
    }
    if (r && r.status === 'interrupted') return { status: 'interrupted', cause: r.cause, detail: `\`${step}\` interrupted ${hist()}: ${r.detail || r.cause}` }
    done.push(step)
    ctx.done = done.length
  }
  throw new Fail('timeout', `goal not reached after ${MAX_STEPS} steps`)
}

module.exports = { achieve, planTool, liveWorld }
