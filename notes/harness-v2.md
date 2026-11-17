# Harness v2 — proposal rev 3 (2026-11-17, session 6)

User feedback:
- rev 1: good direction, lacks nuance and innovation.
- rev 2: OK, with these changes:
  - make the situation sheet much bigger (2-4k tokens is too small);
  - use a HUGE action space and many more inputs;
  - build very large datasets distilled from big teachers (GPT, DeepSeek, Claude...);
  - specialise the students: 350M = excellent fast multi-turn tool caller, 1.7B = knowledge, reasoning, understanding;
  - greatly widen the Minecraft knowledge base.

Other points from the user that carry over:
- the local LLM is free and fast -> do NOT ration calls, call it very often (short outputs);
- v1 context was far too thin: the model groped around, discovering the world one action at a time -> repetitions;
- it must know what a real player knows: where it is, what is happening, what happened before, what is around,
  what it can do, what it already did. What it *should* do stays its own judgement;
- train the models to USE OUR HARNESS and to play Minecraft, with continual learning on in-game logs.

## 1. Principle
Code = senses, muscles, spinal reflexes, memory storage. Model = every decision, at high frequency.
No "Recommended action". The code gives facts and affordances (what is possible), never advice.

## 2. What the model sees: a large situation sheet, ordered stable -> volatile
Budget **~10-20k tokens** (LFM2.5 / LFM3 context 32k). The size is affordable because:
- the stable prefix stays in the llama.cpp KV cache;
- most calls only re-encode the volatile tail;
- monitor calls get a diff since the previous call, not a full re-render;
- a full re-render happens on decision calls or when the prefix changes.

Sections:
1. **Harness manual** (static): turn formats, tool list, DSL. Short because it is trained in.
2. **Long-term memory**: model-written notes and lessons, home, known places with coords and when last seen,
   saved routines.
3. **Mental map**: explored regions on a coarse grid (biome, resources, structures, dangers, visited/unvisited),
   path costs to known places, a local 3D slice around the bot (ascii layers or a block list).
   Built by code from what the bot actually saw — no omniscience.
4. **Episode summary**: what happened so far this session (compressed by the model itself every N minutes),
   plus deaths and their causes.
5. **Goal stack + plan** (model-owned), with progress marks.
6. **Attempt ledger** (anti-repetition): action, target, duration, outcome, count, aggregated
   (`mine iron_ore @(-40,12,88): FAILED x3 no path (water)`).
7. **Body + inventory**:
   - hp, food, saturation, xp, armor, effects;
   - tools with durability, full inventory, chests known and their contents.
8. **Affordances**:
   - craftable now, craftable after one or two steps (with the missing items);
   - smeltable, placeable, edible;
   - reachable resources within N blocks with path cost.
9. **Surroundings**:
   - time, light, weather, biome, y level;
   - entities with distance, direction, hostility, heading, and whether they are moving toward the bot;
   - blocks of interest in view (ores, water, lava, drop-offs, structures);
   - block under the cursor, sounds, nearby players.
10. **Event stream since the last call**: items gained or lost, damage and its source, action progress,
    interruptions, chat, and **surprises** (expected outcome vs actual outcome).

## 3. Call frequency: a continuous mind
- **350M** loops as fast as the GPU allows (target 2-5 calls/s), using two kinds of call:
  - **Monitor calls** (`continue` / `adjust` / `interrupt -> act`): few tokens, supervise the running action.
  - **Decision calls** on events: a full turn of `think / plan / act / expect / note / say / ask`.
- **Every act carries `expect:`.** The code compares the expectation with what actually happened and sends any
  gap back as a surprise event. That is how the model notices it is stuck, with no hardcoded watchdog.
- **1.7B** runs in parallel at a slower rhythm (every 5-10 s or on a surprise) as the deliberate mind:
  - rewrites the plan and notes;
  - answers the 350M's knowledge questions;
  - can override the 350M.
- **Strategist API**: only on `ask:`.

## 4. Huge action space and tool set
The DSL covers most of what a player does, typed and parameterised. Every action takes params plus
`until(...)` / `timeout`, and actions compose with `seq` / `if` / `repeat`.

