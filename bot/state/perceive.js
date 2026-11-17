// Perception: mineflayer bot -> body / inventory / surroundings parts of state.schema.json. Facts only.
// No omniscience: blocks of interest must be exposed (touch air/liquid); `visible` = in line of sight.
'use strict'
const { Vec3 } = require('vec3')
const N = require('../../spec/names.json')

const HOSTILE = new Set(N.hostile)
const SCAN_R = 32
const ENT_R = 48
const ITEM_R = 16
const SLICE_XZ = 9
const SLICE_Y = [-2, 2] // layers relative to the feet block, bottom first

const ARMOR = { leather: [1, 3, 2, 1], golden: [2, 5, 3, 1], chainmail: [2, 5, 4, 1], iron: [2, 6, 5, 2],
  diamond: [3, 8, 6, 3], netherite: [3, 8, 6, 3], copper: [1, 4, 3, 1] }
const ARMOR_SLOT = { helmet: 0, chestplate: 1, leggings: 2, boots: 3 }

const tagSet = t => new Set(N.block_tags[t] || [])
const LOGS = tagSet('logs'), BEDS = tagSet('beds')
const STATIONS = new Set(['crafting_table', 'furnace', 'blast_furnace', 'smoker', 'anvil', 'chipped_anvil', 'damaged_anvil',
  'enchanting_table', 'brewing_stand', 'smithing_table', 'stonecutter', 'grindstone', 'loom', 'cartography_table',
  'fletching_table', 'composter', 'campfire', 'soul_campfire', 'cauldron', 'lectern'])
const CONTAINERS = new Set(['chest', 'trapped_chest', 'barrel', 'ender_chest', 'hopper', 'dispenser', 'dropper', 'shulker_box'])
const MISC = new Set(['water', 'lava', 'spawner', 'trial_spawner', 'obsidian', 'crying_obsidian', 'nether_portal', 'end_portal_frame',
  'bell', 'sugar_cane', 'pumpkin', 'melon', 'hay_block', 'wheat', 'carrots', 'potatoes', 'beetroots', 'bee_nest', 'beehive',
  'sweet_berry_bush', 'cactus', 'bamboo', 'clay', 'gravel', 'sand', 'magma_block', 'powder_snow', 'cobweb', 'budding_amethyst',
  'mossy_cobblestone', 'suspicious_sand', 'suspicious_gravel'])
const isInterest = n => n.endsWith('_ore') || n === 'ancient_debris' || LOGS.has(n) || BEDS.has(n) || STATIONS.has(n)
  || CONTAINERS.has(n) || n.endsWith('shulker_box') || MISC.has(n)
// big uniform clusters: list them but cap the flood fill
const BIG = new Set(['water', 'lava', 'sand', 'gravel', 'clay', 'sugar_cane', 'bamboo', 'cactus', 'wheat', 'carrots', 'potatoes', 'beetroots'])

