// Building + combat / safety verbs: place use | attack fight shoot shield retreat avoid eat sleep equip_best set_spawn
// water_bucket_save extinguish
'use strict'
const C = require('./common')
const { G, Vec3, Fail } = C
const N = require('../../spec/names.json')
const P = require('../state/perceive')

// ---------------------------------------------------------------- build
async function place(ctx, a) {
  const bot = ctx.bot
  const names = C.idsOf(a.block, 'item').filter(n => bot.registry.itemsByName[n])
  if (!names.length) throw new Fail('invalid', `${C.label(a.block)} is not a placeable item`)
  const ps = C.positions(ctx, a.at).sort((p, q) => p.y - q.y)
  ctx.total = ps.length
  const prefer = a.face ? (v => [v.x, v.y, v.z])(C.DIRV[a.face.name]) : null
  let last = null, streak = 0
  for (const p of ps) {
    ctx.check()
    const cur = bot.blockAt(p, false)
    if (cur && names.includes(cur.name)) { ctx.done++; continue }
    if (!C.count(bot, names)) { last = new Fail('missing_items', `out of ${names[0]} after ${ctx.done}/${ps.length}`); break }
    try {
      await C.equip(ctx, names)
      await C.placeAt(ctx, p, prefer)
      ctx.done++; streak = 0
    } catch (e) {
      if (!(e instanceof Fail)) throw e
      last = e; if (++streak >= 3) break
    }
    ctx.progress(`${ctx.done}/${ps.length}`)
  }
  if (last && !ctx.done) throw last
  if (last) return { status: 'partial', cause: last.cause, detail: `${ctx.done}/${ps.length} placed; ${last.detail}` }
  return { detail: `${ctx.done} placed` }
}

const BUCKETS = new Set(['bucket', 'water_bucket', 'lava_bucket', 'powder_snow_bucket'])
async function use(ctx, a) {
  const bot = ctx.bot
  if (a.item) await C.equip(ctx, C.idsOf(a.item))
  if (!a.on) {
    bot.activateItem()
    await ctx.sleep(1700)
    bot.deactivateItem()
    return { detail: `used ${bot.heldItem ? bot.heldItem.name : 'hand'}` }
  }
  const t = C.resolve(ctx, a.on)
  if (t.kind === 'entity') {
    await C.go(ctx, new G.GoalFollow(t.entity, 2))
    await ctx.wait(bot.activateEntity(t.entity))
    return { detail: `used ${bot.heldItem ? bot.heldItem.name : 'hand'} on ${t.label}` }
  }
  const p = t.pos.floored()
  await C.reach(ctx, p)
  const b = bot.blockAt(p, false)
  if (bot.heldItem && BUCKETS.has(bot.heldItem.name)) {
    await ctx.wait(bot.lookAt(p.offset(0.5, bot.heldItem.name === 'bucket' ? 0.5 : 1, 0.5), true))
    bot.activateItem()
    await ctx.sleep(300)
  } else {
    await ctx.wait(bot.activateBlock(b))
    await ctx.sleep(250)
  }
  const after = bot.blockAt(p, false)
  const props = after && after.getProperties ? after.getProperties() : {}
  const st = ['open', 'powered', 'lit'].filter(k => k in props).map(k => `${k}=${props[k]}`).join(' ')
  return { detail: `used ${bot.heldItem ? bot.heldItem.name : 'hand'} on ${after ? after.name : '?'} ${C.fmtPos(p)}${st ? ' -> ' + st : ''}` }
}

// ---------------------------------------------------------------- combat
function cooldown(held) {
  if (!held) return 260
  const n = held.name
  if (n.endsWith('_sword')) return 630
  if (n.endsWith('_axe')) return /wooden|stone/.test(n) ? 1250 : 1000
  if (n === 'trident') return 910
  if (n === 'mace') return 1670
  return 260
}
function target(ctx, v) {
  const e = C.findEntity(ctx, v)
  if (!e) throw new Fail('no_target_known', `no ${C.fmtValueSafe(v)} in sight`)
  return e
}
const aim = e => e.position.offset(0, e.height * 0.8, 0)

