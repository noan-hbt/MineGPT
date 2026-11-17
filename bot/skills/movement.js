// Movement verbs: goto follow flee explore descend ascend pillar bridge swim_up look wander
'use strict'
const C = require('./common')
const { G, Vec3, Fail } = C

const SCAFFOLD = ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'stone', 'deepslate', 'andesite', 'diorite',
  'granite', 'tuff', 'oak_planks', 'spruce_planks', 'birch_planks', 'sand', 'gravel']
const here = bot => bot.entity.position.floored()
const dist = (bot, p) => Math.round(bot.entity.position.distanceTo(p) * 10) / 10

async function goto(ctx, a) {
  const bot = ctx.bot
  const d = a.dist ?? 1
  const t = C.resolve(ctx, a.target)
  const start = bot.entity.position.clone()
  if (t.kind === 'entity') await C.go(ctx, new G.GoalFollow(t.entity, Math.max(1, d)))
  else if (t.kind === 'block') await C.go(ctx, new G.GoalNear(t.pos.x, t.pos.y, t.pos.z, Math.max(1, d)))
  else if (d <= 0.5) await C.go(ctx, new G.GoalBlock(t.pos.x, t.pos.y, t.pos.z))
  else await C.go(ctx, new G.GoalNear(t.pos.x, t.pos.y, t.pos.z, d))
  return { detail: `at ${C.fmtPos(bot.entity.position)}, ${dist(bot, t.pos)}m from ${t.label}, walked ${Math.round(start.distanceTo(bot.entity.position))}m` }
}

async function follow(ctx, a) {
  const bot = ctx.bot
  const e = C.findEntity(ctx, a.target)
  if (!e) throw new Fail('no_target_known', `no ${C.fmtValueSafe(a.target)} in sight`)
  const ref = C.entRef(e)
  bot.pathfinder.setGoal(new G.GoalFollow(e, ctx.args.dist ?? 2), true)
  for (;;) {
    await ctx.sleep(500)
    if (!bot.entities[e.id]) throw new Fail('no_target_known', `lost sight of ${ref}`)
    ctx.progress(`${dist(bot, e.position)}m from ${ref}`)
  }
}

async function flee(ctx, a) {
  const bot = ctx.bot
  const want = a.dist ?? 16
  const t = C.resolve(ctx, a.from)
  const p0 = t.pos.clone()
  const goal = t.kind === 'entity' ? new G.GoalInvert(new G.GoalFollow(t.entity, want)) : new G.GoalInvert(new G.GoalNear(p0.x, p0.y, p0.z, want))
  bot.pathfinder.setGoal(goal, true)
  for (let i = 0; ; i++) {
    const pos = t.kind === 'entity' ? t.entity.position : p0
    if (t.kind === 'entity' && !bot.entities[t.entity.id]) return { detail: `${t.label} is out of sight` }
    const d = bot.entity.position.distanceTo(pos)
    ctx.progress(`${Math.round(d)}/${want}m from ${t.label}`)
    if (d >= want) { bot.pathfinder.setGoal(null); return { detail: `${Math.round(d)}m from ${t.label}` } }
    await ctx.sleep(250)
  }
}

function seenCells(ctx) {
  const m = ctx.senses && ctx.senses.map
  return m ? [...m.cells.values()].filter(c => c.seen_at).length : 0
}

