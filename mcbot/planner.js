// B2 — recipe planner. plan(target, n, ctx) -> ordered sub-tasks from the current inventory.
// Stateless: recomputed every tick from the real inventory, so it never drifts from the world.
// Steps: {do:'collect', item, n, blocks:[...], tier} | {do:'craft', item, n (crafts), table}
//        {do:'place', item} | {do:'smelt', item, input, n, fuel}
// ctx: { inv: {name: count}, near: {blockName: dist}, wood: 'oak' }
'use strict'

const PICK_TIER = { wooden_pickaxe: 1, golden_pickaxe: 1, stone_pickaxe: 2, iron_pickaxe: 3, diamond_pickaxe: 4, netherite_pickaxe: 5 }
const PICK_FOR_TIER = { 1: 'wooden_pickaxe', 2: 'stone_pickaxe', 3: 'iron_pickaxe', 4: 'diamond_pickaxe' }
// minecraft-data has no furnace recipes: output -> input
const SMELT = {
  iron_ingot: 'raw_iron', gold_ingot: 'raw_gold', copper_ingot: 'raw_copper', glass: 'sand', stone: 'cobblestone',
  smooth_stone: 'stone', charcoal: 'oak_log', cooked_beef: 'beef', cooked_porkchop: 'porkchop',
  cooked_chicken: 'chicken', cooked_mutton: 'mutton', cooked_cod: 'cod', cooked_salmon: 'salmon',
  baked_potato: 'potato', brick: 'clay_ball',
}
// always gathered, never crafted (avoids raw_iron <- raw_iron_block <- raw_iron cycles)
const RAW = new Set(['cobblestone', 'cobbled_deepslate', 'coal', 'raw_iron', 'raw_gold', 'raw_copper', 'diamond', 'emerald',
  'redstone', 'lapis_lazuli', 'sand', 'gravel', 'flint', 'clay_ball', 'string', 'leather', 'wheat', 'sugar_cane',
  'beef', 'porkchop', 'chicken', 'mutton', 'feather', 'bone', 'apple'])
// preferred ingredient variants when a recipe has several (furnace: cobblestone vs cobbled_deepslate...)
const COMMON = new Set(['cobblestone', 'stick', 'coal', 'iron_ingot'])
// safe to merge into their first occurrence (ingredients are hoisted too, so order still holds)
const HOISTABLE = item => /_(planks|log)$/.test(item) || item === 'stick'
const STATIONS = new Set(['crafting_table', 'furnace'])
const MAX_DEPTH = 12

