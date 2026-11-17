// B7 — chat intent test without Minecraft: fake bot state, French (and one English) player messages,
// checks the intent the LLM picks (+ goal arg). Needs the LLM server.  node test_chat.js [--llm url]
'use strict'
const { createChat } = require('./chat')
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d }

const ctx = {
  hp: 18, food: 15, pos: [120, 64, -40], night: false, goal: 'iron_pickaxe', tasks: ['iron_pickaxe', '16 torch'],
  doing: 'collect stone (task, run 2)', inv: { oak_log: 3, cobblestone: 7, stick: 4, wooden_pickaxe: 1, coal: 2 },
  memory: 'Home: 35m north.\nRemembered: crafting_table 12m east.\nEarlier: Crafted a wooden pickaxe and started mining stone.',
}
// [message, expected intent, arg regex (get only)]
const CASES = [
  ['salut ça va ?', 'none'],
  ['tu fais quoi là ?', 'none'],
  ["t'as du fer ?", 'none'],
  ['ramène-moi 10 bûches de chêne', 'get', /10 oak_log/],
  ['fabrique moi 4 torches stp', 'get', /4 torch/],
  ['arrête toi', 'stop'],
  ['ok tu peux reprendre ton boulot', 'resume'],
  ['suis moi', 'follow'],
  ['viens ici', 'come'],
  ['ta base est ici maintenant', 'set_home'],
  ['rentre à la maison', 'go_home'],
  ['craft me an iron sword', 'get', /1 iron_sword/],
  // held out: phrasings far from the prompt's examples
  ['va me chercher du charbon', 'get', /coal/],
  ["j'ai besoin d'un four", 'get', /1 furnace/],
  ['attends moi là deux secondes', 'stop'],
  ['laisse tomber, fais ce que tu faisais', 'resume'],
  ['colle moi, on part en expédition', 'follow'],
  ['approche', 'come'],
  ["installe toi ici, c'est chez nous", 'set_home'],
  ['on rentre', 'go_home'],
  ["combien de pierres t'as ?", 'none'],
  ["c'est quoi ton objectif ?", 'none'],
]

async function main() {
  const chat = createChat({ llm: arg('llm', 'http://127.0.0.1:8080'), name: 'LFM', context: () => ctx, onIntent: () => {}, say: () => {} })
  let ok = 0
  const ms = []
  for (const [msg, want, re] of CASES) {
    chat.turns.length = 0 // independent cases
    const out = await chat.ask('Noan', msg)
    const pass = out.intent === want && (!re || re.test(out.arg))
    ok += pass; ms.push(out.ms)
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${String(out.ms).padStart(5)}ms  ${msg.padEnd(36)} -> ${out.intent}${out.arg ? ' "' + out.arg + '"' : ''} | ${out.say}`)
  }
  ms.sort((a, b) => a - b)
  console.log(`\n${ok}/${CASES.length} intents ok, median ${ms[ms.length >> 1]} ms`)
}
main().catch(e => { console.error(e); process.exit(1) })
