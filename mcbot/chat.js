// B7 — natural chat with the LLM (text). Runs beside the decision loop, never blocks it.
// Each player message -> one LLM call constrained by a JSON schema: { intent, arg, say }.
//   say    = the in-game answer (player's language, French by default, short)
//   intent = what the bot should do about it (mapped by bot.js onto its chat commands)
// Context: persona, live status (hp, goal, task stack, current action, inventory), B4 memory, last chat turns.
//   const chat = createChat({ llm, name, slot, context: () => ({...}), onIntent: (intent, arg, user) => {}, say: t => bot.chat(t) })
//   chat.handle(user, msg)
'use strict'

// intent names chosen to be unambiguous for a 1.7B model ("goal"/"go" got mixed up); bot.js maps them to commands
const INTENTS = ['none', 'get', 'stop', 'resume', 'follow', 'come', 'set_home', 'go_home']
const SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: INTENTS },
    arg: { type: 'string', maxLength: 40 },
    say: { type: 'string', minLength: 1, maxLength: 220 },
  },
  required: ['intent', 'arg', 'say'],
}

const system = name => `Tu es ${name}, un bot qui joue à Minecraft en survie avec le joueur. Tu es sympa, un peu taquin, et bref.
Tu réponds dans la langue du joueur (français par défaut), en 1 ou 2 phrases courtes, sans emoji.
Tu connais ton état réel (lignes Status, Goal, Tasks, Doing, Inventory, mémoire). Ne prétends jamais avoir un objet ou avoir fait une chose qui n'y est pas.
Réponds en JSON : {"intent": ..., "arg": ..., "say": ...}
intent :
- get : le joueur veut que tu obtiennes, ramènes, fabriques ou mines quelque chose. arg = "<nombre> <id_minecraft anglais>" (ex "3 torch", "10 oak_log", "1 iron_sword"). Nombre absent = 1.
- stop : arrête-toi, attends, pause.
- resume : reprends ton travail, continue tout seul.
- follow : suis-moi (tu le suis en continu).
- come : viens ici, rejoins-moi (une seule fois).
- set_home : ta base/maison est ici maintenant.
- go_home : rentre à la base.
- none : discussion ou question (où es-tu, que fais-tu, as-tu X...). Réponds avec ton état réel.
arg = "" sauf pour get.
Exemples :
"ramène moi 5 pierres" -> {"intent":"get","arg":"5 cobblestone","say":"Ok, je t'en ramène 5."}
"fais moi une épée en pierre" -> {"intent":"get","arg":"1 stone_sword","say":"Une épée en pierre, ça arrive."}
"bouge pas" -> {"intent":"stop","arg":"","say":"Je ne bouge plus."}
"vas-y continue" -> {"intent":"resume","arg":"","say":"C'est reparti."}
"suis moi" -> {"intent":"follow","arg":"","say":"Je te suis."}
"viens" -> {"intent":"come","arg":"","say":"J'arrive."}
"on habite ici maintenant" -> {"intent":"set_home","arg":"","say":"Ok, c'est notre base."}
"retourne à la base" -> {"intent":"go_home","arg":"","say":"Je rentre."}
"t'as combien de bois ?" -> {"intent":"none","arg":"","say":"J'ai 3 bûches de chêne."}
"il me faudrait un coffre" -> {"intent":"get","arg":"1 chest","say":"Je te fabrique un coffre."}
"stop, plus un geste" -> {"intent":"stop","arg":"","say":"Je ne bouge plus."}
"oublie ça, retourne à ce que tu faisais" -> {"intent":"resume","arg":"","say":"Je reprends."}
"accompagne moi jusqu'à la mine" -> {"intent":"follow","arg":"","say":"Je t'accompagne."}
"rejoins moi" -> {"intent":"come","arg":"","say":"J'arrive."}
"on s'installe là" -> {"intent":"set_home","arg":"","say":"Ok, notre base est ici."}
"tu cherches quoi en ce moment ?" -> {"intent":"none","arg":"","say":"Je cherche du fer pour ma pioche."}
Une question (même avec "base", "maison", "objectif") reste intent none.`

