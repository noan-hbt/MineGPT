// Gathering verbs: mine chop strip_mine branch_mine dig break collect harvest fish shear milk
'use strict'
const C = require('./common')
const { G, Vec3, Fail } = C
const N = require('../../spec/names.json')

const LOGS = N.block_tags.logs
const here = bot => bot.entity.position.floored()

// mine n blocks of a kind, nearest known first; skips blocks that fail (no path, danger) up to 3 times
async function mine(ctx, a) {
  const bot = ctx.bot
  const ids = C.idsOf(a.block, 'block')
  const nearPos = a.near ? C.resolve(ctx, a.near).pos : null
  const skip = new Set()
  let lastFail = null
  const want = () => Math.min(ctx.args.n ?? 1, ctx.args.max ?? Infinity)
  ctx.total = want()
  while (ctx.done < want()) {
    ctx.total = want()
    ctx.check()
    if (bot.inventory.emptySlotCount() === 0) throw new Fail('inventory_full', 'no free inventory slot')
    const cands = C.knownBlocks(ctx, ids, { near: nearPos, radius: nearPos ? 16 : 48, max: 12 }).filter(p => !skip.has(C.k3(p)))
    if (!cands.length) {
      if (lastFail) throw lastFail
      throw new Fail('no_target_known', `no ${C.label(a.block)} seen${nearPos ? ' near ' + C.fmtPos(nearPos) : ''}${ctx.done ? ' any more' : ''}`)
    }
    const p = cands[0]
    const hc = C.harvestCheck(bot, bot.blockAt(p))
    if (hc) throw hc
    try {
      await C.digAt(ctx, p, { tool: a.tool ? C.idsOf(a.tool) : null })
      await C.pickup(ctx, { at: p.offset(0.5, 0.5, 0.5), radius: 3, maxMs: 4000 })
      ctx.done++
      ctx.progress(`${ctx.done}/${want()}`)
    } catch (e) {
      if (!(e instanceof Fail) || e.cause === 'missing_tool' || e.cause === 'tool_too_weak') throw e
      skip.add(C.k3(p)); lastFail = e
      if (skip.size >= 3) throw e
    }
  }
  return { detail: `${ctx.done} ${C.label(a.block)} mined` }
}

// connected logs of one tree (same block name, 26-neighbours, bounded)
function trunk(bot, start, name) {
  const out = [], seen = new Set([C.k3(start)]), q = [start]
  while (q.length && out.length < 40) {
    const p = q.shift()
    out.push(p)
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const n = p.offset(dx, dy, dz)
      if (seen.has(C.k3(n)) || Math.abs(n.x - start.x) > 3 || Math.abs(n.z - start.z) > 3 || n.y < start.y) continue
      seen.add(C.k3(n))
      const b = bot.blockAt(n, false)
      if (b && b.name === name) q.push(n)
    }
  }
  return out.sort((p, q) => p.y - q.y)
}

async function chop(ctx, a) {
  const bot = ctx.bot
  const ids = a.species ? C.idsOf(a.species, 'block') : LOGS
  ctx.total = ctx.args.n ?? 1
  let logs = 0, missed = 0
  const skip = new Set()
  while (ctx.done < (ctx.args.n ?? 1)) {
    ctx.check()
    const c = C.knownBlocks(ctx, ids, { max: 10 }).filter(p => !skip.has(C.k3(p)))
    if (!c.length) throw new Fail('no_target_known', `no ${a.species ? C.label(a.species) : 'tree'} seen${ctx.done ? ' any more' : ''}`)
    // lowest log of the nearest tree
    let base = c[0]
    for (let i = 0; i < 30; i++) { const b = bot.blockAt(base.offset(0, -1, 0), false); if (b && b.name === bot.blockAt(base).name) base = base.offset(0, -1, 0); else break }
    const name = bot.blockAt(base).name
    const parts = trunk(bot, base, name)
    let got = 0
    for (const p of parts) {
      ctx.check()
      const b = bot.blockAt(p, false)
      if (!b || b.name !== name) continue
      try { await C.digAt(ctx, p, { check: false }); got++; logs++ } catch (e) { if (!(e instanceof Fail)) throw e; missed++ }
      ctx.progress(`tree ${ctx.done + 1}/${ctx.args.n ?? 1}, ${logs} logs`)
    }
    for (const p of parts) skip.add(C.k3(p))
    await C.pickup(ctx, { at: base.offset(0.5, 0, 0.5), radius: 6, maxMs: 6000 })
    if (got) ctx.done++
    else if (skip.size > 80) break
  }
  return { detail: `${ctx.done} tree(s), ${logs} logs dug${missed ? `, ${missed} logs out of reach` : ''}` }
}

