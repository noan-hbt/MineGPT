// Crafting / processing verbs: craft smelt blast smoke enchant repair smith trade (brew, stonecut: not yet)
'use strict'
const C = require('./common')
const { Fail } = C
const R = require('../../spec/recipes.json')
const { keyOf } = require('../state/afford')

// what is missing for `times` crafts of the closest recipe (spec/recipes.json)
function missingFor(bot, item, times) {
  const inv = {}
  for (const it of bot.inventory.items()) inv[it.name] = (inv[it.name] || 0) + it.count
  let best = null
  for (const r of R.crafting.filter(r => r.out === item)) {
    const miss = {}
    let tot = 0
    for (const g of r.ing) {
      const have = g.opts.reduce((s, o) => s + (inv[o] || 0), 0)
      const need = g.n * times
      if (have < need) { miss[keyOf(g.opts)] = need - have; tot += need - have }
    }
    if (!best || tot < best.tot) best = { r, miss, tot }
  }
  return best
}
const fmtCounts = c => Object.entries(c).map(([k, v]) => `${k} x${v}`).join(', ')

async function stationNear(ctx, names, what) {
  const bot = ctx.bot
  const b = C.knownBlocks(ctx, names, { radius: 32, max: 1 })[0]
  if (!b) {
    const carry = names.filter(n => C.count(bot, [n]))
    throw new Fail('no_target_known', `no ${what} known nearby${carry.length ? ` (you carry ${carry.join(', ')}: place it first)` : ''}`)
  }
  await C.near(ctx, b, 3)
  return bot.blockAt(b)
}

async function craft(ctx, a) {
  const bot = ctx.bot
  const reg = bot.registry
  let names = C.idsOf(a.item)
  // tag: the first member craftable right now, else the first member with a recipe
  let name = names.find(n => reg.itemsByName[n] && bot.recipesFor(reg.itemsByName[n].id, null, 1, true).length) ||
    names.find(n => R.crafting.some(r => r.out === n)) || names[0]
  const it = reg.itemsByName[name]
  if (!it) throw new Fail('invalid', `unknown item ${name}`)
  const want = ctx.args.n ?? 1
  ctx.total = want
  const start = C.count(bot, [name])
  const made = () => C.count(bot, [name]) - start
  const recipes = R.crafting.filter(r => r.out === name)
  if (!recipes.length) throw new Fail('invalid', `${name} has no crafting recipe${R.smelting.some(r => r.out === name) ? ' (it is smelted)' : ''}`)
  const per = recipes[0].n
  let table = null
  while (made() < want) {
    ctx.check()
    const small = bot.recipesFor(it.id, null, 1, null)[0]
    let rec = small
    if (!rec) {
      const big = bot.recipesFor(it.id, null, 1, true)[0]
      if (!big) {
        const m = missingFor(bot, name, Math.ceil((want - made()) / per))
        const station = m && m.r.grid === 3 ? ' at a crafting_table' : ''
        throw new Fail('missing_items', `${made() ? `made ${made()}/${want}, then ` : ''}missing ${m ? fmtCounts(m.miss) : '?'} for ${name}${station}`)
      }
      if (!table) table = await stationNear(ctx, ['crafting_table'], 'crafting_table (needed for this 3x3 recipe)')
      rec = bot.recipesFor(it.id, null, 1, table)[0] || big
    }
    const times = Math.max(1, Math.ceil((want - made()) / rec.result.count))
    try { await ctx.wait(bot.craft(rec, times, rec.requiresTable ? table : null)) } catch (e) {
      if (e instanceof C.Abort) throw e
      try { await ctx.wait(bot.craft(rec, 1, rec.requiresTable ? table : null)) } catch (e2) {
        if (e2 instanceof C.Abort) throw e2
        throw new Fail('server_refused', `craft ${name}: ${e2.message}`.slice(0, 160))
      }
    }
    ctx.done = Math.min(want, made()); ctx.progress(`${made()}/${want}`)
  }
  return { detail: `${name} x${made()}` }
}

// fuel value in items smelted
const FUEL = { coal: 8, charcoal: 8, coal_block: 80, lava_bucket: 100, blaze_rod: 12, dried_kelp_block: 20, stick: 0.5, bamboo: 0.25 }
function fuelValue(n) {
  if (FUEL[n]) return FUEL[n]
  if (n.endsWith('_planks') || n.endsWith('_log') || n.endsWith('_wood') || n.endsWith('_stem')) return 1.5
  if (n.endsWith('_slab') && /oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|bamboo|crimson|warped|pale_oak/.test(n)) return 0.75
  return 0
}
const FUEL_ORDER = ['coal', 'charcoal', 'coal_block', 'blaze_rod', 'dried_kelp_block', 'lava_bucket']

