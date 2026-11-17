// Senses: attaches to a mineflayer bot, collects events, and builds the full structured state (state.schema.json).
//   const s = new Senses(bot, {session, dataDir}) ; s.push(event) ; s.build({call, running, expect}) -> state
// build() drains the events gathered since the previous build into state.events (and returns them for logging).
'use strict'
const P = require('./perceive')
const { affordances } = require('./afford')
const { Ledger } = require('./ledger')
const { Memory } = require('./memory')
const { MentalMap } = require('./map')

const SCAN_MS = 2000
const MAP_MS = 30000
const LEAVE_R = 52
const SOUND_R = 24
const SOUND_RE = /^entity\.([a-z_]+)\.(ambient|hurt|death|primed|shoot|attack|growl|roar|scream|stare|warn|sonic_boom|explode)|^entity\.generic\.explode|^entity\.tnt\.primed|^block\.(lava|fire)\./
const phase = tod => tod < 12000 ? 'day' : tod < 13000 ? 'dusk' : tod < 23000 ? 'night' : 'dawn'

class Senses {
  constructor(bot, { session, dataDir, source = 'live' } = {}) {
    this.bot = bot
    this.mcData = require('minecraft-data')(bot.version)
    this.t0 = Date.now()
    this.session = session
    this.source = source
    this.memory = new Memory(dataDir && `${dataDir}/memory/${bot.username}.json`, this.t0)
    this.map = new MentalMap(dataDir && `${dataDir}/memory/${bot.username}.map.json`, this.t0)
    this.ledger = new Ledger()
    this.pending = []
    this.ctx = {}
    this.seen = new Set() // block positions seen in line of sight this session
    this.lastScan = 0
    this.prevCounts = null
    this.prevHp = null
    this.prevTime = null
    this.near = new Map() // entity id -> ref, for appear/leave
    this.lastBuild = Date.now()
    this.hurtBy = null
    this.deathMsg = null
    this.soundAt = new Map()
    this.dead = false
    this.attach()
  }

  t() { return Date.now() - this.t0 }
  push(ev) {
    const e = { t: this.t(), ...ev }
    this.pending.push(e)
    if (e.kind === 'result') this.ledger.add(e)
    return e
  }

  attach() {
    const bot = this.bot
    bot.on('entityHurt', (ent, src) => {
      if (ent === bot.entity) this.hurtBy = { at: Date.now(), ref: src ? (src.type === 'player' ? `#player.${src.username}` : `#${src.name}.${src.id}`) : null }
    })
    bot.on('health', () => {
      if (this.prevHp != null && bot.health < this.prevHp) {
        const amount = P.r1(this.prevHp - bot.health)
        this.push({ kind: 'damage', amount, hp: P.r1(bot.health), source: this.damageSource() })
      }
      this.prevHp = bot.health
    })
    bot.on('messagestr', (msg, pos) => {
      if (pos !== 'chat' && msg.startsWith(bot.username + ' ') && !msg.includes('<')) this.deathMsg = { at: Date.now(), text: msg.slice(bot.username.length + 1) }
    })
    bot.on('death', () => {
      if (this.dead) return
      this.dead = true
      const pos = P.fl(bot.entity.position)
      // the death message arrives just after the death packet: wait for it, and hold the respawn event until then
      this.deathDone = new Promise(res => setTimeout(() => {
        const m = this.deathMsg && Date.now() - this.deathMsg.at < 3000 ? this.deathMsg.text : (this.damageSource() || 'unknown')
        const lost = { ...(this.prevCounts || {}) }
        this.push({ kind: 'death', cause: m, pos, lost })
        this.memory.death(pos, m)
        this.map.markDeath(pos, this.dim())
        res()
      }, 700))
    })
    bot.on('spawn', () => {
      if (!this.dead) return
      this.dead = false
      const pos = P.fl(bot.entity.position)
      this.deathDone.then(() => { this.prevCounts = null; this.prevHp = bot.health; this.push({ kind: 'respawn', pos }) })
    })
    bot.on('chat', (from, text) => { if (from !== bot.username) this.push({ kind: 'chat', from, text }) })
    bot.on('whisper', (from, text) => { if (from !== bot.username) this.push({ kind: 'chat', from, text, whisper: true }) })
    bot.on('rain', () => this.push({ kind: 'weather', what: bot.thunderState > 0 ? 'thunder' : bot.isRaining ? 'rain' : 'clear' }))
    const onSound = (name, pos) => {
      if (typeof name !== 'string' || !pos) return
      name = name.replace('minecraft:', '')
      if (!SOUND_RE.test(name)) return
      const d = pos.distanceTo(bot.entity.position)
      if (d > SOUND_R) return
      const last = this.soundAt.get(name) || 0
      if (Date.now() - last < 3000) return
      this.soundAt.set(name, Date.now())
      this.push({ kind: 'sound', name, dist: P.r1(d), dir: P.dir8(pos.x - bot.entity.position.x, pos.z - bot.entity.position.z) })
    }
    // DISABLED: mineflayer resolves sound ids with minecraft-data, wrong for 1.21.11 (a zombie hit was heard as
    // entity.zombie_horse.hurt + entity.zombified_piglin.hurt). Wrong facts are worse than none: re-enable once the
    // id -> name table is taken from the server registry.
    if (process.env.MINEGPT_SOUNDS) bot.on('soundEffectHeard', onSound)
  }

