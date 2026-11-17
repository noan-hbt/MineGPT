// H4 scenario cards (notes/scenario-cards.md): load + validate a card, expand it for a seed (params, templates,
// relative coords), compile it to RCON setup commands, and judge checks on the server (never from the bot's view).
//   const K = require('./sim/cards')
//   const card = K.load('sim/cards/craft/planks.json'); const ep = K.expand(card, 1, { x: 3000, y: 200, z: 3000 })
//   const plan = K.compile(ep, 'LFM'); const judge = new K.Judge(rcon, ep, 'LFM'); await judge.eval(ep.success)
'use strict'
const fs = require('fs')
const path = require('path')

const DIR = path.join(__dirname, 'cards')

// ---------------------------------------------------------------- schema (unknown keys are errors)
const KEYS = {
  card: ['card', 'id', 'title', 'tags', 'difficulty', 'split', 'seeds', 'params', 'let', 'world', 'build', 'entities',
    'player', 'mind', 'order', 'timeline', 'success', 'success_when', 'fail', 'milestones', 'limits', 'solution', 'solution_ticks', 'notes'],
  world: ['template', 'radius', 'height', 'floor', 'depth', 'dimension', 'time', 'weather', 'difficulty', 'gamerules'],
  player: ['at', 'yaw', 'pitch', 'gamemode', 'health', 'food', 'saturation', 'xp_levels', 'spawn', 'effects', 'inventory', 'armor', 'offhand', 'held'],
  item: ['item', 'count', 'slot', 'damage', 'enchant', 'name', 'components'],
  mind: ['places', 'notes', 'dsl'],
  order: ['from', 'text', 'at_tick'],
  limits: ['ticks', 'decisions'],
  entity: ['type', 'item', 'at', 'count', 'tag', 'name', 'nbt', 'no_ai'],
  event: ['at_tick', 'when', 'once', 'chat', 'rcon', 'summon'],
}
const BUILD = { set: ['set', 'block'], fill: ['fill', 'block', 'mode'], feature: ['feature', 'at', 'soil'],
  template: ['template', 'at', 'rotation'], container: ['container', 'block', 'items'], sign: ['sign', 'block', 'text'], rcon: ['rcon'] }
const CHECKS = { have: ['have', 'min', 'max'], block: ['block', 'is'], container: ['container', 'item', 'min', 'max'],
  entity: ['entity', 'near', 'radius', 'min', 'max', 'tag', 'name'], at: ['at', 'radius'], y: ['y'], health: ['health'],
  food: ['food'], xp_levels: ['xp_levels'], died: ['died'], damage_taken: ['damage_taken'], said: ['said'], time: ['time'],
  all: ['all'], any: ['any'], not: ['not'] }
const ENUM = {
  template: ['arena', 'void', 'flat'], dimension: ['overworld', 'the_nether', 'the_end'], weather: ['clear', 'rain', 'thunder'],
  difficulty: ['peaceful', 'easy', 'normal', 'hard'], gamemode: ['survival', 'creative', 'adventure', 'spectator'],
  split: ['train', 'heldout'], mode: ['replace', 'hollow', 'outline', 'keep', 'destroy'], rotation: ['none', 'clockwise_90', '180', 'counterclockwise_90'],
}
const ARMOR = ['head', 'chest', 'legs', 'feet']