async function tunnel(ctx, v, len, { count = true } = {}) {
  const bot = ctx.bot
  for (let i = 0; i < len; i++) {
    ctx.check()
    const f = here(bot)
    const n = f.plus(v)
    for (const p of [n.offset(0, 1, 0), n]) await C.digAt(ctx, p)
    const fl = bot.blockAt(n.offset(0, -1, 0), false)
    if (!fl || fl.name === 'lava') throw new Fail('danger', `lava under ${C.fmtPos(n)}`)
    if (fl.boundingBox !== 'block') throw new Fail('danger', `hole under ${C.fmtPos(n)}`)
    await C.go(ctx, new G.GoalBlock(n.x, n.y, n.z))
    if (count) { ctx.done = i + 1; ctx.progress(`${i + 1}/${len}`) }
  }
}

async function toY(ctx, y) {
  if (y == null) return
  const cur = here(ctx.bot).y
  if (cur > y) await ctx.run(`descend to_y=${y}`)
  else if (cur < y) await ctx.run(`ascend to_y=${y}`)
}

async function strip_mine(ctx, a) {
  const v = C.DIRV[a.dir.name]
  if (!v || v.y) throw new Fail('invalid', 'strip_mine goes north/south/east/west')
  await toY(ctx, a.y)
  const len = a.len ?? 16
  ctx.total = len
  await tunnel(ctx, v, len)
  await C.pickup(ctx, { radius: 4, maxMs: 2000 })
  return { detail: `${len}-block tunnel ${a.dir.name}, now at ${C.fmtPos(ctx.bot.entity.position)}` }
}

async function branch_mine(ctx, a) {
  const bot = ctx.bot
  await toY(ctx, a.y)
  const len = a.len ?? 24, sp = (a.spacing ?? 3) + 1, side = 6
  const v = C.facingVec(bot)
  const left = new Vec3(v.z, 0, -v.x), right = new Vec3(-v.z, 0, v.x)
  ctx.total = len
  for (let i = 0; i < len; i += sp) {
    await tunnel(ctx, v, Math.min(sp, len - i), { count: false })
    const at = here(bot)
    for (const s of [left, right]) {
      try { await tunnel(ctx, s, side, { count: false }) } catch (e) { if (!(e instanceof Fail) || e.cause !== 'danger') throw e }
      await C.go(ctx, new G.GoalBlock(at.x, at.y, at.z))
    }
    ctx.done = Math.min(len, i + sp); ctx.progress(`${ctx.done}/${len}`)
  }
  return { detail: `main tunnel ${len}, branches every ${sp - 1}` }
}

async function dig(ctx, a) {
  const bot = ctx.bot
  const ps = C.positions(ctx, a.area).filter(p => { const b = bot.blockAt(p, false); return b && b.boundingBox === 'block' })
  ctx.total = ps.length
  if (!ps.length) return { detail: 'area already clear' }
  let fails = 0, last
  for (const p of ps) {
    ctx.check()
    try { await C.digAt(ctx, p); ctx.done++ } catch (e) { if (!(e instanceof Fail)) throw e; fails++; last = e; if (e.cause === 'danger' || e.cause === 'missing_tool' || e.cause === 'tool_too_weak') throw e }
    ctx.progress(`${ctx.done}/${ps.length}`)
  }
  await C.pickup(ctx, { radius: 6, maxMs: 3000 })
  if (fails) return { status: ctx.done ? 'partial' : 'failed', cause: last.cause, detail: `${ctx.done}/${ps.length} dug; last problem: ${last.detail}` }
  return { detail: `${ctx.done} blocks dug` }
}

async function brk(ctx, a) {
  const bot = ctx.bot
  const ps = C.positions(ctx, a.at)
  ctx.total = ps.length
  let last = null
  for (const p of ps) {
    ctx.check()
    const b = bot.blockAt(p, false)
    if (!b || b.boundingBox !== 'block') { last = new Fail('no_target_known', `nothing to break at ${C.fmtPos(p)} (${b ? b.name : 'unloaded'})`); continue }
    const hc = C.harvestCheck(bot, b)
    try { await C.digAt(ctx, p, { check: false }); ctx.done++ } catch (e) { if (!(e instanceof Fail)) throw e; last = e }
    if (hc && ctx.done) last = null
  }
  await C.pickup(ctx, { radius: 4, maxMs: 2500 })
  if (last && !ctx.done) throw last
  if (last) return { status: 'partial', cause: last.cause, detail: `${ctx.done}/${ps.length}; ${last.detail}` }
  return {}
}