function cooker(kind) {
  const block = { smelt: 'furnace', blast: 'blast_furnace', smoke: 'smoker' }[kind]
  const rk = { smelt: 'smelting', blast: 'blasting', smoke: 'smoking' }[kind]
  return async (ctx, a) => {
    const bot = ctx.bot
    const reg = bot.registry
    const inName = C.idsOf(a.input).find(n => C.count(bot, [n])) || C.idsOf(a.input)[0]
    const rec = R[rk].find(r => r.in.includes(inName))
    if (!rec) throw new Fail('invalid', `${inName} cannot be ${kind === 'smelt' ? 'smelted in a furnace' : `used in a ${block}`}`)
    const have = C.count(bot, [inName])
    if (!have) throw new Fail('missing_items', `no ${inName} in inventory`)
    const n = Math.min(ctx.args.n ?? have, have)
    ctx.total = n
    const sec = rec.time / 20
    // fuel: given, else the best carried one
    let fuelNames = a.fuel ? C.idsOf(a.fuel) : null
    if (!fuelNames) {
      const inv = bot.inventory.items().map(i => i.name).filter(x => x !== inName && fuelValue(x) > 0)
      inv.sort((p, q) => (FUEL_ORDER.indexOf(p) < 0 ? 99 : FUEL_ORDER.indexOf(p)) - (FUEL_ORDER.indexOf(q) < 0 ? 99 : FUEL_ORDER.indexOf(q)))
      fuelNames = inv.slice(0, 1)
    }
    const st = await stationNear(ctx, [block], block)
    const f = await ctx.wait(bot.openFurnace(st))
    const outName = rec.out
    let got = 0
    try {
      const take = async () => { const o = f.outputItem(); if (o) { const c = o.count; await ctx.wait(f.takeOutput()); if (o.name === outName) got += c } }
      await take()
      got = 0
      if (f.inputItem() && f.inputItem().name !== inName) await ctx.wait(f.takeInput())
      await ctx.wait(f.putInput(reg.itemsByName[inName].id, null, n))
      const fi = f.fuelItem()
      const fuelHave = fi ? fi.count * fuelValue(fi.name) : 0
      if (fuelHave < n) {
        const fname = fuelNames.find(x => C.count(bot, [x]))
        if (!fname && !(f.fuel > 0)) throw new Fail('missing_items', `no fuel (coal, charcoal, planks, logs...)`)
        if (fname) {
          const need = Math.min(C.count(bot, [fname]), Math.ceil((n - fuelHave) / fuelValue(fname)))
          if (!fi || fi.name === fname) await ctx.wait(f.putFuel(reg.itemsByName[fname].id, null, need))
        }
      }
      let lastChange = Date.now(), lastGot = 0
      while (got < n) {
        await ctx.sleep(1000)
        await take()
        if (got !== lastGot) { lastGot = got; lastChange = Date.now() }
        ctx.done = got; ctx.progress(`${got}/${n} ${outName}`)
        if (Date.now() - lastChange > sec * 1000 + 6000) {
          const why = !f.fuelItem() && !(f.fuel > 0) ? 'fuel ran out' : !f.inputItem() ? 'input gone' : 'no progress'
          throw new Fail('missing_items', `${got}/${n} ${outName}, then ${why}`)
        }
      }
    } finally {
      try { if (f.inputItem() && got < n) await f.takeInput() } catch {}
      try { f.close() } catch {}
    }
    return { detail: `${outName} x${got}` }
  }
}

// slot of an inventory item inside an open container window
function winSlot(win, item) {
  const s = item.slot - 9 + win.inventoryStart
  const w = win.slots[s]
  if (w && w.type === item.type) return s
  const f = win.findInventoryItem(item.type, null)
  if (!f) throw new Fail('missing_items', `${item.name} not found in the open window`)
  return f.slot
}

async function enchant(ctx, a) {
  const bot = ctx.bot
  const lvl = a.level ?? 1
  if (lvl < 1 || lvl > 3) throw new Fail('invalid', 'level is the option slot 1-3')
  const it = C.findItem(bot, C.idsOf(a.item))
  if (!it) throw new Fail('missing_items', `no ${C.label(a.item)} in inventory`)
  if (C.count(bot, ['lapis_lazuli']) < lvl) throw new Fail('missing_items', `needs lapis_lazuli x${lvl}`)
  const st = await stationNear(ctx, ['enchanting_table'], 'enchanting_table')
  const t = await ctx.wait(bot.openEnchantmentTable(st))
  try {
    // mineflayer's putTargetItem/putLapis pass inventory-window slots: move by window slot instead
    await ctx.wait(bot.moveSlotItem(winSlot(t, it), 0))
    await ctx.wait(bot.moveSlotItem(winSlot(t, C.findItem(bot, 'lapis_lazuli')), 1))
    const ready = () => t.enchantments.every(e => e.level >= 0) && t.enchantments.some(e => e.level > 0)
    for (let i = 0; i < 30 && !ready(); i++) await ctx.sleep(100)
    if (!ready()) throw new Fail('server_refused', 'enchanting table offered no options')
    const opt = t.enchantments[lvl - 1]
    if (!opt || opt.level <= 0) throw new Fail('missing_items', `option ${lvl} not available`)
    if ((bot.experience.level || 0) < opt.level) throw new Fail('missing_items', `needs xp level ${opt.level}, have ${bot.experience.level}`)
    await ctx.wait(t.enchant(lvl - 1))
    await ctx.sleep(200)
    await ctx.wait(bot.putAway(0))
  } finally { try { t.close() } catch {} }
  return { detail: `enchanted ${it.name} (option ${lvl})` }
}

