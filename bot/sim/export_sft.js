// Mind-policy card logs -> SFT dataset (chat "messages" jsonl). One example per model call that gave a valid
// output, inside episodes the judge marked success: the conversation of that decision is replayed as the model saw
// it (system, sheet, earlier valid rounds + tool answers) and the valid output is the target. Invalid outputs and
// their error feedback are dropped: the student only sees clean turns (the teacher's retry becomes the target).
//   node sim/export_sft.js <cards.jsonl>... [--out data/sft/mind_sft.jsonl] [--all-outcomes]
'use strict'
const fs = require('fs')
const path = require('path')
const { SYSTEM } = require('./mind')

const argv = process.argv.slice(2)
const opt = k => { const i = argv.indexOf('--' + k); return i >= 0 ? argv.splice(i, 2)[1] : null }
const flag = k => { const i = argv.indexOf('--' + k); if (i >= 0) argv.splice(i, 1); return i >= 0 }
const out = opt('out') || path.join(__dirname, '../../data/sft/mind_sft.jsonl')
const allOutcomes = flag('all-outcomes')
if (!argv.length) { console.error('usage: node sim/export_sft.js <cards.jsonl>... [--out f] [--all-outcomes]'); process.exit(1) }

const NO_MORE = 'No more tool rounds: give your final turn now (act: + expect:).' // as in mind.js decide()
const MAX_TOOL_ROUNDS = 4

// one decision (calls with rounds 0..n, round 0 carries the sheet) -> examples
function decisionExamples(calls, bot, meta) {
  const ex = []
  const msgs = [{ role: 'system', content: SYSTEM(bot) }, { role: 'user', content: calls[0].sheet }]
  let valid = 0
  for (const c of calls) {
    if (c.round === MAX_TOOL_ROUNDS) msgs.push({ role: 'user', content: NO_MORE })
    if (!c.ok) continue // dropped with its error feedback: the next round answers the same context
    ex.push({ messages: [...msgs, { role: 'assistant', content: c.output }], meta: { ...meta, round: valid } })
    msgs.push({ role: 'assistant', content: c.output })
    if (c.answers) msgs.push({ role: 'user', content: c.answers.join('\n') })
    valid++
  }
  return ex
}

let nEp = 0, nOk = 0, nEx = 0, nSkip = 0
const lines = []
for (const file of argv) {
  let bot = 'Bot', session = path.basename(file), buf = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let r; try { r = JSON.parse(line) } catch { continue }
    if (r.type === 'session') { bot = r.bot || bot; session = r.session || session }
    else if (r.type === 'mind_call') buf.push(r)
    else if (r.type === 'episode') {
      const calls = buf; buf = []
      if (r.policy !== 'mind') continue
      nEp++
      if (r.outcome !== 'success' && !allOutcomes) continue
      nOk++
      // split the episode's calls into decisions (a decision starts at round 0, which carries the sheet)
      const decisions = []
      for (const c of calls) {
        if (c.round === 0) decisions.push([c])
        else if (decisions.length) decisions[decisions.length - 1].push(c)
      }
      decisions.forEach((d, i) => {
        if (!d[0].sheet) { nSkip++; return } // logs from before the sheet was recorded
        const meta = { session, card: r.id, seed: r.seed, outcome: r.outcome, decision: i, ticks: r.ticks }
        for (const e of decisionExamples(d, bot, meta)) { lines.push(JSON.stringify(e)); nEx++ }
      })
    }
  }
}
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, lines.join('\n') + (lines.length ? '\n' : ''))
console.log(`${nEp} mind episodes, ${nOk} kept${allOutcomes ? ' (all outcomes)' : ' (success)'}, ${nEx} examples${nSkip ? `, ${nSkip} decisions without sheet skipped` : ''} -> ${out}`)
