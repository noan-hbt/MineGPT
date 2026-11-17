# MineGPT v2 — H1 spec (draft 2, 2026-11-17: turns + DSL frozen in spec/)

Plan and rationale: `notes/harness-v2.md` (rev 3). This file is the contract shared by the live bot (JS),
MineSim (Python), the dataset generators, the teachers and the trainers. Decisions taken:
- actions = **DSL lines** (not JSON tool calls), the models are trained on this exact syntax;
- teachers = GPT 6.1 sol (Codex), DeepSeek v4.1 flash (Command Code), Claude (Claude Code, user subscription);
- knowledge = minecraft-data + offline minecraft.wiki dump + other sources + teacher-generated data;
- clean restart: v1 is on branch `v1-archive` / tag `v1-final`.

## 0. Repository layout (v2)
```
bot/        live harness (node, mineflayer): perception, sheet renderer, ledger, map, DSL interpreter, skills, mind loop
sim/        MineSim (python): world, same DSL semantics, same sheet renderer (ported), scenario cards
kb/         knowledge base: sources/ (minecraft-data, wiki dump, ...), build scripts, index for wiki()
data/       datasets: v1/ (real logs, b19 synth), teacher/, literacy/, knowledge/, own/ (live + sim logs)
teach/      teacher drivers (codex, commandcode, claude), prompts, scenario cards, relabelling
train/      SFT / GRPO / continual loop
eval/       sim eval, live bench, knowledge eval, tool-call eval
spec/       JSON schemas + golden examples of this spec (tests for every component)
notes/      docs
archive/    v1 outputs (gitignored)
models/ llama.cpp/ mcserver/ .venv/ remote/   kept as-is (remote/ = remote access, never touch)
```
One shared `spec/` folder is the single source of truth: grammar (`dsl.lark`), sheet schema
(`sheet.schema.json`), event schema, golden examples. JS and Python both test against it.

## 1. Turn protocol
**Authoritative: `spec/turns.md` + golden cases `spec/golden/turns.jsonl`; reference parser `bot/dsl/turn.js`.**
The mind loop calls a model with `system` = harness manual (static) and `user` = situation sheet (full or diff), and
gets back tagged lines (`tag: content`, one per line). Three turn kinds:
- **decision** (hands, on events or idle): either a *tool round* (`think:`* + 1-4 `tool:`; the harness appends
  `result:` lines and the model continues the same turn) or a *final* turn: `think:`* `plan:`? `act:` `expect:`
  `note:`* `say:`? `ask:`? `goal:`?. `expect:` is required after `act:` except for verbs with no game outcome
  (wait, note, forget, name_place, save_routine, stop, say, whisper, obey, refuse).
- **monitor** (hands, while an action runs, 2-5/s): optional `think:` + exactly one of `continue`,
  `adjust: k=v ... [until(cond)]`, `interrupt: <stmt>` (+ `expect:`).