| Family | Actions |
|---|---|
| Movement | goto (pos, place, entity), follow, flee, explore (direction, radius, unexplored), swim, pillar, bridge, descend (staircase), climb, sprint, sneak, jump |
| Gathering | mine (block, n, near, tool), strip-mine pattern, branch-mine, chop tree (whole), dig area, collect drops, fish, shear, milk, harvest crop |
| Crafting / processing | craft (item, n), smelt (input, fuel, n), smoke, blast, brew, enchant, anvil repair, grindstone, stonecutter, smithing |
| Building | place / break (block, positions, face); no predefined structures (H1 review): the model designs builds itself, saves its own routines |
| Combat / safety | attack (target), shield block, bow shoot, retreat, eat, heal, equip best armor, sleep, set spawn, avoid (entity, radius), extinguish, MLG water |
| Inventory | equip, drop, store (chest, filter), take, sort, toss junk, keep list |
| Farming / animals | plant, bonemeal, breed, lead, tame, feed |
| Social | say, whisper, give item to player, follow player, obey / refuse an order |
| Meta | note, recall, plan, save routine, call routine, ask (1.7B / strategist), wait, look around |

The model can ask questions (tools) before acting:

| Tool | Use |
|---|---|
| `recipe` / `uses(item)` | how to make something, what an item is for |
| `where(block)` | known locations |
| `scan(radius, filter)` | look around |
| `path_cost(target)` | how far / hard a route is |
| `inv` / `chest(name)` | inventory and chest contents |
| `recall(query)` | memory |
| `wiki(query)` | knowledge-base RAG |
| `simulate(seq)` | dry-run feasibility check |
| `mob_info(entity)` | mob behaviour |
| `loot(block)` | drops |
| `biome_info(biome)` | biome facts |

Inputs widened accordingly:
- what the bot sees, block entities, item frames and signs, villager trades;
- the advancement and statistics state;
- light levels, mob spawn risk.

## 5. Model roles: distil big teachers into two specialists
Teachers: GPT 6.1 sol (Codex), DeepSeek v4.1 flash (Command Code), Claude.
- Mixing teachers gives diversity; agreement between teachers is a confidence label.
- Disagreement marks the hard cases to keep.

| Student | Speciality | Trained on |
|---|---|---|
| **LFM2.5-350M "hands"** | fast, reliable multi-turn tool calling over the harness: read the sheet, monitor calls, valid DSL with correct params, reacting to events, no repetition | massive teacher transcripts (decision + monitor turns), harness-literacy synthetic data, own logs (prediction, hindsight) |
| **LFM3-1.7B "mind"** | knowledge, reasoning, understanding: plans, diagnosis of failures, explaining, chat with the player, answering the 350M's questions | large knowledge corpus (QA and explanations), teacher plans and critiques, long-horizon summaries |

This split is a hypothesis to test, not a given. Ablations:
- 350M alone vs 350M + 1.7B;
- 1.7B doing everything (slower).

## 6. Minecraft knowledge base (much wider)
- **Structured, exact**: minecraft-data 1.21, all of it:
  - items, blocks (hardness, tool, drops), recipes, entities, foods;
  - biomes, enchantments, effects, loot tables, mining and tool tiers.
- **Mechanics**:
  - ore distribution by y, mob spawning rules, day/night, hunger and saturation, combat damage;
  - redstone basics, villager trading, nether and end progression, structures.
  - Sources: an offline wiki dump (minecraft.wiki — check its size and licence before downloading) plus teacher-written
    explanations.
- **Strategy / progression**: speedrun and survival guides written by the teachers, then cross-checked by a second
  teacher and by minecraft-data facts.
- Turned into:
  - a. a RAG index for `wiki()`;
  - b. QA, explanation and situational reasoning datasets (tens of thousands of samples) for the 1.7B;
  - c. short "fact cards" for the 350M (recipes, tool tiers).
- Validation: every generated fact that can be checked against minecraft-data is checked. Wrong ones are dropped and
  the teacher that produced them gets a lower weight.

