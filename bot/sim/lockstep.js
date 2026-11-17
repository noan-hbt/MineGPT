// H4 MineSim option C: strict lockstep. The server is frozen (`tick freeze`) and the bot process drives it:
// each step = the bot's virtual clock advances one tick (physics + due timers), then `tick step 1` on the server.
// Before start() (login), the clock free-runs at real speed. Needs clock.installManual() before mineflayer.
'use strict'

class Lockstep {
  constructor(clock, rcon) { this.clock = clock; this.r = rcon; this.ticks = 0; this.mode = 'free'; this.stopped = false; this.loop() }

  async loop() {
    const { clock } = this
    let last = clock.realNow()
    while (!this.stopped) {
      if (this.mode === 'free') {
        await new Promise(res => clock.realSetTimeout(res, 10))
        const now = clock.realNow(); await clock.advance(now - last); last = now
      } else {
        await clock.advance(50)
        await this.r.cmd('tick step 1')
        // a second command is executed by the server thread after the stepped tick ran (checked by the spike:
        // gametime moves by exactly one per step), then let the game packets of that tick be read
        this.gametime = +(await this.r.cmd('time query gametime')).match(/(\d+)/)[1]
        await new Promise(res => setImmediate(res))
        this.ticks++
        last = clock.realNow()
      }
    }
  }

  async start() {
    await this.r.cmd('tick freeze')
    await this.r.cmd('tick rate 10000') // stepped ticks run immediately
    this.gametime0 = +(await this.r.cmd('time query gametime')).match(/(\d+)/)[1]
    this.mode = 'lock'
  }

  async stop() {
    this.stopped = true
    await this.r.cmd('tick rate 20')
    await this.r.cmd('tick unfreeze')
  }
}

module.exports = { Lockstep }