function validate(c) {
  const errs = []
  const keys = (o, allowed, where) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) { errs.push(`${where}: expected an object`); return false }
    for (const k of Object.keys(o)) if (!allowed.includes(k)) errs.push(`${where}: unknown key "${k}"`)
    return true
  }
  const en = (v, e, where) => { if (v != null && !ENUM[e].includes(v)) errs.push(`${where}: "${v}" not in ${ENUM[e].join('|')}`) }
  const item = (it, where) => { if (keys(it, KEYS.item, where) && !it.item) errs.push(`${where}: missing item`) }
  for (const r of Object.keys((c.world && c.world.gamerules) || {})) {
    if (!(r in DEFAULT_RULES)) errs.push(`world.gamerules.${r}: no default in cards.js DEFAULT_RULES (it would leak into later cards): add its vanilla value there`)
  }
  const check = (k, where) => {
    if (!k || typeof k !== 'object') return errs.push(`${where}: expected a check object`)
    const kind = Object.keys(k).find(x => CHECKS[x])
    if (!kind) return errs.push(`${where}: unknown check ${JSON.stringify(k).slice(0, 60)}`)
    keys(k, CHECKS[kind], `${where}.${kind}`)
    if (kind === 'all' || kind === 'any') k[kind].forEach((x, i) => check(x, `${where}.${kind}[${i}]`))
    if (kind === 'not') check(k.not, `${where}.not`)
  }
  keys(c, KEYS.card, 'card')
  if (c.card !== 1) errs.push('card: format version must be 1')
  if (!/^[a-z0-9_]+\.[a-z0-9_.]+$/.test(c.id || '')) errs.push('id: expected <area>.<name> (lowercase, digits, _)')
  for (const k of ['title', 'success', 'limits', 'solution']) if (c[k] == null) errs.push(`card: missing ${k}`)
  en(c.split, 'split', 'split')
  if (c.success_when != null && !['any', 'end'].includes(c.success_when)) errs.push('success_when: any|end')
  for (const [k, p] of Object.entries(c.params || {})) {
    if (!(p.int || p.choice || p.bool != null)) errs.push(`params.${k}: expected int|choice|bool`)
  }
  if (c.world) { keys(c.world, KEYS.world, 'world'); for (const e of ['template', 'dimension', 'weather', 'difficulty']) en(c.world[e], e, `world.${e}`) }
  ;(c.build || []).forEach((b, i) => {
    const kind = Object.keys(BUILD).find(x => x in b)
    if (!kind) return errs.push(`build[${i}]: unknown step`)
    keys(b, BUILD[kind], `build[${i}]`)
    en(b.mode, 'mode', `build[${i}].mode`); en(b.rotation, 'rotation', `build[${i}].rotation`)
    ;(b.items || []).forEach((it, j) => item(it, `build[${i}].items[${j}]`))
  })
  ;(c.entities || []).forEach((e, i) => { keys(e, KEYS.entity, `entities[${i}]`); if (!e.type === !e.item) errs.push(`entities[${i}]: type or item`) })
  if (c.player) {
    keys(c.player, KEYS.player, 'player'); en(c.player.gamemode, 'gamemode', 'player.gamemode')
    ;(c.player.inventory || []).forEach((it, i) => item(it, `player.inventory[${i}]`))
    if (c.player.armor) { keys(c.player.armor, ARMOR, 'player.armor'); for (const s of ARMOR) if (c.player.armor[s]) item(c.player.armor[s], `player.armor.${s}`) }
    if (c.player.offhand) item(c.player.offhand, 'player.offhand')
  }
  if (c.mind) keys(c.mind, KEYS.mind, 'mind')
  if (c.order) keys(c.order, KEYS.order, 'order')
  if (c.limits) { keys(c.limits, KEYS.limits, 'limits'); if (!c.limits.ticks) errs.push('limits: missing ticks') }
  ;(c.timeline || []).forEach((e, i) => {
    keys(e, KEYS.event, `timeline[${i}]`)
    if ((e.at_tick == null) === (e.when == null)) errs.push(`timeline[${i}]: at_tick or when`)
    if (e.when) check(e.when, `timeline[${i}].when`)
    if (!e.chat && !e.rcon && !e.summon) errs.push(`timeline[${i}]: needs chat|rcon|summon`)
  })
  if (c.success) check(c.success, 'success')
  if (c.fail) check(c.fail, 'fail')
  ;(c.milestones || []).forEach((m, i) => { if (!m.name) errs.push(`milestones[${i}]: missing name`); check(m.check, `milestones[${i}].check`) })
  if (c.solution && !Array.isArray(c.solution)) errs.push('solution: expected a list of DSL statements')
  return errs
}