function createPlanner(mcData) {
  const nameOf = id => mcData.items[id]?.name
  // item -> natural blocks that drop it (+ pickaxe tier needed)
  const sources = {}
  for (const b of mcData.blocksArray) {
    for (const d of b.drops || []) {
      const it = nameOf(typeof d === 'object' ? d.drop?.id ?? d.id : d)
      if (!it) continue
      const tools = Object.keys(b.harvestTools || {}).map(nameOf).filter(n => n in PICK_TIER).map(n => PICK_TIER[n])
      ;(sources[it] ||= []).push({ block: b.name, tier: tools.length ? Math.min(...tools) : 0 })
    }
  }
  // prefer the block that drops itself / is the "natural" one: stone before cobblestone wall etc.
  for (const k in sources) sources[k].sort((a, b) => a.tier - b.tier || (a.block === k ? -1 : 0) - (b.block === k ? -1 : 0))
  sources.cobblestone = [{ block: 'stone', tier: 1 }, { block: 'cobblestone', tier: 1 }, { block: 'deepslate', tier: 1 }]
  for (const k of ['coal', 'raw_iron', 'raw_gold', 'raw_copper', 'diamond', 'redstone', 'lapis_lazuli', 'emerald'])
    sources[k] = (sources[k] || []).filter(s => s.block.endsWith('_ore'))
  sources.flint = [{ block: 'gravel', tier: 0 }]
  sources.wheat = [{ block: 'wheat', tier: 0 }] // mature crop; farming itself is a B3 skill

  const recipesOf = name => {
    const it = mcData.itemsByName[name]
    return it ? (mcData.recipes[it.id] || []) : []
  }
  const ingredientsOf = r => {
    const c = {}
    const ids = r.inShape ? r.inShape.flat() : r.ingredients
    for (let id of ids) {
      if (Array.isArray(id)) id = id[0]
      if (id == null) continue
      const n = nameOf(typeof id === 'object' ? id.id : id)
      if (n) c[n] = (c[n] || 0) + 1
    }
    return c
  }
  const needsTable = r => r.inShape ? (r.inShape.length > 2 || r.inShape.some(row => row.length > 2)) : r.ingredients.length > 4

  function plan(target, count = 1, ctx = {}) {
    const inv = { ...(ctx.inv || {}) }
    const near = ctx.near || {}
    const wood = ctx.wood || pickWood(inv, near)
    const placed = { crafting_table: near.crafting_table !== undefined, furnace: near.furnace !== undefined }
    const steps = []
    let error = null
    const push = s => {
      const last = steps[steps.length - 1]
      if (last && last.do === s.do && last.item === s.item && s.do !== 'place') last.n += s.n
      else steps.push(s)
    }
    const pickTier = () => Math.max(0, ...Object.keys(inv).filter(n => inv[n] > 0).map(n => PICK_TIER[n] || 0))

    const chooseRecipe = rs => {
      let best = null, bestScore = -Infinity
      for (const r of rs) {
        const ing = ingredientsOf(r)
        let s = 0
        for (const [n, c] of Object.entries(ing)) {
          s += Math.min(inv[n] || 0, c) * 10
          if (n.startsWith(wood + '_')) s += 3 // matches the wood we have / see
          if (/^(crimson|warped|bamboo)_/.test(n)) s -= 20 // nether / bamboo wood: not in overworld forests
          if (COMMON.has(n)) s += 5
          else if (/deepslate|blackstone/.test(n)) s -= 5
        }
        if (s > bestScore) { best = r; bestScore = s }
      }
      return best
    }

    function ensureStation(name, depth) {
      if (placed[name]) return
      need(name, 1, depth + 1)
      push({ do: 'place', item: name, n: 1 })
      placed[name] = true
    }
    function ensureTier(tier, depth) {
      if (tier <= 0 || pickTier() >= tier) return
      const tool = PICK_FOR_TIER[tier]
      need(tool, 1, depth + 1)
      inv[tool] = (inv[tool] || 0) + 1 // tools are kept, not consumed
    }

    const visiting = new Set()
    function need(item, n, depth = 0) {
      if (error || n <= 0) return
      const take = Math.min(inv[item] || 0, n)
      if (take) { inv[item] -= take; n -= take }
      if (n === 0) return
      if (depth > MAX_DEPTH || visiting.has(item)) return gather(item, n, depth)
      visiting.add(item)
      try {
        if (SMELT[item]) {
          let input = SMELT[item]
          if (input === 'oak_log') input = wood + '_log'
          need(input, n, depth + 1)
          const fuel = (inv.coal || 0) > 0 || near.coal_ore !== undefined ? 'coal' : (inv.charcoal || 0) > 0 ? 'charcoal' : wood + '_planks'
          need(fuel, fuel.endsWith('_planks') ? Math.ceil(n / 1.5) : Math.ceil(n / 8), depth + 1)
          ensureStation('furnace', depth)
          push({ do: 'smelt', item, input, n, fuel })
          return
        }
        const rs = RAW.has(item) ? [] : recipesOf(item)
        if (!rs.length) return gather(item, n, depth)
        const r = chooseRecipe(rs)
        const per = r.result.count || 1
        const times = Math.ceil(n / per)
        for (const [ing, c] of Object.entries(ingredientsOf(r))) need(ing, c * times, depth + 1)
        const table = needsTable(r)
        if (table) ensureStation('crafting_table', depth)
        push({ do: 'craft', item, n: times, table })
        inv[item] = (inv[item] || 0) + times * per - n
      } finally { visiting.delete(item) }
    }
    function gather(item, n, depth) {
      const src = sources[item]
      if (!src || !src.length) { error = `don't know how to get ${item}`; return }
      // among sources, prefer one visible nearby, then the lowest tier
      const seen = src.filter(s => near[s.block] !== undefined).sort((a, b) => near[a.block] - near[b.block])
      const tier = Math.min(...src.map(s => s.tier))
      ensureTier(tier, depth)
      let blocks = [...new Set([...seen, ...src.filter(s => s.tier <= Math.max(tier, pickTier()))].map(s => s.block))]
      // any wood will do: the next replan switches the planks variant to whatever log was actually collected
      if (item.endsWith('_log')) blocks = [...new Set([...blocks, ...Object.keys(near).filter(n => n.endsWith('_log')).sort((a, b) => near[a] - near[b])])]
      push({ do: 'collect', item, n, blocks, tier })
    }

    need(target, count)
    hoist(steps)
    // inventory that already satisfies the target -> empty plan
    return { target, count, steps, error, done: !error && steps.length === 0 }
  }

  // merge later collects / planks / sticks into their first occurrence: 1x "collect 3 oak_log" instead of 3x "collect 1"
  function hoist(steps) {
    for (let i = 0; i < steps.length; i++) {
      const a = steps[i]
      if (!(a.do === 'collect' || (a.do === 'craft' && HOISTABLE(a.item)))) continue
      for (let j = steps.length - 1; j > i; j--) {
        const b = steps[j]
        if (b.do === a.do && b.item === a.item) { a.n += b.n; steps.splice(j, 1) }
      }
    }
    // re-merge neighbours made adjacent by the removal
    for (let i = steps.length - 1; i > 0; i--) {
      const a = steps[i - 1], b = steps[i]
      if (a.do === b.do && a.item === b.item && a.do !== 'place') { a.n += b.n; steps.splice(i, 1) }
    }
  }

  // which wood type to plan with: logs in inventory first, then nearest log block
  function pickWood(inv, near) {
    const logs = Object.keys(inv).filter(n => n.endsWith('_log') && inv[n] > 0).sort((a, b) => inv[b] - inv[a])
    if (logs.length) return logs[0].replace(/_log$/, '')
    const seen = Object.keys(near).filter(n => n.endsWith('_log')).sort((a, b) => near[a] - near[b])
    if (seen.length) return seen[0].replace(/_log$/, '')
    const planks = Object.keys(inv).filter(n => n.endsWith('_planks') && inv[n] > 0)
    return planks.length ? planks[0].replace(/_planks$/, '') : 'oak'
  }

  const fmt = s => s.do === 'collect' ? `collect ${s.n} ${s.item}` : s.do === 'smelt' ? `smelt ${s.n} ${s.input}->${s.item}`
    : s.do === 'place' ? `place ${s.item}` : `craft ${s.item}${s.n > 1 ? ' x' + s.n : ''}`

  return { plan, pickWood, fmt, sources, PICK_TIER, isStation: n => STATIONS.has(n) }
}

module.exports = { createPlanner, SMELT, PICK_TIER }
