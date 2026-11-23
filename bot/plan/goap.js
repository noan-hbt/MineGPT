// GOAP-style planner for item goals (have(X)>=N): backward chaining over spec/recipes.json (craft, smelt) and
// minecraft-data block drops (mine), with a simulated inventory, stations (crafting_table, furnace) and harvest tools.
// Pure: the world is given as callbacks, so it runs in tests and on the live bot (plan/live.js).
//   planGoal(goals, world, {force}) -> {ok, steps:[{src, cost, unseen?}], cost, choices, force} | {ok:false, error}
//   alternatives(goals, world, {max:3}) -> [plan, ...]  (A = cheapest choices, B/C = another option at a choice point)
// goals: [{opts:[item ids], n}]  (opts > 1 = a tag: any member counts)
// world: {inv: {item: count}, known(block) -> distance | null, station(name) -> bool, dropped?(item) -> count lying around}
// Facts only: the plan is what the recipes and the known world allow, with a rough duration. The model picks it,
// edits it or ignores it.
'use strict'
const R = require('../../spec/recipes.json')
const N = require('../../spec/names.json')
const md = require('minecraft-data')(N.version)

// ---------------------------------------------------------------- static knowledge
const CRAFTED = new Set(R.crafting.map(r => r.out))
const byOut = new Map()
for (const r of R.crafting) (byOut.get(r.out) || byOut.set(r.out, []).get(r.out)).push(r)
// out -> [{in:[...], verb, station}] : furnace, blast furnace (ores, x2 speed), smoker (food, x2 speed)
const smeltOf = new Map()
for (const [kind, verb, station] of [['smelting', 'smelt', 'furnace'], ['blasting', 'blast', 'blast_furnace'], ['smoking', 'smoke', 'smoker']])
  for (const r of R[kind]) (smeltOf.get(r.out) || smeltOf.set(r.out, []).get(r.out)).push({ ...r, verb, station })
// item -> natural blocks that drop it (a block that is itself a crafting output is a placed block, not a source)
const dropSrc = new Map()
const toolsOf = new Map() // block -> [tool ids] (empty = hand)
// placed forms of items (wall torch, potted plant, crop stem...) are not natural sources
const PLACED = /wall_|^potted_|_cauldron$|^tripwire$|^redstone_wire$|candle_cake$|_stem$|^attached_|^farmland$|^dirt_path$|_crop$|^air$/
for (const b of md.blocksArray) {
  if (CRAFTED.has(b.name) || PLACED.test(b.name) || !b.drops || !b.drops.length) continue
  const tools = Object.keys(b.harvestTools || {}).map(id => md.items[id].name)
  toolsOf.set(b.name, tools)
  for (const d of b.drops) {
    const it = typeof d === 'object' ? md.items[d.drop ? d.drop.id ?? d.drop : d.id] : md.items[d]
    if (!it) continue
    ;(dropSrc.get(it.name) || dropSrc.set(it.name, []).get(it.name)).push(b.name)
  }
}
// random drops minecraft-data does not list: item -> [{block, rate}] (mined with until(have) since the yield varies)
const RANDOM_DROPS = { flint: [{ block: 'gravel', rate: 0.1 }], apple: [{ block: 'oak_leaves', rate: 0.005 }, { block: 'dark_oak_leaves', rate: 0.005 }],
  wheat_seeds: [{ block: 'short_grass', rate: 0.125 }, { block: 'tall_grass', rate: 0.125 }] }
// fuel value in items smelted (same table as skills/craft.js)
const FUEL = { coal: 8, charcoal: 8, coal_block: 80, blaze_rod: 12, dried_kelp_block: 20, lava_bucket: 100 }
const fuelValue = n => FUEL[n] || (/_(planks|log|wood|stem)$/.test(n) ? 1.5 : 0)
const STATION_OF = { 3: 'crafting_table' }

// rough durations (s), used to rank options and to report the plan length
const T = { block: 3, unseen: 45, craft: 1.5, place: 2, smelt: 10 }

