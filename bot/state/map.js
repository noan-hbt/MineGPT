// Mental map: coarse grid (16x16 columns) of what the bot has actually seen, persisted per bot.
//   map.update(bot, clusters) after each block scan ; map.state(pos, dimension, places) -> state.map
// Seen = within the scan radius of the bot. Resources = exposed blocks of interest found by the scan (no x-ray).
'use strict'
const fs = require('fs')
const path = require('path')
const { dir8 } = require('./perceive')

const CELL = 16
const SEEN_R = 32          // cells whose center is within this of the bot get seen_t / biome / surface
const MAX_CELLS = 400      // nearest cells exported in the state
const RES_CAP = 999
const WALK_MPS = 4.3
const DANGER = { lava: 'lava', magma_block: 'magma', powder_snow: 'powder_snow', spawner: 'mob_spawner', trial_spawner: 'trial_spawner' }
const STRUCT = { spawner: 'dungeon', bell: 'village', trial_spawner: 'trial_chambers', end_portal_frame: 'stronghold',
  nether_portal: 'nether_portal', suspicious_sand: 'desert_ruins_or_pyramid', suspicious_gravel: 'trail_ruins' }
const NOT_RES = new Set(['water', 'lava'])

class MentalMap {
  constructor(file, t0 = Date.now()) {
    this.file = file; this.t0 = t0
    this.cells = new Map() // "dim:cx,cz" -> cell
    try {
      for (const c of JSON.parse(fs.readFileSync(file, 'utf8')).cells) {
        c.res = new Map(Object.entries(c.res).map(([k, v]) => [k, new Set(v)]))
        c.structures = new Set(c.structures); c.dangers = new Set(c.dangers)
        this.cells.set(`${c.dim}:${c.cx},${c.cz}`, c)
      }
    } catch {}
  }

  cell(dim, cx, cz) {
    const k = `${dim}:${cx},${cz}`
    let c = this.cells.get(k)
    if (!c) { c = { dim, cx, cz, biome: null, visited: false, seen_at: 0, surface_y: null, res: new Map(), structures: new Set(), dangers: new Set() }; this.cells.set(k, c) }
    return c
  }

  update(bot, clusters, dim = 'overworld') {
    const now = Date.now()
    const p = bot.entity.position
    const bx = Math.floor(p.x / CELL), bz = Math.floor(p.z / CELL)
    const span = Math.ceil(SEEN_R / CELL)
    for (let cx = bx - span; cx <= bx + span; cx++) for (let cz = bz - span; cz <= bz + span; cz++) {
      const mx = cx * CELL + 8, mz = cz * CELL + 8
      if (Math.hypot(mx - p.x, mz - p.z) > SEEN_R + 8) continue
      const c = this.cell(dim, cx, cz)
      if (c.surface_y == null || now - c.seen_at > 60000) {
        const s = surface(bot, mx, mz)
        if (s) { c.surface_y = s.y; c.biome = s.biome }
      }
      c.seen_at = now
    }
    this.cell(dim, bx, bz).visited = true
    for (const cl of clusters) for (const b of cl._all) {
      const c = this.cell(dim, Math.floor(b.x / CELL), Math.floor(b.z / CELL))
      if (!NOT_RES.has(cl.name)) {
        if (!c.res.has(cl.name)) c.res.set(cl.name, new Set())
        const s = c.res.get(cl.name)
        if (s.size < RES_CAP) s.add(`${b.x},${b.y},${b.z}`)
      }
      if (DANGER[cl.name]) c.dangers.add(DANGER[cl.name])
      if (STRUCT[cl.name]) c.structures.add(STRUCT[cl.name])
    }
  }

  // blocks gone (mined): drop them from the remembered resources
  forget(pos, dim = 'overworld') {
    const c = this.cells.get(`${dim}:${Math.floor(pos[0] / CELL)},${Math.floor(pos[2] / CELL)}`)
    if (c) for (const s of c.res.values()) s.delete(pos.join(','))
  }
  markDeath(pos, dim = 'overworld') { this.cell(dim, Math.floor(pos[0] / CELL), Math.floor(pos[2] / CELL)).dangers.add('death') }

  save() {
    if (!this.file) return
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const cells = [...this.cells.values()].map(c => ({ ...c, res: Object.fromEntries([...c.res].map(([k, v]) => [k, [...v]])),
      structures: [...c.structures], dangers: [...c.dangers] }))
    fs.writeFileSync(this.file, JSON.stringify({ cell: CELL, cells }))
  }

  state(pos, dim, places = []) {
    const bx = Math.floor(pos[0] / CELL), bz = Math.floor(pos[2] / CELL)
    const mine = [...this.cells.values()].filter(c => c.dim === dim && c.seen_at)
    const d2 = c => (c.cx - bx) ** 2 + (c.cz - bz) ** 2
    mine.sort((a, b) => d2(a) - d2(b))
    const cells = mine.slice(0, MAX_CELLS).map(c => {
      const resources = {}
      for (const [k, v] of [...c.res].sort((a, b) => b[1].size - a[1].size)) if (v.size) resources[k] = v.size
      return { cx: c.cx, cz: c.cz, ...(c.biome ? { biome: c.biome } : {}), visited: c.visited, seen_t: Math.round(c.seen_at - this.t0),
        ...(c.surface_y != null ? { surface_y: c.surface_y } : {}), resources, structures: [...c.structures], dangers: [...c.dangers] }
    })
    // frontier: in each of 8 directions, distance to the first never-seen cell
    const seen = new Set(mine.map(c => `${c.cx},${c.cz}`))
    const frontier = []
    for (const [dx, dz] of [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]) {
      let k = 1
      while (k < 64 && seen.has(`${bx + dx * k},${bz + dz * k}`)) k++
      const tx = (bx + dx * k) * CELL + 8, tz = (bz + dz * k) * CELL + 8
      frontier.push({ dir: dir8(dx, dz), dist: Math.round(Math.hypot(tx - pos[0], tz - pos[2])) })
    }
    frontier.sort((a, b) => a.dist - b.dist)
    const costs = places.filter(p => (p.dimension || 'overworld') === dim).map(p => {
      const d = Math.hypot(p.pos[0] - pos[0], p.pos[1] - pos[1], p.pos[2] - pos[2])
      return { to: '@' + p.name, dist: Math.round(d), eta_s: Math.round(d / WALK_MPS) }
    }).sort((a, b) => a.dist - b.dist)
    return { cell: CELL, cells, frontier, costs }
  }
}

// highest solid block of the column (from a bit above the bot), with its biome
function surface(bot, x, z) {
  const { Vec3 } = require('vec3')
  for (let y = 319; y > -64; y--) {
    const b = bot.blockAt(new Vec3(x, y, z), false)
    if (!b) return null // chunk not loaded
    if (b.boundingBox === 'block' && !b.name.includes('leaves')) return { y, biome: require('./perceive').biomeName(bot, b) }
  }
  return null
}

module.exports = { MentalMap, CELL }