async function attack(ctx, a) {
  const bot = ctx.bot
  const e = target(ctx, a.target)
  if (e.position.distanceTo(bot.entity.position) > 3) await C.go(ctx, new G.GoalFollow(e, 2))
  await ctx.wait(bot.lookAt(aim(e), true))
  bot.attack(e)
  await ctx.sleep(150)
  return { detail: `hit ${C.entRef(e)}` }
}

async function fight(ctx, a) {
  const bot = ctx.bot
  const e = target(ctx, a.target)
  const ref = C.entRef(e)
  let dead = false, hits = 0, last = 0
  const onDead = x => { if (x.id === e.id) dead = true }
  bot.on('entityDead', onDead)
  try {
    bot.pathfinder.setGoal(new G.GoalFollow(e, 1.5), true)
    for (;;) {
      if (dead) { await ctx.sleep(600); await C.pickup(ctx, { at: e.position, radius: 4, maxMs: 2500 }); return { detail: `${ref} killed after ${hits} hits` } }
      if (!bot.entities[e.id]) return { status: 'failed', cause: 'no_target_known', detail: `lost ${ref} after ${hits} hits` }
      const d = e.position.distanceTo(bot.entity.position)
      if (d <= 3.1 && Date.now() - last >= cooldown(bot.heldItem)) {
        await ctx.wait(bot.lookAt(aim(e), true))
        bot.attack(e); hits++; last = Date.now()
        ctx.progress(`${hits} hits${e.metadata && typeof e.metadata[9] === 'number' ? ', target hp ' + Math.round(e.metadata[9]) : ''}`)
      }
      await ctx.sleep(50)
    }
  } finally { bot.removeListener('entityDead', onDead); bot.pathfinder.setGoal(null) }
}

async function shoot(ctx, a) {
  const bot = ctx.bot
  const e = target(ctx, a.target)
  const w = C.findItem(bot, ['bow', 'crossbow'])
  if (!w) throw new Fail('missing_tool', 'no bow or crossbow')
  if (!C.count(bot, ['arrow', 'spectral_arrow', 'tipped_arrow'])) throw new Fail('missing_items', 'no arrows')
  await C.equip(ctx, w.name)
  const n = a.n ?? 1
  ctx.total = n
  for (let i = 0; i < n; i++) {
    if (!bot.entities[e.id]) return { status: i ? 'partial' : 'failed', cause: 'no_target_known', detail: `${C.entRef(e)} gone after ${i} shots` }
    const d = e.position.distanceTo(bot.entity.position)
    if (d > 40) throw new Fail('unreachable', `${C.entRef(e)} is ${Math.round(d)}m away (max 40)`)
    bot.activateItem()
    const t0 = Date.now()
    while (Date.now() - t0 < (w.name === 'crossbow' ? 1300 : 1100)) {
      const dd = e.position.distanceTo(bot.entity.position)
      await ctx.wait(bot.lookAt(aim(e).offset(0, dd * dd * 0.0045, 0), true))
      await ctx.sleep(50)
    }
    bot.deactivateItem()
    if (w.name === 'crossbow') { await ctx.sleep(150); bot.activateItem(); await ctx.sleep(100); bot.deactivateItem() }
    ctx.done++; ctx.progress(`${ctx.done}/${n}`)
    await ctx.sleep(300)
  }
  return {}
}

async function shield(ctx, a) {
  const bot = ctx.bot
  const off = bot.inventory.slots[45]
  if (!off || off.name !== 'shield') await C.equip(ctx, 'shield', 'off-hand')
  bot.activateItem(true)
  await ctx.sleep((a.dur ? a.dur.dur : 5) * 1000)
  bot.deactivateItem()
  return {}
}

async function retreat(ctx, a) {
  const bot = ctx.bot
  if (a.to) { const t = C.resolve(ctx, a.to); await C.go(ctx, new G.GoalNear(t.pos.x, t.pos.y, t.pos.z, 2)); return { detail: `at ${t.label}` } }
  const h = C.nearest(bot, e => P.HOSTILE.has(e.name), 24)
  if (!h) return { detail: 'no hostile within 24' }
  bot.pathfinder.setGoal(new G.GoalInvert(new G.GoalFollow(h, 12)), true)
  for (let i = 0; i < 100; i++) {
    if (!bot.entities[h.id] || h.position.distanceTo(bot.entity.position) >= 12) break
    await ctx.sleep(200)
  }
  bot.pathfinder.setGoal(null)
  return { detail: `${Math.round(h.position.distanceTo(bot.entity.position))}m from ${C.entRef(h)}` }
}