async function collect(ctx, a) {
  const bot = ctx.bot
  const R = a.radius ?? 16
  const names = a.item ? C.idsOf(a.item) : null
  const match = e => e.name === 'item' && e.position.distanceTo(bot.entity.position) <= R &&
    (!names || (e.getDroppedItem && e.getDroppedItem() && names.includes(e.getDroppedItem().name)))
  if (!C.nearest(bot, match, R + 1)) throw new Fail('no_target_known', `no dropped ${names ? C.label(a.item) : 'item'} within ${R}`)
  let n = 0
  for (; n < 40; n++) {
    const it = C.nearest(bot, match, R + 1)
    if (!it) break
    try { await C.go(ctx, new G.GoalNear(it.position.x, it.position.y, it.position.z, 0)) } catch (e) { if (!(e instanceof Fail)) throw e; break }
    await ctx.sleep(250)
  }
  return {}
}

const CROPS = { wheat: [7, 'wheat_seeds'], carrots: [7, 'carrot'], potatoes: [7, 'potato'], beetroots: [3, 'beetroot_seeds'],
  nether_wart: [3, 'nether_wart'], cocoa: [2, 'cocoa_beans'] }
async function harvest(ctx, a) {
  const bot = ctx.bot
  const crop = a.crop.name
  const info = CROPS[crop]
  const replant = !a.replant || a.replant.name !== 'no'
  const ripe = p => { const b = bot.blockAt(p, false); if (!b || b.name !== crop) return false; if (!info) return true; const pr = b.getProperties(); return +pr.age >= info[0] }
  const want = () => ctx.args.n ?? 64
  ctx.total = 0
  let any = false
  while (ctx.done < want()) {
    ctx.check()
    const ps = C.knownBlocks(ctx, [crop], { radius: 24, max: 64, rays: 128 }).filter(ripe)
    if (!ps.length) break
    any = true
    const p = ps[0]
    await C.digAt(ctx, p, { check: false })
    ctx.done++
    await C.pickup(ctx, { at: p.offset(0.5, 0.5, 0.5), radius: 3, maxMs: 2000 })
    if (replant && info && crop !== 'cocoa' && C.count(bot, [info[1]])) {
      try { await C.equip(ctx, info[1]); await C.placeAt(ctx, p, [0, -1, 0]) } catch (e) { if (!(e instanceof Fail)) throw e }
    }
    ctx.progress(`${ctx.done} harvested`)
  }
  if (!any) throw new Fail('no_target_known', `no grown ${crop} seen (age ${info ? info[0] : '?'} needed)`)
  return { detail: `${ctx.done} ${crop} harvested${replant ? ', replanted' : ''}` }
}

async function fish(ctx, a) {
  const bot = ctx.bot
  await C.equip(ctx, 'fishing_rod')
  const w = C.knownBlocks(ctx, ['water'], { radius: 12, max: 20 }).find(p => { const u = bot.blockAt(p.offset(0, 1, 0), false); return u && u.name === 'air' })
  if (!w) throw new Fail('no_target_known', 'no open water seen within 12')
  await C.near(ctx, w, 4)
  ctx.total = a.n ?? 1
  while (ctx.done < (ctx.args.n ?? 1)) {
    await ctx.wait(bot.lookAt(w.offset(0.5, 1, 0.5)))
    try { await ctx.wait(bot.fish()) } catch (e) { if (e instanceof C.Abort) throw e; throw new Fail('unreachable', 'fishing: ' + e.message) }
    ctx.done++; ctx.progress(`${ctx.done}/${ctx.args.n ?? 1}`)
    await ctx.sleep(400)
  }
  return {}
}

async function useOnMob(ctx, target, item, verb) {
  const bot = ctx.bot
  const e = C.findEntity(ctx, target)
  if (!e) throw new Fail('no_target_known', `no ${C.fmtValueSafe(target)} in sight`)
  await C.equip(ctx, item)
  await C.go(ctx, new G.GoalFollow(e, 2))
  await ctx.wait(bot.lookAt(e.position.offset(0, e.height * 0.6, 0)))
  await ctx.wait(bot.activateEntity(e))
  await ctx.sleep(400)
  if (verb === 'sheared') await C.pickup(ctx, { at: e.position, radius: 4, maxMs: 3000 })
  return { detail: `${verb} ${C.entRef(e)}` }
}
const shear = (ctx, a) => useOnMob(ctx, a.target, 'shears', 'sheared')
const milk = (ctx, a) => useOnMob(ctx, a.target, 'bucket', 'milked')

module.exports = { mine, chop, strip_mine, branch_mine, dig, break: brk, collect, harvest, fish, shear, milk, useOnMob }
