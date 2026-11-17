// H5 `mind` policy for the card runner: an LLM plays the episode through the harness turn protocol
// (spec/turns.md). Each decision: build the state, render the sheet (its MANUAL section explains the format),
// ask the model (llama-server, OpenAI-compatible), apply the turn (tool rounds -> results appended, final turn ->
// interpreter), wait for the action's result, repeat. In lockstep the world is held frozen while the model thinks.
// v1: decision turns only (no monitor calls while an action runs).
'use strict'
const http = require('http')
const crypto = require('crypto')
const { render } = require('../render')

const SYSTEM = name => `You control the Minecraft player "${name}". Each user message is your current sheet: read it ` +
  `(the MANUAL section explains the format) and answer ONLY with tagged lines "tag: content", no markdown, no prose ` +
  `outside the tags. Follow the order you received in chat.`
const MAX_TOOL_ROUNDS = 4

// POST /v1/chat/completions with real-time timeouts (the bot clock may be virtual or held)
function chat(url, body, { timeoutMs = 120000, setT = setTimeout } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL('/v1/chat/completions', url)
    const data = JSON.stringify(body)
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
      let out = ''
      res.setEncoding('utf8')
      res.on('data', c => { out += c })
      res.on('end', () => { try { resolve(JSON.parse(out)) } catch (e) { reject(new Error(`bad LLM reply (${res.statusCode}): ${out.slice(0, 200)}`)) } })
    })
    const t = setT(() => req.destroy(new Error('LLM timeout')), timeoutMs)
    req.on('error', e => reject(e))
    req.on('close', () => clearTimeout(t))
    req.end(data)
  })
}

class Mind {
  // opts: {url, model, maxTokens, temperature, hold(fn), setT, write}
  constructor(opts) { this.o = { maxTokens: 1024, temperature: 0.3, hold: fn => fn(), write: () => {}, ...opts }; this.stats = { calls: 0, tokens: 0, ms: 0, invalid: 0 } }

  async ask(messages) {
    const { url, model, maxTokens, temperature, hold, setT } = this.o
    const body = { messages, max_tokens: maxTokens, temperature, ...(model ? { model } : {}) }
    const t0 = Date.now()
    const r = await hold(() => chat(url, body, { setT }))
    const msg = (r.choices && r.choices[0] && r.choices[0].message) || {}
    const usage = r.usage || {}
    this.stats.calls++; this.stats.tokens += usage.completion_tokens || 0
    const ms = r.timings ? Math.round((r.timings.prompt_ms || 0) + (r.timings.predicted_ms || 0)) : Date.now() - t0
    this.stats.ms += ms
    // some templates leave <think> blocks in the content
    const text = String(msg.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^```\w*\n?|```$/gm, '').trim()
    return { text, reasoning: msg.reasoning_content || null, usage, ms, finish: r.choices && r.choices[0] && r.choices[0].finish_reason }
  }

  // one decision: tool rounds then a final turn. Returns {r, done} (done = Promise of the action result or null)
  async decide({ senses, interp, turns, bot, ep }) {
    const state = senses.build({ call: 'decision', running: null, expect: interp.expectInfo() })
    const sheet = render(state).text
    const messages = [{ role: 'system', content: SYSTEM(bot.username) }, { role: 'user', content: sheet }]
    let retried = false
    for (let round = 0; ; round++) {
      if (round === MAX_TOOL_ROUNDS) messages.push({ role: 'user', content: 'No more tool rounds: give your final turn now (act: + expect:).' })
      const a = await this.ask(messages)
      const r = await turns.apply(a.text, 'decision')
      this.o.write({ type: 'mind_call', id: ep.id, seed: ep.seed, round, prompt_hash: crypto.createHash('sha1').update(sheet).digest('hex').slice(0, 12),
        sheet_chars: sheet.length, output: a.text, reasoning: a.reasoning, ok: r.ok, error: r.error || null, answers: r.answers || null,
        tokens: a.usage.completion_tokens, prompt_tokens: a.usage.prompt_tokens, ms: a.ms, finish: a.finish })
      if (process.env.DBG_MIND) console.log(`  [mind r${round} ${a.ms}ms ${a.usage.completion_tokens}tok] ${r.ok ? '' : 'INVALID ' + r.error + ' | '}${a.text.replace(/\n/g, ' / ').slice(0, 300)}`)
      messages.push({ role: 'assistant', content: a.text })
      if (!r.ok) {
        this.stats.invalid++
        if (retried) { const w = await turns.apply('act: wait 2s', 'decision'); return { r: w, done: w.done || null } }
        retried = true
        messages.push({ role: 'user', content: `invalid_output: ${r.error}. Answer again with valid tagged lines.` })
        continue
      }
      if (r.answers && round < MAX_TOOL_ROUNDS) { messages.push({ role: 'user', content: r.answers.join('\n') }); continue }
      if (r.answers) { const w = await turns.apply('act: wait 2s', 'decision'); return { r: w, done: w.done || null } }
      return { r, done: r.done || null }
    }
  }
}

module.exports = { Mind, chat }
