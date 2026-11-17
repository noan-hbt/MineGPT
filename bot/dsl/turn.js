// Parse one model output (a turn) into structured form. Spec: notes/spec-v2.md section 1, spec/turns.md.
// parseTurn(text, kind, ctx) with kind = 'decision' | 'monitor' | 'mind'; ctx.running = verb of the running action
// (monitor `adjust:`). Returns {ok:true, turn} | {ok:false, error, line}.
'use strict';
const {parseStmt, parseTool, parseExpect, parseAdjust} = require('./parse');

const MAX_TOOLS = 4;
// verbs whose outcome is not a game-state change: `expect:` optional
const NO_EXPECT = new Set(['wait', 'note', 'forget', 'name_place', 'save_routine', 'stop', 'say', 'whisper', 'obey', 'refuse']);

const TAGS = {
  decision: ['think', 'tool', 'plan', 'act', 'expect', 'note', 'say', 'ask', 'goal'],
  monitor: ['think', 'adjust', 'interrupt', 'expect'],
  mind: ['think', 'plan', 'note', 'say', 'goal', 'answer', 'override', 'expect', 'ask'],
};
const REPEATABLE = new Set(['think', 'tool', 'note']);
const GOAL_OPS = {push: true, replace: true, done: false, fail: true};

class TurnError extends Error {
  constructor(msg, line) { super(msg); this.line = line; }
}

function sub(res, line, tag) {
  if (!res.ok) throw new TurnError(`line ${line} (${tag}): ${res.error}`, line);
  return res.ast;
}

function needsExpect(stmt) {
  return !(stmt.op === 'call' && NO_EXPECT.has(stmt.verb));
}

function parseGoal(text, line) {
  const m = text.match(/^(\w+)\s*(.*)$/);
  if (!m || !(m[1] in GOAL_OPS)) throw new TurnError(`line ${line} (goal): use push <text> | replace <text> | done | fail <reason>`, line);
  if (GOAL_OPS[m[1]] && !m[2]) throw new TurnError(`line ${line} (goal): '${m[1]}' needs a text`, line);
  if (!GOAL_OPS[m[1]] && m[2]) throw new TurnError(`line ${line} (goal): '${m[1]}' takes no text`, line);
  return m[2] ? {op: m[1], text: m[2]} : {op: m[1]};
}

function parseTurn(text, kind, ctx = {}) {
  try {
    return {ok: true, turn: parse(text, kind, ctx)};
  } catch (e) {
    if (e instanceof TurnError) return {ok: false, error: e.message, line: e.line};
    throw e;
  }
}

