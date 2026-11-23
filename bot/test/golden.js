// Golden tests for the DSL + turn parsers against spec/golden/*.jsonl.
// node test/golden.js            -> check (exit 1 on any failure)
// node test/golden.js --update   -> (re)write the `ast` snapshot of passing ok-cases; review the diff before committing
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const dsl = require('../dsl/parse');
const {parseTurn} = require('../dsl/turn');

const DIR = path.join(__dirname, '..', '..', 'spec', 'golden');
const update = process.argv.includes('--update');

function run(c) {
  switch (c.kind) {
    case 'stmt': return dsl.parseStmt(c.src);
    case 'tool': return dsl.parseTool(c.src);
    case 'cond': return dsl.parseCond(c.src);
    case 'expect': return dsl.parseExpect(c.src);
    case 'turn': {
      const r = parseTurn(c.src, c.turn_kind, c.ctx || {});
      return r.ok ? {ok: true, ast: r.turn} : r;
    }
  }
  throw new Error(`unknown case kind ${c.kind}`);
}

let pass = 0, fail = 0;
for (const file of fs.readdirSync(DIR).filter(f => f.endsWith('.jsonl'))) {
  const p = path.join(DIR, file);
  const cases = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  for (const c of cases) {
    const r = run(c);
    let err = null;
    if (r.ok !== c.ok) err = c.ok ? `expected ok, got error: ${r.error}` : `expected an error, got ok: ${JSON.stringify(r.ast)}`;
    else if (!c.ok && !r.error.includes(c.error_contains)) err = `error '${r.error}' lacks '${c.error_contains}'`;
    else if (c.ok && update) c.ast = r.ast;
    else if (c.ok) {
      if (!c.ast) err = 'no ast snapshot (run --update)';
      else try { assert.deepStrictEqual(r.ast, c.ast); } catch { err = `ast differs: ${JSON.stringify(r.ast)}`; }
    }
    if (!c.ok && update) c.error = r.error; // keep the full message visible for review
    if (err) { fail++; console.log(`FAIL ${file} ${JSON.stringify(c.src)}\n     ${err}`); } else pass++;
  }
  if (update) fs.writeFileSync(p, cases.map(c => JSON.stringify(c)).join('\n') + '\n');
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