const DIRS8 = ['east', 'south_east', 'south', 'south_west', 'west', 'north_west', 'north', 'north_east']
function dir8(dx, dz) { // north = -z, east = +x
  if (Math.abs(dx) < 0.5 && Math.abs(dz) < 0.5) return 'here'
  const a = Math.atan2(dz, dx) // 0 = east, +pi/2 = south
  return DIRS8[((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8]
}
function facing(yaw) { // mineflayer yaw: 0 = north (-z), increases counter-clockwise (pi/2 = west)
  return dir8(-Math.sin(yaw), -Math.cos(yaw))
}
const r1 = x => Math.round(x * 10) / 10
const fl = v => [Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)]

function biomeName(bot, b) {
  if (!b || !b.biome) return null
  if (b.biome.name) return b.biome.name
  const r = bot.registry.biomes && bot.registry.biomes[b.biome.id]
  return r ? r.name : null
}
// open sky = no opaque block above the head (water / glass / leaves let you see the sky)
function seesSky(bot) {
  const p = bot.entity.position.floored()
  for (let y = p.y + 2; y < 320; y++) {
    const b = bot.blockAt(p.offset(0, y - p.y, 0), false)
    if (!b) return true
    if (b.boundingBox === 'block' && !b.transparent && !b.name.includes('leaves') && !b.name.includes('glass')) return false
  }
  return true
}

function isAirName(n) { return n === 'air' || n === 'cave_air' || n === 'void_air' }
function passable(b) { return !b || b.boundingBox !== 'block' }

// ---------------------------------------------------------------- body + inventory
function body(bot, mcData) {
  const slots = bot.inventory.slots
  const name = s => (slots[s] ? slots[s].name : null)
  const worn = { head: name(5), chest: name(6), legs: name(7), feet: name(8) }
  let armor = 0
  for (const it of Object.values(worn)) {
    if (!it) continue
    if (it === 'turtle_helmet') { armor += 2; continue }
    const m = it.match(/^([a-z]+)_(helmet|chestplate|leggings|boots)$/)
    if (m && ARMOR[m[1]]) armor += ARMOR[m[1]][ARMOR_SLOT[m[2]]]
  }
  const effects = Object.values(bot.entity.effects || {}).map(e => {
    const def = mcData.effects[e.id]
    const nm = def ? def.name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase() : String(e.id)
    return { name: nm, amp: e.amplifier, dur_s: r1(e.duration / 20) }
  })
  const tools = []
  for (const it of bot.inventory.slots) {
    if (!it || !it.maxDurability) continue
    const t = { name: it.name, dur: it.maxDurability - (it.durabilityUsed || 0), max: it.maxDurability }
    let raw = []
    try { raw = it.enchants } catch {} // prismarine-item getter can throw / return non-arrays on 1.21 components
    const en = (Array.isArray(raw) ? raw : []).map(e => `${e.name} ${e.lvl}`)
    if (en.length) t.enchants = en
    tools.push(t)
  }
  return {
    hp: r1(bot.health), food: bot.food, sat: r1(bot.foodSaturation || 0), xp: bot.experience ? bot.experience.level : 0,
    armor, air: bot.oxygenLevel != null ? Math.round(bot.oxygenLevel * 15) : 300, effects,
    held: bot.heldItem ? bot.heldItem.name : null, offhand: name(45), worn, tools,
  }
}

function invCounts(bot) {
  const c = {}
  for (const it of bot.inventory.items()) c[it.name] = (c[it.name] || 0) + it.count
  return c
}
// counts including armor + offhand (for gain/loss events: equipping is not a loss)
function allCounts(bot) {
  const c = {}
  for (const it of bot.inventory.slots) if (it) c[it.name] = (c[it.name] || 0) + it.count
  return c
}

function inventory(bot) {
  return { items: invCounts(bot), free_slots: bot.inventory.emptySlotCount() }
}

// ---------------------------------------------------------------- surroundings
function boundary(bot, p, name) {
  for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    const b = bot.blockAt(p.offset(d[0], d[1], d[2]), false)
    if (b && b.name !== name) return true
  }
  return false
}
function exposed(bot, p) {
  for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    const b = bot.blockAt(p.offset(d[0], d[1], d[2]), false)
    if (!b || b.boundingBox !== 'block' || b.transparent) return true
  }
  return false
}

let solidIds = null, liquidIds = null
function scanBlocks(bot, mcData) {
  if (!solidIds) {
    solidIds = mcData.blocksArray.filter(b => isInterest(b.name) && b.name !== 'water' && b.name !== 'lava').map(b => b.id)
    liquidIds = ['water', 'lava'].map(n => mcData.blocksByName[n].id)
  }
  const me = bot.entity.position
  // two scans so a lake does not use up the budget of the ores; liquids kept only at their boundary
  // (touching something else), the inside of a lake says nothing more
  const found = bot.findBlocks({ matching: solidIds, maxDistance: SCAN_R, count: 4000 })
  const liquids = bot.findBlocks({ matching: liquidIds, maxDistance: SCAN_R, count: 4000 })
  const byName = new Map()
  const add = (b, p) => {
    if (!byName.has(b.name)) byName.set(b.name, new Map())
    byName.get(b.name).set(`${p.x},${p.y},${p.z}`, p)
  }
  for (const p of found) {
    const b = bot.blockAt(p, false)
    if (b && exposed(bot, p)) add(b, p) // solids must touch air/liquid (no x-ray)
  }
  for (const p of liquids) {
    const b = bot.blockAt(p, false)
    if (b && boundary(bot, p, b.name)) add(b, p)
  }
  // clusters = 26-connected components per block name
  const clusters = []
  for (const [name, set] of byName) {
    const seen = new Set()
    for (const [k, p] of set) {
      if (seen.has(k)) continue
      const comp = []
      const q = [p]; seen.add(k)
      const cap = BIG.has(name) ? 5000 : 300
      while (q.length && comp.length < cap) {
        const c = q.pop(); comp.push(c)
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
          const kk = `${c.x + dx},${c.y + dy},${c.z + dz}`
          if (!seen.has(kk) && set.has(kk)) { seen.add(kk); q.push(set.get(kk)) }
        }
      }
      let best = comp[0], bd = Infinity
      for (const c of comp) { const d = c.offset(0.5, 0.5, 0.5).distanceTo(me); if (d < bd) { bd = d; best = c } }
      clusters.push({ name, pos: [best.x, best.y, best.z], n: comp.length, dist: r1(bd), dir: dir8(best.x + 0.5 - me.x, best.z + 0.5 - me.z), _p: best, _all: comp })
    }
  }
  clusters.sort((a, b) => a.dist - b.dist)
  return clusters
}

