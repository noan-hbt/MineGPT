// Farming, social and meta verbs: plant bonemeal breed lead tame feed | say whisper give come_to obey refuse |
// wait note forget name_place save_routine stop
'use strict'
const C = require('./common')
const { G, Fail } = C
const { fmtStmt } = require('../dsl/fmt')
const { useOnMob } = require('./gather')

// ---------------------------------------------------------------- farm
async function plant(ctx, a) {
  const bot = ctx.bot
  const seeds = C.idsOf(a.seed)
  if (!C.count(bot, seeds)) throw new Fail('missing_items', `no ${C.label(a.seed)} in inventory`)
  const soil = new Set(['farmland', 'soul_sand', 'dirt', 'grass_block', 'moss_block', 'podzol', 'coarse_dirt', 'rooted_dirt', 'mud', 'jungle_log'])
  let spots
  if (a.at) spots = C.positions(ctx, a.at).map(p => { const b = bot.blockAt(p, false); return b && soil.has(b.name) ? p.offset(0, 1, 0) : p })
  else {
    const air = p => { const u = bot.blockAt(p.offset(0, 1, 0), false); return u && (u.name === 'air' || u.name === 'cave_air') }
    spots = C.knownBlocks(ctx, ['farmland'], { radius: 16, max: 64, rays: 128 }).filter(air).slice(0, ctx.args.max ?? 1).map(p => p.offset(0, 1, 0))
    if (!spots.length) throw new Fail('no_target_known', 'no free farmland seen within 16 (use a hoe on dirt near water)')
  }
  ctx.total = spots.length
  let last
  for (const p of spots) {
    if (!C.count(bot, seeds)) { last = new Fail('missing_items', `out of ${seeds[0]}`); break }
    try { await C.equip(ctx, seeds); await C.placeAt(ctx, p, [0, -1, 0]); ctx.done++ } catch (e) { if (!(e instanceof Fail)) throw e; last = e }
  }
  if (last && !ctx.done) throw last
  return last ? { status: 'partial', cause: last.cause, detail: `${ctx.done}/${spots.length}; ${last.detail}` } : { detail: `${ctx.done} planted` }
}

async function bonemeal(ctx, a) {
  const bot = ctx.bot
  const t = C.resolve(ctx, a.target)
  const p = t.pos.floored()
  await C.equip(ctx, 'bone_meal')
  await C.reach(ctx, p)
  const before = bot.blockAt(p).getProperties()
  await ctx.wait(bot.activateBlock(bot.blockAt(p)))
  await ctx.sleep(300)
  const b = bot.blockAt(p)
  const pr = b.getProperties()
  return { detail: `${b.name} ${C.fmtPos(p)}${'age' in pr ? ` age ${before.age} -> ${pr.age}` : ''}` }
}

const BREED_FOOD = { cow: ['wheat'], mooshroom: ['wheat'], sheep: ['wheat'], goat: ['wheat'], pig: ['carrot', 'potato', 'beetroot'],
  chicken: ['wheat_seeds', 'melon_seeds', 'pumpkin_seeds', 'beetroot_seeds', 'torchflower_seeds', 'pitcher_pod'],
  rabbit: ['dandelion', 'carrot', 'golden_carrot'], horse: ['golden_carrot', 'golden_apple'], donkey: ['golden_carrot', 'golden_apple'],
  llama: ['hay_block'], wolf: ['cooked_beef', 'beef', 'cooked_porkchop', 'porkchop', 'cooked_chicken', 'chicken', 'mutton', 'cooked_mutton', 'rabbit', 'cooked_rabbit'],
  cat: ['cod', 'salmon'], ocelot: ['cod', 'salmon'], fox: ['sweet_berries', 'glow_berries'], turtle: ['seagrass'], bee: ['dandelion', 'poppy', 'sunflower'],
  panda: ['bamboo'], strider: ['warped_fungus'], hoglin: ['crimson_fungus'], frog: ['slime_ball'], camel: ['cactus'], armadillo: ['spider_eye'],
  sniffer: ['torchflower_seeds'], axolotl: ['tropical_fish_bucket'] }
const TAME_FOOD = { wolf: ['bone'], cat: ['cod', 'salmon'], ocelot: ['cod', 'salmon'], parrot: ['wheat_seeds', 'melon_seeds', 'pumpkin_seeds', 'beetroot_seeds'] }

async function breed(ctx, a) {
  const bot = ctx.bot
  const kind = a.target.name
  const food = (BREED_FOOD[kind] || []).filter(f => C.count(bot, [f]))
  if (!BREED_FOOD[kind]) throw new Fail('invalid', `${kind} cannot be bred`)
  const pairs = a.n ?? 1
  if (C.count(bot, food) < pairs * 2) throw new Fail('missing_items', `needs ${pairs * 2} of ${BREED_FOOD[kind].join('/')}`)
  const mobs = Object.values(bot.entities).filter(e => e.name === kind && e.position.distanceTo(bot.entity.position) < 24)
    .sort((p, q) => p.position.distanceTo(bot.entity.position) - q.position.distanceTo(bot.entity.position))
  if (mobs.length < 2) throw new Fail('no_target_known', `${mobs.length} ${kind} in sight, 2 needed`)
  ctx.total = pairs
  let fed = 0
  for (const e of mobs.slice(0, pairs * 2)) {
    await C.equip(ctx, food)
    await C.go(ctx, new G.GoalFollow(e, 2))
    await ctx.wait(bot.lookAt(e.position.offset(0, e.height * 0.6, 0)))
    await ctx.wait(bot.activateEntity(e))
    fed++
    ctx.done = Math.floor(fed / 2); ctx.progress(`${fed} fed`)
    await ctx.sleep(300)
  }
  return { detail: `fed ${fed} ${kind}` }
}