function load(file) {
  const c = JSON.parse(fs.readFileSync(file, 'utf8'))
  const errs = validate(c)
  if (errs.length) throw new Error(`${file}:\n  ` + errs.join('\n  '))
  c._file = file
  return c
}

function list(dir = DIR) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...list(f))
    else if (e.name.endsWith('.json')) out.push(f)
  }
  return out.sort()
}

// ---------------------------------------------------------------- expansion
// PRNG seeded by (card id, seed): same card + seed = same params
function rng(str) {
  // seed from sha256 (a weak string hash gave correlated first draws for seeds 1, 2, 3...), then mulberry32
  let a = require('crypto').createHash('sha256').update(str).digest().readUInt32LE(0)
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 }
}

const FUNCS = { ceil: Math.ceil, floor: Math.floor, round: Math.round, min: Math.min, max: Math.max, abs: Math.abs }
// ${expr}: a param name, or arithmetic over params/numbers with ceil/floor/round/min/max/abs
function evalExpr(expr, vars) {
  expr = expr.trim()
  if (Object.prototype.hasOwnProperty.call(vars, expr)) return vars[expr]
  if (!/^[\w\s+\-*/%().,]*$/.test(expr)) throw new Error(`bad expression \${${expr}}`)
  const names = Object.keys(vars).filter(k => typeof vars[k] === 'number' || typeof vars[k] === 'boolean')
  for (const id of expr.match(/[A-Za-z_]\w*/g) || []) if (!names.includes(id) && !FUNCS[id]) throw new Error(`unknown name "${id}" in \${${expr}}`)
  // eslint-disable-next-line no-new-func
  return Function(...Object.keys(FUNCS), ...names, `return (${expr})`)(...Object.values(FUNCS), ...names.map(k => vars[k]))
}

// substitute ${...} in every string; a string that is exactly "${x}" takes x's type (number stays a number)
function subst(v, vars) {
  if (typeof v === 'string') {
    const whole = v.match(/^\$\{([^}]+)\}$/)
    if (whole) return evalExpr(whole[1], vars)
    return v.replace(/\$\{([^}]+)\}/g, (_, e) => String(evalExpr(e, vars)))
  }
  if (Array.isArray(v)) return v.map(x => subst(x, vars))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, subst(x, vars)]))
  return v
}

const DEFAULT_WORLD = { template: 'arena', radius: 15, height: 12, floor: 'stone', depth: 15, dimension: 'overworld', time: 1000,
  weather: 'clear', difficulty: 'easy', gamerules: {} }
// gamerules every card gets unless it overrides them (reproducibility: no random spawns, no fire spread...)
// Every rule a card may set must be listed here: the reset re-applies these each episode, so a rule missing here
// would leak into the next cards (advance_time false froze the clock for every later card: sleep_night failed).
const DEFAULT_RULES = { spawn_monsters: false, spawn_phantoms: false, spawn_patrols: false, spawn_wandering_traders: false,
  advance_weather: false, fire_spread_radius_around_player: 0,
  // vanilla values
  advance_time: true, block_drops: true, mob_drops: true, random_tick_speed: 3, natural_health_regeneration: true,
  keep_inventory: false, mob_griefing: true }
const DEFAULT_PLAYER = { at: '<0,0,0>', yaw: 0, pitch: 0, gamemode: 'survival', health: 20, food: 20, saturation: 5, xp_levels: 0,
  effects: [], inventory: [], armor: {}, offhand: null, held: 0 }

