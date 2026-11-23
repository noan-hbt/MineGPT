// MineGPT DSL v2 parser + validator. Spec: spec/dsl.md, spec/catalog.json, spec/names.json.
// parseStmt(src) / parseCond(src) / parseExpect(src) -> {ok:true, ast} | {ok:false, error, at}
'use strict';
const fs = require('fs');
const path = require('path');

const SPEC = path.join(__dirname, '..', '..', 'spec');
const catalog = JSON.parse(fs.readFileSync(path.join(SPEC, 'catalog.json'), 'utf8'));
const names = JSON.parse(fs.readFileSync(path.join(SPEC, 'names.json'), 'utf8'));

const sets = {
  item: new Set(names.items), block: new Set(names.blocks), mob: new Set(names.mobs),
  entity: new Set(names.entities), biome: new Set(names.biomes),
  item_tag: new Set(Object.keys(names.item_tags)), block_tag: new Set(Object.keys(names.block_tags)),
};
const FLAGS = new Set(['night', 'day', 'rain', 'thunder', 'inv_full', 'idle', 'in_water', 'in_lava', 'on_fire', 'sky']);
const METRICS = new Set(['hp', 'food', 'sat', 'xp', 'armor', 'air', 'y', 'light', 'time', 'free_slots', 'hostile']);
const ARG_METRICS = {have: 'item', dist: 'target'};
const DIRS = ['north', 'south', 'east', 'west', 'up', 'down'];
const SPOTS = ['front', 'below', 'above'];
const CMPS = ['<=', '>=', '==', '!=', '<', '>'];

class DslError extends Error {
  constructor(msg, at) { super(msg); this.at = at; }
}

// ---------- lexer ----------
const TOKEN_RES = [
  ['STRING', /"(?:[^"\\]|\\.)*"/y],
  ['PLACE', /@[a-z0-9_]+/y],
  ['ENTITY', /#[a-z_][a-z0-9_]*(?:\.[A-Za-z0-9_]+)?/y],
  ['DUR', /\d+(?:s|m|h)(?![a-z0-9_])/y],
  ['FLOAT', /-?\d+\.\d+/y],
  ['INT', /-?\d+/y],
  ['REL', /~(?:-?\d+)?/y],
  ['NAME', /[a-z_][a-z0-9_]*(?::[a-z0-9_/]+)?/y],
  ['P', /<=|>=|==|!=|[()[\],;=&|!<>+]/y],
];

function lex(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    if (/\s/.test(src[i])) { i++; continue; }
    let hit = null;
    for (const [type, re] of TOKEN_RES) {
      re.lastIndex = i;
      const m = re.exec(src);
      if (m) { hit = {type, v: m[0], at: i}; break; }
    }
    if (!hit) {
      const bad = src.slice(i).match(/^\S+/)[0];
      const hint = /[A-Z]/.test(bad) ? ' (ids are lowercase; player names go in #player.Name)' : '';
      throw new DslError(`unexpected '${bad}'${hint}`, i);
    }
    toks.push(hit);
    i += hit.v.length;
  }
  toks.push({type: 'EOF', v: '', at: src.length});
  return toks;
}