  damageSource() {
    const bot = this.bot
    if (this.hurtBy && Date.now() - this.hurtBy.at < 500 && this.hurtBy.ref) return this.hurtBy.ref
    const e = bot.entity
    if (e.isInLava) return 'lava'
    if (e.metadata && typeof e.metadata[0] === 'number' && (e.metadata[0] & 1)) return 'fire'
    if (bot.oxygenLevel === 0) return 'drown'
    if (bot.food === 0) return 'starve'
    if (this.hurtBy && Date.now() - this.hurtBy.at < 500) return e.onGround ? 'fall_or_unknown' : 'unknown'
    return 'unknown'
  }

  dim() { return (this.bot.game.dimension || 'overworld').replace('minecraft:', '') }

  // derived events: inventory gains/losses, time of day marks, entities appearing/leaving
  derive(running) {
    const bot = this.bot
    const counts = P.allCounts(bot)
    if (this.prevCounts && !this.dead) {
      const gain = {}, loss = {}
      for (const k of new Set([...Object.keys(counts), ...Object.keys(this.prevCounts)])) {
        const d = (counts[k] || 0) - (this.prevCounts[k] || 0)
        if (d > 0) gain[k] = d; else if (d < 0) loss[k] = -d
      }
      const why = running ? running.src : undefined
      if (Object.keys(gain).length) this.push({ kind: 'gain', items: gain, ...(why ? { why } : {}) })
      if (Object.keys(loss).length) this.push({ kind: 'loss', items: loss, ...(why ? { why } : {}) })
    }
    this.prevCounts = counts
    const tod = bot.time.timeOfDay
    const ph = phase(tod)
    if (this.prevTime != null && phase(this.prevTime) !== ph) this.push({ kind: 'time', what: ph })
    this.prevTime = tod
  }

  entityEvents(ents, players) {
    const now = new Map()
    for (const e of ents) if (!e.ref.startsWith('#item.')) now.set(e.ref, e)
    for (const p of players) if (p.dist <= 48) now.set(`#player.${p.name}`, p)
    for (const [ref, e] of now) if (!this.near.has(ref)) this.push({ kind: 'entity_appear', ref, dist: e.dist, dir: e.dir })
    for (const [ref, e] of this.near) if (!now.has(ref)) {
      this.push({ kind: 'entity_leave', ref, dist: e.dist, dir: e.dir })
    }
    this.near = now
  }

  build({ call = 'decision', running = null, expect = null } = {}) {
    const bot = this.bot
    const nowMs = Date.now()
    if (nowMs - this.lastScan >= SCAN_MS || !this.ctx.clusters) {
      this.ctx.clusters = P.sightFilter(bot, P.scanBlocks(bot, this.mcData), this.seen)
      this.map.update(bot, this.ctx.clusters, this.dim())
      this.lastScan = nowMs
    }
    this.derive(running)
    const surroundings = P.surroundings(bot, this.mcData, this.ctx)
    this.entityEvents(surroundings.entities, surroundings.players)
    const inventory = P.inventory(bot)
    const mem = this.memory.state()
    const events = this.pending
    this.pending = []
    const state = {
      meta: { t: this.t(), session: this.session, bot: bot.username, version: '2.0', mc_version: bot.version, source: this.source },
      memory: mem.memory,
      map: this.mapState(surroundings, mem.memory.places),
      episode: mem.episode,
      goals: mem.goals,
      ledger: this.ledger.state(),
      body: P.body(bot, this.mcData),
      inventory: { ...inventory, chests: [] },
      affordances: affordances(inventory.items, { stations: P.stations(this.ctx.clusters) }),
      surroundings,
      events,
      now: { running, expect, since_last_ms: nowMs - this.lastBuild, call },
    }
    this.lastBuild = nowMs
    return state
  }

  // MAP is a stable section: re-exported every MAP_MS, or when the bot changes cell / dimension / named places
  mapState(sur, places) {
    const key = `${sur.dimension}:${Math.floor(sur.pos[0] / 16)},${Math.floor(sur.pos[2] / 16)}:${places.map(p => p.name).join(',')}`
    if (!this.mapCache || this.mapCache.key !== key || Date.now() - this.mapCache.at >= MAP_MS) {
      this.mapCache = { key, at: Date.now(), state: this.map.state(sur.pos, sur.dimension, places) }
    }
    return this.mapCache.state
  }

  save() { this.memory.save(); this.map.save() }
}

module.exports = { Senses }