async function explore(ctx, a) {
  const bot = ctx.bot
  const R = a.radius ?? 48
  const me = bot.entity.position
  let v = null, why = ''
  if (a.dir) {
    if (a.dir.name === 'up' || a.dir.name === 'down') throw new Fail('invalid', 'explore is horizontal: use ascend / descend')
    v = C.DIRV[a.dir.name]; why = a.dir.name
  } else {
    const pref = a.prefer
    const map = ctx.senses && ctx.senses.map
    const st = map ? map.state([Math.floor(me.x), Math.floor(me.y), Math.floor(me.z)], ctx.senses.dim()) : null
    let cell = null
    if (pref && st && pref.name !== 'unexplored') {
      const want = pref.name && pref.name.startsWith('biome:') ? { biome: pref.name.slice(6) } : { res: C.idsOf(pref, 'block') }
      const bx = Math.floor(me.x / 16), bz = Math.floor(me.z / 16)
      cell = st.cells.filter(c => (c.cx !== bx || c.cz !== bz) && (want.biome ? c.biome === want.biome : want.res.some(r => c.resources[r])))
        .sort((p, q) => Math.hypot(p.cx - bx, p.cz - bz) - Math.hypot(q.cx - bx, q.cz - bz))[0]
    }
    if (cell) {
      const tx = cell.cx * 16 + 8, tz = cell.cz * 16 + 8
      v = new Vec3(tx - me.x, 0, tz - me.z); const l = v.norm(); v = v.scaled(1 / l)
      why = `known cell (${tx},${tz}) with ${pref.name || 'tag:' + pref.tag}`
    } else if (st && st.frontier.length) {
      const f = st.frontier[0]
      const DV = { east: [1, 0], south_east: [1, 1], south: [0, 1], south_west: [-1, 1], west: [-1, 0], north_west: [-1, -1], north: [0, -1], north_east: [1, -1] }[f.dir]
      v = new Vec3(DV[0], 0, DV[1]); v = v.scaled(1 / v.norm()); why = `nearest unexplored edge, ${f.dir}`
    } else { const ang = Math.random() * Math.PI * 2; v = new Vec3(Math.cos(ang), 0, Math.sin(ang)); why = 'random direction' }
  }
  const before = seenCells(ctx)
  let r = R, last
  for (let i = 0; i < 3; i++) {
    const x = Math.floor(me.x + v.x * r), z = Math.floor(me.z + v.z * r)
    try { await C.go(ctx, new G.GoalNearXZ(x, z, 3)); last = null; break } catch (e) { if (!(e instanceof Fail)) throw e; last = e; r = Math.floor(r / 2) }
  }
  const moved = Math.round(me.distanceTo(bot.entity.position))
  const detail = `toward ${why}: walked ${moved}m, now at ${C.fmtPos(bot.entity.position)}, ${seenCells(ctx) - before} new map cells`
  if (last) return moved > 8 ? { status: 'partial', cause: last.cause, detail: detail + ` (${last.detail})` } : { status: 'failed', cause: last.cause, detail: detail + ` (${last.detail})` }
  return { detail }
}

// one block below must not be lava / a deep drop
function landing(bot, p) {
  const b = bot.blockAt(p, false)
  if (!b) return 'unloaded'
  if (b.name === 'lava') return `lava at ${C.fmtPos(p)}`
  if (b.boundingBox === 'block') return null
  let k = 0
  while (k < 5) { const u = bot.blockAt(p.offset(0, -k - 1, 0), false); if (!u || u.boundingBox === 'block') break; if (u.name === 'lava') return `lava below ${C.fmtPos(p)}`; k++ }
  return k >= 3 ? `drop of ${k + 1}+ blocks at ${C.fmtPos(p)}` : null
}

async function descend(ctx, a) {
  const bot = ctx.bot
  const y0 = here(bot).y
  const target = ctx.args.to_y ?? y0 - 10
  if (target >= y0) return { detail: `already at y=${y0}` }
  const mode = a.mode ? a.mode.name : 'stairs'
  const v = C.facingVec(bot)
  ctx.total = y0 - target
  while (here(bot).y > (ctx.args.to_y ?? target)) {
    ctx.check()
    const f = here(bot)
    if (mode === 'shaft') {
      const d = landing(bot, f.offset(0, -2, 0)); if (d) throw new Fail('danger', d)
      await C.digAt(ctx, f.offset(0, -1, 0))
      for (let i = 0; i < 10 && here(bot).y === f.y; i++) await ctx.sleep(100)
    } else {
      const n = f.plus(v)
      const d = landing(bot, n.offset(0, -2, 0)); if (d) throw new Fail('danger', d)
      for (const p of [n.offset(0, 1, 0), n, n.offset(0, -1, 0)]) await C.digAt(ctx, p)
      await C.go(ctx, new G.GoalBlock(n.x, n.y - 1, n.z))
    }
    ctx.done = y0 - here(bot).y
    ctx.progress(`y=${here(bot).y} -> ${target}`)
  }
  return { detail: `now at y=${here(bot).y}` }
}

async function ascend(ctx, a) {
  const bot = ctx.bot
  const P = require('../state/perceive')
  const y0 = here(bot).y
  const done = () => ctx.args.to_y != null ? here(bot).y >= ctx.args.to_y : P.seesSky(bot)
  for (let i = 0; i < 40 && !done(); i++) {
    ctx.check()
    const y = here(bot).y
    const ty = ctx.args.to_y != null ? Math.min(ctx.args.to_y, y + 6) : y + 6
    await C.go(ctx, new G.GoalY(ty))
    ctx.progress(`y=${here(bot).y}`)
  }
  if (!done()) throw new Fail('unreachable', `still at y=${here(bot).y}`)
  return { detail: `from y=${y0} to y=${here(bot).y}${P.seesSky(bot) ? ', open sky' : ''}` }
}

function blockChoice(ctx, a) {
  const bot = ctx.bot
  if (a.block) return C.idsOf(a.block, 'item')
  const have = SCAFFOLD.filter(n => C.count(bot, [n]) > 0)
  if (!have.length) throw new Fail('missing_items', `no building block (give block=..., e.g. ${SCAFFOLD.slice(0, 3).join(', ')})`)
  return have
}