// ---------------------------------------------------------------- unit costs (world-free, fixed point)
let BASE = null
function baseCosts() {
  if (BASE) return BASE
  const c = new Map()
  const get = n => c.has(n) ? c.get(n) : Infinity
  const set = (n, v) => { if (v < get(n) - 1e-9) { c.set(n, v); return true } return false }
  const toolCost = b => { const ts = toolsOf.get(b) || []; return ts.length ? Math.min(...ts.map(get)) / 8 : 0 }
  for (let pass = 0, changed = true; changed && pass < 40; pass++) {
    changed = false
    for (const [item, bs] of dropSrc) for (const b of bs) changed = set(item, T.block + T.unseen / 8 + toolCost(b)) || changed
    for (const r of R.crafting) {
      let s = T.craft
      for (const g of r.ing) s += g.n * Math.min(...g.opts.map(get))
      changed = set(r.out, s / r.n + (r.grid === 3 ? 0.5 : 0)) || changed
    }
    for (const r of R.smelting) changed = set(r.out, T.smelt + Math.min(...r.in.map(get)) + 0.5) || changed
  }
  BASE = c
  return c
}
const unit = n => baseCosts().has(n) ? baseCosts().get(n) : Infinity

// ---------------------------------------------------------------- planner
class PlanFail extends Error {}