// background: pathing cost around the kind + an `interrupt` event when one comes within radius (watcher in run.js)
async function avoid(ctx, a) {
  const bot = ctx.bot
  const kind = a.target.entity || a.target.name
  const r = a.radius ?? 8
  const mv = bot.pathfinder.movements
  if (r <= 0) { ctx.interp.avoid.delete(kind); if (mv) mv.entitiesToAvoid.delete(kind); return { detail: `no longer avoiding ${kind}` } }
  ctx.interp.avoid.set(kind, r)
  if (mv) mv.entitiesToAvoid.add(kind)
  return { detail: `avoiding ${kind}: paths go around it, and an event fires when one comes within ${r} (avoid ${kind} radius=0 to stop)` }
}

const FOODS = require('minecraft-data')(N.version).foodsByName
const BAD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit', 'suspicious_stew'])
const ANYTIME = new Set(['golden_apple', 'enchanted_golden_apple', 'chorus_fruit', 'honey_bottle', 'milk_bucket'])
async function eat(ctx, a) {
  const bot = ctx.bot
  let names = a.food ? C.idsOf(a.food) : bot.inventory.items().map(i => i.name).filter(n => FOODS[n])
  if (!a.food) names.sort((p, q) => (BAD.has(p) - BAD.has(q)) || (FOODS[q].foodPoints + FOODS[q].saturation) - (FOODS[p].foodPoints + FOODS[p].saturation))
  names = names.filter(n => C.count(bot, [n]) || n === 'milk_bucket')
  if (!names.length) throw new Fail('missing_items', a.food ? `no ${C.label(a.food)}` : 'no food in inventory')
  if (bot.food >= 20 && !ANYTIME.has(names[0])) throw new Fail('server_refused', 'not hungry (food 20/20)')
  await C.equip(ctx, names[0])
  const f0 = bot.food
  try { await ctx.wait(bot.consume()) } catch (e) { if (e instanceof C.Abort) throw e; throw new Fail('server_refused', 'eat: ' + e.message) }
  return { detail: `ate ${names[0]}, food ${f0} -> ${bot.food}` }
}

async function sleep(ctx, a) {
  const bot = ctx.bot
  let p
  if (a.at) p = C.resolve(ctx, a.at).pos.floored()
  else p = C.knownBlocks(ctx, N.block_tags.beds, { radius: 32, max: 1 })[0]
  if (!p) throw new Fail('no_target_known', 'no bed known nearby')
  await C.near(ctx, p, 2)
  try { await ctx.wait(bot.sleep(bot.blockAt(p))) } catch (e) {
    if (e instanceof C.Abort) throw e
    const m = e.message || ''
    throw new Fail(/monster/i.test(m) ? 'danger' : 'server_refused', 'sleep: ' + m)
  }
  return { detail: 'in bed (the next action wakes the bot up)' }
}