// card + seed + origin -> episode: params drawn, templates substituted, defaults filled. Coords stay "<dx,dy,dz>"
// strings; use ep.pos() / ep.rconPos() / ep.dslPos() / ep.text() to resolve them.
function expand(card, seed, origin) {
  const rand = rng(`${card.id}#${seed}`)
  const vars = {}
  for (const [k, p] of Object.entries(card.params || {})) {
    if (p.int) vars[k] = p.int[0] + Math.floor(rand() * (p.int[1] - p.int[0] + 1))
    else if (p.choice) vars[k] = p.choice[Math.floor(rand() * p.choice.length)]
    else vars[k] = rand() < p.bool
  }
  for (const [k, e] of Object.entries(card.let || {})) vars[k] = subst(e, vars)
  const c = subst(card, vars)
  const ep = {
    id: card.id, seed, params: vars, origin, title: c.title, tags: c.tags || [], split: c.split || 'train',
    world: { ...DEFAULT_WORLD, ...(c.world || {}), gamerules: { ...DEFAULT_RULES, ...((c.world || {}).gamerules || {}) } },
    build: c.build || [], entities: c.entities || [], player: { ...DEFAULT_PLAYER, ...(c.player || {}) },
    mind: { places: {}, notes: [], dsl: [], ...(c.mind || {}) }, order: c.order || null, timeline: c.timeline || [],
    success: c.success, success_when: c.success_when || 'any', fail: c.fail || { died: true }, milestones: c.milestones || [], limits: { decisions: null, ...c.limits },
    solution: c.solution, solution_ticks: c.solution_ticks || null,
  }
  const rel = s => { const m = String(s).match(/^<(-?\d+),(-?\d+),(-?\d+)>$/); if (!m) throw new Error(`${card.id}: bad position "${s}"`); return [+m[1], +m[2], +m[3]] }
  ep.pos = s => { const [a, b, d] = rel(s); return [origin.x + a, origin.y + b, origin.z + d] }
  ep.rconPos = s => ep.pos(s).join(' ')
  const COORD = /<(-?\d+),(-?\d+),(-?\d+)>/g
  ep.rcon = s => s.replace(COORD, (_, a, b, d) => `${origin.x + +a} ${origin.y + +b} ${origin.z + +d}`) // in RCON commands
  ep.text = s => s.replace(COORD, (_, a, b, d) => `(${origin.x + +a},${origin.y + +b},${origin.z + +d})`) // in DSL, chat
  return ep
}

// ---------------------------------------------------------------- compile to RCON
const ns = id => id.startsWith('#') ? '#' + ns(id.slice(1)) : id.includes(':') ? id : 'minecraft:' + id
const snbtStr = s => JSON.stringify(String(s))

// {item, count, damage, enchant, name, components} -> "minecraft:x[comp] count"
function itemArg(it) {
  const comps = []
  if (it.damage) comps.push(`damage=${it.damage}`)
  if (it.enchant) comps.push(`enchantments={${Object.entries(it.enchant).map(([k, v]) => `${snbtStr(ns(k))}:${v}`).join(',')}}`)
  if (it.name) comps.push(`custom_name=${snbtStr(it.name)}`)
  if (it.components) comps.push(it.components)
  return `${ns(it.item)}${comps.length ? `[${comps.join(',')}]` : ''} ${it.count ?? 1}`
}

// fill a box, split in y slabs to stay under the 32768 block limit
function fillBox(a, b, block, mode = '') {
  const [x1, y1, z1] = a, [x2, y2, z2] = b
  const area = (Math.abs(x2 - x1) + 1) * (Math.abs(z2 - z1) + 1)
  const slab = Math.max(1, Math.floor(32768 / area))
  const out = []
  for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y += slab) {
    out.push(`fill ${x1} ${y} ${z1} ${x2} ${Math.min(y + slab - 1, Math.max(y1, y2))} ${z2} ${block}${mode ? ' ' + mode : ''}`)
  }
  return out
}