// keep only what the bot has actually seen: a cluster is kept when one of its blocks is in line of sight now
// (checked on its nearest members) or was seen before (seen = Set of "x,y,z" kept for the session)
function sightFilter(bot, clusters, seen, maxRays = 400) {
  let rays = 0
  const out = []
  for (const c of clusters) {
    let vis = false
    const members = c._all.length > 4 ? c._all.slice().sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position)).slice(0, 4) : c._all
    for (const m of members) {
      if (rays >= maxRays) break
      rays++
      if (c.dist < 2 || safeSee(bot, m)) { vis = true; break }
    }
    if (vis) for (const m of c._all) seen.add(`${m.x},${m.y},${m.z}`)
    const known = vis || c._all.some(m => seen.has(`${m.x},${m.y},${m.z}`))
    if (known) out.push({ ...c, visible: vis })
  }
  return out
}

function slice(bot, mcData) {
  const o = bot.entity.position.floored()
  const h = (SLICE_XZ - 1) / 2
  const fixed = { '.': 'air', '~': 'water', 'L': 'lava', '@': 'bot' }
  const charOf = new Map([['air', '.'], ['cave_air', '.'], ['void_air', '.'], ['water', '~'], ['lava', 'L']])
  const count = new Map()
  const grid = []
  for (let dy = SLICE_Y[0]; dy <= SLICE_Y[1]; dy++) {
    const layer = []
    for (let dz = -h; dz <= h; dz++) {
      const row = []
      for (let dx = -h; dx <= h; dx++) {
        const b = bot.blockAt(o.offset(dx, dy, dz), false)
        const n = b ? b.name : 'unknown'
        row.push(n); count.set(n, (count.get(n) || 0) + 1)
      }
      layer.push(row)
    }
    grid.push(layer)
  }
  // letters by frequency: first letter of the id, upper then lower case, then digits / symbols
  const pool = 'ABCDEFGHIJKMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789#%&*+=?'.split('')
  const used = new Set(Object.keys(fixed))
  for (const [n] of [...count].sort((a, b) => b[1] - a[1])) {
    if (charOf.has(n)) continue
    const base = n.replace(/^(stripped_|deepslate_|infested_)/, '')
    let ch = [base[0].toUpperCase(), base[0], ...pool].find(c => !used.has(c) && pool.includes(c))
    if (!ch) ch = '?'
    used.add(ch); charOf.set(n, ch)
  }
  const legend = { ...fixed }
  for (const [n, ch] of charOf) if (!isAirName(n) && n !== 'water' && n !== 'lava' && count.has(n)) legend[ch] = n
  for (const k of Object.keys(legend)) if (k !== '@' && ![...count.keys()].some(n => charOf.get(n) === k)) delete legend[k]
  const layers = grid.map((layer, li) => layer.map((row, zi) => row.map((n, xi) =>
    (li === -SLICE_Y[0] && zi === h && xi === h) ? '@' : charOf.get(n)).join('')))
  return { origin: [o.x, o.y, o.z], y_from: o.y + SLICE_Y[0], size: [SLICE_XZ, SLICE_Y[1] - SLICE_Y[0] + 1, SLICE_XZ], legend, layers }
}