const TIER = ['leather', 'golden', 'chainmail', 'copper', 'iron', 'diamond', 'netherite']
const WEAPON = n => { const m = n.match(/^(\w+?)_(sword|axe)$/); if (!m) return n === 'trident' ? 9 : n === 'mace' ? 6 : -1; return ['wooden', 'golden', 'stone', 'copper', 'iron', 'diamond', 'netherite'].indexOf(m[1]) + (m[2] === 'sword' ? 0.5 : 0) }
async function equip_best(ctx, a) {
  const bot = ctx.bot
  const slot = a.slot ? a.slot.name : null
  const done = []
  const items = () => bot.inventory.items()
  if (!slot || slot === 'armor') {
    for (const [part, dest, idx] of [['helmet', 'head', 5], ['chestplate', 'torso', 6], ['leggings', 'legs', 7], ['boots', 'feet', 8]]) {
      const cur = bot.inventory.slots[idx]
      const rank = n => TIER.indexOf(n.split('_')[0])
      const best = items().filter(i => i.name.endsWith('_' + part)).sort((p, q) => rank(q.name) - rank(p.name))[0]
      if (best && (!cur || rank(best.name) > rank(cur.name))) { await ctx.wait(bot.equip(best, dest)); done.push(best.name) }
    }
  }
  if (!slot || slot === 'weapon') {
    const best = items().filter(i => WEAPON(i.name) >= 0).sort((p, q) => WEAPON(q.name) - WEAPON(p.name))[0]
    if (best) { await ctx.wait(bot.equip(best, 'hand')); done.push(best.name) }
  } else if (slot === 'tool') {
    const best = items().filter(i => i.name.endsWith('_pickaxe')).sort((p, q) => C.tier(q.name) - C.tier(p.name))[0]
    if (best) { await ctx.wait(bot.equip(best, 'hand')); done.push(best.name) }
  }
  return { detail: done.length ? 'equipped ' + done.join(', ') : 'nothing better to equip' }
}

async function set_spawn(ctx, a) {
  const bot = ctx.bot
  const p = a.at ? C.resolve(ctx, a.at).pos.floored() : C.knownBlocks(ctx, [...N.block_tags.beds, 'respawn_anchor'], { radius: 32, max: 1 })[0]
  if (!p) throw new Fail('no_target_known', 'no bed or respawn_anchor known nearby')
  await C.reach(ctx, p)
  await ctx.wait(bot.activateBlock(bot.blockAt(p)))
  await ctx.sleep(400)
  if (bot.isSleeping) return { detail: 'spawn set (asleep in the bed)' }
  return { detail: `spawn set at ${C.fmtPos(p)}` }
}

async function water_bucket_save(ctx) {
  const bot = ctx.bot
  await C.equip(ctx, 'water_bucket')
  await ctx.wait(bot.look(bot.entity.yaw, -Math.PI / 2, true))
  for (let i = 0; i < 200; i++) {
    if (bot.entity.onGround && i > 0) break
    const p = bot.entity.position
    let gap = 0
    while (gap < 6) { const b = bot.blockAt(p.offset(0, -gap - 1, 0).floored(), false); if (b && b.boundingBox === 'block') break; gap++ }
    if (bot.entity.velocity.y < -0.5 && gap <= 3) { bot.activateItem(); break }
    await ctx.sleep(25)
  }
  for (let i = 0; i < 40 && !bot.entity.onGround && !bot.entity.isInWater; i++) await ctx.sleep(50)
  await ctx.sleep(300)
  // take the water back
  const w = C.knownBlocks(ctx, ['water'], { radius: 3, max: 1, rays: 10 })[0]
  if (w && C.findItem(bot, 'bucket')) { await C.equip(ctx, 'bucket'); await ctx.wait(bot.lookAt(w.offset(0.5, 0.5, 0.5), true)); bot.activateItem() }
  return {}
}

async function extinguish(ctx) {
  const bot = ctx.bot
  const burning = () => !!(bot.entity.metadata && typeof bot.entity.metadata[0] === 'number' && (bot.entity.metadata[0] & 1))
  if (!burning()) return { detail: 'not burning' }
  if (C.findItem(bot, 'water_bucket')) {
    await C.equip(ctx, 'water_bucket')
    const below = bot.entity.position.floored().offset(0, -1, 0)
    await ctx.wait(bot.lookAt(below.offset(0.5, 1, 0.5), true))
    bot.activateItem()
    await ctx.sleep(600)
    if (C.findItem(bot, 'bucket')) { await C.equip(ctx, 'bucket'); bot.activateItem() }
    return { detail: burning() ? 'still burning' : 'fire out (water bucket)' }
  }
  const w = C.knownBlocks(ctx, ['water'], { radius: 12, max: 1 })[0]
  if (!w) throw new Fail('no_target_known', 'no water bucket and no water seen within 12')
  await C.go(ctx, new G.GoalBlock(w.x, w.y, w.z))
  return { detail: 'jumped into water' }
}

module.exports = { place, use, attack, fight, shoot, shield, retreat, avoid, eat, sleep, equip_best, set_spawn, water_bucket_save, extinguish }
