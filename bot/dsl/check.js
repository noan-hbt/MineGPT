// JSONL validation service for Python (teachers, dataset builders): one request per stdin line, one answer per
// stdout line, same order. Request {kind: stmt|tool|cond|expect|turn, src, turn_kind?, ctx?} -> {ok, ast|turn, error?}
// Usage: node bot/dsl/check.js < requests.jsonl > answers.jsonl   (or keep it open as a pipe)
'use strict';
const readline = require('readline');
const dsl = require('./parse');
const {parseTurn} = require('./turn');

function check(req) {
  switch (req.kind) {
    case 'stmt': return dsl.parseStmt(req.src);
    case 'tool': return dsl.parseTool(req.src);
    case 'cond': return dsl.parseCond(req.src);
    case 'expect': return dsl.parseExpect(req.src);
    case 'turn': return parseTurn(req.src, req.turn_kind, req.ctx || {});
  }
  return {ok: false, error: `unknown kind ${req.kind}`};
}

if (require.main === module) {
  const rl = readline.createInterface({input: process.stdin});
  rl.on('line', line => {
    if (!line.trim()) return;
    let out;
    try { out = check(JSON.parse(line)); } catch (e) { out = {ok: false, error: `bad request: ${e.message}`}; }
    process.stdout.write(JSON.stringify(out) + '\n');
  });
}

module.exports = {check};