function entityHp(e) {
  const m = e.metadata
  return m && typeof m[9] === 'number' ? r1(m[9]) : undefined
}

function entities(bot, prevDist) {
  const me = bot.entity.position
  const out = [], players = [], dist = new Map()
  for (const e of Object.values(bot.entities)) {
    if (e === bot.entity || !e.position) continue
    const d = e.position.distanceTo(me)
    const dx = e.position.x - me.x, dz = e.position.z - me.z
    if (e.type === 'player') {
      if (d <= ENT_R * 2) players.push({ name: e.username, dist: r1(d), dir: dir8(dx, dz), ...(e.heldItem ? { held: e.heldItem.name } : {}) })
      continue
    }
    const kind = e.name || 'unknown'
    if (kind === 'item') {
      if (d > ITEM_R) continue
      const it = e.getDroppedItem && e.getDroppedItem()
      out.push({ ref: `#item.${e.id}`, dist: r1(d), dir: dir8(dx, dz), dy: Math.round(e.position.y - me.y),
        hostile: false, approaching: false, ...(it ? { item: it.name, count: it.count } : {}) })
      continue
    }
    if (!['mob', 'hostile', 'animal', 'passive', 'ambient', 'water_creature'].includes(e.type) || d > ENT_R) continue
    dist.set(e.id, d)
    const pd = prevDist && prevDist.get(e.id)
    const hp = entityHp(e)
    out.push({ ref: `#${kind}.${e.id}`, dist: r1(d), dir: dir8(dx, dz), dy: Math.round(e.position.y - me.y),
      hostile: HOSTILE.has(kind), approaching: pd != null && pd - d > 0.25, ...(hp != null ? { hp } : {}),
      ...(e.heldItem ? { held: e.heldItem.name } : {}) })
  }
  out.sort((a, b) => a.dist - b.dist); players.sort((a, b) => a.dist - b.dist)
  return { entities: out, players, dist }
}

function flags(bot) {
  const f = []
  const e = bot.entity
  if (e.isInWater) f.push('in_water')
  if (e.isInLava) f.push('in_lava')
  if (require('../skills/common').burning(bot)) f.push('on_fire')
  if (e.onGround) f.push('on_ground')
  if (bot.getControlState('sneak')) f.push('sneaking')
  if (bot.getControlState('sprint')) f.push('sprinting')
  const feet = bot.blockAt(e.position.floored(), false)
  if (feet && feet.light === 0 && feet.skyLight < 8) f.push('dark') // block light 0: monsters can spawn here
  return f
}

function surroundings(bot, mcData, ctx) {
  const p = bot.entity.position
  const feet = bot.blockAt(p.floored(), false)
  const { entities: ents, players, dist } = entities(bot, ctx.prevDist)
  ctx.prevDist = dist
  const clusters = ctx.clusters || []
  const blocks = clusters.slice(0, 60).map(c => ({ name: c.name, pos: c.pos, n: c.n, dist: c.dist, dir: c.dir,
    visible: !!c.visible }))
  return {
    pos: fl(p), facing: facing(bot.entity.yaw), dimension: (bot.game.dimension || 'overworld').replace('minecraft:', ''),
    biome: biomeName(bot, feet) || 'unknown', time: bot.time.timeOfDay, day: bot.time.day,
    light: feet ? Math.max(feet.light || 0, feet.skyLight || 0) : 0, sky: seesSky(bot),
    weather: bot.thunderState > 0 ? 'thunder' : bot.isRaining ? 'rain' : 'clear',
    flags: flags(bot), slice: slice(bot, mcData), blocks, entities: ents, players,
  }
}

function safeSee(bot, p) {
  return require('../skills/common').canSee(bot, p) // not bot.canSeeBlock (ray too short, see common.canSee)
}

function stations(clusters) {
  return clusters.filter(c => STATIONS.has(c.name) || CONTAINERS.has(c.name)).slice(0, 12)
    .map(c => ({ kind: c.name, pos: c.pos, dist: c.dist }))
}

module.exports = { sightFilter, biomeName, body, inventory, invCounts, allCounts, surroundings, scanBlocks, stations, dir8, facing, r1, fl,
  passable, LOGS, HOSTILE, seesSky, STATIONS, CONTAINERS }
