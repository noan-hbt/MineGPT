# GOAP planner + BT executor, LLM as translator & arbiter (session #21, 2026-11-18)

User idea: GOAP / Behavior Tree with the LLM as "traducteur & arbitre". Decision taken: **default execution**: the
executor runs the plan, and the LLM steps in on a new plan, a failure or surprise, danger, or a chat order.

## Layers
| Layer | Role | Code |
|---|---|---|
| LLM translator | chat -> goal predicates (`goal: push ...`, `have(X)>=N`) | mind.js (prompt example) |
| GOAP planner | `tool: plan <goal>` -> 1-3 step lists with durations (facts, not advice) | `bot/plan/goap.js` |
| LLM arbiter | picks a plan (`act: achieve <goal> via=N`), edits it (raw verbs), or refuses | model |
| BT executor | `achieve`: plan -> run first step -> replan; a failure comes back as a normal result | `bot/plan/live.js` |
| Reflexes | flee / eat / air | unchanged |

## Planner (pure, ~1 ms per plan)
- Backward chaining with a simulated inventory + reservations (an ingredient obtained for a craft is not eaten by
  the next sub-goal). Options per item: crafting recipes, smelting recipes, natural blocks that drop it
  (minecraft-data drops; placed forms such as wall_torch, potted_*, tripwire are excluded; a crafted block is never a
  source). Harvest tool = sub-goal (cheapest tool). 3x3 craft / smelt = station sub-goal (`place crafting_table`,
  `place furnace`) unless one is known within 32 blocks. Smelting fuel comes from carried fuels first, otherwise from
  the cheapest of coal and planks.
- Costs: world-free unit costs (fixed point over all recipes), plus live costs (initial inventory = free, a known
  block = its distance, an unseen block = explore 45 s). Options are tried cheapest first, with backtracking.
- An unseen source gives `explore prefer=<block>` followed by `mine <block> n=`. Plans are compacted (later mines of
  the same block are folded into the first one, adjacent crafts are merged).
- Alternatives: change the choice at one of the early choice points; the `force` map keeps that choice across
  replans. Only alternatives costing at most 2x the cheapest + 20 s are kept.
- Limits: `have` goals only (no `|`, `!`, or other metrics). Mob drops, loot, trades and crops are not planned
  (the plan says so). Durability is not tracked; neither are probabilistic drops.

## Executor (`achieve <goal> [via=N]`, timeout 3600 s)
Replans after every step. Stops when:
- the goal holds -> ok;
- the same step fails twice, or the inventory is full -> failed, with the rest of the plan in the detail;
- the first step repeats with an unchanged inventory -> stuck (explore gets 3 tries);
- it reaches 60 steps.

A chat order interrupts the running action, as for any other verb.

## Bench
`node sim/run_cards.js --sim 1 --lock --policy achieve --only <ids>` runs one `achieve` per have-card, with no
model.
- 2026-11-18, all 27 have-cards: first run 23/27. After fixes, seeds 1+2: **54/54 in 277 s**
  (`eval/results/goap_achieve_s12.txt`).
- Fixes made along the way:
  - one block scan per plan: a findBlocks per kind blocked the event loop 10 s and the server dropped the bot;
  - blast and smoke recipes;
  - random drops (flint from gravel, mined with until(have));
  - `collect` of items lying on the ground;
  - free spot for `place` (never on top of a crafting table);
  - station cost measured by a trial sub-plan (the smoker had eaten the logs needed for planks).
- Next: mind bench, LFM3 / Bonsai with and without plan/achieve (`eval/bench_mind.ps1`).
