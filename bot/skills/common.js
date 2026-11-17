// Shared helpers for the skills (verb implementations): failures, cancellable waits, target resolution without
// omniscience (blocks must have been seen), inventory helpers, pathing with classified failures.
'use strict'
const { Vec3 } = require('vec3')
const { goals: G } = require('mineflayer-pathfinder')
const N = require('../../spec/names.json')
const P = require('../state/perceive')

// A skill failure with a cause from the closed set (spec/catalog.json failure_causes)
class Fail extends Error {
  constructor(cause, detail) { super(detail || cause); this.cause = cause; this.detail = detail }
}
// Thrown into a running skill when its scope is aborted (until met, timeout, interrupt, death)
class Abort extends Error {
  constructor(reason) { super('aborted: ' + reason.kind); this.reason = reason }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// the bot's pathfinder movements (one config for every entry point). Parkour jumps over lava are refused: the
// pathfinder plans a sprint-jump across a 3-wide lava moat as a normal move and the bot misses it.
function makeMovements(bot) {
  const { Movements } = require('mineflayer-pathfinder')
  dying(bot) // start tracking deaths now (every bot setup goes through here)
  const mv = new Movements(bot)
  mv.canDig = true; mv.allow1by1towers = true
  const lava = bot.registry.blocksByName.lava.id
  const parkour = mv.getMoveParkourForward.bind(mv)
  mv.getMoveParkourForward = function (node, dir, neighbors) {
    for (let d = 1; d <= 3; d++) for (const dy of [-1, -2]) {
      const b = this.getBlock(node, dir.x * d, dy, dir.z * d)
      if (b && b.type === lava) return
    }
    return parkour(node, dir, neighbors)
  }
  return mv
}
const k3 = p => `${p.x},${p.y},${p.z}`
const r1 = P.r1
const fmtPos = p => `(${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)})`

// ---------------------------------------------------------------- ids
const itemTags = N.item_tags, blockTags = N.block_tags
// value {name} | {tag} -> array of ids (item or block tags)
function idsOf(v, kind = 'item') {
  if (!v) return []
  if (v.tag) return [...((kind === 'block' ? blockTags : itemTags)[v.tag] || (kind === 'block' ? itemTags : blockTags)[v.tag] || [])]
  if (v.name) return [v.name]
  return []
}
const label = v => v.tag ? 'tag:' + v.tag : v.name
const fmtValueSafe = v => { try { return require('../dsl/fmt').fmtValue(v) } catch { return '?' } }

// ---------------------------------------------------------------- inventory
function count(bot, names) {
  const s = new Set(names)
  let n = 0
  for (const it of bot.inventory.items()) if (s.has(it.name)) n += it.count
  return n
}
function findItem(bot, names) {
  const s = new Set(Array.isArray(names) ? names : [names])
  return bot.inventory.items().find(it => s.has(it.name)) || null
}
async function equip(ctx, names, dest = 'hand') {
  const bot = ctx.bot
  const list = Array.isArray(names) ? names : [names]
  if (dest === 'hand' && bot.heldItem && list.includes(bot.heldItem.name)) return bot.heldItem
  if (dest === 'off-hand' && bot.inventory.slots[45] && list.includes(bot.inventory.slots[45].name)) return bot.inventory.slots[45]
  const it = findItem(bot, list)
  if (!it) throw new Fail('missing_items', `no ${list.length > 3 ? list.slice(0, 3).join('/') + '/..' : list.join('/')} in inventory`)
  await ctx.wait(bot.equip(it, dest))
  return it
}

// ---------------------------------------------------------------- positions
// facing as a unit horizontal vector (4 directions)
function facingVec(bot) {
  const dx = -Math.sin(bot.entity.yaw), dz = -Math.cos(bot.entity.yaw)
  return Math.abs(dx) > Math.abs(dz) ? new Vec3(Math.sign(dx), 0, 0) : new Vec3(0, 0, Math.sign(dz))
}
const DIRV = { north: new Vec3(0, 0, -1), south: new Vec3(0, 0, 1), east: new Vec3(1, 0, 0), west: new Vec3(-1, 0, 0),
  up: new Vec3(0, 1, 0), down: new Vec3(0, -1, 0) }

function posOf(ctx, v) {
  const o = ctx.origin
  const c = v.pos.map((x, i) => typeof x === 'number' ? x : [o.x, o.y, o.z][i] + (x === '~' ? 0 : +x.slice(1)))
  return new Vec3(c[0], c[1], c[2])
}

// posset -> [Vec3]
function positions(ctx, v) {
  const bot = ctx.bot
  const feet = bot.entity.position.floored()
  if (!v || v.name === 'front') return [feet.plus(facingVec(bot))]
  if (v.name === 'below') return [feet.offset(0, -1, 0)]
  if (v.name === 'above') return [feet.offset(0, 2, 0)]
  if (v.pos) return [posOf(ctx, v)]
  if (v.list) return v.list.flatMap(x => positions(ctx, x))
  if (v.box) {
    const a = posOf(ctx, v.box[0]), b = posOf(ctx, v.box[1])
    const out = []
    for (let y = Math.max(a.y, b.y); y >= Math.min(a.y, b.y); y--)
      for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x++)
        for (let z = Math.min(a.z, b.z); z <= Math.max(a.z, b.z); z++) out.push(new Vec3(x, y, z))
    if (out.length > 512) throw new Fail('invalid', `box has ${out.length} blocks, max 512`)
    return out
  }
  throw new Fail('invalid', `not a position: ${JSON.stringify(v)}`)
}

