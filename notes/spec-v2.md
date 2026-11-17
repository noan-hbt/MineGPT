# MineGPT v2 — H1 spec (draft 1, 2026-11-17)

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
The mind loop calls the model with `system` = harness manual (static) and `user` = situation sheet
(full or diff), and gets back **tagged lines**. Two call kinds:

### 1.1 Decision call (on events, or when nothing is running)
Output, one block, each tag at most once except `tool`/`act`:
```
think: <free text, short>
tool: <tool call>                 # 0..4, the harness answers inline, then the model continues
plan: <step> | <step> | ...       # optional, replaces the current plan
act: <dsl statement>              # required (or `act: wait 5s`)
expect: <outcome prediction>      # required with act
note: <long-term memory line>     # optional
say: <chat text>                  # optional
ask: <mind|strategist> <question> # optional, escalation
```
Tool loop (ReAct): when the model emits `tool:` lines and no `act:`, generation stops, the harness appends
`result: ...` lines and the model continues the same turn. Max 4 rounds, then `act` is forced.

### 1.2 Monitor call (while an action runs, as often as the GPU allows)
Input = sheet diff since the last call + running action progress. Output = exactly one line:
```
continue
adjust: <param>=<value> [...]       # e.g. adjust: radius=48 / until=hp<6
interrupt: <dsl statement>          # cancels the running action, starts this one (+ expect: on next line)
```
Optional `think:` before. Monitor outputs are ~1-15 tokens.

### 1.3 Expectation format
`expect: <cond>[, <cond>...] in <duration>` with conditions over the same predicates as `until`:
`expect: have(oak_log)>=+4, hp>=15 in 30s`. `+N` = delta from now. The harness checks it when the action ends
or the duration passes, and emits a `surprise` event listing each unmet condition with the actual value.

## 2. DSL
### 2.1 Syntax
```
stmt      := call [mods] | "seq[" stmt (";" stmt)* "]" | "if(" cond ")" stmt ["else" stmt]
           | "repeat(" int ")" stmt | "routine" NAME              # call a saved routine
call      := VERB arg*                       # positional first, then key=value
arg       := value | KEY "=" value
value     := NAME | INT | FLOAT | pos | place | entity | duration | list
pos       := "(" INT "," INT "," INT ")"     # absolute block coords
place     := "@" NAME                        # remembered place: @home @iron_vein_1 @spawn
entity    := "#" NAME [ "." INT ]            # #zombie, #player.Noan, nearest if no index
duration  := INT ("s"|"m")
list      := "[" value ("," value)* "]"
mods      := ("until(" cond ")" | "timeout=" duration | "max=" INT)*
cond      := pred (("&"|"|") pred)* ; pred := night | day | rain | hp<N | food<N | hostile<D | inv_full
           | have(ITEM)[op N] | near(TARGET,D) | light<N | y<N | y>N | idle
```
Item/block/entity names = minecraft-data 1.21 ids without `minecraft:`. Unknown names are a validation error.

### 2.2 Verb catalogue (v2.0 target; implementation is incremental, the catalogue is the contract)
Movement: `goto target [dist=]`, `follow entity [dist=]`, `flee from=entity|pos [dist=]`, `explore [dir=] [radius=] [prefer=unexplored|biome:X]`,
`descend [to_y=] [mode=stairs|shaft_safe]`, `ascend [to_y=]`, `pillar n`, `bridge dir n`, `swim_up`, `look target`, `wander`.
Gathering: `mine block [n=] [near=] [tool=]`, `chop [n=] [species=]`, `strip_mine dir [len=] [y=]`, `branch_mine [len=] [spacing=]`,
`dig area=(p1,p2)`, `collect [item] [radius=]`, `harvest crop [n=]`, `fish [n=]`, `shear entity`, `milk entity`.
Craft/process: `craft item [n=]`, `smelt input [n=] [fuel=]`, `cook food [n=]`, `blast input [n=]`, `smoke food [n=]`,
`enchant item [level=]`, `repair item`, `brew potion`, `stonecut input output [n=]`, `smith base addition template`.
Build: `place block at=pos|[pos,...]|front|below [face=]` (positions absolute or `~`-relative to the bot), `break at=pos|[pos,...]`.
**No predefined structures** (decided at H1 review): no build templates, no `light`/`door`/`bed` macros. The model
designs its builds block by block and may save its own as routines (`save_routine`).
Combat/safety: `attack entity`, `fight entity [until=]`, `shoot entity`, `shield [dur]`, `retreat [to=]`, `avoid entity [radius=]`,
`eat [food]`, `sleep`, `equip_best [slot=armor|weapon|tool]`, `set_spawn`, `water_bucket_save`, `extinguish`.
Inventory/storage: `equip item [slot=]`, `drop item [n=]`, `store [chest=] [filter=]`, `take item [n=] [chest=]`, `sort`,
`toss_junk`, `keep list`.
Farm/animals: `plant seed [area=]`, `bonemeal target`, `breed entity [n=]`, `lead entity`, `tame entity`, `feed entity item`.
Social: `say text`, `whisper player text`, `give player item [n=]`, `come_to player`, `obey`, `refuse reason`.
Meta: `wait dur`, `note text`, `forget key`, `name_place NAME [at=]`, `save_routine NAME stmt`, `stop`.

### 2.3 Tools (read-only, answered inline, cost no game time)
`recipe item`, `uses item`, `where target [n=]`, `scan [radius=] [filter=]`, `path_cost target`, `inv`, `chest NAME`,
`recall query`, `wiki query`, `mob_info entity`, `loot block`, `biome_info biome`, `simulate stmt` (feasibility only:
missing items, unreachable target, estimated duration).

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

## 4. Events (JSON, logged; rendered into EVENTS)
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
