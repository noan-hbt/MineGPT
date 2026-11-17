// Apply a parsed model turn (dsl/turn.js) to the live harness: tools -> tool_answer events, act/interrupt/override ->
// interpreter, adjust -> running statement, note/say/goal/plan -> memory and chat. Shared by the harness, the
// scripted runs and (later) the mind loop.
//   const T = new Turns({bot, senses, interp}) ; await T.apply(text, 'decision') -> {ok, turn?, error?, result?}
'use strict'
const { parseTurn } = require('./dsl/turn')
const { runTool } = require('./tools')

class Turns {
  constructor({ bot, senses, interp }) { this.bot = bot; this.senses = senses; this.interp = interp }

  // returns {ok, turn, answers?, done?: Promise<result event>} ; invalid output -> invalid_output event
  async apply(text, kind = 'decision') {
    const run = this.interp.running()
    const p = parseTurn(text, kind, { running: run && run.ast.op === 'call' ? run.ast.verb : null })
    if (!p.ok) { this.senses.push({ kind: 'invalid_output', error: p.error, output: text.slice(0, 500) }); return { ok: false, error: p.error } }
    const turn = p.turn
    const out = { ok: true, turn }
    const mem = this.senses.memory
    if (turn.tools) {
      out.answers = []
      for (const t of turn.tools) {
        const answer = await runTool({ bot: this.bot, senses: this.senses, interp: this.interp }, t)
        const src = require('./dsl/fmt').fmtStmt(t)
        this.senses.push({ kind: 'tool_answer', tool: src, answer })
        out.answers.push(`result: ${src} -> ${answer}`)
      }
      return out
    }
    if (turn.plan) mem.setPlan(turn.plan)
    for (const n of turn.notes || []) { mem.note(n); this.senses.push({ kind: 'note', text: n }) }
    if (turn.goal) { mem.goal(turn.goal.op, turn.goal.text, kind === 'mind' ? 'mind' : 'self'); this.senses.push({ kind: 'goal', op: turn.goal.op, ...(turn.goal.text ? { text: turn.goal.text } : {}) }) }
    if (turn.say) this.bot.chat(turn.say.slice(0, 256))
    if (turn.answer) this.senses.push({ kind: 'mind', text: turn.answer })
    if (turn.adjust) { const r = this.interp.adjust(turn.adjust); if (!r.ok) this.senses.push({ kind: 'invalid_output', error: 'adjust: ' + r.error, output: text.slice(0, 200) }) }
    const stmt = turn.act || turn.interrupt || turn.override
    if (stmt) out.done = this.interp.start(stmt, { expect: turn.expect || null })
    return out
  }
}

module.exports = { Turns }