// ---------------------------------------------------------------- what the bot knows
// line of sight from the eyes to the block. Not bot.canSeeBlock: its ray length is the distance to the block's
// min corner, so the ray toward the center can stop before the block (e.g. a tree 8 east 5 south: lowest logs unseen)
function canSee(bot, p) {
  try {
    const b = bot.blockAt(p, false)
    if (!b) return false
    const eye = bot.entity.position.offset(0, bot.entity.eyeHeight, 0)
    const dir = b.position.offset(0.5, 0.5, 0.5).minus(eye)
    const len = dir.norm() // before normalize(): it mutates dir
    const hit = bot.world.raycast(eye, dir.normalize(), len + 1,
      (blk, iter) => !!iter.intersect(blk.shapes, blk.position) || blk.position.equals(b.position))
    return !!hit && hit.position.equals(b.position)
  } catch { return false }
}
// blocks of the given ids the bot knows about: seen before (senses.seen) or visible now. Nearest first.
function knownBlocks(ctx, ids, { near = null, radius = 48, max = 32, rays = 64 } = {}) {
  const bot = ctx.bot
  const reg = bot.registry
  const idset = ids.map(n => reg.blocksByName[n]).filter(Boolean).map(b => b.id)
  if (!idset.length) return []
  const me = bot.entity.position
  const feet = me.floored()
  const ps = bot.findBlocks({ matching: idset, maxDistance: radius, count: 4000, ...(near ? { point: near } : {}) })
  const under = p => p.x === feet.x && p.z === feet.z && p.y < feet.y // prefer not to dig under itself
  ps.sort((a, b) => (a.distanceTo(me) + (under(a) ? 4 : 0)) - (b.distanceTo(me) + (under(b) ? 4 : 0)))
  const seen = ctx.senses ? ctx.senses.seen : new Set()
  const out = []
  for (const p of ps) {
    const key = k3(p)
    if (seen.has(key)) out.push(p)
    else if (rays > 0) { rays--; if (canSee(bot, p)) { seen.add(key); out.push(p) } }
    if (out.length >= max) break
  }
  return out
}

function findEntity(ctx, v) {
  const bot = ctx.bot
  if (!v) return null
  if (v.entity === 'player') {
    if (!v.ref) return nearest(bot, e => e.type === 'player' && e !== bot.entity)
    const p = bot.players[v.ref]
    return p && p.entity ? p.entity : null
  }
  const kind = v.entity || v.name
  if (v.ref !== undefined) {
    const e = bot.entities[+v.ref]
    return e && e.isValid !== false && !dying(bot).has(e) && (!kind || e.name === kind) ? e : null
  }
  return nearest(bot, e => e.name === kind && e !== bot.entity)
}
// mobs stay in bot.entities for ~1 s of death animation after entityDead: never pick them as targets
function dying(bot) {
  if (!bot._dying) { bot._dying = new WeakSet(); bot.on('entityDead', e => { if (e) bot._dying.add(e) }) }
  return bot._dying
}
function nearest(bot, pred, maxDist = 48) {
  let best = null, bd = maxDist
  const dead = dying(bot)
  for (const e of Object.values(bot.entities)) {
    if (!e.position || dead.has(e) || !pred(e)) continue
    const d = e.position.distanceTo(bot.entity.position)
    if (d < bd) { bd = d; best = e }
  }
  return best
}
const entRef = e => e.type === 'player' ? `#player.${e.username}` : `#${e.name}.${e.id}`