async function pillar(ctx, a) {
  const bot = ctx.bot
  const names = blockChoice(ctx, a)
  const n = a.n
  if (C.count(bot, names) < n) throw new Fail('missing_items', `need ${n} blocks, have ${C.count(bot, names)} ${names[0]}`)
  ctx.total = n
  for (let i = 0; i < n; i++) {
    const f = here(bot)
    const head = bot.blockAt(f.offset(0, 2, 0), false)
    if (head && head.boundingBox === 'block') await C.digAt(ctx, f.offset(0, 2, 0))
    await C.equip(ctx, names)
    await ctx.wait(bot.look(bot.entity.yaw, -Math.PI / 2, true))
    bot.setControlState('jump', true)
    for (let k = 0; k < 20 && bot.entity.position.y < f.y + 1.05; k++) await ctx.sleep(25)
    const ref = bot.blockAt(f.offset(0, -1, 0), false)
    try { await ctx.wait(bot.placeBlock(ref, new Vec3(0, 1, 0))) } catch (e) { if (e instanceof C.Abort) throw e }
    bot.setControlState('jump', false)
    for (let k = 0; k < 20 && !bot.entity.onGround; k++) await ctx.sleep(50)
    if (here(bot).y <= f.y) throw new Fail('unreachable', `could not climb at ${C.fmtPos(f)} (ceiling or placement refused)`)
    ctx.done = i + 1; ctx.progress(`${i + 1}/${n}`)
  }
  return { detail: `now at y=${here(bot).y}` }
}

async function bridge(ctx, a) {
  const bot = ctx.bot
  const v = C.DIRV[a.dir.name]
  if (!v || v.y) throw new Fail('invalid', 'bridge goes north/south/east/west')
  const names = blockChoice(ctx, a)
  const n = a.n
  ctx.total = n
  await ctx.wait(bot.lookAt(bot.entity.position.offset(v.x * 4, 1.6, v.z * 4)))
  for (let i = 0; i < n; i++) {
    const f = here(bot)
    const nx = f.plus(v)
    const floor = nx.offset(0, -1, 0)
    const fb = bot.blockAt(floor, false)
    if (!fb || C.replaceable(fb)) {
      if (!C.count(bot, names)) throw new Fail('missing_items', `out of ${names[0]}`)
      await C.equip(ctx, names)
      bot.setControlState('sneak', true)
      await C.placeAt(ctx, floor, [-v.x, 0, -v.z])
    }
    for (const p of [nx.offset(0, 1, 0), nx]) { const b = bot.blockAt(p, false); if (b && b.boundingBox === 'block') await C.digAt(ctx, p) }
    await C.go(ctx, new G.GoalBlock(nx.x, nx.y, nx.z))
    ctx.done = i + 1; ctx.progress(`${i + 1}/${n}`)
  }
  bot.setControlState('sneak', false)
  return { detail: `now at ${C.fmtPos(bot.entity.position)}` }
}

async function swim_up(ctx) {
  const bot = ctx.bot
  if (!bot.entity.isInWater) return { detail: 'not in water' }
  bot.setControlState('jump', true)
  for (let i = 0; i < 200; i++) {
    const head = bot.blockAt(bot.entity.position.offset(0, 1.62, 0).floored(), false)
    if (!bot.entity.isInWater || (head && head.name !== 'water')) break
    await ctx.sleep(100)
  }
  bot.setControlState('jump', false)
  return { detail: `head above water at y=${here(bot).y}` }
}

async function look(ctx, a) {
  const bot = ctx.bot
  const t = C.resolve(ctx, a.target)
  const p = t.kind === 'entity' ? t.entity.position.offset(0, t.entity.height * 0.85, 0) : t.pos.offset(0.5, 0.5, 0.5)
  await ctx.wait(bot.lookAt(p, true))
  return { detail: `looking at ${t.label}` }
}

async function wander(ctx, a) {
  const bot = ctx.bot
  const R = a.radius ?? 12
  const me = bot.entity.position
  let last
  for (let i = 0; i < 3; i++) {
    const ang = Math.random() * Math.PI * 2, r = R * (0.5 + Math.random() * 0.5)
    try { await C.go(ctx, new G.GoalNearXZ(Math.floor(me.x + Math.cos(ang) * r), Math.floor(me.z + Math.sin(ang) * r), 2)); return { detail: `now at ${C.fmtPos(bot.entity.position)}` } } catch (e) { if (!(e instanceof Fail)) throw e; last = e }
  }
  throw last
}

module.exports = { goto, follow, flee, explore, descend, ascend, pillar, bridge, swim_up, look, wander, SCAFFOLD }
