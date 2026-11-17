// TEST driver for H2: makes the bot move so the state / sheet / ledger / map change. NOT a policy, never used as
// training data (the model decides from H3 on). Each action is written as a DSL statement and reported as a
// result event (status, dur, gained/lost, cause) exactly like the H3 interpreter will.
//   modes: wander (gather logs if seen, craft planks/sticks, otherwise walk to a random point) | idle
//   orders (chat): follow | come | stop | wander
'use strict'
const { goals: G } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const P = require('./state/perceive')

const ACTION_TIMEOUT = 25000

class Driver {
  constructor(bot, senses, mode = 'wander') {
    this.bot = bot; this.senses = senses; this.mode = mode
    this.cur = null; this.alive = false; this.followName = null
  }

  running() { return this.cur ? { src: this.cur.src, started_t: this.cur.started_t, ...(this.cur.progress ? { progress: this.cur.progress } : {}) } : null }

  start() { this.alive = true; this.loop() }
  stop() { this.alive = false; this.bot.pathfinder.setGoal(null); try { this.bot.collectBlock.cancelTask() } catch {} }

  order(c, from) {
    if (c === 'stop') this.mode = 'idle'
    else if (c === 'wander') this.mode = 'wander'
    else if (c === 'follow' || c === 'come') { this.mode = c; this.followName = from }
    if (this.cur) { this.cur.interrupted = `order "${c}" from ${from}`; this.bot.pathfinder.setGoal(null); try { this.bot.collectBlock.cancelTask() } catch {} }
  }

  async loop() {
    while (this.alive) {
      try {
        if (this.bot.health <= 0 || !this.bot.entity) { await sleep(1000); continue }
        const next = this.choose()
        if (!next) { await sleep(500); continue }
        await this.run(next.src, next.fn)
      } catch (e) { await sleep(1000) }
    }
  }

  choose() {
    const bot = this.bot
    if (this.mode === 'idle') return null
    if (this.mode === 'follow' || this.mode === 'come') {
      const p = bot.players[this.followName] && bot.players[this.followName].entity
      const verb = this.mode === 'come' ? 'come_to' : 'follow'
      if (this.mode === 'come') this.mode = 'idle'
      const src = `${verb} #player.${this.followName} dist=2`
      if (!p) { this.mode = 'idle'; return { src, fn: async () => ({ status: 'failed', cause: 'no_target_known', detail: `${this.followName} is not in sight` }) } }
      return { src, fn: () => verb === 'follow' ? this.goto(new G.GoalFollow(p, 2), true) : this.goto(new G.GoalNear(p.position.x, p.position.y, p.position.z, 2)) }
    }
    const inv = P.invCounts(bot)
    const logs = Object.entries(inv).filter(([k]) => P.LOGS.has(k)).reduce((s, [, v]) => s + v, 0)
    const planks = Object.entries(inv).filter(([k]) => k.endsWith('_planks')).reduce((s, [, v]) => s + v, 0)
    if (logs >= 2 && planks < 8) {
      const log = Object.keys(inv).find(k => P.LOGS.has(k))
      const out = log.replace(/_(log|wood|stem|hyphae)$/, '').replace(/^stripped_/, '') + '_planks'
      return { src: `craft ${out} n=4`, fn: () => this.craft(out, 1) }
    }
    if (planks >= 2 && (inv.stick || 0) < 4) return { src: 'craft stick n=4', fn: () => this.craft('stick', 1) }
    if (logs < 6 && Math.random() < 0.7) {
      const b = bot.findBlock({ matching: blk => P.LOGS.has(blk.name), maxDistance: 24 })
      if (b) return { src: `mine ${b.name} n=1 near=(${b.position.x},${b.position.y},${b.position.z})`, fn: () => this.collect(b) }
    }
    const a = Math.random() * Math.PI * 2, r = 12 + Math.random() * 20
    const x = Math.floor(bot.entity.position.x + Math.cos(a) * r), z = Math.floor(bot.entity.position.z + Math.sin(a) * r)
    return { src: `goto (${x},~,${z}) dist=2`, fn: () => this.goto(new G.GoalNearXZ(x, z, 2)) }
  }

  async run(src, fn) {
    const t0 = Date.now()
    const before = P.allCounts(this.bot)
    this.cur = { src, started_t: this.senses.t() }
    let status = 'ok', cause, detail
    try {
      const r = await Promise.race([fn(), sleep(ACTION_TIMEOUT).then(() => { throw Object.assign(new Error('timeout'), { cause: 'timeout' }) })])
      if (r && r.status) ({ status, cause, detail } = r)
    } catch (e) {
      if (this.cur.interrupted) { status = 'interrupted'; detail = this.cur.interrupted }
      else { status = 'failed'; cause = e.cause || classify(e.message); detail = e.message.slice(0, 160) }
      this.bot.pathfinder.setGoal(null)
    }
    const after = P.allCounts(this.bot)
    const gained = {}, lost = {}
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const d = (after[k] || 0) - (before[k] || 0)
      if (d > 0) gained[k] = d; else if (d < 0) lost[k] = -d
    }
    this.cur = null
    this.senses.push({ kind: 'result', status, stmt: src, dur_s: Math.round((Date.now() - t0) / 100) / 10,
      ...(Object.keys(gained).length ? { gained } : {}), ...(Object.keys(lost).length ? { lost } : {}),
      ...(cause ? { cause } : {}), ...(detail ? { detail } : {}) })
  }

  async goto(goal, dynamic = false) {
    await this.bot.pathfinder.goto(goal, dynamic)
  }

  async collect(block) {
    await this.bot.collectBlock.collect(block)
    this.senses.map.forget([block.position.x, block.position.y, block.position.z])
  }

  async craft(item, times) {
    const bot = this.bot
    const id = bot.registry.itemsByName[item].id
    const table = bot.findBlock({ matching: bot.registry.blocksByName.crafting_table.id, maxDistance: 4 })
    const rec = bot.recipesFor(id, null, 1, table)[0]
    if (!rec) return { status: 'failed', cause: 'missing_items', detail: `no recipe for ${item} with the current inventory` }
    await bot.craft(rec, times, table)
  }
}

function classify(msg) {
  if (/path|goal|No path/i.test(msg)) return 'no_path'
  if (/timeout|too long/i.test(msg)) return 'timeout'
  if (/inventory/i.test(msg)) return 'inventory_full'
  if (/interrupt|stopped|changed/i.test(msg)) return 'interrupted_by_model'
  return 'unreachable'
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

module.exports = { Driver }