const lead = (ctx, a) => useOnMob(ctx, a.target, 'lead', 'leashed')
async function tame(ctx, a) {
  const bot = ctx.bot
  const kind = a.target.entity || a.target.name
  const food = TAME_FOOD[kind]
  const e = C.findEntity(ctx, a.target)
  if (!e) throw new Fail('no_target_known', `no ${kind} in sight`)
  if (!food) { // horses & co: mount until tamed
    await C.go(ctx, new G.GoalFollow(e, 2))
    for (let i = 0; i < 6; i++) { bot.mount(e); await ctx.sleep(2500); if (bot.vehicle) { bot.dismount(); await ctx.sleep(400) } }
    return { detail: `rode ${C.entRef(e)} several times (watch for hearts)` }
  }
  let n = 0
  for (; n < 10 && C.count(bot, food); n++) {
    await C.equip(ctx, food)
    await C.go(ctx, new G.GoalFollow(e, 2))
    await ctx.wait(bot.activateEntity(e))
    await ctx.sleep(700)
  }
  return { detail: `fed ${C.entRef(e)} ${n} times` }
}
const feed = (ctx, a) => useOnMob(ctx, a.target, C.idsOf(a.item), 'fed')

// ---------------------------------------------------------------- social
const playerName = v => v.entity === 'player' && v.ref ? v.ref : null
async function say(ctx, a) { ctx.bot.chat(a.text.text.slice(0, 256)); return {} }
async function whisper(ctx, a) {
  const n = playerName(a.to)
  if (!n) throw new Fail('invalid', 'whisper to #player.Name')
  ctx.bot.whisper(n, a.text.text.slice(0, 200))
  return {}
}
async function give(ctx, a) {
  const bot = ctx.bot
  const e = C.findEntity(ctx, a.to)
  if (!e) throw new Fail('no_target_known', `${C.fmtValueSafe(a.to)} not in sight`)
  const names = C.idsOf(a.item)
  const have = C.count(bot, names)
  if (!have) throw new Fail('missing_items', `no ${C.label(a.item)} in inventory`)
  await C.go(ctx, new G.GoalFollow(e, 2))
  await ctx.wait(bot.lookAt(e.position.offset(0, 1.5, 0), true))
  let n = Math.min(a.n ?? have, have)
  for (const name of names) { const c = Math.min(n, C.count(bot, [name])); if (c > 0) { await ctx.wait(bot.toss(bot.registry.itemsByName[name].id, null, c)); n -= c } }
  return { detail: `tossed to ${C.entRef(e)}` }
}
async function come_to(ctx, a) {
  const e = C.findEntity(ctx, a.to)
  if (!e) throw new Fail('no_target_known', `${C.fmtValueSafe(a.to)} not in sight`)
  await C.go(ctx, new G.GoalFollow(e, a.dist ?? 2))
  return { detail: `next to ${C.entRef(e)}` }
}
function order(ctx) {
  const o = ctx.interp.lastOrder
  if (!o) throw new Fail('no_target_known', 'no order received from a player')
  return o
}
async function obey(ctx) {
  const o = order(ctx)
  if (ctx.senses) { ctx.senses.memory.goal('push', o.text, 'player', o.from); ctx.senses.push({ kind: 'goal', op: 'push', text: o.text }) }
  ctx.interp.lastOrder = null
  return { detail: `goal from ${o.from}: ${o.text}` }
}
async function refuse(ctx, a) {
  const o = order(ctx)
  ctx.bot.chat(`${o.from}: ${a.reason.text}`.slice(0, 256))
  ctx.interp.lastOrder = null
  return { detail: `refused "${o.text}"` }
}

// ---------------------------------------------------------------- meta
async function wait(ctx, a) { await ctx.sleep(a.dur.dur * 1000); return {} }
function mem(ctx) { if (!ctx.senses) throw new Fail('invalid', 'no memory attached'); return ctx.senses.memory }
async function note(ctx, a) {
  mem(ctx).note(a.text.text, a.key ? a.key.name : undefined)
  ctx.senses.push({ kind: 'note', text: a.text.text })
  return {}
}
async function forget(ctx, a) {
  const m = mem(ctx), k = a.key.name
  const before = m.notes.length + m.places.length + m.routines.length
  m.forget(k)
  m.routines = m.routines.filter(r => r.name !== k); m.save()
  if (m.notes.length + m.places.length + m.routines.length === before) throw new Fail('no_target_known', `nothing named '${k}' in memory`)
  return {}
}
async function name_place(ctx, a) {
  const bot = ctx.bot
  const p = a.at ? C.resolve(ctx, a.at) : { pos: bot.entity.position.floored(), label: 'here' }
  const b = bot.blockAt(p.pos.floored(), false)
  mem(ctx).namePlace(a.name.name, [p.pos.x, p.pos.y, p.pos.z].map(Math.floor), undefined, ctx.senses.dim())
  return { detail: `@${a.name.name} = ${C.fmtPos(p.pos)}${b ? ' (' + b.name + ')' : ''}` }
}
async function save_routine(ctx, a) {
  const src = fmtStmt(a.body)
  mem(ctx).saveRoutine(a.name.name, src)
  return { detail: `routine ${a.name.name} = ${src}` }
}
async function stop() { return { detail: 'nothing was running' } }

module.exports = { plant, bonemeal, breed, lead, tame, feed, say, whisper, give, come_to, obey, refuse, wait, note, forget, name_place, save_routine, stop }