// episode -> { dim, reset: [...], world: [...], build: [...], player: [...], food, mind: [...] }
// every command must be run through `execute in <dim> run` (plan.dim) except the player-only ones.
function compile(ep, bot) {
  const w = ep.world, o = ep.origin, R = w.radius
  const dim = `minecraft:${w.dimension}`
  const lo = [o.x - R, o.y, o.z - R], hi = [o.x + R, o.y + w.height, o.z + R]
  const region = { x: o.x, y: o.y, z: o.z, r: R + w.height + w.depth } // entity cleanup sphere
  const reset = [
    `clear ${bot}`, `effect clear ${bot}`, `xp set ${bot} 0 levels`, `xp set ${bot} 0 points`,
    `effect give ${bot} minecraft:instant_health 1 28 true`, // health persists across episodes and runs: back to 20
    `kill @e[type=!player,x=${o.x},y=${o.y},z=${o.z},distance=..${region.r}]`,
    `scoreboard objectives add card_deaths deathCount`, `scoreboard objectives add card_damage minecraft.custom:minecraft.damage_taken`,
  ]
  // run by the runner right before tick 0: setup itself can hurt (the bot falls into a pit dug under it, `damage` for
  // player.health) and none of that belongs to the episode
  const scores = [`scoreboard players set ${bot} card_deaths 0`, `scoreboard players set ${bot} card_damage 0`]
  const world = [
    `time set ${w.time}`, `weather ${w.weather}`, `difficulty ${w.difficulty}`,
    ...Object.entries(w.gamerules).map(([k, v]) => `gamerule ${k} ${v}`),
    ...fillBox(lo, hi, 'air'),
  ]
  if (w.template === 'arena') world.push(...fillBox([o.x - R, o.y - w.depth, o.z - R], [o.x + R, o.y - 1, o.z + R], ns(w.floor)))
  else if (w.template === 'void') world.push(...fillBox([o.x - R, o.y - w.depth, o.z - R], [o.x + R, o.y - 1, o.z + R], 'air'))

  const build = []
  for (const b of ep.build) {
    if (b.set) build.push(`setblock ${ep.rconPos(b.set)} ${ns(b.block)}`)
    else if (b.fill) build.push(...fillBox(ep.pos(b.fill[0]), ep.pos(b.fill[1]), ns(b.block), b.mode))
    else if (b.feature) {
      const [x, y, z] = ep.pos(b.at)
      if (b.soil !== null) build.push(`setblock ${x} ${y - 1} ${z} ${ns(b.soil || 'grass_block')}`)
      build.push(`place feature ${ns(b.feature)} ${x} ${y} ${z}`)
    } else if (b.template) build.push(`place template ${ns(b.template)} ${ep.rconPos(b.at)} ${b.rotation || 'none'}`)
    else if (b.container) {
      build.push(`setblock ${ep.rconPos(b.container)} ${ns(b.block || 'chest')}`)
      ;(b.items || []).forEach((it, i) => build.push(`item replace block ${ep.rconPos(b.container)} container.${it.slot ?? i} with ${itemArg(it)}`))
    } else if (b.sign) {
      const msgs = [0, 1, 2, 3].map(i => snbtStr((b.text || [])[i] || ''))
      build.push(`setblock ${ep.rconPos(b.sign)} ${ns(b.block || 'oak_sign')}{front_text:{messages:[${msgs.join(',')}]}}`)
    } else if (b.rcon) build.push(ep.rcon(b.rcon))
  }
  for (const e of ep.entities) build.push(...summon(ep, e))

  const p = ep.player
  const player = [`gamemode ${p.gamemode} ${bot}`, `execute in ${dim} run tp ${bot} ${tpPos(ep.pos(p.at))} ${p.yaw} ${p.pitch}`,
    `spawnpoint ${bot} ${ep.rconPos(p.spawn || p.at)}`]
  if (p.health < 20) player.push(`damage ${bot} ${20 - p.health} minecraft:generic_kill`) // before armor: not reduced
  const used = new Set(p.inventory.filter(i => i.slot != null).map(i => i.slot))
  let free = 0
  for (const it of p.inventory) {
    let s = it.slot
    if (s == null) { while (used.has(free)) free++; s = free; used.add(s) }
    player.push(`item replace entity ${bot} ${s < 9 ? `hotbar.${s}` : `inventory.${s - 9}`} with ${itemArg(it)}`)
  }
  for (const s of ARMOR) if (p.armor[s]) player.push(`item replace entity ${bot} armor.${s} with ${itemArg(p.armor[s])}`)
  if (p.offhand) player.push(`item replace entity ${bot} weapon.offhand with ${itemArg(p.offhand)}`)
  if (p.xp_levels) player.push(`xp set ${bot} ${p.xp_levels} levels`)
  for (const e of p.effects) player.push(`effect give ${bot} ${ns(e.id)} ${e.seconds ?? 30} ${e.amplifier ?? 0} true`)
  // food: there is no command to set it; the runner drains it with hunger down to p.food (saturation is then 0)
  const food = { target: p.food, saturation: p.food >= 20 ? p.saturation : 0 }

  // mind.dsl: statements run by the interpreter; mind.notes: turn `note:` lines (notes are a turn field, not DSL)
  const mind = { dsl: [], notes: ep.mind.notes.map(ep.text) }
  for (const [k, v] of Object.entries(ep.mind.places)) mind.dsl.push(`name_place ${k} at=${ep.text(v)}`)
  for (const s of ep.mind.dsl) mind.dsl.push(ep.text(s))
  return { dim, reset, world, build, player, held: p.held, food, mind, scores, region }
}

