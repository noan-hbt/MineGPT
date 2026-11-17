// B3 — skill library. Each skill is a robust, parametrised behaviour with its own time budget, retries
// and a failure reason. Every skill resolves to a string: "ok ..." on success / progress, anything else = failure
// (logger.isOk). They never throw on normal failures, so the decision log always gets a readable reason.
//
//   const S = createSkills(bot, mcData, env)
//   await S.gather('oak_log', 3)       await S.mineOre('iron_ore')       await S.craft('stick')
//   await S.smelt('raw_iron')          await S.place('crafting_table')   await S.eat('bread')
//   await S.fight('zombie')            await S.flee('zombie')            await S.explore('north')
//   await S.buildShelter()             await S.sleep()                   await S.farm()
//   await S.storeInChest()             await S.goHome()                  await S.come('player')
//   await S.follow('ZeiK_0', 10000)
//
// env (all optional): isUnreachable(pos), markUnreachable(pos), keep: () => Set of item names storeInChest keeps,
//                     home: Vec3 | null (goHome target; set by bot.js)
'use strict'
const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')

const HOSTILE = new Set(['zombie', 'skeleton', 'creeper', 'spider', 'husk', 'drowned', 'stray', 'witch', 'enderman', 'slime',
  'cave_spider', 'zombie_villager', 'pillager', 'phantom', 'bogged', 'silverfish', 'breeze'])
const FOOD = new Set(['apple', 'bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'baked_potato',
  'carrot', 'beef', 'porkchop', 'chicken', 'mutton', 'sweet_berries', 'melon_slice', 'cookie', 'cooked_cod', 'cooked_salmon',
  'cod', 'salmon', 'potato', 'rabbit', 'cooked_rabbit', 'golden_apple', 'pumpkin_pie', 'beetroot', 'dried_kelp'])
// best Y to look for each ore (1.18+ generation)
const ORE_Y = { coal_ore: 48, copper_ore: 48, iron_ore: 16, gold_ore: -16, lapis_ore: 0, redstone_ore: -58, diamond_ore: -58, emerald_ore: 100 }
const BUILD = ['cobblestone', 'cobbled_deepslate', 'dirt', 'stone', 'deepslate', 'netherrack', 'andesite', 'diorite', 'granite', 'tuff', 'sand', 'gravel']
const CROPS = { wheat: { age: 7, seed: 'wheat_seeds' }, carrots: { age: 7, seed: 'carrot' }, potatoes: { age: 7, seed: 'potato' }, beetroots: { age: 3, seed: 'beetroot_seeds' } }
const WEAPON = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword',
  'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'golden_axe', 'wooden_axe']
const TOOL_RE = /_(pickaxe|axe|shovel|hoe|sword)$/

const sleepMs = ms => new Promise(r => setTimeout(r, ms))
const waitUntil = async (f, ms) => { const end = Date.now() + ms; while (Date.now() < end && !f()) await sleepMs(100) }
const short = e => String(e?.message || e).split('\n')[0].slice(0, 60)