function place(ctx, name) {
  const p = ctx.senses && ctx.senses.memory.places.find(x => x.name === name)
  if (!p) {
    const known = ctx.senses ? ctx.senses.memory.places.map(x => '@' + x.name) : []
    throw new Fail('no_target_known', `unknown place @${name}${known.length ? ' (known: ' + known.slice(0, 8).join(', ') + ')' : ' (no places named yet)'}`)
  }
  return new Vec3(p.pos[0], p.pos[1], p.pos[2])
}

// target -> {kind:'pos'|'entity'|'block', pos, entity?, label}; throws Fail(no_target_known)
function resolve(ctx, v, { blocksOnly = false } = {}) {
  if (v.pos) { const p = posOf(ctx, v); return { kind: 'pos', pos: p, label: fmtPos(p) } }
  if (v.place) return { kind: 'pos', pos: place(ctx, v.place), label: '@' + v.place }
  if (v.entity) {
    const e = findEntity(ctx, v)
    if (!e) throw new Fail('no_target_known', `no ${'#' + v.entity + (v.ref ? '.' + v.ref : '')} in sight`)
    return { kind: 'entity', entity: e, pos: e.position, label: entRef(e) }
  }
  const ids = idsOf(v, 'block')
  const bl = knownBlocks(ctx, ids, { max: 1 })
  if (bl.length) return { kind: 'block', pos: bl[0], label: `${ctx.bot.blockAt(bl[0]).name} ${fmtPos(bl[0])}` }
  if (!blocksOnly && v.name) {
    const e = findEntity(ctx, { entity: v.name })
    if (e) return { kind: 'entity', entity: e, pos: e.position, label: entRef(e) }
  }
  throw new Fail('no_target_known', `no ${label(v)} seen nearby`)
}
function tryResolve(ctx, v) { try { return resolve(ctx, v) } catch { return null } }

// ---------------------------------------------------------------- moving
function pathFail(e) {
  if (e instanceof Abort || e instanceof Fail) return e
  const n = e && e.name
  if (n === 'NoPath') return new Fail('no_path', 'no path found')
  if (n === 'Timeout') return new Fail('no_path', 'path search took too long (target too far or blocked)')
  if (n === 'GoalChanged' || n === 'PathStopped') return new Fail('unreachable', 'movement was stopped')
  return new Fail('unreachable', String(e && e.message || e).slice(0, 160))
}
// pathfinder.goto resolves silently when it finds no move at all: check the goal really is reached
async function go(ctx, goal, retried = false) {
  try { await ctx.wait(ctx.bot.pathfinder.goto(goal)) } catch (e) {
    const f = pathFail(e)
    // mineflayer-pathfinder finds no path from a water surface: swim ashore, then plan again (once)
    if (!retried && f instanceof Fail && f.cause === 'no_path' && ctx.bot.entity.isInWater && await swimOut(ctx)) return go(ctx, goal, true)
    throw f
  }
  const p = ctx.bot.entity.position.floored()
  if (!goal.isEnd(p)) throw new Fail('no_path', `no way to get closer, stopped at ${fmtPos(p)}`)
}
// swim to the nearest dry spot to stand on (solid below, 2 air above) within 6 blocks; true once out of the water
async function swimOut(ctx) {
  const bot = ctx.bot
  const me = bot.entity.position, f = me.floored()
  const dry = b => b && b.boundingBox === 'empty' && b.name !== 'water' && b.name !== 'lava' && b.name !== 'bubble_column'
  let best = null, bd = Infinity
  for (let dx = -6; dx <= 6; dx++) for (let dz = -6; dz <= 6; dz++) for (let dy = -1; dy <= 2; dy++) {
    const p = f.offset(dx, dy, dz)
    const below = bot.blockAt(p.offset(0, -1, 0), false)
    if (!below || below.boundingBox !== 'block' || !dry(bot.blockAt(p, false)) || !dry(bot.blockAt(p.offset(0, 1, 0), false))) continue
    const d = p.offset(0.5, 0, 0.5).distanceTo(me)
    if (d < bd) { bd = d; best = p }
  }
  if (!best) return false
  bot.pathfinder.setGoal(null)
  try {
    for (let i = 0; i < 80 && (bot.entity.isInWater || !bot.entity.onGround); i++) {
      await ctx.wait(bot.lookAt(best.offset(0.5, 1, 0.5), true))
      bot.setControlState('jump', true); bot.setControlState('forward', true) // re-asserted: the pathfinder may clear them
      await ctx.sleep(100)
    }
  } finally { bot.setControlState('jump', false); bot.setControlState('forward', false) }
  return !bot.entity.isInWater
}
// walk until within `dist` of pos (or reach for blocks)
async function near(ctx, pos, dist = 3) {
  const me = ctx.bot.entity.position
  if (me.distanceTo(pos.offset(0.5, 0.5, 0.5)) <= dist) return
  await go(ctx, new G.GoalNear(pos.x, pos.y, pos.z, Math.max(1, Math.floor(dist))))
}
// get within reach of a block to dig/use it
async function reach(ctx, pos) {
  const bot = ctx.bot
  if (bot.entity.position.offset(0, bot.entity.height * 0.9, 0).distanceTo(pos.offset(0.5, 0.5, 0.5)) <= 4.3) return
  // GoalLookAtBlock only works on full faces: for crops, slabs, etc. fall back to standing near it
  try { await go(ctx, new G.GoalLookAtBlock(pos, bot.world, { reach: 4 })) } catch (e) {
    if (!(e instanceof Fail) || e.cause !== 'no_path') throw e
    await go(ctx, new G.GoalNear(pos.x, pos.y, pos.z, 2))
  }
}

