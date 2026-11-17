// H5 `mind` policy for the card runner: an LLM plays the episode through the harness turn protocol
// (spec/turns.md). Each decision: build the state, render the sheet (its MANUAL section explains the format),
// ask the model (llama-server, OpenAI-compatible), apply the turn (tool rounds -> results appended, final turn ->
// interpreter), wait for the action's result, repeat. In lockstep the world is held frozen while the model thinks.
// v1: decision turns only (no monitor calls while an action runs).
'use strict'
const http = require('http')
const https = require('https')
const crypto = require('crypto')
const { render } = require('../render')

// the MANUAL is a grammar (think:* = any number of think lines, plan:? = optional, ...): small models copied the
// notation literally, so the system prompt adds concrete turns. Examples only show the format, not a strategy.
const SYSTEM = name => `You control the Minecraft player "${name}". Each user message is your current sheet: read it ` +
  `(the MANUAL section explains the format) and answer ONLY with tagged lines "tag: content", no markdown, no prose ` +
  `outside the tags. Allowed tags in a decision turn: think, tool, plan, act, expect, note, say, ask, goal. ` +
  `A decision ends with exactly one act: line (one statement) or with 1-4 tool: lines. Orders come in chat (EVENTS): ` +
  `events are shown once, so put the order on your goal stack (goal: push ...) and finish it with goal: done. ` +
  `Keyword arguments are key=value (n=4), never x4.

Example decision answers (format only):
think: Noan asks for 8 torches; I have coal but no sticks.
goal: push make 8 torches for Noan
plan: craft sticks | craft torches
act: craft stick n=4
expect: have(stick)>=4 in 20s

think: the goal is to reach the house; it is 30 blocks east.
act: goto @house
expect: dist(@house)<3 in 60s

think: I do not know how a lantern is crafted.
tool: recipe lantern

think: the goal is done.
goal: done
say: done, here are your planks
act: wait 2s`
const MAX_TOOL_ROUNDS = 4

// POST /v1/chat/completions with real-time timeouts (the bot clock may be virtual or held)
// url: llama-server (http://127.0.0.1:8080) or a remote OpenAI-compatible API (https://.../v1, key = bearer token)
function chat(url, body, { timeoutMs = 120000, setT = setTimeout, key = null } = {}) {
  return new Promise((resolve, reject) => {
    const base = url.replace(/\/+$/, '')
    const u = new URL(base + (/\/v1$/.test(base) ? '' : '/v1') + '/chat/completions')
    const data = JSON.stringify(body)
    const req = (u.protocol === 'https:' ? https : http).request({ host: u.hostname, port: u.port || undefined, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...(key ? { Authorization: `Bearer ${key}` } : {}) } }, res => {
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

// Codex CLI as the model (frontier teacher without an API key): the conversation is flattened into one prompt, run
// read-only and ephemeral in an empty temp dir; the reply is the agent's last message. Same reply shape as chat().
function codexChat(messages, { model = null, effort = 'low', timeoutMs = 300000, setT = setTimeout } = {}) {
  const { spawn } = require('child_process')
  const fs = require('fs'), os = require('os'), path = require('path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-codex-'))
  const out = path.join(dir, 'last.txt')
  const prompt = 'You are the decision model of a game bot, not a coding agent: do not run any command or read any file. ' +
    'Your whole final message is parsed by a program, so it must contain only the tagged lines asked for.\n\n' +
    messages.map(m => `### ${m.role.toUpperCase()}\n${m.content}`).join('\n\n') + '\n\n### YOUR ANSWER (tagged lines only)'
  const args = ['exec', '-s', 'read-only', '--ephemeral', '--skip-git-repo-check', '-C', dir, '-o', out,
    '-c', `model_reasoning_effort=${effort}`, ...(model ? ['-m', model] : []), '-']
  return new Promise((resolve, reject) => {
    const p = spawn('codex', args, { shell: true, windowsHide: true })
    let err = ''
    p.stderr.on('data', c => { err += c })
    p.stdout.on('data', () => {})
    const t = setT(() => { p.kill(); reject(new Error('LLM timeout (codex)')) }, timeoutMs)
    p.on('error', e => { clearTimeout(t); reject(e) })
    p.on('close', code => {
      clearTimeout(t)
      let text = null
      try { text = fs.readFileSync(out, 'utf8') } catch {}
      fs.rmSync(dir, { recursive: true, force: true })
      if (text == null) return reject(new Error(`codex failed (${code}): ${err.slice(-300)}`))
      const m = err.match(/tokens used\s*\n?\s*([\d,]+)/i)
      resolve({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { completion_tokens: m ? +m[1].replace(/,/g, '') : 0 } })
    })
    p.stdin.end(prompt)
  })
}

class Mind {
  // opts: {url, model, maxTokens, temperature, hold(fn), setT, write}
  constructor(opts) { this.o = { maxTokens: 1024, temperature: 0.3, hold: fn => fn(), write: () => {}, ...opts }; this.stats = { calls: 0, tokens: 0, ms: 0, invalid: 0 } }

  async ask(messages) {
    const { url, model, maxTokens, temperature, hold, setT, key } = this.o
    // remote reasoning models take max_completion_tokens and only the default temperature
    const body = key ? { messages, max_completion_tokens: maxTokens, model } : { messages, max_tokens: maxTokens, temperature, ...(model ? { model } : {}) }
    const t0 = performance.now() // real time: Date.now() is the virtual clock in lockstep
    const r = await hold(() => this.o.codex ? codexChat(messages, { model, effort: this.o.codex, setT })
      : chat(url, body, { setT, key, timeoutMs: key ? 300000 : 120000 }))
    if (r.error) throw new Error(`LLM error: ${r.error.message || JSON.stringify(r.error)}`)
    const msg = (r.choices && r.choices[0] && r.choices[0].message) || {}
    const usage = r.usage || {}
    const rt = (usage.completion_tokens_details || {}).reasoning_tokens
    this.stats.calls++; this.stats.tokens += usage.completion_tokens || 0
    const ms = r.timings ? Math.round((r.timings.prompt_ms || 0) + (r.timings.predicted_ms || 0)) : Math.round(performance.now() - t0)
    this.stats.ms += ms
    // some templates leave <think> blocks in the content
    const text = String(msg.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^```\w*\n?|```$/gm, '').trim()
    return { text, reasoning: msg.reasoning_content || (rt ? `(${rt} hidden reasoning tokens)` : null), usage, ms, finish: r.choices && r.choices[0] && r.choices[0].finish_reason }
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
        sheet_chars: sheet.length, ...(round === 0 ? { sheet } : {}), output: a.text, reasoning: a.reasoning, ok: r.ok, error: r.error || null, answers: r.answers || null,
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

module.exports = { Mind, chat, codexChat, SYSTEM }