function parse(text, kind, ctx) {
  const allowed = TAGS[kind];
  if (!allowed) throw new Error(`unknown turn kind ${kind}`);
  const lines = [];
  text.split(/\r?\n/).forEach((raw, idx) => {
    const s = raw.trim();
    if (!s) return;
    const n = idx + 1;
    if (s === 'continue' && kind !== 'decision') { lines.push({tag: 'continue', body: '', n}); return; }
    const m = s.match(/^([a-z]+):\s*(.*)$/);
    if (!m) throw new TurnError(`line ${n}: every line starts with a tag (${allowed.join(', ')}${kind !== 'decision' ? ', continue' : ''})`, n);
    if (!allowed.includes(m[1])) throw new TurnError(`line ${n}: tag '${m[1]}' not allowed in a ${kind} turn (tags: ${allowed.join(', ')})`, n);
    if (!m[2]) throw new TurnError(`line ${n} (${m[1]}): empty`, n);
    lines.push({tag: m[1], body: m[2], n});
  });
  if (!lines.length) throw new TurnError('empty output', 0);

  const seen = {};
  for (const l of lines) {
    if (seen[l.tag] && !REPEATABLE.has(l.tag)) throw new TurnError(`line ${l.n}: '${l.tag}' given twice`, l.n);
    seen[l.tag] = (seen[l.tag] || 0) + 1;
  }
  const turn = {kind};
  const thinks = lines.filter(l => l.tag === 'think').map(l => l.body);
  if (thinks.length) turn.think = thinks.join('\n');
  const one = tag => lines.find(l => l.tag === tag);
  const lastLine = lines[lines.length - 1].n;

  function actWithExpect(tag) {
    const l = one(tag);
    const stmt = sub(parseStmt(l.body), l.n, tag);
    const e = one('expect');
    if (e) {
      if (e.n < l.n) throw new TurnError(`line ${e.n}: expect comes after ${tag}`, e.n);
      turn.expect = sub(parseExpect(e.body), e.n, 'expect');
    } else if (needsExpect(stmt)) {
      throw new TurnError(`line ${l.n} (${tag}): missing 'expect: <conditions> in <duration>' after it`, l.n);
    }
    return stmt;
  }
  function common() {
    const p = one('plan');
    if (p) {
      turn.plan = p.body.split('|').map(s => s.trim());
      if (turn.plan.some(s => !s)) throw new TurnError(`line ${p.n} (plan): empty step, steps are separated by ' | '`, p.n);
    }
    const notes = lines.filter(l => l.tag === 'note').map(l => l.body);
    if (notes.length) turn.notes = notes;
    if (one('say')) turn.say = one('say').body;
    if (one('goal')) turn.goal = parseGoal(one('goal').body, one('goal').n);
    const a = one('ask');
    if (a) {
      const m = a.body.match(/^(mind|strategist)\s+(.+)$/);
      if (!m) throw new TurnError(`line ${a.n} (ask): use 'ask: mind <question>' or 'ask: strategist <question>'`, a.n);
      if (kind === 'mind' && m[1] === 'mind') throw new TurnError(`line ${a.n} (ask): the mind asks the strategist`, a.n);
      turn.ask = {to: m[1], q: m[2]};
    }
  }

  if (kind === 'decision') {
    const tools = lines.filter(l => l.tag === 'tool');
    if (tools.length) {
      const other = lines.find(l => l.tag !== 'tool' && l.tag !== 'think');
      if (other) throw new TurnError(`line ${other.n}: a tool round has only think/tool lines; wait for the results, then act`, other.n);
      if (tools.length > MAX_TOOLS) throw new TurnError(`line ${tools[MAX_TOOLS].n}: at most ${MAX_TOOLS} tool calls per round`, tools[MAX_TOOLS].n);
      turn.tools = tools.map(l => sub(parseTool(l.body), l.n, 'tool'));
      return turn;
    }
    if (!one('act')) throw new TurnError(`line ${lastLine}: a decision ends with 'act: <statement>' (or tool: lines)`, lastLine);
    turn.act = actWithExpect('act');
    common();
    return turn;
  }

  if (kind === 'monitor') {
    const ctl = lines.filter(l => ['continue', 'adjust', 'interrupt'].includes(l.tag));
    if (ctl.length !== 1) throw new TurnError(`line ${lastLine}: a monitor turn has exactly one of continue / adjust: / interrupt:`, lastLine);
    const c = ctl[0];
    if (c.tag === 'continue') turn.continue = true;
    else if (c.tag === 'adjust') turn.adjust = sub(parseAdjust(c.body, ctx.running), c.n, 'adjust');
    else turn.interrupt = actWithExpect('interrupt');
    if (c.tag !== 'interrupt' && one('expect')) throw new TurnError(`line ${one('expect').n}: expect only follows interrupt`, one('expect').n);
    return turn;
  }

  // mind
  if (one('override')) turn.override = actWithExpect('override');
  else if (one('expect')) throw new TurnError(`line ${one('expect').n}: expect only follows override`, one('expect').n);
  if (one('answer')) turn.answer = one('answer').body;
  common();
  if (one('continue')) {
    if (lines.some(l => !['think', 'continue'].includes(l.tag))) throw new TurnError("'continue' means no change: no other tags", lastLine);
    turn.continue = true;
  }
  if (Object.keys(turn).every(k => k === 'kind' || k === 'think')) {
    throw new TurnError("the mind outputs at least one of plan/note/say/goal/answer/override/ask, or 'continue'", lastLine);
  }
  return turn;
}

module.exports = {parseTurn, NO_EXPECT, MAX_TOOLS};