## 7. Training data: scale + continual learning
| Data | Source | Volume target |
|---|---|---|
| Harness literacy | auto-generated from sim states | 50k+ turns |
| Knowledge | KB -> QA, explanations, situations | 50k+ |
| Teacher play | 3 teachers play MineSim and live with the full sheet, many scenario cards (1-50 steps, orders, chat, emergencies, nether...) | 5-20k episodes |
| Own play | every live and sim session | continuous |

Turning own logs into training signal without a teacher:
- **Prediction / world-model loss**: (sheet, act) -> what actually happened.
- **Hindsight relabelling**: any segment that achieved something becomes a successful demonstration of that goal.
- **Teacher fixes only on surprises and failures** (DAgger).
- **GRPO in MineSim** with outcome reward.

Continual loop:
1. play (live + sim);
2. build datasets;
3. LoRA update;
4. regression gate on a frozen eval suite;
5. deploy if better, otherwise discard.

Guards against drift:
- a replay buffer of old data;
- own decisions count as "good" only when the outcome or a teacher verifies them;
- held-out scenario cards are never trained on.

## 8. MineSim = the real engine, accelerated (decided 2026-11-17)
User requirement: the sim must replicate the real game engine very faithfully, otherwise training is biased.

**Decision: do not reimplement Minecraft.** Rewriting the engine faithfully (worldgen, mob AI, physics,
fluids...) is out of reach. Instead, MineSim = the vanilla server (fidelity by construction) driven fast:
- `/tick sprint` / `/tick rate`: the server runs ticks as fast as the CPU allows.
- The bot runs in **lockstep** with server ticks: patch the mineflayer physics loop to step once per received
  server tick instead of on a 50 ms wall-clock timer, so the bot speeds up with the world.
  To be verified: whether mineflayer and the pathfinder stay correct when sped up.
- Several small headless instances (view-distance 4, flat worlds or prepared seeds), as many as the 16 GB of
  RAM allows next to the LLM.
- **Scenario cards** = world template + `/setblock` / `/give` / `/summon` / `/time` setup scripts through RCON.
- **Branching for counterfactuals / RL**: snapshot the world (region files or structure saves + player
  state), restore it, try N alternatives.
- **Fidelity guard**: the same cards run at x1 and at sprint speed must give the same outcome distributions.
- **Reproducibility**: fixed seeds and gamerules. Residual mob-AI randomness is handled by running several
  seeds per card.

Only if the throughput measured at H4 is far too low for RL: an abstract fast sim for pre-training only.
It would be calibrated on real-engine logs (durations, failure rates) and never used for evaluation.

## 9. Evaluation (outcomes)
- Held-out scenario cards in sim, plus the live `eval.js` bench.
- Metrics:
  - success %, time, deaths;
  - repeated failed attempts;
  - prediction accuracy, invalid DSL;
  - escalations.
- Separate knowledge eval for the 1.7B: held-out QA checked against minecraft-data.
- Separate tool-call eval for the 350M: validity and param accuracy.

## 10. Phases
| # | What | Done when |
|---|---|---|
| H1 | spec: sheet schema, turn formats, full DSL and tool list, events, ledger | doc + JSON schema + examples |
| H2 | big sheet renderer + ledger + mental map + more inputs in `mcbot`, logged live (v1 decider kept) | live logs with full sheet |
| H3 | DSL interpreter (JS) covering the action families, with rich results | scripted live runs pass |
| H4 | MineSim sharing renderer and DSL | scripted sim runs pass |
| H5 | knowledge base: minecraft-data + wiki + teacher guides -> RAG + QA sets | KB built, facts validated |
| H6 | teacher datasets at scale (3 teachers, sim + live) | 5k+ episodes, validity > 95% |
| H7 | 350M SFT (hands) + 1.7B SFT (mind), sim eval, ablations | first outcome numbers |
| H8 | continual loop (prediction, hindsight, DAgger) + GRPO + regression gate | improves across iterations |
| H9 | live deployment of the two-model stack | live success vs v1 |

## Open questions
- DSL lines vs LFM3 native JSON tool calls (could differ per model).
- Wiki dump: size, licence, offline copy.
- Running Claude as a teacher: which access (subscription via Claude Code, or API).