- **mind** (1.7B, every 5-10 s or on surprise/ask): `think:`* + any of `plan:`, `note:`*, `say:`, `goal:`,
  `answer:` (to the hands' `ask: mind`), `override: <stmt>` (+ `expect:`), `ask: strategist ...`; or `continue`.
- `goal: push <text> | replace <text> | done | fail <reason>`; `plan: step | step | ...` (free text steps).
- Expectation: `expect: <cond>, <cond> in <dur>`; `+N` / `~N` = relative to the start of the action.
  The harness emits a `surprise` event for each unmet condition.

## 2. DSL
**Authoritative: `spec/dsl.md` (grammar, values, AST, errors) + `spec/catalog.json` (verbs, tools, argument
types) + `spec/names.json` (valid ids: minecraft-data 1.21.11 + vanilla jar tags, `spec/tools/gen_names.py`).
Reference parser `bot/dsl/parse.js`, golden cases `spec/golden/dsl.jsonl` (`cd bot; npm test`), Python access via
`node bot/dsl/check.js` (JSONL in/out).**

Summary: `verb positional... key=value... [until(cond)]`, composed with `seq[a; b] [until()]`,
`if(cond) a else b`, `repeat(n) a`, `routine name`. Values: ids (`iron_ore`, `tag:logs`), `@place`,
`#entity[.id]` / `#player.Name`, ints, durations (`30s`), `"text"`, positions `(x,y,z)` with `~` relative coords,
boxes `((..),(..))`, lists `[..]`. Conditions: flags (night, sky, inv_full, ...) and comparisons on metrics
(hp, food, y, hostile, `have(item)`, `dist(target)`, ...) with `& | ! ( )`.

Changes vs draft 1 (H1 freeze): `near(T,D)` -> `dist(T)<D`; `tag:X` vanilla tags; positional params may also be
given as `name=value`; no build templates nor `light/door/bed/fill_hole` macros (model places blocks itself,
`place block at=posset`, `break at=posset`, `use [item] on=target` for doors/levers/buckets); `cook` dropped
(smelt/smoke/blast); `trade` added; `whisper/give/come_to` take `#player.Name`; `goal:` and `answer:` tags.

### 2.4 Results
Every action ends with one result event:
```
result: <ok|partial|failed|interrupted> <verb> <args> in <dur> | gained: oak_log x4, stick x0 | lost: - |
        cause: <machine cause> | detail: <human text>
```
Failure causes (closed set, extend in the spec only): `no_target_known`, `no_path`, `unreachable`, `timeout`,
`missing_items`, `missing_tool`, `tool_too_weak`, `inventory_full`, `interrupted_until`, `interrupted_by_model`,
`danger`, `died`, `invalid` (DSL/validation), `server_refused`.

## 3. Situation sheet
**Structured state (what is logged and rendered): `spec/state.schema.json`, example `spec/golden/state_example.json`,
validator `spec/tools/validate.py`. The text rendering (layout, per-section budgets) is defined by the H2 renderer.**
Plain text, sections in this fixed order, each with a `## NAME` header and a version stamp so the prefix
cache works. Stable first. Target 10-20k tokens full; sections have budgets and truncate oldest/farthest first.

| # | Section | Changes | Content |
|---|---|---|---|
| 1 | MANUAL | never | short reminder of formats (trained in) |
| 2 | MEMORY | on note | model notes, lessons, named places (`@name pos, what, seen T ago`), routines |
| 3 | MAP | every ~30 s | explored 16x16 columns: biome, top resources, structures, dangers, visited flag; unexplored frontier directions; path cost to named places |
| 4 | EPISODE | every ~2 min | model-written running summary, deaths + causes, goals done |
| 5 | GOALS | on change | goal stack (source: player/self/strategist), current plan with done/todo marks |
| 6 | LEDGER | on result | attempts aggregated: `verb args -> ok 3, failed 2 (no_path)`, last 30 results verbatim |
| 7 | BODY | per call | hp, food, sat, xp, armor, effects, held, tools + durability |
| 8 | INVENTORY | per call | grouped (tools, blocks, ores, food, misc), counts, free slots; known chests |
| 9 | AFFORDANCES | per call | craftable now; craftable after 1-2 steps + missing items; smeltable; edible; placeable |
| 10 | SURROUNDINGS | per call | time (ticks + "night in 2m10s"), light, weather, biome, pos, y, facing; local 3D slice (ascii, 9x9x5 around) ; blocks of interest within 32 (ore/water/lava/chest/drop-off: kind, pos, dist, dir, visible?); entities within 48 (kind, dist, dir, hostile, approaching, hp); players |
| 11 | EVENTS | per call | since last call: results, gains/losses, damage+source, chat, sounds, surprises, interrupts |
| 12 | NOW | per call | running action + progress, last expect, ms since last call |

Diff mode (monitor calls): sections 1-9 omitted when unchanged (`## BODY unchanged`), 10-12 always present.
Every logged call stores the full structured state (JSON) so datasets can be re-rendered later with a new
renderer version without replaying the game.

### 3.1 Sheet renderer r1 (H2, 2026-11-17) — `bot/render.js`, snapshot `spec/golden/sheet_example.txt`
- Header `## NAME [stamp]`, stamp = 4 hex of the section text. Diff mode: stable sections 1-9 whose stamp did not
  change become `## NAME [stamp] unchanged`; SURROUNDINGS / EVENTS / NOW always sent.
- KV-cache friendliness: stable sections use coarse ages (`<1m ago`, `5m ago`), MAP distances are measured from the
  bot's 16x16 cell and rounded, and the MAP state is re-exported every 30 s or on cell change (`Senses.mapState`).
- No omniscience: blocks of interest are kept only once seen in line of sight (raycast on the 4 nearest blocks of
  each cluster, then remembered for the session); liquids only at their boundary. Entities = what the server sends.
- MANUAL is generated from `catalog.json` (verb signatures by family + tools), ~1.05k tokens.
- Affordances come from `spec/recipes.json` (extracted from the 1.21.11 server jar by `spec/tools/gen_recipes.py`):
  craftable by hand / at a table with max count, 1-2 steps away with missing items (`tag:planks` when any variant
  works), smeltable -> outputs, edible, placeable, stations seen.
- Sound events disabled (mineflayer sound ids wrong for 1.21.11); `MINEGPT_SOUNDS=1` re-enables them.
- Measured on 279 live calls (`eval/sheet_tokens.py`, LFM2.5-350M tokenizer; LFM3 within 2%): full mean 5.2k,
  p95 5.9k, max 6.2k; diff-mode calls mean 1.4-1.9k. Biggest: MAP 1.5k, SURROUNDINGS 1.1k (p95 1.8k), MANUAL 1.05k,
  AFFORDANCES 0.86k. Memory/goals/episode were nearly empty in these runs: they will grow with a real model.

## 4. Events (JSON, logged; rendered into EVENTS) — schema `spec/events.schema.json`
`{t, kind, ...}` with kind in: `result, gain, loss, damage, death, respawn, chat, sound, entity_appear, entity_leave,
time (dusk/dawn), weather, surprise, interrupt, goal (set/done/failed), note, tool_answer, invalid_output`.

## 5. Mind loop (bot/mind.js)
- **Hands (350M)**: loop. If nothing runs or an interrupt-class event arrived -> decision call; else monitor
  call. Target 2-5 calls/s.
- **Mind (1.7B)**: every 5-10 s or on surprise/death/chat/`ask: mind`. Receives the full sheet, may output
  `plan:`, `note:`, `say:`, `goal:` and `override: <dsl>` (replaces the hands' action).
- **Strategist**: on `ask: strategist`. Async, its answer arrives as an event.
- Reflexes (code, sub-second, logged as events, never decide strategy): lava/fire step-back, drowning swim-up,
  hp<=4 eat/flee if a hostile is adjacent. The reflex list is fixed and short.
- Invalid output: 1 retry with an `invalid_output` event carrying the parser error, then `wait 2s`.

## 6. Logging (the dataset source)
One JSONL per session in `data/own/<date>/`: per call `{call_id, kind, model, state (structured), sheet_version,
prompt_hash, output, parsed, latency_ms, tokens}`, plus events and results. Enough to (re)build: SFT samples,
prediction samples (state, act -> next events), hindsight goals, DAgger queries.

## 7. H1 review decisions (user, 2026-11-17)
- DSL lines for BOTH models (350M and 1.7B), no JSON tool calls.
- Token budgets per section: measured on real renders during H2.
- No predefined build templates (see 2.2): test whether the model copes without.
- Place names chosen by the model, `@[a-z0-9_]+`.
- Reference baselines kept: `models/LFM2.5-350M-wedit*` (v1 weight-writing experiments) and the untouched base
  models, to measure how much v2 fine-tuning improves on them.