function createChat({ llm, name, slot = null, context, onIntent, say, log = () => {}, history = 10, timeoutMs = 15000 }) {
  const turns = [] // {role, content} alternating, last `history` kept
  const queue = []
  let busy = false

  async function ask(user, msg) {
    const c = context()
    const lines = [
      `Status: hp ${c.hp}/20, food ${c.food}/20, position ${c.pos?.join(' ') ?? '?'}, ${c.night ? 'night' : 'day'}${c.paused ? ', paused (waiting for orders)' : ''}${c.following ? `, following ${c.following}` : ''}.`,
      `Goal: ${c.goal || 'none'}`,
      `Tasks: ${c.tasks?.length ? c.tasks.join(' > ') : 'none'}`,
      `Doing: ${c.doing || 'nothing'}`,
      `Inventory: ${Object.entries(c.inv || {}).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `${k} x${v}`).join(', ') || 'empty'}`,
    ]
    if (c.memory) lines.push(c.memory)
    const body = {
      messages: [
        { role: 'system', content: system(name) + '\n\n' + lines.join('\n') },
        ...turns,
        { role: 'user', content: `${user}: ${msg}` },
      ],
      max_tokens: 120, temperature: 0.4, top_k: 40, repeat_penalty: 1.1,
      chat_template_kwargs: { enable_thinking: false }, reasoning_format: 'none',
      response_format: { type: 'json_schema', json_schema: { name: 'reply', schema: SCHEMA } },
      cache_prompt: true,
    }
    const sl = typeof slot === 'function' ? slot() : slot
    if (sl != null) body.id_slot = sl
    const t0 = performance.now()
    const r = await fetch(llm + '/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    })
    if (!r.ok) throw new Error(`LLM HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
    const text = (await r.json()).choices[0].message.content.replace(/<think>[\s\S]*?<\/think>/, '').trim()
    const ms = Math.round(performance.now() - t0)
    let out
    try { out = JSON.parse(text) } catch { out = { intent: 'none', arg: '', say: text.slice(0, 220) } }
    if (!INTENTS.includes(out.intent)) out.intent = 'none'
    out.arg = String(out.arg || '').trim()
    out.say = String(out.say || '').trim()
    turns.push({ role: 'user', content: `${user}: ${msg}` }, { role: 'assistant', content: JSON.stringify(out) })
    while (turns.length > history * 2) turns.splice(0, 2)
    return { ...out, ms }
  }

  async function pump() {
    if (busy) return
    busy = true
    while (queue.length) {
      const { user, msg } = queue.shift()
      try {
        const out = await ask(user, msg)
        log({ user, msg, ...out })
        console.log(`[chat] ${out.ms}ms ${user}: ${msg} -> ${out.intent}${out.arg ? ' ' + out.arg : ''} | ${out.say}`)
        if (out.say) say(out.say)
        if (out.intent !== 'none') onIntent(out.intent, out.arg, user)
      } catch (e) {
        console.log('[chat] failed:', e.message)
        log({ user, msg, error: e.message })
      }
    }
    busy = false
  }

  return {
    handle(user, msg) {
      queue.push({ user, msg })
      while (queue.length > 3) queue.shift() // a flood of messages: keep the latest ones
      pump()
    },
    ask, // for tests
    turns,
  }
}

// Number of llama-server slots (1 when unknown): with >= 2, decisions use slot 0 and chat/summaries slot 1
// so the decider's prompt cache is never evicted by chat.
async function slotCount(llm) {
  try { return (await (await fetch(llm + '/props', { signal: AbortSignal.timeout(3000) })).json()).total_slots || 1 } catch { return 1 }
}

module.exports = { createChat, slotCount, INTENTS, system }
