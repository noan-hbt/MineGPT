// B5 — hierarchical control. Pure logic (no Mineflayer), unit-tested by test_control.js.
//   reflexes (bot.js, code) > current task (no LLM) > LLM decider (only when there is no task, it ended, or an event fired)
// A task = one skill + arg chosen by the LLM ("collect iron_ore"). Repeatable skills (collect, mine) keep running
// without asking the LLM while they succeed and the plan is still on the same step.
// Anti-loop:
//   bans      an action that failed FAIL_N times within the last FAIL_WINDOW actions is banned for BAN_MS
//             (removed from the grammar and from the hint). Not only consecutive failures: A,B,A,B,A loops count too.
//   watchdog  progress = remaining plan cost (lower is better). STUCK_N actions without a new best -> escalate:
//             ban the most used action of the window for STUCK_BAN_MS and rotate the explore direction.
//             "ok" results that make no progress (collect sand forever) are caught here, not by the bans.
'use strict'

const REPEATABLE = new Set(['collect', 'mine'])
const MAX_RUNS = 6 // a task asks the LLM again after this many repetitions anyway
const FAIL_WINDOW = 12, FAIL_N = 3, BAN_MS = 5 * 60 * 1000
const STUCK_N = 20, STUCK_BAN_MS = 10 * 60 * 1000
const HP_DROP = 4

const isOk = r => /^ok\b/.test(r) || /gone\/killed$/.test(r)

// remaining work of a B2 plan: collect/smelt count their items, craft/place count 1. null = no plan (free-text goal)
function planCost(plan) {
  if (!plan || plan.error) return null
  if (plan.done) return 0
  return plan.steps.reduce((s, st) => s + (st.do === 'collect' || st.do === 'smelt' ? st.n || 1 : 1), 0)
}
// identity of the plan's first step: a repeatable task continues only while this does not change
const stepKey = plan => plan && !plan.error && !plan.done && plan.steps[0] ? `${plan.steps[0].do}:${plan.steps[0].item}` : null

function createController({ now = Date.now } = {}) {
  const bans = new Map() // action -> { until, why }
  const recent = [] // last FAIL_WINDOW { a, ok }
  const window = [] // actions since the last progress (watchdog)
  const last8 = [] // last 8 actions (free-text goals: same action over and over = no progress)
  let task = null, best = Infinity, lastGoal = null, escalations = 0, taskId = 0

  function ban(a, ms, why) { bans.set(a, { until: now() + ms, why }) }
  function isBanned(a) {
    const b = bans.get(a)
    if (b && b.until <= now()) bans.delete(a)
    return !!bans.get(a)
  }
  const banned = () => [...bans.keys()].filter(isBanned)

  // the context a task was started in; a change = event = ask the LLM again
  const ctxOf = o => ({ threat: !!o.threat, night: !!o.night, goal: o.goal, hp: o.hp, step: stepKey(o.plan) })

  // new decision (LLM / hint / user). Returns the task
  function start(action, source, obs) {
    task = { id: ++taskId, action, source, runs: 0, ctx: ctxOf(obs) }
    return task
  }

  // before deciding: should the current task run again without the LLM? -> action string or null (+ why it ended)
  function next(obs) {
    if (!task) return { action: null, why: 'no task' }
    const t = task, c = ctxOf(obs)
    const end = why => { task = null; return { action: null, why, task: t } }
    if (!t.last) return end('not run')
    if (!isOk(t.last)) return end('failed')
    if (c.threat && !t.ctx.threat) return end('event: danger')
    if (c.night !== t.ctx.night) return end('event: ' + (c.night ? 'night' : 'day'))
    if (c.goal !== t.ctx.goal) return end('event: new goal')
    if (c.hp <= t.ctx.hp - HP_DROP) return end('event: hurt')
    const [verb, arg] = t.action.split(' ')
    if (!REPEATABLE.has(verb)) return end('done')
    if (t.runs >= MAX_RUNS) return end('max runs')
    if (!c.step || c.step !== t.ctx.step) return end('plan step changed')
    if (!(obs.options?.[verb] || []).includes(arg)) return end('no longer valid')
    if (isBanned(t.action)) return end('banned')
    return { action: t.action, why: 'continue', task: t }
  }

  // after every action (any source). Returns { banned?, stuck? } so the caller can log / react
  function done(action, result, { cost = null, goal = null, gained = 0 } = {}) {
    const out = {}
    const ok = isOk(result)
    if (task && task.action === action) { task.runs++; task.last = result }
    // sliding failure window -> bans
    recent.push({ a: action, ok }); if (recent.length > FAIL_WINDOW) recent.shift()
    if (!ok && !isBanned(action) && !action.startsWith('wait') && recent.filter(r => r.a === action && !r.ok).length >= FAIL_N) {
      ban(action, BAN_MS, `failed ${FAIL_N}x in ${FAIL_WINDOW}`); out.banned = action
    }
    // watchdog
    if (goal !== lastGoal) { lastGoal = goal; best = Infinity; window.length = 0 }
    if (cost !== null && cost > best + 5) best = cost // setback (death, tool broke): measure from here
    last8.push(action); if (last8.length > 8) last8.shift()
    const progressed = cost !== null ? cost < best : gained > 0 && !(last8.length === 8 && last8.every(a => a === action))
    if (cost !== null && cost < best) best = cost
    if (progressed) { window.length = 0; escalations = 0; return out }
    window.push(action)
    if (window.length >= STUCK_N) {
      const counts = {}
      for (const a of window) counts[a] = (counts[a] || 0) + 1
      const [top] = Object.entries(counts).filter(([a]) => !a.startsWith('wait')).sort((a, b) => b[1] - a[1])[0] || []
      if (top) ban(top, STUCK_BAN_MS, `no progress in ${STUCK_N} actions`)
      escalations++
      out.stuck = { top, counts, escalations }
      window.length = 0
      if (task && task.action === top) task = null
    }
    return out
  }

  return {
    start, next, done, ban, isBanned, banned,
    get task() { return task }, get escalations() { return escalations },
    drop() { task = null },
  }
}

module.exports = { createController, planCost, stepKey, isOk, REPEATABLE, MAX_RUNS, FAIL_N, STUCK_N }
