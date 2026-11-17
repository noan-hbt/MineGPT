// Affordances = facts computed from spec/recipes.json + inventory (no advice). Pure: shared by live bot, sim, tests.
//   affordances(invCounts, {stations}) -> state.affordances
// Multi-option ingredients (any planks) are shown as the vanilla tag that has exactly those items (tag:planks).
'use strict'
const R = require('../../spec/recipes.json')
const N = require('../../spec/names.json')

const BLOCKS = new Set(N.blocks)
const FOODS = new Set(require('minecraft-data')(N.version).foodsArray.map(f => f.name))
const SOON_MAX = 30

// opts list -> display key: single id, or the smallest vanilla item tag with exactly those ids
const tagOf = new Map()
for (const [t, ids] of Object.entries(N.item_tags)) {
  const k = [...ids].sort().join(',')
  if (!tagOf.has(k) || t.length < tagOf.get(k).length) tagOf.set(k, t)
}
const keyOf = opts => opts.length === 1 ? opts[0] : (tagOf.has(opts.join(',')) ? 'tag:' + tagOf.get(opts.join(',')) : opts[0] + '|..')

const avail = (inv, opts) => opts.reduce((s, o) => s + (inv[o] || 0), 0)

// how many times the recipe can be made (overlapping option pools between groups are rare: ignored)
function times(r, inv) {
  let t = Infinity
  for (const g of r.ing) t = Math.min(t, Math.floor(avail(inv, g.opts) / g.n))
  return t
}

const cookOut = {}  // input id -> [{kind, out}]
for (const kind of ['smelting', 'blasting', 'smoking', 'campfire_cooking'])
  for (const r of R[kind]) for (const i of r.in) (cookOut[i] = cookOut[i] || []).push({ kind, out: r.out })

function affordances(inv, { stations = [] } = {}) {
  const craftable = new Map()
  const soon = new Map()
  for (const r of R.crafting) {
    const t = times(r, inv)
    if (t >= 1) {
      const prev = craftable.get(r.out)
      const max = t * r.n
      if (!prev || prev.max < max) craftable.set(r.out, { item: r.out, max, ...(r.grid === 3 ? { station: 'crafting_table' } : {}) })
    }
  }
  // one/two steps away: at most 2 missing ingredient kinds, and either the missing items can be made from the
  // inventory in one craft/cook, or at least half of the items are already in hand
  for (const r of R.crafting) {
    if (craftable.has(r.out) || soon.has(r.out)) continue
    let need = 0, have = 0
    const missing = {}
    for (const g of r.ing) {
      const a = avail(inv, g.opts)
      need += g.n; have += Math.min(a, g.n)
      if (a < g.n) missing[keyOf(g.opts)] = g.n - a
    }
    if (Object.keys(missing).length > 2 || have === 0) continue
    // steps = 2 when every missing item can be made from the inventory by one craft or one cook
    const makeable = r.ing.filter(g => avail(inv, g.opts) < g.n).every(g => g.opts.some(o =>
      craftable.has(o) || Object.keys(inv).some(i => (cookOut[i] || []).some(c => c.out === o))))
    if (!makeable && have * 2 < need) continue
    soon.set(r.out, { item: r.out, missing, ...(makeable ? { steps: 2 } : {}), _f: have / need })
  }
  const soonList = [...soon.values()].sort((a, b) => (b.steps || 0) - (a.steps || 0) || b._f - a._f || a.item.localeCompare(b.item))
    .slice(0, SOON_MAX).map(({ _f, ...x }) => x)
  const items = Object.keys(inv).filter(i => inv[i] > 0).sort()
  return {
    craftable: [...craftable.values()].sort((a, b) => a.item.localeCompare(b.item)),
    craftable_soon: soonList,
    smeltable: items.filter(i => cookOut[i]),
    edible: items.filter(i => FOODS.has(i)),
    placeable: items.filter(i => BLOCKS.has(i)),
    stations,
  }
}

// what an input becomes when cooked: [{kind, out}]
const cooked = item => cookOut[item] || []

module.exports = { affordances, cooked, keyOf }