function createSkills(bot, mcData, env = {}) {
  const isUnreachable = env.isUnreachable || (() => false)
  const markUnreachable = env.markUnreachable || (() => {})
  const pos = () => bot.entity.position
  const inv = () => { const c = {}; for (const it of bot.inventory.items()) c[it.name] = (c[it.name] || 0) + it.count; return c }
  const gained = (before, after = inv()) => Object.keys(after).filter(n => after[n] > (before[n] || 0)).map(n => `+${after[n] - (before[n] || 0)} ${n}`)
  const item = name => bot.inventory.items().find(i => i.name === name)
  const stop = () => { bot.pathfinder.setGoal(null); bot.clearControlStates() }
  const hostiles = (r = 16) => Object.values(bot.entities).filter(e => e !== bot.entity && HOSTILE.has(e.name) && e.position.distanceTo(pos()) <= r)
  // abort long skills when something is hitting us and health is low: the reflex in bot.js then flees
  const danger = () => bot.health <= 8 && hostiles(5).length > 0

  // pathfinder.goto with a hard time limit. Never leaves a pending goal behind (see HANDOFF: stop() bug).
  async function goto(goal, ms = 15000) {
    let t
    try {
      await Promise.race([bot.pathfinder.goto(goal), new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms) })])
      return null
    } catch (e) { return short(e) } finally { clearTimeout(t); stop() }
  }

  // ---------- digging ----------
  // mineflayer computes the dig time ONCE, and only sees water when the block at eye level is named "water"
  // (misses swimming, waterlogged blocks, sliding on ice / floating = not on ground). Too short -> the server
  // rejects the finish and the block stays ("breaking stops before the block breaks"). Finishing late is always
  // accepted, so: x5 when the physics says we're in water or airborne, + a margin that grows with each retry.
  let digSlack = 1
  if (!bot._digTimePatched) {
    const orig = bot.digTime
    bot.digTime = block => {
      let t = orig(block)
      const eyeName = bot._getBlockAtEyeLevel()?.name
      if (bot.entity.isInWater && eyeName !== 'water' && eyeName !== 'flowing_water') t *= 5
      return Math.ceil(t * digSlack + 100)
    }
    bot._digTimePatched = true
  }
  // canHarvest with the best tool we have (equips it). false = we lack the tier.
  // Blocks that only drop with a pickaxe tier (stone, ores) -> false without it. Others (leaves, dirt...) always ok.
  const PICKS = new Set(['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'golden_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'].map(n => mcData.itemsByName[n].id))
  async function equipFor(block) {
    try { await bot.tool.equipForBlock(block, { requireHarvest: true }); return true } catch {}
    const needsPick = block.harvestTools && Object.keys(block.harvestTools).some(id => PICKS.has(+id))
    if (needsPick) return false
    try { await bot.tool.equipForBlock(block, {}) } catch {}
    return true
  }
  // never dig the block we stand on (falls into caves/lava, or off a ledge)
  const underFeet = q => { const f = pos().floored(); return q.x === f.x && q.z === f.z && q.y < f.y && q.y >= f.y - 2 }
  // walk next to one block, dig it until it is really gone, pick up the drops.
  // Enclosed blocks (ore inside stone) work too: get near, then dig whatever is between our eyes and the target.
  const eye = () => pos().offset(0, 1.62, 0)
  const sightHit = p => { const c = p.offset(0.5, 0.5, 0.5); return bot.world.raycast(eye(), c.minus(eye()).normalize(), 5.5) }
  async function mineAt(p, deadline, { pickup = true, depth = 0 } = {}) {
    let b = bot.blockAt(p)
    if (!b || b.name === 'air' || b.name === 'cave_air') return 'gone'
    const name = b.name
    if (process.env.SKILLS_DEBUG) console.log(`[mineAt] ${name} ${p} from ${pos().floored()}`)
    const far = () => eye().distanceTo(p.offset(0.5, 0.5, 0.5)) > 4.4
    const left = () => Math.max(1000, Math.min(20000, deadline - Date.now()))
    // rays pass through non-solid blocks (crops, flowers): only the distance matters for those
    const solid = b.boundingBox === 'block'
    if (far() || (solid && !sightHit(p)?.position.equals(p))) {
      let err = await goto(new goals.GoalLookAtBlock(p, bot.world, { reach: 4.4 }), left())
      if (err && depth === 0) err = await goto(new goals.GoalNear(p.x, p.y, p.z, 2), left()) // no visible face: dig a way in
      if (err && far()) return err
    }
    for (let i = 0; i < 4 && depth === 0 && solid; i++) {
      const hit = sightHit(p)
      if (!hit || hit.position.equals(p) || !hit.diggable || underFeet(hit.position)) break
      const e = await mineAt(hit.position, deadline, { pickup: false, depth: 1 })
      if (e && e !== 'gone') break
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      b = bot.blockAt(p)
      if (!b || b.name !== name) break
      if (!await equipFor(b)) return 'need a better tool'
      stop()
      digSlack = [1.15, 2, 5][attempt] // retry = assume we were in water / airborne
      try { await bot.dig(b, true) } catch (e) { if (Date.now() > deadline) return 'timeout'; await sleepMs(150) }
      finally { digSlack = 1 }
      if (bot.blockAt(p)?.name === name) await sleepMs(250) // server may still be confirming
    }
    if (bot.blockAt(p)?.name === name) return 'block did not break'
    if (!pickup) return null
    // drops: walk onto the item entities around the block (they can fall a few blocks into a cave)
    await sleepMs(400)
    const tried = new Set()
    for (let i = 0; i < 4 && Date.now() < deadline; i++) {
      const drop = bot.nearestEntity(e => e.name === 'item' && e.isValid && !tried.has(e.id) && e.position.distanceTo(p) < 7)
      if (!drop) break
      tried.add(drop.id)
      await goto(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 1), 6000)
      await waitUntil(() => !drop.isValid, 800)
    }
    return null
  }

  // gather(block, n): mine up to n blocks of one type nearby. Retries on other blocks of that type when one fails.
  async function gather(name, n = 1, budget = 40000) {
    const blk = mcData.blocksByName[name]
    if (!blk) return `unknown block ${name}`
    const deadline = Date.now() + budget
    const before = inv()
    let mined = 0, fails = 0, lost = 0, reason = null
    const total = () => Object.values(inv()).reduce((a, b) => a + b, 0)
    while (mined - Math.min(lost, 2) < n && Date.now() < deadline) {
      if (danger()) { reason = 'interrupted: danger'; break }
      const me = pos()
      const p = bot.findBlocks({ matching: blk.id, maxDistance: 32, count: 64 })
        .filter(q => !isUnreachable(q) && !underFeet(q)).sort((a, b) => a.distanceTo(me) - b.distanceTo(me))[0]
      if (!p) { reason = `no reachable ${name} found`; break }
      const t0 = total()
      const err = await mineAt(p, deadline)
      if (err === 'need a better tool') { reason = err; break }
      if (err && err !== 'gone') { markUnreachable(p); reason = err; if (++fails >= 3) break; continue }
      mined++
      if (total() <= t0) lost++ // drop not picked up: allow up to 2 extra blocks
    }
    // success = got what this block drops (cobblestone for stone...), not just what we dug through on the way
    const drops = new Set([name, ...(blk.drops || []).map(d => mcData.items[typeof d === 'object' ? d.drop?.id ?? d.id : d]?.name)])
    const after = inv()
    const g = gained(before, after)
    const gotTarget = Object.keys(after).some(k => drops.has(k) && after[k] > (before[k] || 0))
    if (gotTarget) return `ok ${g.join(' ')}` + (mined < n && reason ? ` (stopped: ${reason})` : '')
    if (mined) return 'mined but nothing picked up' + (g.length ? ` (${g.join(' ')})` : '')
    return 'failed: ' + (reason || 'timeout') + (g.length ? ` (${g.join(' ')})` : '')
  }

  // one step of a 1x2 tunnel: dy = -1 -> staircase down, 0 -> straight. Own digging, no pathfinder search
  // (GoalY / far GoalXZ underground = "Took to long to decide path"). Refuses steps next to lava / water.
  const LIQUID = /lava|water/
  async function digStep(dx, dz, dy, deadline) {
    const f = pos().floored()
    const t = f.offset(dx, dy, dz) // feet cell after the step
    const cells = dy < 0 ? [f.offset(dx, 1, dz), f.offset(dx, 0, dz), t] : [t.offset(0, 1, 0), t]
    for (const c of cells) {
      for (const [ox, oy, oz] of [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const n = bot.blockAt(c.offset(ox, oy, oz))
        if (!n) return 'unloaded'
        if (LIQUID.test(n.name)) return `liquid ahead (${n.name} at ${n.position})`
      }
    }
    const floor = bot.blockAt(t.offset(0, -1, 0))
    if (floor && floor.boundingBox !== 'block') {
      // open floor = cave: fine if there is ground within 3 blocks, else turn
      let ground = false
      for (let k = 2; k <= 4; k++) { const g = bot.blockAt(t.offset(0, -k, 0)); if (g?.boundingBox === 'block') { ground = !LIQUID.test(g.name); break } }
      if (!ground) return 'drop ahead'
    }
    for (let round = 0; round < 4; round++) { // gravel/sand can fall back in
      const solid = cells.filter(c => bot.blockAt(c)?.boundingBox === 'block')
      if (!solid.length) break
      for (const c of solid) {
        const b = bot.blockAt(c)
        if (!b.diggable || b.name === 'bedrock') return 'bedrock'
        const err = await mineAt(c, deadline, { pickup: false, depth: 1 })
        if (err && err !== 'gone') return err
      }
    }
    return goto(new goals.GoalBlock(t.x, t.y, t.z), 4000)
  }

  // a spot r blocks away (8 directions) whose top block is solid, not water/ice: where to dig from
  function dryGround(r) {
    const p = pos().floored(), out = []
    for (let k = 0; k < 8; k++) {
      const a = k * Math.PI / 4, x = Math.round(p.x + Math.cos(a) * r), z = Math.round(p.z + Math.sin(a) * r)
      for (let y = p.y + 6; y >= p.y - 6; y--) {
        const b = bot.blockAt(new Vec3(x, y, z))
        if (!b || b.boundingBox !== 'block' && !LIQUID.test(b.name)) continue
        if (b.boundingBox === 'block' && !/ice|water/.test(b.name)) out.push(new Vec3(x, y + 1, z))
        break
      }
    }
    return out[Math.floor(Math.random() * out.length)] || null
  }

  // mineOre(ore): gather it if visible, else staircase down to its usual depth and tunnel until one shows up
  async function mineOre(ore, n = 1, budget = 60000) {
    const ids = [ore, 'deepslate_' + ore].map(x => mcData.blocksByName[x]?.id).filter(x => x !== undefined)
    if (!ids.length) return `unknown ore ${ore}`
    const deadline = Date.now() + budget
    const visible = () => bot.findBlocks({ matching: ids, maxDistance: 16, count: 16 }).filter(q => !isUnreachable(q))
    const take = async () => {
      const name = bot.blockAt(visible()[0]).name
      return gather(name, n, Math.max(8000, deadline - Date.now()))
    }
    if (visible().length) { const r = await take(); if (r.startsWith('ok')) return r }
    const y0 = Math.floor(pos().y)
    const targetY = ORE_Y[ore] ?? 16
    const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]]
    let d = Math.floor(Math.random() * 4), steps = 0, blocked = 0
    while (Date.now() < deadline - 1000) {
      if (danger()) return 'failed: interrupted: danger'
      if (visible().length) { const r = await take(); if (r.startsWith('ok')) return r } // failed ones get marked unreachable
      const down = Math.floor(pos().y) > targetY
      const [dx, dz] = dirs[d % 4]
      const err = await digStep(dx, dz, down ? -1 : 0, deadline)
      if (err) {
        if (process.env.SKILLS_DEBUG) console.log(`[mineOre] step ${dirs[d % 4]} ${down ? 'down' : 'flat'}: ${err}`)
        d++; steps = 0
        if (++blocked % 4 === 0) { // boxed in (water, lava, bedrock): walk to dry ground and retry
          if (blocked >= 24) break
          const t = dryGround(16) || (() => { const a = Math.random() * 2 * Math.PI; return pos().offset(Math.cos(a) * 16, 0, Math.sin(a) * 16) })()
          await goto(new goals.GoalNearXZ(t.x, t.z, 2), Math.min(15000, deadline - Date.now()))
        }
        continue
      }
      blocked = 0
      if (++steps >= (down ? 40 : 20)) { d++; steps = 0 } // branch: turn every 20 blocks of tunnel
    }
    const y1 = Math.floor(pos().y)
    return y1 < y0 - 3 ? `ok now at y ${y1}, no ${ore} yet` : `failed: no ${ore} found`
  }

  // ---------- crafting / stations ----------
  const nearBlock = (name, d = 12) => mcData.blocksByName[name] && bot.findBlock({ matching: mcData.blocksByName[name].id, maxDistance: d })

  async function craft(name, n = 1) {
    const it = mcData.itemsByName[name]
    if (!it) return `unknown item ${name}`
    let table = null
    let recipe = bot.recipesFor(it.id, null, 1, null)[0]
    if (!recipe) {
      table = nearBlock('crafting_table')
      if (!table) return 'needs crafting_table'
      recipe = bot.recipesFor(it.id, null, 1, table)[0]
      if (!recipe) return 'missing ingredients'
      if (table.position.distanceTo(pos()) > 4) {
        const err = await goto(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2), 12000)
        if (err) return 'could not reach crafting_table: ' + err
      }
      table = nearBlock('crafting_table', 5)
      if (!table) return 'could not reach crafting_table'
    }
    let done = 0
    for (; done < n; done++) {
      const r = bot.recipesFor(it.id, null, 1, table)[0]
      if (!r) break
      try { await bot.craft(r, 1, table) } catch (e) { if (!done) return 'failed: ' + short(e); break }
    }
    return done ? `ok crafted ${name}` + (done > 1 ? ' x' + done : '') : 'missing ingredients'
  }

  // a cell where a block can be placed: replaceable (air/grass/snow), solid block below, not where we stand
  const replaceable = b => b && (b.name === 'air' || b.name === 'cave_air' || b.name === 'short_grass' || b.name === 'tall_grass' || b.name === 'snow')
  function findPlaceSpot(r = 3) {
    const me = pos().floored()
    const cells = []
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) for (const dy of [0, -1, 1]) {
      if (!dx && !dz) continue
      const c = me.offset(dx, dy, dz)
      if (!replaceable(bot.blockAt(c))) continue
      const below = bot.blockAt(c.offset(0, -1, 0))
      if (!below || below.boundingBox !== 'block') continue
      const d = c.offset(0.5, 0, 0.5).distanceTo(pos())
      if (d < 1.2 || d > 4.2) continue
      // the top face of the support block must be visible from our eyes (else it's behind a wall)
      const eye = pos().offset(0, 1.62, 0), face = below.position.offset(0.5, 1, 0.5)
      const hit = bot.world.raycast(eye, face.minus(eye).normalize(), 5)
      if (!hit || !hit.position.equals(below.position)) continue
      cells.push({ c, below, d })
    }
    cells.sort((a, b) => a.d - b.d)
    return cells[0] || null
  }
  // also counts a diggable wall next to us (tunnels): dig it out, then place in the hole
  function diggableSpot() {
    const me = pos().floored()
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const c = me.offset(dx, 0, dz)
      const b = bot.blockAt(c), below = bot.blockAt(c.offset(0, -1, 0))
      if (b && b.diggable && b.boundingBox === 'block' && !/ore$/.test(b.name) && below?.boundingBox === 'block' && b.name !== 'bedrock') return c
    }
    return null
  }
  const canPlace = () => !!(findPlaceSpot() || diggableSpot())

  async function place(name) {
    const it = item(name)
    if (!it) return `no ${name} in inventory`
    let spot = findPlaceSpot()
    if (!spot) {
      const c = diggableSpot()
      if (!c) return 'no free spot'
      const err = await mineAt(c, Date.now() + 8000, { pickup: false }) // don't walk into the hole we place into
      if (err && err !== 'gone') return 'no free spot (dig failed: ' + err + ')'
      spot = { c, below: bot.blockAt(c.offset(0, -1, 0)) }
      await sleepMs(300)
    }
    let err = null
    for (let i = 0; i < 2 && bot.blockAt(spot.c)?.name !== name; i++) {
      try {
        await bot.equip(item(name), 'hand')
        await bot.lookAt(spot.below.position.offset(0.5, 1, 0.5), true)
        await bot.placeBlock(bot.blockAt(spot.below.position), new Vec3(0, 1, 0))
      } catch (e) { err = e; await sleepMs(300) }
    }
    if (bot.blockAt(spot.c)?.name !== name && err) return 'failed: ' + short(err)
    return bot.blockAt(spot.c)?.name === name ? `ok placed ${name}` : 'failed: block not placed'
  }

  async function smelt(input, n = 8) {
    let fb = nearBlock('furnace')
    if (!fb) return 'no furnace nearby'
    if (fb.position.distanceTo(pos()) > 3) {
      const err = await goto(new goals.GoalNear(fb.position.x, fb.position.y, fb.position.z, 2), 12000)
      if (err) return 'could not reach furnace: ' + err
    }
    fb = nearBlock('furnace', 5)
    if (!fb) return 'could not reach furnace'
    const have = inv()
    n = Math.min(have[input] || 0, n)
    if (!n) return `no ${input}`
    const fuel = ['coal', 'charcoal'].find(f => have[f]) || Object.keys(have).find(k => k.endsWith('_planks'))
      || Object.keys(have).find(k => k.endsWith('_log') && k !== input)
    const before = inv()
    let f
    try { f = await bot.openFurnace(fb) } catch (e) { return 'failed: ' + short(e) }
    try {
      // leftovers from an earlier run first
      if (f.outputItem()) await f.takeOutput()
      if (!f.fuelItem() && !fuel) return 'no fuel'
      if (!f.fuelItem()) await f.putFuel(mcData.itemsByName[fuel].id, null, Math.min(have[fuel], /coal/.test(fuel) ? Math.ceil(n / 8) : Math.ceil(n / 1.5)))
      await f.putInput(mcData.itemsByName[input].id, null, n)
      let got = 0
      const end = Date.now() + n * 10500 + 3000
      while (Date.now() < end && got < n) {
        await sleepMs(1000)
        if (f.outputItem()) { got += f.outputItem().count; await f.takeOutput() }
        if (!f.inputItem()) break
        if (danger()) break
      }
      if (f.outputItem()) await f.takeOutput()
      if (f.inputItem()) await f.takeInput() // leftovers back: keeps the planner's view honest
    } catch (e) { return 'failed: ' + short(e) } finally { f.close() }
    const g = gained(before).filter(s => !s.endsWith(' ' + input))
    return g.length ? 'ok ' + g.join(' ') : 'nothing smelted'
  }

  // ---------- survival ----------
  async function eat(name) {
    name = name || bot.inventory.items().map(i => i.name).find(n => FOOD.has(n))
    const it = name && item(name)
    if (!it) return `no ${name || 'food'}`
    if (bot.food >= 20) return 'not hungry'
    try { await bot.equip(it, 'hand'); await bot.consume() } catch (e) { return 'failed: ' + short(e) }
    return `ok food ${bot.food}/20`
  }

  const nearestEntity = name => bot.nearestEntity(e => e !== bot.entity && (name === 'player' ? e.type === 'player' : e.name === name))
  async function equipWeapon() {
    const w = WEAPON.map(item).find(Boolean)
    if (w && bot.heldItem?.name !== w.name) try { await bot.equip(w, 'hand') } catch {}
  }

  // fight(mob): melee until dead/gone; retreats (returns) when health gets low instead of dying
  async function fight(name, budget = 15000, minHp = 7) {
    const end = Date.now() + budget
    let hits = 0
    try {
      while (Date.now() < end) {
        const e = nearestEntity(name)
        if (!e || !e.isValid) return hits ? `ok ${name} killed` : `${name} gone/killed`
        if (bot.health <= minHp && HOSTILE.has(name)) return `retreat: low health ${Math.round(bot.health)}`
        await equipWeapon()
        const d = e.position.distanceTo(pos())
        if (d > 3) {
          if (d > 24) return `${name} too far`
          bot.pathfinder.setGoal(new goals.GoalFollow(e, 1.5), true)
          await sleepMs(250)
          continue
        }
        bot.pathfinder.setGoal(null)
        await bot.lookAt(e.position.offset(0, e.height * 0.8, 0), true)
        bot.attack(e); hits++
        await sleepMs(620) // sword cooldown
      }
      return 'still fighting'
    } finally { stop() }
  }

  // flee: run away from every hostile around (not only the named one), sprinting, until >= dist blocks away
  async function flee(name, dist = 14, budget = 8000) {
    const end = Date.now() + budget
    try {
      while (Date.now() < end) {
        const foes = hostiles(16).filter(e => !name || name === 'all' || HOSTILE.has(name) ? true : e.name === name)
        const near = foes.filter(e => e.position.distanceTo(pos()) < dist)
        if (!near.length) break
        // direction away from the foes' centre
        const c = near.reduce((a, e) => a.plus(e.position), new Vec3(0, 0, 0)).scaled(1 / near.length)
        let v = pos().minus(c); v.y = 0
        if (v.norm() < 0.1) v = new Vec3(1, 0, 0)
        v = v.normalize().scaled(dist + 4)
        bot.setControlState('sprint', true)
        const t = pos().plus(v)
        bot.pathfinder.setGoal(new goals.GoalNearXZ(t.x, t.z, 2), false)
        await sleepMs(1200)
      }
    } finally { stop() }
    const foe = hostiles(32).sort((a, b) => a.position.distanceTo(pos()) - b.position.distanceTo(pos()))[0]
    const d = foe ? Math.round(foe.position.distanceTo(pos())) : 99
    return d >= Math.min(dist, 10) ? `ok ${foe ? d + 'm from ' + foe.name : 'no hostile around'}` : `failed: still ${d}m from ${foe.name}`
  }

  // dig in: 3 blocks down and close the hole with a block. Needs 1 building block (or digs one out first).
  let shelterPos = null
  async function buildShelter() {
    if (!bot.entity.onGround) return 'failed: not on ground'
    const start = pos().floored()
    const deadline = Date.now() + 25000
    for (let i = 1; i <= 3; i++) {
      const c = start.offset(0, -i, 0)
      const b = bot.blockAt(c)
      if (!b) return 'failed: unloaded'
      if (b.name === 'bedrock' || b.name.includes('lava') || b.name.includes('water')) return `failed: ${b.name} below`
      const under = bot.blockAt(c.offset(0, -1, 0))
      if (under && (under.name.includes('lava') || under.name.includes('water') || under.name === 'air' || under.name === 'cave_air') && i === 3) return 'failed: cave or liquid below'
      if (b.boundingBox === 'block') {
        if (!await equipFor(b)) return 'failed: need a better tool to dig in'
        try { await bot.dig(b, true) } catch (e) { return 'failed: ' + short(e) }
      }
      await sleepMs(350)
      if (Date.now() > deadline) return 'failed: timeout'
    }
    await sleepMs(400)
    // cover: the cell at the old ground level, placed against one of its solid side neighbours
    const cover = start.offset(0, -1, 0)
    const blockItem = () => BUILD.map(item).find(Boolean)
    if (!blockItem()) return 'failed: no block to close the hole'
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ref = bot.blockAt(cover.offset(dx, 0, dz))
      if (!ref || ref.boundingBox !== 'block') continue
      try {
        await bot.equip(blockItem(), 'hand')
        await bot.placeBlock(ref, new Vec3(-dx, 0, -dz))
      } catch {}
      if (bot.blockAt(cover)?.boundingBox === 'block') { shelterPos = pos().floored(); return `ok sheltered at y ${shelterPos.y}` }
    }
    return 'failed: could not close the hole'
  }
  const inShelter = () => {
    if (!shelterPos || pos().floored().distanceTo(shelterPos) > 1) return false
    const above = bot.blockAt(pos().floored().offset(0, 2, 0))
    return above?.boundingBox === 'block'
  }

  async function sleep(waitMs = 30000) {
    if (bot.time.timeOfDay < 12542 && !bot.thunderState) return 'failed: can only sleep at night'
    let bed = bot.findBlock({ matching: b => b.name.endsWith('_bed'), maxDistance: 24 })
    if (!bed) {
      const bi = bot.inventory.items().find(i => i.name.endsWith('_bed'))
      if (!bi) return 'no bed'
      const r = await place(bi.name)
      if (!r.startsWith('ok')) return 'failed to place bed: ' + r
      await sleepMs(600) // second half of the bed arrives in a later block update
      bed = bot.findBlock({ matching: b => b.name.endsWith('_bed'), maxDistance: 6 })
      if (!bed) return 'failed: bed not found after placing'
    }
    if (bed.position.distanceTo(pos()) > 2.5) {
      const err = await goto(new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 1), 15000)
      if (err) return 'could not reach bed: ' + err
    }
    try { await bot.sleep(bed) } catch (e) { return 'failed: ' + short(e) }
    const woke = await new Promise(res => { const t = setTimeout(() => res(false), waitMs); bot.once('wake', () => { clearTimeout(t); res(true) }) })
    return woke ? 'ok slept, it is day' : 'ok sleeping'
  }

  // farm: harvest mature crops nearby, replant with the seed
  async function farm(budget = 40000) {
    const deadline = Date.now() + budget
    const before = inv()
    let harvested = 0, planted = 0
    while (Date.now() < deadline && harvested < 16) {
      const b = bot.findBlock({ maxDistance: 16, matching: bl => CROPS[bl.name] && bl.getProperties().age >= CROPS[bl.name].age })
      if (!b) break
      const p = b.position.clone(), seed = CROPS[b.name].seed
      const err = await mineAt(p, deadline)
      if (err && err !== 'gone') { if (process.env.SKILLS_DEBUG) console.log('[farm] harvest', err); markUnreachable(p); break }
      harvested++
      const soil = bot.blockAt(p.offset(0, -1, 0))
      if (soil?.name === 'farmland' && item(seed)) {
        try { await bot.equip(item(seed), 'hand'); await bot.placeBlock(soil, new Vec3(0, 1, 0)); planted++ } catch (e) { if (process.env.SKILLS_DEBUG) console.log('[farm] replant', e.message) }
      }
    }
    const g = gained(before)
    if (!harvested) return 'no mature crops nearby'
    return `ok harvested ${harvested}, replanted ${planted}` + (g.length ? ' ' + g.join(' ') : '')
  }

  // storeInChest: deposit everything except tools, food, stations and env.keep() items
  async function storeInChest() {
    let ch = nearBlock('chest', 16)
    if (!ch) {
      if (!item('chest')) return 'no chest nearby'
      const r = await place('chest')
      if (!r.startsWith('ok')) return 'failed to place chest: ' + r
      ch = nearBlock('chest', 6)
    }
    if (ch.position.distanceTo(pos()) > 3) {
      const err = await goto(new goals.GoalNear(ch.position.x, ch.position.y, ch.position.z, 2), 15000)
      if (err) return 'could not reach chest: ' + err
    }
    const keep = env.keep ? env.keep() : new Set()
    let c
    try { c = await bot.openContainer(bot.blockAt(ch.position)) } catch (e) { return 'failed: ' + short(e) }
    let n = 0
    try {
      for (const it of bot.inventory.items()) {
        if (TOOL_RE.test(it.name) || FOOD.has(it.name) || keep.has(it.name) || ['crafting_table', 'furnace', 'torch'].includes(it.name)) continue
        try { await c.deposit(it.type, null, it.count); n += it.count } catch { break }
      }
    } finally { c.close() }
    if (env.onStore) env.onStore(ch.position)
    return n ? `ok stored ${n} items` : 'nothing to store'
  }

  async function goHome() {
    const h = env.home
    if (!h) return 'no home set'
    if (h.distanceTo(pos()) <= 3) return 'ok already home'
    const err = await goto(new goals.GoalNear(h.x, h.y, h.z, 2), 45000)
    const d = Math.round(h.distanceTo(pos()))
    return d <= 3 ? 'ok home' : err === 'timeout' ? `ok on the way, ${d}m left` : `failed: ${err || d + 'm left'}`
  }

  async function explore(dir, budget = 20000) {
    const p0 = pos().clone()
    let err
    if (dir === 'down') {
      err = await goto(new goals.GoalY(Math.floor(p0.y) - 10), budget)
      const dy = Math.floor(p0.y) - Math.floor(pos().y)
      return !err ? `ok now at y ${Math.floor(pos().y)}` : dy >= 3 ? `ok went down ${dy}, now at y ${Math.floor(pos().y)}` : 'failed: ' + err
    }
    const v = { north: [0, -24], south: [0, 24], east: [24, 0], west: [-24, 0] }[dir]
    if (!v) return `unknown direction ${dir}`
    err = await goto(new goals.GoalNearXZ(p0.x + v[0], p0.z + v[1], 3), budget)
    const moved = Math.round(Math.hypot(pos().x - p0.x, pos().z - p0.z))
    return !err ? 'ok arrived' : moved >= 6 ? `ok moved ${moved}m ${dir}` : 'failed: ' + err
  }

  async function come(name = 'player') {
    const e = name === 'player' ? nearestEntity('player') : bot.players[name]?.entity
    if (!e) return 'no player visible'
    const err = await goto(new goals.GoalNear(e.position.x, e.position.y, e.position.z, 2), 25000)
    return e.position.distanceTo(pos()) <= 3.5 ? 'ok next to player' : 'failed: ' + (err || 'too far')
  }

  // follow a player for ms (bot.js uses its own endless follow mode; this is the bounded skill version)
  async function follow(name = 'player', ms = 10000) {
    const e = name === 'player' ? nearestEntity('player') : bot.players[name]?.entity
    if (!e) return 'no player visible'
    bot.pathfinder.setGoal(new goals.GoalFollow(e, 2), true)
    await sleepMs(ms)
    stop()
    return e.position.distanceTo(pos()) <= 5 ? 'ok following' : 'failed: lost the player'
  }

  return {
    gather, mineOre, craft, place, smelt, eat, fight, flee, buildShelter, sleep, farm, storeInChest, goHome, explore, come, follow,
    // helpers for observe()/grammar
    canPlace, findPlaceSpot, inShelter, hostiles, danger, goto, mineAt,
    get shelterPos() { return shelterPos },
  }
}

module.exports = { createSkills, HOSTILE, FOOD, ORE_Y, BUILD, CROPS }
