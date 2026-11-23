// H4 spike: can the bot follow a sped-up vanilla server? Per trial: pathfind 24 blocks, mine 5 stone; measure
// success, wall time, game time (ticks), server MSPT.
//   node sim/spike.js [--rates 20,100,200,400]   option A: `tick rate R`, bot clock scaled (clock.install)
//   node sim/spike.js --lock [--trials 3]          option C: frozen server stepped by the bot (clock.installManual)
// Restores `tick rate 20` / unfreeze at the end. Needs the local server (start-mc.ps1) with RCON.
'use strict'
const LOCK = process.argv.includes('--lock')
const clockMod = require('./clock')
const clock = LOCK ? clockMod.installManual() : clockMod.install()
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const rcon = require('../rcon')
const { Lockstep } = require('./lockstep')

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d }
const NAME = arg('name', 'LFM')
const RATES = LOCK ? Array(+arg('trials', 3)).fill('lock') : arg('rates', '20,100,200,400').split(',').map(Number)
const X = 3000, Y = 200, Z = 3000
const sleepReal = ms => new Promise(r => clock.realSetTimeout(r, ms))
// real-time guard: which step hangs?
const guard = (name, p, ms = 30000) => Promise.race([p, new Promise((_, rej) => clock.realSetTimeout(() => rej(new Error('HANG ' + name)), ms))])

async function main() {
  const r = await rcon.connect()
  const cmd = c => guard('rcon ' + c, r.cmd(c), 10000)
  const lock = LOCK ? new Lockstep(clock, r) : null
  // keepalive timer runs on the bot clock: keep it >> 30 s real
  const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: NAME, version: '1.21.11', maxCatchupTicks: 50, checkTimeoutInterval: 30000 * 1000 })
  bot.loadPlugin(pathfinder)
  await new Promise((res, rej) => { bot.once('spawn', res); bot.once('kicked', rej); bot.once('error', rej) })
  bot.on('kicked', why => { console.log('KICKED', why); process.exit(1) })
  if (!LOCK) clock.follow(bot)
  const mv = new Movements(bot); mv.canDig = false
  bot.pathfinder.setMovements(mv)
  await cmd('tick rate 20')
  await cmd(`gamemode survival ${NAME}`)
  await cmd('gamerule spawn_monsters false')
  await sleepReal(1000)
  if (LOCK) await lock.start()
  const ticks = () => LOCK ? lock.ticks : bot.time.age
  const rows = []
  try {
    for (const R of RATES) {
      // arena: stone floor, clear above, a 5-block stone wall to mine at the end of the run
      await cmd(`fill ${X - 4} ${Y - 3} ${Z - 4} ${X + 30} ${Y - 1} ${Z + 4} stone`)
      await cmd(`fill ${X - 4} ${Y} ${Z - 4} ${X + 30} ${Y + 6} ${Z + 4} air`)
      await cmd(`fill ${X + 26} ${Y} ${Z - 2} ${X + 26} ${Y} ${Z + 2} stone`)
      await cmd(`kill @e[type=item,x=${X},y=${Y},z=${Z},distance=..60]`)
      await cmd(`clear ${NAME}`); await cmd(`give ${NAME} stone_pickaxe`)
      await cmd(`tp ${NAME} ${X} ${Y} ${Z}`)
      let row
      if (LOCK) {
        const t = ticks(); while (ticks() < t + 20) await sleepReal(5) // tp + chunk updates reach the bot
        row = { R }
      } else {
        await cmd(`tick rate ${R}`)
        await sleepReal(3000) // let k converge (time packets every 20 ticks)
        row = { R, tps: +(clock.serverTps || 0).toFixed(1), k: +clock.speed.toFixed(2) }
      }
      const g0 = LOCK ? lock.gametime : 0, tk0 = ticks(), rt0 = clock.realNow()

      // 1. walk
      let t0 = clock.realNow(), a0 = ticks()
      try {
        await guard('walk', bot.pathfinder.goto(new goals.GoalNear(X + 24, Y, Z, 1)))
        row.walk = 'ok'
      } catch (e) { row.walk = 'FAIL ' + e.message }
      row.walk_dist = +bot.entity.position.distanceTo({ x: X + 24.5, y: Y, z: Z + 0.5 }).toFixed(1)
      row.walk_real_s = +((clock.realNow() - t0) / 1000).toFixed(2); row.walk_ticks = ticks() - a0

      // 2. mine the wall (5 blocks, from x+25)
      await guard('approach', bot.pathfinder.goto(new goals.GoalBlock(X + 25, Y, Z))).catch(e => { row.approach = e.message })
      await bot.equip(bot.inventory.items().find(i => i.name === 'stone_pickaxe'), 'hand')
      t0 = clock.realNow(); a0 = ticks()
      let mined = 0
      for (let dz = -2; dz <= 2; dz++) {
        const b = bot.blockAt(bot.entity.position.offset(1, 0, dz).floored())
        if (!b || b.name !== 'stone') continue
        try { await guard('dig', bot.dig(b), 10000); mined++ } catch (e) { row.dig_err = e.message }
      }
      row.dig_real_s = +((clock.realNow() - t0) / 1000).toFixed(2); row.dig_ticks = ticks() - a0
      if (!LOCK) await sleepReal(300)
      const check = await cmd(`execute if block ${X + 26} ${Y} ${Z} air`) // server view of the center block
      row.mined = mined; row.server_center_air = /passed/i.test(check)
      if (LOCK) {
        row.tps = +((ticks() - tk0) / ((clock.realNow() - rt0) / 1000)).toFixed(0)
        row.server_ticks = lock.gametime - g0; row.bot_ticks = ticks() - tk0 // must match: one server tick per step
      } else row.mspt = ((await cmd('tick query')).match(/([\d.]+)\s*ms/) || [])[1]
      rows.push(row)
      console.log(JSON.stringify(row))
    }
  } finally {
    if (LOCK) await lock.stop(); else await cmd('tick rate 20')
    r.close(); bot.quit()
  }
  console.table(rows)
  process.exit(0)
}
main().catch(e => { console.error(e); rcon.connect().then(async r => { await r.cmd('tick rate 20'); await r.cmd('tick unfreeze') }).finally(() => process.exit(1)) })
