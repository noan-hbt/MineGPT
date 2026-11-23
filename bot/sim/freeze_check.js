// Lockstep fidelity check for the player-freeze mod (sim/mod/): player-side timers must advance once per stepped
// tick. Measures (1) Air under water vs game ticks (vanilla: -1 per tick), (2) ticks from lying in bed to the night
// being skipped (vanilla: sleep timer must reach 100). Without the mod: Air 259 -> 0 in ~10 ticks, sleep ~58 ticks.
//   node sim/freeze_check.js [--sim 0] [--x1]
'use strict'
const X1 = process.argv.includes('--x1')
const clock = X1 ? null : require('./clock').installManual() // before mineflayer
const mineflayer = require('mineflayer')
const rcon = require('../rcon')
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d }
const SIM = +arg('sim', 0)
const NAME = 'LFM'
const O = { x: 3100, y: 200, z: 3100 }
let lock = null

async function main() {
  const s = await require('./instance').start(SIM)
  const r = await rcon.connect({ port: s.rconPort, password: s.password })
  lock = X1 ? null : new (require('./lockstep').Lockstep)(clock, r)
  const wait = ms => new Promise(res => (X1 ? setTimeout : clock.realSetTimeout)(res, ms))
  const gt = async () => +(await r.cmd('time query gametime')).match(/(\d+)/)[1]
  const air = async () => +((await r.cmd(`data get entity ${NAME} Air`)).match(/(-?\d+)s?$/) || [])[1]
  const bot = mineflayer.createBot({ host: s.host, port: s.port, username: NAME, version: '1.21.11', ...(X1 ? {} : { checkTimeoutInterval: 30000 * 1000 }) })
  await new Promise((res, rej) => { bot.once('spawn', res); bot.once('kicked', rej); bot.once('error', rej) })
  for (const c of [`gamemode survival ${NAME}`, 'gamerule spawn_monsters false', 'weather clear', 'time set 1000',
    `effect clear ${NAME}`, `effect give ${NAME} instant_health 1 10`,
    `fill ${O.x - 2} ${O.y - 1} ${O.z - 2} ${O.x + 2} ${O.y + 4} ${O.z + 2} glass`,
    `fill ${O.x - 1} ${O.y} ${O.z - 1} ${O.x + 1} ${O.y + 3} ${O.z + 1} air`,
    `tp ${NAME} ${O.x} ${O.y} ${O.z}`]) await r.cmd(c)
  await wait(3000)
  await bot.waitForChunksToLoad()
  if (lock) await lock.start()

  // (1) drowning: water fills the box, bot stands still on the floor
  await r.cmd(`fill ${O.x - 1} ${O.y} ${O.z - 1} ${O.x + 1} ${O.y + 3} ${O.z + 1} water`)
  const pts = []
  const t0 = await gt()
  while (pts.length < 400) {
    const g = (await gt()) - t0, a = await air()
    if (!pts.length || g !== pts[pts.length - 1].g) pts.push({ g, a })
    if (a <= 0 || g > 400) break
  }
  const dec = pts.filter(p => p.a < 300)
  const first = dec[0], last = dec[dec.length - 1]
  const rate = last && last.g > first.g ? (first.a - last.a) / (last.g - first.g) : NaN
  console.log(`air (tick:Air): ${pts.filter((p, i) => i % 10 === 0 || p.a <= 0).map(p => `${p.g}:${p.a}`).join(' ')}`)
  console.log(`AIR rate ${rate.toFixed(2)} per game tick (vanilla 1.00)`)
  await r.cmd(`fill ${O.x - 1} ${O.y} ${O.z - 1} ${O.x + 1} ${O.y + 3} ${O.z + 1} air`)
  await r.cmd(`effect give ${NAME} instant_health 1 10`)

  // (2) sleep: bed in the box at night
  await r.cmd(`setblock ${O.x} ${O.y} ${O.z} red_bed[facing=north,part=foot]`)
  await r.cmd(`setblock ${O.x} ${O.y} ${O.z - 1} red_bed[facing=north,part=head]`)
  await r.cmd(`tp ${NAME} ${O.x + 1} ${O.y} ${O.z}`)
  await r.cmd('time set 13000')
  await wait(500)
  const bed = bot.blockAt(new (require('vec3'))(O.x, O.y, O.z))
  const g0 = await gt()
  await bot.sleep(bed)
  const gs = await gt()
  await new Promise(res => bot.once('wake', res))
  const gw = await gt()
  console.log(`SLEEP in bed after ${gs - g0} ticks, night skipped after ${gw - gs} ticks in bed (vanilla >= 100)`)
  console.log(`time of day now: ${await r.cmd('time query daytime')}`)

  if (lock) await lock.stop()
  bot.quit(); r.close()
  setTimeout(() => process.exit(0), 300)
}

main().catch(async e => { console.error(e); if (lock) await lock.stop().catch(() => {}); process.exit(1) })