// stand within reach of an (empty) position to place into it, but not inside it
async function placeReach(ctx, p) {
  const bot = ctx.bot
  const inside = () => { const f = bot.entity.position.floored(); return f.equals(p) || f.offset(0, 1, 0).equals(p) }
  const eye = () => bot.entity.position.offset(0, 1.62, 0)
  if (eye().distanceTo(p.offset(0.5, 0.5, 0.5)) > 4.3) await go(ctx, new G.GoalNear(p.x, p.y, p.z, 3))
  if (inside()) await go(ctx, new G.GoalInvert(new G.GoalNear(p.x, p.y, p.z, 1.5)))
}

// ---------------------------------------------------------------- digging
function harvestCheck(bot, block) {
  const ht = block.harvestTools
  if (!ht || !Object.keys(ht).length) return null
  const reg = bot.registry
  const ok = Object.keys(ht).map(id => reg.items[id].name)
  if (bot.inventory.items().some(it => ok.includes(it.name))) return null
  const kind = ok[0].split('_').pop() // pickaxe / shovel / ...
  const have = bot.inventory.items().filter(it => it.name.endsWith('_' + kind)).map(it => it.name)
  const weakest = ok.slice().sort((a, b) => tier(a) - tier(b))[0]
  if (have.length) return new Fail('tool_too_weak', `${block.name} needs ${weakest} or better; you have ${have.join(', ')}`)
  return new Fail('missing_tool', `${block.name} needs a ${weakest} or better to drop anything`)
}
const TIERS = ['wooden', 'golden', 'stone', 'copper', 'iron', 'diamond', 'netherite']
const tier = n => TIERS.indexOf(n.split('_')[0])

const DANGER = new Set(['lava', 'fire', 'soul_fire'])
// would breaking p let lava/water in, or open a drop under the bot?
function digDanger(bot, p) {
  for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]]) {
    const b = bot.blockAt(p.offset(d[0], d[1], d[2]), false)
    if (b && DANGER.has(b.name)) return `${b.name} next to ${fmtPos(p)}`
  }
  return null
}

