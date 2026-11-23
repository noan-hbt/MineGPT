// Inventory verbs: equip drop store take sort toss_junk keep
'use strict'
const C = require('./common')
const { Fail } = C

const DEST = { hand: 'hand', offhand: 'off-hand', head: 'head', chest: 'torso', legs: 'legs', feet: 'feet' }
function autoDest(n) {
  if (/_helmet$|^turtle_helmet$|^carved_pumpkin$/.test(n)) return 'head'
  if (/_chestplate$|^elytra$/.test(n)) return 'torso'
  if (/_leggings$/.test(n)) return 'legs'
  if (/_boots$/.test(n)) return 'feet'
  if (n === 'shield') return 'off-hand'
  return 'hand'
}

async function equip(ctx, a) {
  const bot = ctx.bot
  const names = C.idsOf(a.item)
  const it = C.findItem(bot, names)
  if (!it) throw new Fail('missing_items', `no ${C.label(a.item)} in inventory`)
  const dest = a.slot ? DEST[a.slot.name] : autoDest(it.name)
  await ctx.wait(bot.equip(it, dest))
  return { detail: `${it.name} -> ${dest}` }
}

async function drop(ctx, a) {
  const bot = ctx.bot
  const names = C.idsOf(a.item)
  const have = C.count(bot, names)
  if (!have) throw new Fail('missing_items', `no ${C.label(a.item)} in inventory`)
  let n = Math.min(a.n ?? have, have)
  const want = n
  for (const name of names) {
    const c = Math.min(n, C.count(bot, [name]))
    if (c <= 0) continue
    await ctx.wait(bot.toss(bot.registry.itemsByName[name].id, null, c))
    n -= c
  }
  if (want < (a.n ?? 0)) return { status: 'partial', cause: 'missing_items', detail: `only had ${want}` }
  return {}
}

const CHESTS = ['chest', 'trapped_chest', 'barrel']
async function openChest(ctx, v) {
  const bot = ctx.bot
  let p
  if (v) p = C.resolve(ctx, v).pos.floored()
  else p = C.knownBlocks(ctx, CHESTS, { radius: 32, max: 1 })[0]
  if (!p) throw new Fail('no_target_known', 'no chest known nearby')
  const b = bot.blockAt(p)
  if (!b || !(CHESTS.includes(b.name) || b.name.endsWith('shulker_box'))) throw new Fail('no_target_known', `no chest at ${C.fmtPos(p)} (${b ? b.name : '?'})`)
  await C.reach(ctx, p)
  const w = await ctx.wait(bot.openContainer(b))
  return { w, p }
}
function remember(ctx, p, w) {
  const items = {}
  for (const it of w.containerItems()) items[it.name] = (items[it.name] || 0) + it.count
  if (ctx.senses) ctx.senses.chests.set(C.k3(p), { at: `(${p.x},${p.y},${p.z})`, items, seen_at: Date.now() })
  return items
}
const fmtCounts = c => Object.entries(c).map(([k, v]) => `${k} x${v}`).join(', ') || 'empty'

async function store(ctx, a) {
  const bot = ctx.bot
  const { w, p } = await openChest(ctx, a.chest)
  let moved = 0, full = false
  try {
    const filter = a.filter ? new Set(listIds(a.filter)) : null
    const keep = new Set(ctx.interp.keep || [])
    const held = bot.heldItem
    for (const it of bot.inventory.items()) {
      if (filter ? !filter.has(it.name) : (keep.has(it.name) || (held && it.slot === held.slot))) continue
      try { await ctx.wait(w.deposit(it.type, null, it.count)); moved += it.count } catch (e) { if (e instanceof C.Abort) throw e; full = true; break }
    }
    const items = remember(ctx, p, w)
    if (!moved) throw new Fail(full ? 'inventory_full' : 'missing_items', full ? 'chest is full' : 'nothing matching to store')
    return full ? { status: 'partial', cause: 'inventory_full', detail: `stored ${moved}, chest full` } : { detail: `stored ${moved} items; chest now: ${fmtCounts(items)}` }
  } finally { try { w.close() } catch {} }
}

async function take(ctx, a) {
  const bot = ctx.bot
  const { w, p } = await openChest(ctx, a.chest)
  try {
    const names = C.idsOf(a.item)
    const inChest = w.containerItems().filter(i => names.includes(i.name)).reduce((s, i) => s + i.count, 0)
    if (!inChest) { const items = remember(ctx, p, w); throw new Fail('missing_items', `no ${C.label(a.item)} in the chest (it has: ${fmtCounts(items)})`) }
    let n = Math.min(a.n ?? inChest, inChest)
    const want = a.n ?? inChest
    for (const name of names) {
      const c = Math.min(n, w.containerItems().filter(i => i.name === name).reduce((s, i) => s + i.count, 0))
      if (c <= 0) continue
      try { await ctx.wait(w.withdraw(bot.registry.itemsByName[name].id, null, c)) } catch (e) { if (e instanceof C.Abort) throw e; throw new Fail('inventory_full', 'take: ' + e.message) }
      n -= c
    }
    remember(ctx, p, w)
    if (inChest < want) return { status: 'partial', cause: 'missing_items', detail: `chest only had ${inChest}` }
    return {}
  } finally { try { w.close() } catch {} }
}

// merge partial stacks of the same item
async function sort(ctx) {
  const bot = ctx.bot
  let merges = 0
  const byName = new Map()
  for (const it of bot.inventory.items()) if (it.count < it.stackSize) { if (!byName.has(it.name)) byName.set(it.name, []); byName.get(it.name).push(it) }
  for (const [, list] of byName) {
    while (list.length > 1) {
      const src = list.pop(), dst = list[0]
      await ctx.wait(bot.clickWindow(src.slot, 0, 0))
      await ctx.wait(bot.clickWindow(dst.slot, 0, 0))
      if (bot.inventory.selectedItem) await ctx.wait(bot.clickWindow(src.slot, 0, 0))
      merges++
      const now = bot.inventory.slots[dst.slot]
      if (!now || now.count >= now.stackSize) list.shift()
    }
  }
  return { detail: `${merges} stacks merged, ${bot.inventory.emptySlotCount()} free slots` }
}

async function toss_junk(ctx, a) {
  const bot = ctx.bot
  const keep = a.keep ? listIds(a.keep) : ctx.interp.keep
  if (!keep) throw new Fail('invalid', 'no keep list: give keep=[...] or set one with `keep [...]`')
  const ks = new Set(keep)
  const tossed = {}
  for (const it of bot.inventory.items()) {
    if (ks.has(it.name)) continue
    await ctx.wait(bot.tossStack(it))
    tossed[it.name] = (tossed[it.name] || 0) + it.count
  }
  return { detail: Object.keys(tossed).length ? 'dropped ' + fmtCounts(tossed) : 'nothing to drop' }
}
const listIds = v => v.list ? v.list.flatMap(x => C.idsOf(x)) : C.idsOf(v)

async function keep(ctx, a) {
  ctx.interp.keep = listIds(a.items)
  return { detail: `keep list: ${ctx.interp.keep.join(', ')}` }
}

module.exports = { equip, drop, store, take, sort, toss_junk, keep }