async function repair(ctx, a) {
  const bot = ctx.bot
  const it = C.findItem(bot, C.idsOf(a.item))
  if (!it) throw new Fail('missing_items', `no ${C.label(a.item)} in inventory`)
  const st = await stationNear(ctx, ['anvil', 'chipped_anvil', 'damaged_anvil'], 'anvil (grindstone repair not supported yet)')
  const other = a.with ? C.findItem(bot, C.idsOf(a.with).filter(n => true)) : bot.inventory.items().find(x => x.name === it.name && x.slot !== it.slot)
  if (!other) throw new Fail('missing_items', `nothing to combine with ${it.name} (give with=<item>)`)
  // mineflayer's anvil.combine pre-computes the cost with prismarine-item, which reads 0 on 1.21 data components
  // ("Not anvil-able"): put both items in by hand and take the result if the server offers one
  const an = await ctx.wait(bot.openBlock(st))
  try {
    await ctx.wait(bot.moveSlotItem(winSlot(an, it), 0))
    await ctx.wait(bot.moveSlotItem(winSlot(an, other), 1))
    let out = null
    for (let i = 0; i < 20 && !(out = an.slots[2]); i++) await ctx.sleep(100)
    if (!out) throw new Fail('server_refused', `anvil offers nothing for ${it.name} + ${other.name}`)
    const xp0 = bot.experience.level
    await ctx.wait(bot.clickWindow(2, 0, 1)) // shift-click the result into the inventory
    await ctx.sleep(300)
    if (an.slots[0] && an.slots[1]) throw new Fail('missing_items', `anvil refused the take (cost ? levels, have ${xp0})`)
  } finally { try { for (const s of [0, 1]) if (an.slots[s]) await bot.putAway(s) } catch {} try { an.close() } catch {} }
  return { detail: `combined ${it.name} with ${other.name}` }
}

async function smith(ctx, a) {
  const bot = ctx.bot
  const base = C.findItem(bot, C.idsOf(a.base)), add = C.findItem(bot, C.idsOf(a.addition))
  const tpl = C.findItem(bot, a.template ? C.idsOf(a.template) : ['netherite_upgrade_smithing_template'])
  if (!base || !add || !tpl) throw new Fail('missing_items', `needs ${[!tpl && 'template', !base && C.label(a.base), !add && C.label(a.addition)].filter(Boolean).join(', ')}`)
  const st = await stationNear(ctx, ['smithing_table'], 'smithing_table')
  const w = await ctx.wait(bot.openBlock(st))
  try {
    const inv = s => s - 9 + w.inventoryStart
    for (const [item, slot] of [[tpl, 0], [base, 1], [add, 2]]) await ctx.wait(bot.moveSlotItem(inv(item.slot), slot))
    await ctx.sleep(300)
    if (!w.slots[3]) throw new Fail('server_refused', 'no smithing result for these items')
    await ctx.wait(bot.clickWindow(3, 0, 1))
  } finally { try { bot.closeWindow(w) } catch {} }
  return {}
}

async function trade(ctx, a) {
  const bot = ctx.bot
  const e = C.findEntity(ctx, a.with)
  if (!e) throw new Fail('no_target_known', `no ${C.fmtValueSafe(a.with)} in sight`)
  await C.go(ctx, new C.G.GoalFollow(e, 2))
  const v = await ctx.wait(bot.openVillager(e))
  try {
    const i = a.offer - 1
    const tr = v.trades[i]
    if (!tr) throw new Fail('invalid', `offer ${a.offer} does not exist (1-${v.trades.length}): ` + v.trades.map((t, k) => `${k + 1}: ${t.inputItem1.count} ${t.inputItem1.name}${t.inputItem2 ? ' + ' + t.inputItem2.count + ' ' + t.inputItem2.name : ''} -> ${t.outputItem.count} ${t.outputItem.name}${t.tradeDisabled ? ' (sold out)' : ''}`).join('; '))
    if (tr.tradeDisabled) throw new Fail('server_refused', 'offer sold out')
    await ctx.wait(bot.trade(v, i, ctx.args.n ?? 1))
  } catch (err) { if (err instanceof C.Abort || err instanceof Fail) throw err; throw new Fail('missing_items', 'trade: ' + err.message) } finally { try { v.close() } catch {} }
  return {}
}

module.exports = { craft, smelt: cooker('smelt'), blast: cooker('blast'), smoke: cooker('smoke'), enchant, repair, smith, trade, missingFor }