async function digAt(ctx, p, { tool = null, check = true } = {}) {
  const bot = ctx.bot
  const b = bot.blockAt(p, false)
  if (!b) throw new Fail('unreachable', `chunk at ${fmtPos(p)} not loaded`)
  if (b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air') return false
  if (b.name === 'water' || b.name === 'lava') return false
  if (b.hardness == null || b.hardness < 0) throw new Fail('unreachable', `${b.name} cannot be broken`)
  if (check) { const d = digDanger(bot, p); if (d) throw new Fail('danger', d) }
  const hc = harvestCheck(bot, b)
  if (hc) throw hc
  await reach(ctx, p)
  if (tool) await equip(ctx, tool)
  else {
    const best = bot.pathfinder.bestHarvestTool(b)
    if (best) await ctx.wait(bot.equip(best, 'hand'))
  }
  try { await ctx.wait(bot.dig(b, true)) } catch (e) {
    if (e instanceof Abort) throw e
    throw new Fail('unreachable', `dig ${b.name}: ${e.message}`.slice(0, 160))
  }
  if (ctx.senses) ctx.senses.map.forget([p.x, p.y, p.z])
  return true
}

// pick up dropped items near a point (or anywhere within radius)
async function pickup(ctx, { at = null, radius = 4, names = null, maxMs = 6000 } = {}) {
  const bot = ctx.bot
  const t0 = Date.now()
  const skip = new Set()
  await ctx.sleep(250)
  while (Date.now() - t0 < maxMs) {
    const center = at || bot.entity.position
    const it = nearest(bot, e => e.name === 'item' && !skip.has(e.id) && e.position.distanceTo(center) <= radius &&
      (!names || (e.getDroppedItem && e.getDroppedItem() && names.includes(e.getDroppedItem().name))), radius + 8)
    if (!it) return
    // one unreachable drop must not stop the others from being collected
    // stand in the drop's own cell: GoalNear(1) counts as reached from a block above / beside it, out of pickup range
    const goal = new G.GoalBlock(Math.floor(it.position.x), Math.floor(it.position.y + 0.1), Math.floor(it.position.z))
    try { await go(ctx, goal) } catch (e) {
      if (e instanceof Abort) throw e
      try { await go(ctx, new G.GoalNear(it.position.x, it.position.y, it.position.z, 1)) } catch (e2) { if (e2 instanceof Abort) throw e2 }
      skip.add(it.id)
    }
    await ctx.sleep(200)
  }
}

// ---------------------------------------------------------------- placing
const FACES = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
const replaceable = b => !b || b.name === 'air' || b.name === 'cave_air' || b.name === 'water' || b.name === 'lava' ||
  b.name === 'short_grass' || b.name === 'tall_grass' || b.name === 'snow' || b.name === 'fern' || b.name === 'dead_bush'
// place the held block at p against a solid neighbour (preferred face first)
async function placeAt(ctx, p, prefer = null) {
  const bot = ctx.bot
  const cur = bot.blockAt(p, false)
  if (cur && !replaceable(cur)) throw new Fail('unreachable', `${fmtPos(p)} is occupied by ${cur.name}`)
  const faces = prefer ? [prefer, ...FACES] : FACES
  for (const f of faces) {
    const ref = bot.blockAt(p.offset(f[0], f[1], f[2]), false)
    if (!ref || ref.boundingBox !== 'block') continue
    const face = new Vec3(-f[0], -f[1], -f[2])
    await placeReach(ctx, p)
    try { await ctx.wait(bot.placeBlock(ref, face)) } catch (e) {
      if (e instanceof Abort) throw e
      const now = bot.blockAt(p, false)
      if (now && !replaceable(now)) return true // placed, the server confirmation was just late
      throw new Fail('server_refused', `place at ${fmtPos(p)}: ${e.message}`.slice(0, 160))
    }
    return true
  }
  throw new Fail('unreachable', `nothing solid next to ${fmtPos(p)} to place against`)
}

// stop every motor activity (abort cleanup)
function halt(bot) {
  try { bot.pathfinder.stop() } catch {}
  try { bot.pathfinder.setGoal(null) } catch {}
  try { bot.stopDigging() } catch {}
  try { bot.clearControlStates() } catch {}
  try { bot.deactivateItem() } catch {}
  try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch {}
}

// Is the bot burning? The server never sends the shared "on fire" metadata flag for the bot itself (1.21.11,
// measured: metadata[0] never set), so track contact instead: fire / lava at the feet or head keeps the bot burning
// 8 s (fire) / 15 s (lava) of game time after the last contact, water ends it. The flag is still honoured if sent.
function burning(bot) {
  const e = bot.entity
  if (!e) return false
  if (e.metadata && typeof e.metadata[0] === 'number' && (e.metadata[0] & 1)) return true
  if (!bot._fireTrack) {
    bot._fireTrack = { until: -1 }
    const hot = { fire: 160, soul_fire: 160, lava: 300 }
    bot.on('physicsTick', () => {
      if (!bot.entity) return
      const now = bot.time && bot.time.age != null ? Number(bot.time.age) : 0
      if (bot.entity.isInWater) { bot._fireTrack.until = -1; return }
      for (const dy of [0, 1]) {
        const b = bot.blockAt(bot.entity.position.offset(0, dy, 0).floored(), false)
        if (b && hot[b.name]) bot._fireTrack.until = Math.max(bot._fireTrack.until, now + hot[b.name])
      }
    })
  }
  const now = bot.time && bot.time.age != null ? Number(bot.time.age) : 0
  return now < bot._fireTrack.until
}

module.exports = { burning, makeMovements, fmtValueSafe, Fail, Abort, sleep, k3, r1, fmtPos, idsOf, label, count, findItem, equip, facingVec, DIRV, posOf,
  positions, canSee, knownBlocks, findEntity, nearest, entRef, place, resolve, tryResolve, go, near, reach, pathFail,
  harvestCheck, digDanger, digAt, pickup, placeAt, replaceable, halt, G, Vec3, tier }