// ---------- suggestions ----------
function lev(a, b) {
  const d = Array.from({length: b.length + 1}, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return d[b.length];
}
function suggest(word, pool, k = 3) {
  const max = Math.max(2, Math.floor(word.length / 3));
  const scored = [];
  for (const w of pool) {
    if (Math.abs(w.length - word.length) > max + 3) continue;
    let s = lev(word, w);
    if (w.includes(word) || word.includes(w)) s = Math.min(s, 1.5);
    if (s <= max) scored.push([s, w]);
  }
  // ties: shortest first (birch -> birch_log before birch_door), then alphabetical
  scored.sort((a, b) => a[0] - b[0] || a[1].length - b[1].length || a[1].localeCompare(b[1]));
  const out = scored.slice(0, k).map(x => x[1]);
  return out.length ? ` (did you mean ${out.join(', ')}?)` : '';
}

// ---------- parser ----------
class Parser {
  constructor(src, table) {
    this.src = src; this.toks = lex(src); this.i = 0;
    this.table = table || catalog.verbs; // verbs for act, tools for tool:
  }
  peek(o = 0) { return this.toks[this.i + o]; }
  next() { return this.toks[this.i++]; }
  is(v, o = 0) { const t = this.peek(o); return t.type === 'P' && t.v === v; }
  isName(v, o = 0) { const t = this.peek(o); return t.type === 'NAME' && t.v === v; }
  expect(v) {
    const t = this.next();
    if (t.type !== 'P' || t.v !== v) throw new DslError(`expected '${v}' but got ${show(t)}`, t.at);
    return t;
  }
  done() {
    const t = this.peek();
    if (t.type !== 'EOF') throw new DslError(`unexpected ${show(t)} after the end of the statement`, t.at);
  }

  stmt() {
    const t = this.peek();
    if (t.type !== 'NAME') throw new DslError(`expected a verb but got ${show(t)}`, t.at);
    if (t.v === 'seq' && this.is('[', 1)) {
      this.i += 2;
      const body = [this.stmt()];
      while (this.is(';')) { this.next(); body.push(this.stmt()); }
      this.expect(']');
      return this.withUntil({op: 'seq', body});
    }
    if (t.v === 'if' && this.is('(', 1)) {
      this.i += 2;
      const cond = this.cond();
      this.expect(')');
      const node = {op: 'if', cond, then: this.stmt()};
      if (this.isName('else')) { this.next(); node.else = this.stmt(); }
      return node;
    }
    if (t.v === 'repeat' && this.is('(', 1)) {
      this.i += 2;
      const n = this.next();
      if (n.type !== 'INT' || +n.v < 1) throw new DslError(`repeat needs a positive integer, got ${show(n)}`, n.at);
      this.expect(')');
      return {op: 'repeat', n: +n.v, body: this.stmt()};
    }
    if (t.v === 'routine' && this.peek(1).type === 'NAME') {
      this.i += 2;
      return {op: 'routine', name: this.peek(-1).v};
    }
    return this.call();
  }

  withUntil(node) {
    if (this.isName('until') && this.is('(', 1)) {
      this.i += 2;
      node.until = this.cond();
      this.expect(')');
    }
    return node;
  }

  call() {
    const vt = this.next();
    const spec = this.table[vt.v];
    if (!spec) {
      const kind = this.table === catalog.tools ? 'tool' : 'verb';
      const other = this.table === catalog.tools ? catalog.verbs : catalog.tools;
      const extra = other[vt.v] ? ` ('${vt.v}' is a ${kind === 'tool' ? 'verb, use it in act:' : 'tool, use it in tool:'})` : '';
      throw new DslError(`unknown ${kind} '${vt.v}'${extra || suggest(vt.v, Object.keys(this.table))}`, vt.at);
    }
    const verb = vt.v;
    const args = {};
    let pi = 0;
    // positional params may also be given as name=value
    const kwSpec = Object.assign({}, catalog.global_kw, spec.kw);
    for (const a of spec.args) kwSpec[a.name] = a.type;
    let until;
    for (;;) {
      const t = this.peek();
      if (t.type === 'EOF' || (t.type === 'P' && [';', ']', ')'].includes(t.v))) break;
      if (t.type === 'NAME' && t.v === 'else') break;
      if (t.type === 'NAME' && t.v === 'until' && this.is('(', 1)) { // until() may sit among key=value args
        if (until) throw new DslError('until(...) given twice', t.at);
        until = this.withUntil({}).until;
        continue;
      }
      if (t.type === 'NAME' && this.is('=', 1)) { // keyword
        const key = t.v;
        if (!(key in kwSpec)) {
          throw new DslError(`${verb} has no parameter '${key}'` +
            ` (parameters: ${Object.keys(kwSpec).join(', ')})`, t.at);
        }
        if (key in args) throw new DslError(`parameter '${key}' given twice`, t.at);
        this.i += 2;
        args[key] = this.typed(kwSpec[key], key, verb);
        continue;
      }
      if (Object.keys(args).length > pi) {
        throw new DslError(`positional argument ${show(t)} after key=value arguments`, t.at);
      }
      while (spec.args[pi] && spec.args[pi].name in args) pi++;
      const a = spec.args[pi];
      if (!a) {
        const kws = Object.keys(spec.kw).map(k => `${k}=`).join(' ');
        const usage = [...spec.args.map(x => x.opt ? `[${x.name}]` : x.name), kws].filter(Boolean).join(' ');
        throw new DslError(`too many arguments for ${verb} at ${show(t)} (usage: ${verb} ${usage})`, t.at);
      }
      pi++;
      args[a.name] = this.typed(a.type, a.name, verb);
    }
    for (const a of spec.args) {
      if (!a.opt && !(a.name in args)) {
        const usage = spec.args.map(x => x.opt ? `[${x.name}]` : x.name).join(' ');
        throw new DslError(`${verb} is missing '${a.name}' (usage: ${verb} ${usage})`, this.peek().at);
      }
    }
    return until ? {op: 'call', verb, args, until} : {op: 'call', verb, args};
  }

  // parse one value and check it against a catalogue type
  typed(type, argName, verb) {
    if (type === 'stmt') { // statement argument: always parsed against the verb table (simulate is a tool)
      const saved = this.table;
      this.table = catalog.verbs;
      try { return this.stmt(); } finally { this.table = saved; }
    }
    if (type === 'cond') return this.cond();
    const t = this.peek();
    const v = this.value();
    const err = check(type, v);
    if (err) throw new DslError(`${verb} ${argName}: ${err}`, t.at);
    return v;
  }

  value() {
    const t = this.next();
    switch (t.type) {
      case 'NAME': return t.v.startsWith('tag:') ? {tag: t.v.slice(4)} : {name: t.v};
      case 'PLACE': return {place: t.v.slice(1)};
      case 'ENTITY': {
        const [kind, ref] = t.v.slice(1).split('.');
        return ref === undefined ? {entity: kind} : {entity: kind, ref};
      }
      case 'INT': case 'FLOAT': return +t.v;
      case 'DUR': return {dur: +t.v.slice(0, -1) * {s: 1, m: 60, h: 3600}[t.v.slice(-1)]};
      case 'STRING': return {text: JSON.parse(t.v)};
      case 'P':
        if (t.v === '(') {
          if (this.is('(')) {
            const a = this.value(); this.expect(','); const b = this.value(); this.expect(')');
            if (!a.pos || !b.pos) throw new DslError('a box is ((x,y,z),(x,y,z))', t.at);
            return {box: [a, b]};
          }
          const c = [this.coord()]; this.expect(','); c.push(this.coord()); this.expect(','); c.push(this.coord());
          this.expect(')');
          return {pos: c};
        }
        if (t.v === '[') {
          const list = [this.value()];
          while (this.is(',')) { this.next(); list.push(this.value()); }
          this.expect(']');
          return {list};
        }
    }
    throw new DslError(`expected a value but got ${show(t)}`, t.at);
  }

  coord() {
    const t = this.next();
    if (t.type === 'INT') return +t.v;
    if (t.type === 'REL') return t.v;
    throw new DslError(`a coordinate is an integer or ~N, got ${show(t)}`, t.at);
  }

  // ---- conditions ----
  cond() {
    const parts = [this.condAnd()];
    while (this.is('|')) { this.next(); parts.push(this.condAnd()); }
    return parts.length === 1 ? parts[0] : {or: parts};
  }
  condAnd() {
    const parts = [this.condUnary()];
    while (this.is('&')) { this.next(); parts.push(this.condUnary()); }
    return parts.length === 1 ? parts[0] : {and: parts};
  }
  condUnary() {
    if (this.is('!')) { this.next(); return {not: this.condUnary()}; }
    if (this.is('(')) { this.next(); const c = this.cond(); this.expect(')'); return c; }
    const t = this.next();
    if (t.type !== 'NAME') throw new DslError(`expected a condition but got ${show(t)}`, t.at);
    if (FLAGS.has(t.v)) return {flag: t.v};
    const node = {metric: t.v};
    if (t.v in ARG_METRICS) {
      this.expect('(');
      const at = this.peek().at;
      node.arg = this.value();
      const err = check(ARG_METRICS[t.v], node.arg);
      if (err) throw new DslError(`${t.v}(): ${err}`, at);
      this.expect(')');
    } else if (!METRICS.has(t.v)) {
      throw new DslError(`unknown condition '${t.v}'` +
        suggest(t.v, [...FLAGS, ...METRICS, ...Object.keys(ARG_METRICS)]), t.at);
    }
    const c = this.next();
    if (c.type !== 'P' || !CMPS.includes(c.v)) {
      throw new DslError(`'${t.v}' needs a comparison (< <= > >= == !=), got ${show(c)}`, c.at);
    }
    node.cmp = c.v;
    let rel = false;
    if (this.is('+')) { this.next(); rel = true; }
    const n = this.next();
    if (n.type === 'REL') {
      if (n.v === '~') throw new DslError("relative value needs a number: ~N", n.at);
      node.value = +n.v.slice(1); rel = true;
    } else if (n.type === 'INT' || n.type === 'FLOAT') {
      node.value = +n.v;
    } else throw new DslError(`expected a number after ${c.v} but got ${show(n)}`, n.at);
    if (rel) node.rel = true;
    return node;
  }
}

function show(t) { return t.type === 'EOF' ? 'end of line' : `'${t.v}'`; }

// ---------- type checks: return an error string or null ----------
function checkId(v, kind) {
  if (v.tag !== undefined) {
    const tags = kind === 'item' ? sets.item_tag : sets.block_tag;
    return tags.has(v.tag) ? null : `unknown ${kind} tag 'tag:${v.tag}'${suggest(v.tag, tags)}`;
  }
  if (v.name === undefined) return `expected ${a(kind)} id`;
  return sets[kind].has(v.name) ? null : `unknown ${kind} '${v.name}'${suggest(v.name, sets[kind])}`;
}
function a(w) { return (/^[aeiou]/.test(w) ? 'an ' : 'a ') + w; }

function checkEntity(v) {
  if (v.entity === undefined) return 'expected an entity (#kind, #kind.id, #player.Name)';
  if (v.entity === 'player') return v.ref ? null : 'a player is #player.Name';
  return sets.entity.has(v.entity) ? null : `unknown entity '#${v.entity}'${suggest(v.entity, sets.entity)}`;
}

function check(type, v) {
  if (typeof type === 'object' && type.enum) {
    return v.name !== undefined && type.enum.includes(v.name) ? null : `expected one of ${type.enum.join(', ')}`;
  }
  if (type.includes('|')) {
    const errs = type.split('|').map(t => check(t, v));
    return errs.includes(null) ? null : errs.join('; or ');
  }
  switch (type) {
    case 'item': return checkId(v, 'item');
    case 'block': return checkId(v, 'block');
    case 'mob':
      if (v.name === undefined) return 'expected a mob kind';
      return sets.mob.has(v.name) ? null : `unknown mob '${v.name}'${suggest(v.name, sets.mob)}`;
    case 'entity': return checkEntity(v);
    case 'biome':
      if (v.name === undefined) return 'expected a biome id';
      return sets.biome.has(v.name) ? null : `unknown biome '${v.name}'${suggest(v.name, sets.biome)}`;
    case 'target':
      if (v.pos || v.place) return null;
      if (v.entity !== undefined) return checkEntity(v);
      if (v.name !== undefined || v.tag !== undefined) {
        if (v.tag !== undefined) return sets.block_tag.has(v.tag) || sets.item_tag.has(v.tag) ? null : `unknown tag 'tag:${v.tag}'`;
        if (sets.block.has(v.name) || sets.item.has(v.name)) return null;
        return `unknown target '${v.name}'${suggest(v.name, sets.block)}`;
      }
      return 'expected a target: (x,y,z), @place, #entity or a block/item id';
    case 'pos': return v.pos ? null : 'expected a position (x,y,z)';
    case 'box': return v.box ? null : 'expected a box ((x,y,z),(x,y,z))';
    case 'posset':
      if (v.pos || v.box) return null;
      if (v.list) return v.list.every(p => p.pos) ? null : 'a position list holds only (x,y,z)';
      return v.name !== undefined && SPOTS.includes(v.name) ? null : 'expected (x,y,z), [(x,y,z),...], a box, front, below or above';
    case 'dir': return v.name !== undefined && DIRS.includes(v.name) ? null : `expected a direction: ${DIRS.join(', ')}`;
    case 'int': return Number.isInteger(v) ? null : 'expected an integer';
    case 'num': return typeof v === 'number' ? null : 'expected a number';
    case 'duration': return v.dur !== undefined ? null : 'expected a duration like 30s or 2m';
    case 'text': return v.text !== undefined ? null : 'expected a "quoted text"';
    case 'query': return v.text !== undefined || v.name !== undefined ? null : 'expected a "quoted query" or a name';
    case 'name':
      return v.name !== undefined && /^[a-z0-9_]+$/.test(v.name) ? null : 'expected a name [a-z0-9_]';
    case 'prefer':
      if (v.name === 'unexplored') return null;
      if (v.name && v.name.startsWith('biome:')) {
        const b = v.name.slice(6);
        return sets.biome.has(b) ? null : `unknown biome '${b}'${suggest(b, sets.biome)}`;
      }
      return checkId(v, 'block') && 'expected unexplored, biome:<biome> or a block id';
    case 'item_list':
      if (v.list) { for (const x of v.list) { const e = checkId(x, 'item'); if (e) return e; } return null; }
      return checkId(v, 'item');
  }
  throw new Error(`catalog type not handled: ${type}`);
}

// ---------- public API ----------
function run(src, fn) {
  try {
    const p = new Parser(src, fn.table);
    const ast = fn(p);
    p.done();
    return {ok: true, ast};
  } catch (e) {
    if (e instanceof DslError) return {ok: false, error: e.message, at: e.at};
    throw e;
  }
}
function withTable(fn, table) { fn.table = table; return fn; }

const parseStmt = src => run(src, withTable(p => p.stmt(), catalog.verbs));
const parseTool = src => run(src, withTable(p => p.call(), catalog.tools));
const parseCond = src => run(src, withTable(p => p.cond(), catalog.verbs));
function parseExpect(src) {
  return run(src, withTable(p => {
    const conds = [p.cond()];
    while (p.is(',')) { p.next(); conds.push(p.cond()); }
    if (!p.isName('in')) throw new DslError(`expect ends with 'in <duration>', got ${show(p.peek())}`, p.peek().at);
    p.next();
    const d = p.next();
    if (d.type !== 'DUR') throw new DslError(`expected a duration like 30s after 'in', got ${show(d)}`, d.at);
    return {conds, within: +d.v.slice(0, -1) * {s: 1, m: 60, h: 3600}[d.v.slice(-1)]};
  }, catalog.verbs));
}
// adjust: k=v ... [until(cond)] against the running statement's verb
function parseAdjust(src, verb) {
  return run(src, withTable(p => {
    const spec = verb && catalog.verbs[verb];
    const kwSpec = Object.assign({}, catalog.global_kw, spec ? spec.kw : {});
    const out = {set: {}};
    while (p.peek().type === 'NAME' && p.is('=', 1)) {
      const t = p.next(); p.next();
      if (!(t.v in kwSpec)) {
        throw new DslError(`cannot adjust '${t.v}'${verb ? ` on ${verb}` : ''} (adjustable: ${Object.keys(kwSpec).join(', ')})`, t.at);
      }
      out.set[t.v] = p.typed(kwSpec[t.v], t.v, verb || 'adjust');
    }
    p.withUntil(out);
    if (!Object.keys(out.set).length && !out.until) throw new DslError('adjust needs key=value or until(...)', p.peek().at);
    if (!Object.keys(out.set).length) delete out.set;
    return out;
  }, catalog.verbs));
}

module.exports = {parseStmt, parseTool, parseCond, parseExpect, parseAdjust, catalog, names, lex, FLAGS, METRICS, ARG_METRICS, CMPS};