function planGoal(goals, world, { force = {}, maxDepth = 40 } = {}) {
  const inv = Object.assign({}, world.inv)
  const res = {} // reserved for a pending consumer
  const placed = new Set()
  const collected = {}
  const steps = []
  const choices = [] // [{key, options:[label], chosen}]
  const seenMemo = new Map()
  const known = b => { if (!seenMemo.has(b)) seenMemo.set(b, world.known(b)); return seenMemo.get(b) }
  const avail = n => (inv[n] || 0) - (res[n] || 0)
  const availAny = opts => opts.reduce((s, o) => s + Math.max(0, avail(o)), 0)
  const push = (src, cost, extra = {}) => {
    const last = steps[steps.length - 1]
    const m = /^(craft|mine) (\S+) n=(\d+)$/.exec(src)
    const lm = last && /^(craft|mine) (\S+) n=(\d+)$/.exec(last.src)
    if (m && lm && m[1] === lm[1] && m[2] === lm[2]) { last.src = `${m[1]} ${m[2]} n=${+m[3] + +lm[3]}`; last.cost += cost; return }
    steps.push({ src, cost, ...extra })
  }

  // live unit cost: world-aware (initial inventory = free, known blocks = cheap), depth-limited, memoized
  const lmemo = new Map()
  function live(item, d = 0) {
    if ((world.inv[item] || 0) > 0) return 0
    if (lmemo.has(item)) return lmemo.get(item)
    if (d > 3) return unit(item)
    lmemo.set(item, unit(item)) // provisional (cycles)
    let best = Infinity
    for (const b of dropSrc.get(item) || []) {
      const k = known(b), tools = toolsOf.get(b) || []
      const tc = !tools.length || tools.some(t => (world.inv[t] || 0) > 0) ? 0 : Math.min(...tools.map(t => live(t, d + 1))) / 8
      best = Math.min(best, T.block + (k == null ? T.unseen / 8 : k / 40) + tc)
    }
    for (const r of byOut.get(item) || []) {
      let s = T.craft
      for (const g of r.ing) s += g.n * Math.min(...g.opts.map(o => live(o, d + 1)))
      best = Math.min(best, s / r.n)
    }
    for (const { block: b, rate } of RANDOM_DROPS[item] || []) best = Math.min(best, T.block / rate + (known(b) == null ? T.unseen : 0))
    if (world.dropped && world.dropped(item) > 0) best = Math.min(best, 1)
    for (const r of smeltOf.get(item) || []) best = Math.min(best, T.smelt + Math.min(...r.in.map(o => live(o, d + 1))))
    lmemo.set(item, best)
    return best
  }
  const lu = o => avail(o) > 0 ? 0 : live(o)

  // options to make `miss` more `item`, cheapest total first: {label, cost, kind, r|b}
  function options(item, miss, stack) {
    const out = []
    for (const [i, r] of (byOut.get(item) || []).entries()) {
      if (r.ing.some(g => g.opts.every(o => stack.has(o)))) continue
      const times = Math.ceil(miss / r.n)
      let s = T.craft * times
      for (const g of r.ing) s += Math.max(0, g.n * times - availAny(g.opts)) * Math.min(...g.opts.filter(o => !stack.has(o)).map(lu))
      if (isFinite(s)) out.push({ label: `craft#${i + 1}`, cost: s, kind: 'craft', r })
    }
    for (const [i, r] of (smeltOf.get(item) || []).entries()) {
      if (r.in.every(o => stack.has(o))) continue
      const st = placed.has(r.station) || world.station(r.station) ? 0 : trialCost(() => station(r.station, stack, 0))
      const s = (r.verb === 'smelt' ? T.smelt : T.smelt / 2) * miss + st + Math.max(0, miss - availAny(r.in)) * Math.min(...r.in.filter(o => !stack.has(o)).map(lu))
      if (isFinite(s)) out.push({ label: `${r.verb}#${i + 1}`, cost: s, kind: 'smelt', r })
    }
    for (const b of dropSrc.get(item) || []) {
      const d = known(b)
      const tools = toolsOf.get(b) || []
      const hasTool = !tools.length || tools.some(t => (inv[t] || 0) > 0)
      const s = T.block * miss + (d == null ? T.unseen : d / 4) + (hasTool ? 0 : Math.min(...tools.map(lu)))
      if (isFinite(s)) out.push({ label: `mine:${b}`, cost: s, kind: 'mine', b })
    }
    for (const { block: b, rate } of RANDOM_DROPS[item] || []) {
      const d = known(b)
      const s = T.block * Math.ceil(miss / rate) + (d == null ? T.unseen : d / 4)
      out.push({ label: `mine:${b}`, cost: s, kind: 'random', b, rate })
    }
    const lying = world.dropped ? world.dropped(item) - (collected[item] || 0) : 0
    if (lying > 0) out.push({ label: 'collect', cost: 2 + T.block, kind: 'collect', n: Math.min(lying, miss) })
    // ties: the block that is the item itself (oak_log), then stable order
    return out.sort((p, q) => p.cost - q.cost || (q.b === item) - (p.b === item))
  }

  // exact cost of a sub-plan given the current simulated inventory (planned, measured, rolled back)
  function trialCost(f) {
    const z = snap(), nc = choices.length, before = steps.reduce((a, x) => a + x.cost, 0)
    let c
    try { f(); c = steps.reduce((a, x) => a + x.cost, 0) - before } catch (e) { if (!(e instanceof PlanFail)) throw e; c = Infinity }
    restore(z); choices.length = nc
    return c
  }

  const snap = () => ({ inv: { ...inv }, res: { ...res }, col: { ...collected }, placed: new Set(placed), n: steps.length, last: steps.length ? { ...steps[steps.length - 1] } : null })
  const restore = z => {
    for (const k of Object.keys(inv)) delete inv[k]; Object.assign(inv, z.inv)
    for (const k of Object.keys(res)) delete res[k]; Object.assign(res, z.res)
    placed.clear(); z.placed.forEach(x => placed.add(x))
    for (const k of Object.keys(collected)) delete collected[k]; Object.assign(collected, z.col)
    steps.length = z.n; if (z.last) steps[z.n - 1] = z.last
  }

  // make avail(item) >= n; tries the options cheapest first, backtracking when one cannot be completed
  function obtain(item, n, stack, depth) {
    const miss = n - avail(item)
    if (miss <= 0) return
    if (depth > maxDepth) throw new PlanFail(`plan too deep at ${item}`)
    if (stack.has(item)) throw new PlanFail(`cycle at ${item}`)
    let opts = options(item, miss, stack)
    if (!opts.length) throw new PlanFail(`no recipe and no natural block source for ${item} (mob drop, loot or trade: use loot / mob_info)`)
    const f = force[item] && opts.find(o => o.label === force[item])
    if (f) opts = [f, ...opts.filter(o => o !== f)]
    const st = new Set(stack).add(item)
    let err = null
    for (const pick of opts.slice(0, 4)) {
      const z = snap(), nc = choices.length
      try {
        if (pick.kind === 'craft') doCraft(item, pick.r, miss, st, depth)
        else if (pick.kind === 'smelt') doSmelt(item, pick.r, miss, st, depth)
        else if (pick.kind === 'random') doRandom(item, pick, miss)
        else if (pick.kind === 'collect') { inv[item] = (inv[item] || 0) + pick.n; collected[item] = (collected[item] || 0) + pick.n; push(`collect ${item}`, T.block + 2); obtain(item, n, stack, depth) }
        else doMine(item, pick.b, miss, st, depth)
        if (opts.length > 1) choices.splice(nc, 0, { key: item, options: opts.map(o => o.label), chosen: pick.label })
        return
      } catch (e) {
        if (!(e instanceof PlanFail)) throw e
        restore(z); choices.length = nc; err = err || e
      }
    }
    throw err
  }

  // make availAny(opts) >= n, producing the cheapest option
  function obtainAny(opts, n, stack, depth) {
    const have = availAny(opts)
    if (have >= n) return
    const key = 'any:' + opts.join(',')
    let cands = opts.filter(o => !stack.has(o)).map(o => ({ o, c: avail(o) > 0 ? -1 : live(o) }))
      .filter(x => isFinite(x.c)).sort((p, q) => p.c - q.c)
    if (!cands.length) throw new PlanFail(`no way to get any of ${opts.slice(0, 4).join('|')}`)
    if (cands.length > 1 && opts.length > 1) {
      const f = force[key] && cands.find(x => x.o === force[key])
      if (f) cands = [f, ...cands.filter(x => x !== f)]
    }
    let err = null
    for (const { o } of cands.slice(0, 3)) {
      const z = snap(), nc = choices.length
      try {
        obtain(o, Math.max(0, avail(o)) + (n - have), stack, depth + 1)
        if (cands.length > 1) choices.splice(nc, 0, { key, options: cands.slice(0, 4).map(x => x.o), chosen: o })
        return
      } catch (e) {
        if (!(e instanceof PlanFail)) throw e
        restore(z); choices.length = nc; err = err || e
      }
    }
    throw err
  }

  // take n from opts (avail first), releasing reservations
  function consume(opts, n) {
    for (const o of opts) {
      const t = Math.min(n, Math.max(0, avail(o)))
      inv[o] -= t; n -= t
      if (!n) return
    }
    if (n > 0) throw new PlanFail(`internal: short of ${opts[0]} by ${n}`)
  }
  const reserve = (opts, n) => { const r = []; for (const o of opts) { const t = Math.min(n, Math.max(0, avail(o))); if (t) { res[o] = (res[o] || 0) + t; r.push([o, t]); n -= t } } return r }
  const release = r => { for (const [o, t] of r) res[o] -= t }

  function station(name, stack, depth) {
    if (placed.has(name) || world.station(name)) return
    obtain(name, 1, stack, depth + 1)
    consume([name], 1)
    push(`place ${name}`, T.place)
    placed.add(name)
  }

  function doCraft(item, r, miss, stack, depth) {
    const times = Math.ceil(miss / r.n)
    const held = []
    for (const g of r.ing) { obtainAny(g.opts, g.n * times, stack, depth + 1); held.push(reserve(g.opts, g.n * times)) }
    if (r.grid === 3) station(STATION_OF[3], stack, depth)
    held.forEach(release)
    for (const g of r.ing) consume(g.opts, g.n * times)
    inv[item] = (inv[item] || 0) + times * r.n
    push(`craft ${item} n=${times * r.n}`, T.craft * times)
  }

  function doSmelt(item, r, miss, stack, depth) {
    obtainAny(r.in, miss, stack, depth + 1)
    const held = [reserve(r.in, miss)]
    // fuel: carried fuels first (best first), else the cheapest fuel to get
    let need = miss, used = []
    const fuels = Object.keys(inv).filter(f => fuelValue(f) > 0 && avail(f) > 0 && !r.in.includes(f))
      .sort((p, q) => fuelValue(q) - fuelValue(p))
    for (const f of fuels) {
      if (need <= 0) break
      const k = Math.min(avail(f), Math.ceil(need / fuelValue(f)))
      held.push(reserve([f], k)); used.push([f, k]); need -= k * fuelValue(f)
    }
    if (need > 0) {
      const coal = Math.ceil(need / 8), planks = Math.ceil(need / 1.5)
      const cCoal = coal * Math.min(live('coal'), live('charcoal')), cPlank = planks * Math.min(...N.item_tags.planks.map(o => live(o)))
      const [f, k, opts] = cCoal <= cPlank ? ['coal', coal, ['coal', 'charcoal']] : ['planks', planks, N.item_tags.planks]
      obtainAny(opts, k, stack, depth + 1)
      const r2 = reserve(opts, k); held.push(r2); for (const [o, t] of r2) used.push([o, t])
      need = 0
    }
    station(r.station, stack, depth)
    held.forEach(release)
    const input = r.in.find(o => avail(o) > 0) || r.in[0]
    consume(r.in, miss)
    for (const [f, k] of used) consume([f], k)
    inv[item] = (inv[item] || 0) + miss
    const fk = [...new Set(used.map(u => u[0]))]
    push(`${r.verb} ${input} n=${miss}${fk.length === 1 ? ' fuel=' + fk[0] : ''}`, (r.verb === 'smelt' ? T.smelt : T.smelt / 2) * miss)
  }

  function doRandom(item, pick, miss) {
    const target = Math.max(0, avail(item)) + (res[item] || 0) + miss
    if (known(pick.b) == null) push(`explore prefer=${pick.b}`, T.unseen, { unseen: pick.b })
    inv[item] = (inv[item] || 0) + miss
    push(`mine ${pick.b} n=${Math.ceil(miss / pick.rate)} until(have(${item})>=${target})`, T.block * Math.ceil(miss / pick.rate))
  }

  function doMine(item, b, miss, stack, depth) {
    const tools = toolsOf.get(b) || []
    if (tools.length && !tools.some(t => (inv[t] || 0) > 0)) {
      const t = tools.slice().sort((p, q) => unit(p) - unit(q))[0]
      obtain(t, 1, stack, depth + 1)
    }
    const d = known(b)
    if (d == null) push(`explore prefer=${b}`, T.unseen, { unseen: b })
    inv[item] = (inv[item] || 0) + miss
    push(`mine ${b} n=${miss}`, T.block * miss + (d == null ? 0 : d / 4))
  }

  try {
    for (const g of goals) obtainAny(g.opts, g.n, new Set(), 0)
    // re-reserve nothing: goal items are simply held at the end
  } catch (e) {
    if (e instanceof PlanFail) return { ok: false, error: e.message, steps, choices }
    throw e
  }
  const out = compact(steps)
  const cost = out.reduce((s, x) => s + x.cost, 0)
  return { ok: true, steps: out, cost: Math.round(cost), choices, force }
}

