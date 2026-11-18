// GBNF grammar (llama.cpp constrained decoding) for a decision turn (dsl/turn.js), built from the DSL catalog.
// Constrains the FORMAT only: tags, line structure, verb/tool names, expect conditions. The content (what to do,
// arguments, thoughts) stays free. Every output it allows is a structurally valid turn; arguments can still fail
// the type checks (unknown item...) and come back as invalid_output like before.
// Fixed tag order: think* then either tool lines, or goal? plan? note* say? act expect (expect always present:
// optional after wait/say/..., but always accepted).
//   node dsl/gbnf.js > decision.gbnf      (or require('./gbnf').decisionGrammar())
'use strict';
const {catalog, FLAGS, METRICS, ARG_METRICS, CMPS} = require('./parse');

const lit = s => JSON.stringify(s);
const alt = xs => '(' + [...xs].sort((a, b) => b.length - a.length).map(lit).join(' | ') + ')';

function decisionGrammar({maxThink = 3} = {}) {
  const verbs = Object.keys(catalog.verbs);
  const tools = Object.keys(catalog.tools);
  return [
    `root ::= think{0,${maxThink}} (tools | final)`,
    'think ::= "think: " [^\\n]{1,300} "\\n"', // capped: long think lines used up max_tokens before act
    'tools ::= tool{1,4}',
    `tool ::= "tool: " ${alt(tools)} (" " dsl)? "\\n"`,
    'final ::= goal? plan? note{0,2} say? act expect',
    // free-text lines are length-capped: LFM3 wrote whole paragraphs in goal:/say: and hit max_tokens before act
    'goal ::= "goal: " ("push " short | "replace " short | "done" | "fail " short) "\\n"',
    'plan ::= "plan: " [^\\n]{1,200} "\\n"',
    'note ::= "note: " short "\\n"',
    'say ::= "say: " short "\\n"',
    `act ::= "act: " (("seq [" | "if (" | "repeat (" | "routine ") [^\\n]{1,300} | ${alt(verbs)} (" " dsl)?) "\\n"`,
    'expect ::= "expect: " cond (", " cond)* " in " [1-9] [0-9]{0,3} [smh] "\\n"',
    'cond ::= atom ((" & " | " | ") atom)*',
    `atom ::= "!"? (${alt(FLAGS)} | ${alt(METRICS)} cmp num | ${alt(Object.keys(ARG_METRICS))} "(" [a-zA-Z0-9_:#.@~, ()-]{1,60} ")" cmp num)`,
    `cmp ::= " "? ${alt(CMPS)} " "?`,
    'num ::= ("+" | "~")? [0-9]{1,6} ("." [0-9]{1,3})?',
    'short ::= [^\\n]{1,150}',
    // DSL arguments: ids, numbers, conditions, positions, "quoted text"; no prose punctuation (? ' ;) outside quotes
    'dsl ::= ([a-zA-Z0-9_:#@~=<>!&|+.,()\\[\\] -] | "\\"" [^"\\n]{0,150} "\\"")+',
  ].join('\n') + '\n';
}

module.exports = {decisionGrammar};
if (require.main === module) process.stdout.write(decisionGrammar());