const tpPos = ([x, y, z]) => `${x + 0.5} ${y} ${z + 0.5}`

function summon(ep, e) {
  const [x, y, z] = ep.pos(e.at)
  // an item entity is one stack of e.count; a mob is summoned e.count times
  if (e.item) return [`summon minecraft:item ${x + 0.5} ${y} ${z + 0.5} {Item:{id:${snbtStr(ns(e.item))},count:${e.count ?? 1}},Tags:["card"]}`]
  const tags = ['card', ...(e.tag ? [e.tag] : [])].map(snbtStr).join(',')
  let nbt = `Tags:[${tags}]`
  if (e.name) nbt += `,CustomName:${snbtStr(e.name)}`
  if (e.no_ai) nbt += ',NoAI:1b'
  if (e.nbt) nbt += ',' + e.nbt.trim().replace(/^\{|\}$/g, '')
  return Array.from({ length: e.count ?? 1 }, () => `summon ${ns(e.type)} ${x + 0.5} ${y} ${z + 0.5} {${nbt}}`)
}

// ---------------------------------------------------------------- judge (server side, through RCON)
class Judge {
  constructor(rcon, ep, bot, plan) { this.r = rcon; this.ep = ep; this.bot = bot; this.dim = plan.dim; this.chat = [] }
  cmd(c) { return this.r.cmd(`execute in ${this.dim} run ${c}`) }
  async count(c) { const out = await this.cmd(c); const m = out.match(/count: (\d+)/i); return m ? +m[1] : /passed/i.test(out) ? 1 : 0 }
  async data(path) { const out = await this.r.cmd(`data get entity ${this.bot} ${path}`); const m = out.match(/data: (.+)$/); return m ? m[1] : null }
  async num(path) { const v = await this.data(path); return v == null ? NaN : parseFloat(v) }
  async score(obj) { const m = (await this.r.cmd(`scoreboard players get ${this.bot} ${obj}`)).match(/has (-?\d+)/); return m ? +m[1] : 0 }
  async pos() { const v = await this.data('Pos'); return v ? v.replace(/[[\]d]/g, '').split(',').map(Number) : null }
  range(v, r) { return (r.min == null || v >= r.min) && (r.max == null || v <= r.max) }