// gathering earlier never hurts (same block = same tool, already there at its first occurrence): fold every later
// `mine B` / `explore prefer=B` into the first one, then merge adjacent identical crafts
function compact(steps) {
  const first = new Map(), out = []
  for (const s of steps) {
    const m = /^mine (\S+) n=(\d+)$/.exec(s.src)
    if (m && first.has(m[1])) { const f = first.get(m[1]); f.src = `mine ${m[1]} n=${+/n=(\d+)$/.exec(f.src)[1] + +m[2]}`; f.cost += s.cost; continue }
    if (s.unseen && out.some(x => x.src === s.src)) continue
    const c = { ...s }
    if (m) first.set(m[1], c)
    out.push(c)
  }
  const res = []
  for (const s of out) {
    const m = /^craft (\S+) n=(\d+)$/.exec(s.src), last = res[res.length - 1]
    const lm = last && /^craft (\S+) n=(\d+)$/.exec(last.src)
    if (m && lm && m[1] === lm[1]) { last.src = `craft ${m[1]} n=${+m[2] + +lm[2]}`; last.cost += s.cost } else res.push(s)
  }
  return res
}

// cheapest plan, then one variant per early choice point (second option), distinct, sorted by cost
function alternatives(goals, world, { max = 3 } = {}) {
  const a = planGoal(goals, world)
  if (!a.ok) return [a]
  const out = [a]
  const sig = p => p.steps.map(s => s.src).join(';')
  const seen = new Set([sig(a)])
  for (const ch of a.choices.slice(0, 8)) {
    if (out.length >= max) break
    for (const alt of ch.options.filter(o => o !== ch.chosen).slice(0, 2)) {
      const p = planGoal(goals, world, { force: { [ch.key]: alt } })
      if (p.ok && !seen.has(sig(p))) { seen.add(sig(p)); out.push(p); break }
    }
  }
  // only alternatives in the same league as the cheapest one
  return out.sort((p, q) => p.cost - q.cost).filter(p => p.cost <= 2 * out[0].cost + 20).slice(0, max)
}

// goal condition AST (dsl/cond) -> [{opts, n, rel}] ; only have(...) comparisons joined by &
function goalsOf(cond, idsOf) {
  const parts = cond.and ? cond.and : [cond]
  const out = []
  for (const c of parts) {
    if (c.metric !== 'have' || !['>=', '>', '=='].includes(c.cmp)) return { ok: false, error: 'plan/achieve take have(item)>=N goals joined by & (no |, !, or other metrics)' }
    out.push({ opts: idsOf(c.arg), n: c.value + (c.cmp === '>' ? 1 : 0), rel: !!c.rel })
  }
  return { ok: true, goals: out }
}

const fmtPlan = (p, tag) => p.ok
  ? `${tag ? 'plan ' + tag + ' ' : ''}(~${p.cost}s, ${p.steps.length} steps${p.steps.some(s => s.unseen) ? ', unseen: ' + [...new Set(p.steps.filter(s => s.unseen).map(s => s.unseen))].join(',') : ''}): ` +
    (p.steps.length ? p.steps.map(s => s.src).join('; ') : 'already done')
  : `no plan: ${p.error}`

module.exports = { planGoal, alternatives, goalsOf, fmtPlan, fuelValue, _dropSrc: dropSrc }
