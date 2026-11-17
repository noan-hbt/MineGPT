// Read-only tools (catalog.json "tools"): answer a parsed tool call with one line of text for the model.
//   runTool({bot, senses, interp}, ast) -> Promise<string>   (ast from parseTool)
// Facts only, from what the bot knows (seen blocks, memory) + minecraft-data / spec/recipes.json. No advice.
'use strict'
const C = require('./skills/common')
const R = require('../spec/recipes.json')
const N = require('../spec/names.json')
const { keyOf } = require('./state/afford')
const { missingFor } = require('./skills/craft')
const { fmtStmt, fmtValue } = require('./dsl/fmt')

const MAX = 1200
const cut = s => s.length > MAX ? s.slice(0, MAX - 3) + '...' : s
const ing = r => r.ing.map(g => `${keyOf(g.opts)} x${g.n}`).join(' + ')

const tools = {
  recipe(ctx, a) {
    const out = []
    for (const name of C.idsOf(a.item).slice(0, 3)) {
      const cr = R.crafting.filter(r => r.out === name).slice(0, 3)
      for (const r of cr) out.push(`${name} x${r.n} = ${ing(r)}${r.grid === 3 ? ' (crafting_table)' : ' (2x2, inventory)'}`)
      for (const k of ['smelting', 'blasting', 'smoking', 'campfire_cooking', 'stonecutting'])
        for (const r of R[k].filter(r => r.out === name).slice(0, 2)) out.push(`${name} x${r.n} = ${k} ${r.in.slice(0, 4).join('|')}${r.time ? ` (${r.time / 20}s)` : ''}`)
      if (cr.length && ctx.bot) { const m = missingFor(ctx.bot, name, 1); if (m) out.push(Object.keys(m.miss).length ? `missing now for 1: ${Object.entries(m.miss).map(([k, v]) => `${k} x${v}`).join(', ')}` : 'craftable now') }
    }
    return out.length ? out.join('; ') : `no recipe makes ${C.label(a.item)} (gathered, dropped or found)`
  },

  uses(ctx, a) {
    const names = new Set(C.idsOf(a.item))
    const out = R.crafting.filter(r => r.ing.some(g => g.opts.some(o => names.has(o)))).map(r => r.out)
    const cook = []
    for (const k of ['smelting', 'blasting', 'smoking', 'campfire_cooking']) for (const r of R[k]) if (r.in.some(i => names.has(i))) cook.push(`${k} -> ${r.out}`)
    const uniq = [...new Set(out)]
    const parts = []
    if (uniq.length) parts.push(`ingredient of ${uniq.length}: ${uniq.slice(0, 30).join(', ')}${uniq.length > 30 ? ', ...' : ''}`)
    if (cook.length) parts.push([...new Set(cook)].join(', '))
    const food = require('minecraft-data')(N.version).foodsByName
    for (const n of names) if (food[n]) parts.push(`food: ${food[n].foodPoints} hunger, ${food[n].saturation} saturation`)
    return parts.join('; ') || `${C.label(a.item)} is not used in any recipe`
  },

  where(ctx, a) {
    const n = a.n ?? 5
    const t = a.target
    const me = ctx.bot.entity.position
    if (t.place) { const p = C.place(ctx, t.place); return `@${t.place} ${C.fmtPos(p)} ${Math.round(p.distanceTo(me))}m` }
    if (t.entity) {
      const kind = t.entity
      const list = Object.values(ctx.bot.entities).filter(e => e !== ctx.bot.entity && (kind === 'player' ? e.type === 'player' && (!t.ref || e.username === t.ref) : e.name === kind))
        .sort((p, q) => p.position.distanceTo(me) - q.position.distanceTo(me)).slice(0, n)
      return list.length ? list.map(e => `${C.entRef(e)} ${C.fmtPos(e.position)} ${Math.round(e.position.distanceTo(me))}m`).join('; ') : `no #${kind} in sight`
    }
    if (t.pos) return `${fmtValue(t)} is ${Math.round(C.posOf(ctx, t).distanceTo(me))}m away`
    const ids = C.idsOf(t, 'block')
    const ps = C.knownBlocks(ctx, ids, { radius: 64, max: n })
    const parts = ps.map(p => `${ctx.bot.blockAt(p).name} ${C.fmtPos(p)} ${Math.round(p.distanceTo(me))}m`)
    // farther: map cells where it was seen
    const map = ctx.senses && ctx.senses.map
    if (map && parts.length < n) {
      const cells = [...map.cells.values()].filter(c => ids.some(i => c.res.has(i) && c.res.get(i).size))
        .map(c => ({ c, d: Math.hypot(c.cx * 16 + 8 - me.x, c.cz * 16 + 8 - me.z) })).filter(x => x.d > 48).sort((p, q) => p.d - q.d).slice(0, n - parts.length)
      for (const { c, d } of cells) parts.push(`seen in cell (${c.cx * 16},${c.cz * 16})-(${c.cx * 16 + 15},${c.cz * 16 + 15}) ~${Math.round(d)}m`)
    }
    return parts.length ? parts.join('; ') : `no ${C.label(t)} seen so far`
  },

  scan(ctx, a) {
    const bot = ctx.bot
    const R_ = a.radius ?? 16
    const q = a.filter ? (a.filter.text || a.filter.name || a.filter.tag || '') : ''
    const me = bot.entity.position
    const cl = ((ctx.senses && ctx.senses.ctx.clusters) || []).filter(c => c.dist <= R_ && (!q || c.name.includes(q)))
    const ents = Object.values(bot.entities).filter(e => e !== bot.entity && e.position.distanceTo(me) <= R_ && (!q || (e.name || '').includes(q) || (e.username || '').includes(q)))
    const parts = cl.slice(0, 25).map(c => `${c.name}${c.n > 1 ? ' x' + c.n : ''} ${C.fmtPos({ x: c.pos[0], y: c.pos[1], z: c.pos[2] })} ${c.dist}m${c.visible ? '' : ' (seen before)'}`)
    for (const e of ents.slice(0, 15)) parts.push(`${C.entRef(e)} ${Math.round(e.position.distanceTo(me))}m`)
    return parts.length ? parts.join('; ') : `nothing${q ? ' matching ' + q : ''} within ${R_}`
  },

  async path_cost(ctx, a) {
    const bot = ctx.bot
    const t = C.resolve(ctx, a.target)
    const d = t.pos.distanceTo(bot.entity.position)
    const goal = t.kind === 'entity' ? new C.G.GoalFollow(t.entity, 2) : new C.G.GoalNear(t.pos.x, t.pos.y, t.pos.z, 1)
    let r
    try { r = bot.pathfinder.getPathTo(bot.pathfinder.movements, goal, 3000) } catch (e) { return `${t.label}: ${Math.round(d)}m straight line, path search failed (${e.message})` }
    const digs = r.path.reduce((s, n) => s + (n.toBreak ? n.toBreak.length : 0), 0)
    const places = r.path.reduce((s, n) => s + (n.toPlace ? n.toPlace.length : 0), 0)
    const st = r.status === 'success' ? 'path found' : r.status === 'partial' ? 'only a partial path (search stopped)' : 'no path'
    return `${t.label}: ${Math.round(d)}m straight line, ${st}: ${r.path.length} steps, ~${Math.round(r.path.length / 4.3)}s${digs ? `, ${digs} blocks to dig` : ''}${places ? `, ${places} blocks to place` : ''}`
  },

  inv(ctx) {
    const bot = ctx.bot
    const out = []
    for (const it of bot.inventory.slots) {
      if (!it) continue
      const where = it.slot >= 36 && it.slot <= 44 ? `hotbar${it.slot - 36}` : it.slot === 45 ? 'offhand' : it.slot >= 5 && it.slot <= 8 ? 'worn' : `slot${it.slot}`
      out.push(`${where}: ${it.name} x${it.count}${it.maxDurability ? ` dur ${it.maxDurability - (it.durabilityUsed || 0)}/${it.maxDurability}` : ''}${bot.heldItem && bot.heldItem.slot === it.slot ? ' (held)' : ''}`)
    }
    return `${out.join('; ') || 'empty'}; ${bot.inventory.emptySlotCount()} free slots`
  },

  chest(ctx, a) {
    const ch = ctx.senses ? [...ctx.senses.chests.values()] : []
    if (!ch.length) return 'no chest opened so far'
    const p = C.tryResolve(ctx, a.at)
    const pick = p ? ch.filter(c => c.at === `(${Math.floor(p.pos.x)},${Math.floor(p.pos.y)},${Math.floor(p.pos.z)})`) : ch
    if (!pick.length) return `that chest was never opened; opened chests: ${ch.map(c => c.at).join(', ')}`
    return pick.map(c => `${c.at}: ${Object.entries(c.items).map(([k, v]) => `${k} x${v}`).join(', ') || 'empty'} (${Math.round((Date.now() - c.seen_at) / 1000)}s ago)`).join('; ')
  },

  recall(ctx, a) {
    const m = ctx.senses && ctx.senses.memory
    if (!m) return 'no memory'
    const q = (a.query.text || a.query.name || '').toLowerCase()
    const words = q.split(/[^a-z0-9_]+/).filter(w => w.length > 2)
    const hit = s => !words.length || words.some(w => s.toLowerCase().includes(w))
    const out = []
    for (const n of m.notes) if (hit((n.key || '') + ' ' + n.text)) out.push(`note${n.key ? ' ' + n.key : ''}: ${n.text}`)
    for (const p of m.places) if (hit(p.name + ' ' + (p.what || ''))) out.push(`@${p.name} (${p.pos.join(',')})${p.what ? ' ' + p.what : ''}`)
    for (const r of m.routines) if (hit(r.name + ' ' + r.src)) out.push(`routine ${r.name}: ${r.src} (runs ${r.runs}, ok ${r.ok})`)
    for (const d of m.episode.deaths) if (hit('death died ' + d.cause)) out.push(`died at (${d.pos.join(',')}): ${d.cause}`)
    return out.length ? cut(out.slice(0, 20).join('; ')) : `nothing in memory about "${q}"`
  },

  wiki() { return 'knowledge base not built yet (H5); use recipe, uses, loot, mob_info, biome_info' },

  mob_info(ctx, a) {
    const md = require('minecraft-data')(N.version)
    const kind = a.mob.name
    const e = md.entitiesByName[kind]
    if (!e) return `unknown mob ${kind}`
    const loot = md.entityLoot && md.entityLoot[kind]
    const drops = loot ? loot.drops.map(d => `${d.item}${d.dropChance < 1 ? ` ${Math.round(d.dropChance * 100)}%` : ''}${d.stackSizeRange && d.stackSizeRange[1] > 1 ? ` x${d.stackSizeRange.join('-')}` : ''}${d.playerKill ? ' (player kill)' : ''}`).join(', ') : '?'
    return `${kind}: ${N.hostile.includes(kind) ? 'hostile' : e.category || e.type}, size ${e.width}x${e.height}; drops: ${drops}`
  },

  loot(ctx, a) {
    const md = require('minecraft-data')(N.version)
    const out = []
    for (const name of C.idsOf(a.block, 'block').slice(0, 3)) {
      const b = md.blocksByName[name]
      if (!b) { out.push(`unknown block ${name}`); continue }
      const tools = b.harvestTools ? Object.keys(b.harvestTools).map(id => md.items[id].name) : null
      const loot = md.blockLoot && md.blockLoot[name]
      const drops = loot ? loot.drops.map(d => `${d.item}${d.dropChance < 1 ? ` ${Math.round(d.dropChance * 100)}%` : ''}${d.silkTouch ? ' (silk touch)' : ''}${d.noSilkTouch ? ' (no silk touch)' : ''}`).join(', ') : name
      out.push(`${name}: hardness ${b.hardness}, ${tools ? 'needs ' + tools.sort((p, q) => C.tier(p) - C.tier(q))[0] + ' or better' : 'any tool / hand'}${b.material ? ', best tool ' + b.material.replace('mineable/', '') : ''}; drops ${drops}`)
    }
    return out.join('; ')
  },

  biome_info(ctx, a) {
    const md = require('minecraft-data')(N.version)
    const b = md.biomesByName[a.biome.name.replace(/^biome:/, '')]
    if (!b) return `unknown biome ${a.biome.name}`
    return `${b.name}: ${b.category || '?'}, ${b.dimension}, temperature ${b.temperature}, ${b.has_precipitation === false || b.precipitation === 'none' ? 'no rain' : 'rain/snow'}`
  },

  simulate(ctx, a) {
    const issues = [], ok = []
    let secs = 0
    const walk = n => {
      if (n.op === 'seq') return n.body.forEach(walk)
      if (n.op === 'if') { walk(n.then); if (n.else) walk(n.else); return }
      if (n.op === 'repeat') { for (let i = 0; i < Math.min(n.n, 3); i++) walk(n.body); return }
      if (n.op === 'routine') { const r = ctx.senses && ctx.senses.memory.routines.find(x => x.name === n.name); if (!r) issues.push(`no routine ${n.name}`); return }
      const v = n.verb, s = fmtStmt(n)
      try {
        if (v === 'craft') {
          const name = C.idsOf(n.args.item)[0]
          const r0 = R.crafting.find(r => r.out === name)
          const m = r0 ? missingFor(ctx.bot, name, Math.ceil((n.args.n ?? 1) / r0.n)) : null
          if (!r0) issues.push(`${s}: no recipe`)
          else if (Object.keys(m.miss).length) issues.push(`${s}: missing ${Object.entries(m.miss).map(([k, x]) => `${k} x${x}`).join(', ')}`)
          else if (m.r.grid === 3 && !C.knownBlocks(ctx, ['crafting_table'], { radius: 32, max: 1 }).length) issues.push(`${s}: no crafting_table known`)
          else ok.push(s)
          secs += 2
        } else if (v === 'mine' || v === 'chop') {
          const ids = v === 'chop' ? (n.args.species ? C.idsOf(n.args.species, 'block') : N.block_tags.logs) : C.idsOf(n.args.block, 'block')
          const ps = C.knownBlocks(ctx, ids, { max: 1 })
          if (!ps.length) issues.push(`${s}: none seen`)
          else { const hc = v === 'mine' && C.harvestCheck(ctx.bot, ctx.bot.blockAt(ps[0])); if (hc) issues.push(`${s}: ${hc.detail}`); else ok.push(s); secs += ps[0].distanceTo(ctx.bot.entity.position) / 4.3 + 3 * (n.args.n ?? 1) }
        } else if (v === 'goto' || v === 'come_to') {
          const t = C.resolve(ctx, n.args.target || n.args.to); ok.push(s); secs += t.pos.distanceTo(ctx.bot.entity.position) / 4.3
        } else if (['smelt', 'blast', 'smoke'].includes(v)) {
          const name = C.idsOf(n.args.input)[0], have = C.count(ctx.bot, [name])
          const st = { smelt: 'furnace', blast: 'blast_furnace', smoke: 'smoker' }[v]
          if (!have) issues.push(`${s}: no ${name}`)
          else if (!C.knownBlocks(ctx, [st], { radius: 32, max: 1 }).length) issues.push(`${s}: no ${st} known`)
          else ok.push(s)
          secs += (n.args.n ?? have) * (v === 'smelt' ? 10 : 5)
        } else if (v === 'place') {
          const names = C.idsOf(n.args.block, 'item'), need = n.args.at ? C.positions(ctx, n.args.at).length : 1
          if (C.count(ctx.bot, names) < need) issues.push(`${s}: needs ${need}, have ${C.count(ctx.bot, names)}`); else ok.push(s)
          secs += need
        } else { ok.push(s + ' (not checked)'); secs += 5 }
      } catch (e) { issues.push(`${s}: ${e.detail || e.message}`) }
    }
    walk(a.body)
    return `${issues.length ? 'problems: ' + issues.join('; ') : 'no problem found'}${ok.length ? '; ok: ' + ok.join('; ') : ''}; ~${Math.round(secs)}s`
  },
}

async function runTool(ctx, ast) {
  const fn = tools[ast.verb]
  if (!fn) return `unknown tool ${ast.verb}`
  const c = { origin: ctx.bot.entity.position.floored(), ...ctx }
  try { return cut(String(await fn(c, ast.args))) } catch (e) { return cut(`${ast.verb}: ${e.detail || e.message}`) }
}

module.exports = { runTool, tools }