  async value(k) { // the measured value of a leaf check (for logs)
    const ep = this.ep
    if ('have' in k) {
      const it = ns(k.have)
      let n = 0
      for (const s of ['container.*', 'armor.*', 'weapon.offhand']) n += await this.count(`execute if items entity ${this.bot} ${s} ${it}`)
      return n
    }
    if ('block' in k) return (await this.count(`execute if block ${ep.rconPos(k.block)} ${ns(k.is)}`)) > 0
    if ('container' in k) return this.count(`execute if items block ${ep.rconPos(k.container)} container.* ${ns(k.item)}`)
    if ('entity' in k) {
      const sel = [`type=${ns(k.entity)}`]
      if (k.near) { const [x, y, z] = ep.pos(k.near); sel.push(`x=${x}`, `y=${y}`, `z=${z}`, `distance=..${k.radius ?? 5}`) }
      if (k.tag) sel.push(`tag=${k.tag}`)
      if (k.name) sel.push(`name=${JSON.stringify(k.name)}`)
      return this.count(`execute if entity @e[${sel.join(',')}]`)
    }
    if ('at' in k) { const p = await this.pos(); const t = ep.pos(k.at); return p ? Math.hypot(p[0] - t[0] - 0.5, p[1] - t[1], p[2] - t[2] - 0.5) : Infinity }
    if ('y' in k) { const p = await this.pos(); return p ? Math.floor(p[1]) - ep.origin.y : NaN }
    if ('health' in k) return this.num('Health')
    if ('food' in k) return this.num('foodLevel')
    if ('xp_levels' in k) return this.num('XpLevel')
    if ('died' in k) return (await this.score('card_deaths')) > 0
    if ('damage_taken' in k) return this.score('card_damage')
    if ('said' in k) return this.chat.some(t => new RegExp(k.said, 'i').test(t))
    if ('time' in k) { const m = (await this.r.cmd('time query daytime')).match(/(\d+)/); return m ? +m[1] : NaN }
    throw new Error('unknown check ' + JSON.stringify(k))
  }

  async eval(k) {
    if (!k) return false
    if (k.all) { for (const x of k.all) if (!await this.eval(x)) return false; return true }
    if (k.any) { for (const x of k.any) if (await this.eval(x)) return true; return false }
    if (k.not) return !await this.eval(k.not)
    const v = await this.value(k)
    if ('have' in k || 'container' in k || 'entity' in k) return this.range(v, { min: k.min ?? (k.max == null ? 1 : null), max: k.max })
    if ('block' in k) return v
    if ('at' in k) return v <= (k.radius ?? 1.5)
    if ('died' in k) return v === !!k.died
    if ('said' in k) return v
    const r = k.y || k.health || k.food || k.xp_levels || k.damage_taken || k.time
    return this.range(v, r)
  }

  // {leaf description: measured value} for every leaf, for the episode log
  async explain(k, out = {}) {
    if (!k) return out
    if (k.all || k.any) { for (const x of k.all || k.any) await this.explain(x, out); return out }
    if (k.not) return this.explain(k.not, out)
    out[JSON.stringify(k)] = await this.value(k)
    return out
  }
}

module.exports = { DIR, load, list, validate, expand, compile, itemArg, Judge }

if (require.main === module) { // node sim/cards.js [file...]: validate cards and print the compiled setup for seed 1
  const files = process.argv.slice(2).length ? process.argv.slice(2) : list()
  let bad = 0
  for (const f of files) {
    try {
      const c = load(f)
      for (const s of c.seeds || [1]) {
        const ep = expand(c, s, { x: 3000, y: 200, z: 3000 }); const plan = compile(ep, 'LFM')
        const { parseStmt } = require('../dsl/parse')
        for (const st of [...ep.solution.map(ep.text), ...plan.mind.dsl]) {
          const res = parseStmt(st)
          if (!res.ok) throw new Error(`seed ${s}: DSL "${st}": ${res.error}`)
        }
        if (process.argv.includes('-v') || files.length === 1) console.log(JSON.stringify({ seed: s, params: ep.params, plan, solution: ep.solution.map(ep.text) }, null, 1))
      }
      console.log(`ok   ${c.id}`)
    } catch (e) { bad++; console.log(`FAIL ${f}: ${e.message}`) }
  }
  process.exit(bad ? 1 : 0)
}
