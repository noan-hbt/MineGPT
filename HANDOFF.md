# Handoff: local LFM3 setup + Minecraft bot (state 2026-11-17)

## Goal
Run a LiquidAI LFM model locally, as fast as possible (target 100-200 tps single stream), then use it as a
**game-playing agent**. Next step: plug it into **Minecraft** (probably via Mineflayer).

## Hardware
- RTX 4070 Laptop, 8 GB VRAM, driver 610.60 (CUDA 13.x OK)
- i9-13900HX: logical CPUs 0-15 = 8 P-cores (hyperthreaded), 16-31 = E-cores
- 16 GB RAM, Windows 11, power plan already "Haute performance"
- Hugging Face downloads are slow/unstable (0.1-3 MB/s): avoid big downloads

## What's installed (all in `C:\Users\noanh\Desktop\Dev\localai`)
| Path | What |
|---|---|
| `llama.cpp\` | llama.cpp b12445, Windows CUDA 13.5 build (+ cudart DLLs) |
| `models\LFM3-1.7B-QAD-Q4_0.gguf` | LFM3-1.7B, quantization-aware Q4_0 (1 GB). Prod model |
| `models\LFM3-1.7B-hf\` | Same model, HF bf16 safetensors (3.4 GB) for training/eval |
| `b21\` | Closed B21 bench (weight editing). `b21\.venv` = torch 2.13 cu130 + transformers 5.12.1 + peft, works on the GPU. `lfm3_compat.py` = shim needed to load LFM3 in HF |
| `start-game.ps1` | **Single-agent low-latency server (use this for Minecraft)**, port 8080 |
| `game_latency.py` | Simulated Minecraft-like loop; reference client for game requests |
| `start-lfm3.ps1` | General server, N parallel slots (`-Slots`, `-CtxPerSlot`, `-Reasoning`) |
| `swarm_server.py` | Launcher + load-balancer proxy + live dashboard (`:8080/dash`) |
| `dashboard.html` | Dashboard page served by `swarm_server.py` |
| `swarm.py` | Multi-agent swarm stress test (planner → workers → reviewers → synthesizer) |
| `bench_agents.py` | Simple N-concurrent-requests benchmark |
| `start-mc.ps1`, `mcserver\` | Local Minecraft 1.21.11 server (see Minecraft section) |
| `run-bot.ps1`, `mcbot\` | Minecraft LLM bot (`mcbot\bot.js`) + auto-restart wrapper |

LM Studio is installed but the user does **not** want to use it.

## Why LFM3-1.7B
Beats LFM2.5-2.6B everywhere and rivals Qwen3.5-9B on agent/tool-use benchmarks (BFCL V4 71.4).
Card says: not for agentic coding / complex multi-step reasoning. It's a thinking model (`<think>`),
recommended sampling `temperature=0.1, top_k=50, repetition_penalty=1.1`. No DSpark draft model exists for LFM3.

## Measured performance
- Raw decode (llama-bench): ~167 tps empty ctx, ~141 tps @16k ctx. Prompt processing ~10k tok/s.
- Server single stream: ~140 tps.
- Parallel (one server): 8 agents ≈ 350-640 tok/s total; 16+ agents → <30 tps each. Measurements are noisy.
- **Game loop (what matters): ~155-165 ms per decision ≈ 6 actions/s**, 50/50 valid actions, with:
  thinking off, temp 0 / top_k 1, grammar-forced output `action arg` (~10 tokens), stateless prompt
  (`--compact --history 0`). JSON with a "why" field + history = 370 ms.

## Tuning findings (llama.cpp b12445 on this machine)
- `--backend-sampling` (GPU sampling): +60% in parallel. Keep.
- `--no-kv-unified`: +15% single stream.
- Pin to P-cores + high priority: `-t 8 -C 0xFFFF --cpu-strict 1 --prio 2` → much more stable.
- `--samplers 'penalties;top_k;temperature'`: small gain.
- `--spec-type ngram-mod`: ~+5% for repetitive outputs. `ngram-cache` is slower.
- No gain: KV cache quantization (q8_0), `-ub` > 1024, thread/poll tweaks.
- `--mlock` does not exist in this build (error).
- **Multiple llama-server instances on the one GPU = failure** (VRAM 7.7/8 GB, GPU 100%, ~0 tok/s). Stay on 1 instance.
- Output tokens dominate latency (~7 ms/token). Keep actions tiny; keep the prompt prefix stable so the prompt cache hits.

## How to call it from a game bot
`POST http://127.0.0.1:8080/v1/chat/completions` (start with `.\start-game.ps1`), body like:
```json
{
  "messages": [{"role": "system", "content": "<fixed rules + action list>"},
               {"role": "user", "content": "<current game state, incl. goal + last actions>"}],
  "max_tokens": 30, "temperature": 0, "top_k": 1, "repeat_penalty": 1.0,
  "chat_template_kwargs": {"enable_thinking": false},
  "grammar": "root ::= (\"move\" | \"jump\" | \"mine\" | ...) \" \" [a-z0-9_,-]{1,24}",
  "cache_prompt": true
}
```
Strip a leading empty `<think></think>` from the content if present. Full working example: `game_latency.py`.

## Caveats / open points
- `start-game.ps1` uses `--reasoning off` server-side; tests disabled thinking per request. The script works (verified 2026-11-17).
- Stateless = no memory: the bot must put goal/recent actions into the state text.
- Decision quality is not evaluated (the simulated test mostly chose `mine`).
- p95 latency ~280 ms (spikes).
- Faster option if needed: a smaller model (LFM2.5-350M, ~2x faster, much dumber; different vocab → can't be a draft for LFM3).

## Minecraft bot (working, playable with the user)

### How to run (3 terminals / background)
1. `.\start-game.ps1` -> LFM3 llama-server on :8080 (verified working).
2. `.\start-mc.ps1` -> vanilla **1.21.11** server in `mcserver\` (offline-mode, spawn-protection 0, EULA accepted,
   uses the launcher's bundled Java 21: `%LOCALAPPDATA%\Packages\Microsoft.4297127D64EC6_8wekyb3d8bbwe\LocalCache\Local\runtime\java-runtime-delta\...`;
   system Java is 8). User **ZeiK_0 is op** (`mcserver\ops.json`, offline UUID). RCON enabled on :25575
   (password in `server.properties`), not used by code yet. User set difficulty to Peaceful in-game.
3. `.\run-bot.ps1 [-Goal "..."]` -> runs `mcbot\bot.js` in a restart loop (node `--max-old-space-size=2048`).
   Kill the node process to reload code: the wrapper restarts it in 5 s.
- User joins with the **vanilla 1.21.11** profile (not Forge/OptiFine), Multiplayer > `localhost`. `/tp LFM ZeiK_0`.

### bot.js design
- Node 22, mineflayer 4.39 + mineflayer-pathfinder + mineflayer-collectblock. Bot name `LFM`.
- Loop (B5): reflexes (code) > current task (repeats without LLM) > LLM picks ONE skill+arg (`skills.js`).
  Verbs: collect/goto/mine/craft/place/smelt/attack/flee/eat/shelter/sleep/farm/store/home/explore/come/wait.
- **Per-tick dynamic grammar**: only currently valid options (visible blocks minable with current pickaxe tier,
  craftable items, present mobs, food) -> 100% valid actions. Banned actions (control.js) are removed.
- Observation = goal, time, hp/food, nearby blocks, mobs, inventory, craftables, last 4 actions+results,
  then LAST line `Recommended action:` computed by code (`next` in observe()):
  danger reflex (hostile <=6 m: attack if hp>8 and not creeper, else flee) > eat if food<14 >
  tool progression (table -> sticks -> planks -> wooden_pickaxe -> 3 cobble -> stone_pickaxe) > "pursue the goal".
- Chat commands (no slash): `goal <text>`, `go` (autonomous), `stop`, `follow` (follows player + fights hostiles
  within 6 m, no LLM), `come`, `where`, `help`.
- Debug: last observation + grammar written to `mcbot\last_obs.txt` every tick.

### Results
- LLM ~100-180 ms/decision; actions take 1-15 s, so the LLM is not the bottleneck.
- Autonomously got logs -> planks -> table -> sticks -> wooden pickaxe -> stone -> stone pickaxe.

### Lessons (LFM3-1.7B + mineflayer)
- The 1.7B ignores hints placed mid-prompt and copies "Recent actions" (loops 30x on same action). Hint as the
  **LAST line** "Recommended action: ..." fixes it (A/B tested with a scratch script). Free-text goal has little effect.
- `bot.pathfinder.stop()` when nothing is pathing leaves a pending stop that cancels the NEXT goto
  ("Path was stopped before it could be completed", 0.0 s). Use `bot.pathfinder.setGoal(null)` instead.
- On death, an in-flight pathfinder/collectBlock blew the JS heap (OOM, exit 134). Now: on 'death' cancel
  collectBlock + setGoal(null) and the loop waits for respawn.
- Wooden pickaxe breaks after 59 blocks; pathfinder often "Took to long to decide path" on acacia trees
  (thinkTimeout raised to 10 s).

### Not tested / open
- `follow` mode and the danger reflex with the real player (bot died to a zombie before the fixes; then Peaceful).
- (fixed since: iron and diamond pickaxes reached autonomously, see B5 below.)
- Bot does not talk (no LLM chat replies). Ideas: LLM chat replies, commands like "mine iron" / "build shelter",
  use RCON for scripted tests.

## State 2026-11-17 session #16 (RESUME HERE) — lockstep player freeze (Fabric mod)
Branch `v2`. Don't commit `eval/results/`.

### Done
- **Sim instances run Fabric** (loader 0.20.1, MC 1.21.11) + mod `bot/sim/mod/` (`minesim-freeze.jar`). Two
  mixins, active only while `TickRateManager.runsNormally()` is false (frozen, no `tick step` tick running):
  `ServerGamePacketListenerImpl.tickPlayer()` returns false without running (= `ServerPlayer.doTick`: air, regen,
  hunger, sleep, effects, fire + floating-kick counters), `ServerPlayer.tick()` cancelled (entity loop: vanilla
  `isEntityFrozen` never freezes players). Unfrozen (x1) = vanilla behaviour.
- Built WITHOUT Gradle/Loom: sources use Fabric intermediary names, compiled by `java -m jdk.compiler/...` (the
  bundled Minecraft runtime has jdk.compiler/jdk.jartool) against `.fabric/remappedJars/.../server-intermediary.jar`.
  `sim/mod/build.js` `ensure(dir)`: Fabric launcher (cached in `mcserver-sim/fabric-cache/`, downloaded from
  meta.fabricmc.net if missing), first remap via `--initSettings`, rebuild if sources newer, copy to `<inst>/mods/`.
  Called by `instance.js start()` (launches `fabric-server-launch.jar`). New instances get it automatically.
- `node sim/mod/map.js <MojangClass> [method]`: Mojang -> obf -> intermediary names (needs `server_mappings.txt` +
  `mappings/mappings.tiny` in `mcserver-sim/fabric-cache/`, both there now) for future mixins.
- `node sim/freeze_check.js [--x1]`: fidelity probe. x1 and lockstep identical now: Air -1.00/tick (300 -> 0 in 300
  ticks), night skipped after 99-100 ticks in bed (before the mod: Air 259 -> 0 in 10 ticks, sleep 58).
- Validation lockstep: cards 21 x seeds 1-5 **105/105** (survive.drowning 5/5, was 0/5), 23415 ticks in 108 s
  (216 tps; was 19832 ticks: episodes take more game ticks now, expected); live suite **64/64** (32.5 s, 131 tps).

### Open (carried)
- craft.planks#4 lockstep flake, ledger noise across seeds, some lockstep episodes waiting on real time (see #15).
- Other per-loop server work not tied to the player tick is not audited (e.g. anything in the connection tick:
  keepalive still runs per loop, harmless). Fidelity guard below will show remaining gaps.

### Next
1. Fidelity guard: all cards x1 vs lockstep (outcome, ticks, damage distributions); `freeze_check.js` style
   probes for regen/hunger. 2. More cards. 3. Mind loop = policy `mind`.

## State 2026-11-17 session #15 — 21 cards, lockstep player-tick finding
Branch `v2`. Don't commit `eval/results/`.

### Validation
- 21 cards x seeds 1-5 lockstep: 100/105. survive.drowning 0/5 in lockstep (expected, see below), 5/5 at x1
  (seeds 1-2 checked after the last fix, 3-5 before). craft.planks#4 1 flaky (below). Live suite lockstep: 64/64.
- Rerun: `node sim/run_cards.js --sim 0 --lock --seeds 1,2,3,4,5` and `node test/live.js --lock --sim 0` from bot/.
  x1: drop `--lock`. If the server is left frozen: rcon `tick unfreeze` + `tick rate 20` (or `node sim/instance.js stop 0`).

### Done (session #15)
- 6 cards: survive.drowning (dry pit flooded at tick 0), survive.sleep_night, survive.hunger_hunt (kill cow, eat raw
  beef), combat.zombie_group (3 zombies), heldout: survive.descend_cliff, craft.cook_beef (table+furnace+smelt).
- eat_hungry card bug: food 5 + 2 baked potatoes < 17 -> food param 7-12.
- Bot bugs fixed: fight/attack picked a mob in its death animation (still in bot.entities ~1 s) -> C.nearest skips
  entities after entityDead. `go()` from a water surface: pathfinder finds no path -> swimOut (to the nearest dry
  standing spot, jump+forward re-asserted each 100 ms) then plan again once. `sleep` now waits until woken (night
  skipped, up to 10 s) instead of returning in bed (any next statement woke it before the night passed). `eat` waits
  for the slot update (consume() resolves before it: bot model had 1 food item too many).
- Runner: death/damage scoreboards reset right before tick 0 (plan.scores), not in reset (falling into a pit dug
  under the bot's previous position counted as episode damage).
- notes/scenario-cards.md: success_when, setup order, "pitfalls" section.

### KEY FINDING: lockstep does not freeze the player
`tick freeze` + `tick rate 10000` (sim/lockstep.js): vanilla never freezes players, so the bot's ServerPlayer ticks
every server loop, many times per game tick. Measured: Air 259 -> 0 in 10 game ticks during setup; drowning in ~43
ticks; sleep skipped the night in 58 ticks (x1 needs 100+). Also affects natural regen, hunger/saturation, effect
durations, fire, item use timers -> lockstep is optimistic for every "keep N hp" card (creeper, zombie...).
Options: (a) `tick rate` near the achieved step rate (approximate), (b) server mod/plugin freezing players
(Fabric/Paper), (c) mark such cards x1-only. **User decided: (b)**, to be done in a new session (session #16).
Why keep lockstep: ~x8 faster than x1 (105 episodes = 19832 ticks in 127 s at 156 tps vs >= 16.5 min at x1; live
suite 33 s vs >= 3.5 min), and the world pauses while the LLM thinks, so mind-loop results don't depend on GPU latency.

### Open
- craft.planks#4 (acacia n=13) once in lockstep: bot model 16 planks, server 4 (3 of 4 crafts lost server-side,
  clicks too fast?). Not reproduced in 9 reruns.
- Ledger noise: a `sleep` step logged gained/lost bed from the previous seed.
- Lockstep episodes sometimes ~10 s real for ~350 ticks: something waits on real time.
- Reserved, not implemented: actors (owner NPC), seed-world templates, mind.chests/map, snapshot/restore.

### Next
1. **Session #16: freeze the player in lockstep (option b).** Check first what the sim server runs
   (sim/instance.js: vanilla jar?), then the cheapest exact route: a small Fabric mod (mixin skipping
   ServerPlayer tick / ServerGamePacketListenerImpl player tick while the tick manager is frozen and not stepping),
   or Paper if it exposes this. Keep client movement packets handled (the bot moves during stepped ticks only).
   Verify with the measurements above: Air must drop 1 per stepped tick, sleep must take 100 ticks, then
   survive.drowning must pass in lockstep and the full suite must stay green. 2. Fidelity guard (all cards x1 vs lockstep, outcome + ticks +
   damage distributions). 3. More cards (shelter, fall, mob mixes, longer chains). 4. Mind loop = policy `mind`.

## State 2026-11-17 session #14 — 15 cards, lava/health/RNG fixes
Branch `v2`. Commit `8f7158f`.

### Done
- `success_when: "end"` (card key): success judged only at the time limit (survival cards); runner waits for it.
- 6 cards: survive.creeper (pillar 4 + shoot, 5/5), survive.descend_pillar, survive.lava_moat (4/4 after fix),
  craft.stone_pickaxe (multi-stage, 7 steps), nav.order_change (timeline chat redirect), craft.torches (`heldout`).
- Bot bug found by lava_moat: mineflayer-pathfinder plans a sprint parkour jump over a 3-wide lava moat and the bot
  misses ("LFM tried to swim in lava"). `C.makeMovements(bot)` (skills/common.js) = the one Movements config
  (canDig, 1x1 towers) + no parkour when lava is under the jump; used by harness.js, live.js, run_cards.js.
- Runner bug: health persisted across episodes AND runs (creeper/zombie failures at 9.67 HP were leftovers) ->
  reset gives instant_health. The earlier "zombie#2 died after 2 HP" was probably this too.
- RNG: weak string hash gave correlated draws across seeds 1,2,3 (creeper dz always < 0) -> sha256 seed + mulberry32.
- Sword-fight / flee+bow creeper solutions failed, but under the health bug: retest if a card needs them.

## State 2026-11-17 session #13 — scenario cards v1, craft/see/pickup fixes
Branch `v2`. **NOT committed** (everything since `8cd9b21`, incl. session #12 files + `bot/sim/cards.js`,
`bot/sim/run_cards.js`, `bot/sim/cards/**`, `notes/scenario-cards.md`, skills/common.js, state/perceive.js).
Don't commit `eval/results/`. Validation done: live suite lockstep **64/64**, x1 63/64 (`plant` flake: server
refused wheat_seeds), cards 22/23 then zombie 6/6.

### Done
- **Craft**: `settle()` in craft.js retries (resync + empty grid/cursor, up to 4x) instead of one pass; debug removed.
- **Scenario cards** (spec `notes/scenario-cards.md`): JSON cards in `bot/sim/cards/<area>/`, loader/validator/
  seeded expansion/RCON compile/server-side judge in `bot/sim/cards.js` (`node sim/cards.js` validates all cards
  for all seeds incl. DSL parse), runner `node sim/run_cards.js --sim 0 [--lock] [--only id|prefix] [--seeds 1,2]`
  (policy `script` = reference solution; `mind` = H5). Episode record: outcome, ticks, milestones, died,
  death_msgs, damage, judge values; `card_step` records carry `desync` (bot inventory vs server count).
  9 cards: craft.planks / wooden_pickaxe / smelt_iron, mine.iron_ore, gather.chop_tree, survive.eat_hungry,
  combat.zombie, logistics.fetch_from_chest, nav.goto_place. All pass with script policy (~15 s lockstep).
- Bot bugs the cards found (fixed):
  - `C.canSee` reimplemented: mineflayer `canSeeBlock` ray length = distance to the block's min corner -> some
    blocks never "seen" (birch 8E 5S invisible -> chop no_target_known). perceive.js `safeSee` uses it too.
  - `C.pickup`: GoalNear(1) counted as reached out of pickup range (3 ore mined, 1 collected) -> GoalBlock on the
    drop's cell, GoalNear fallback.
- RCON facts: `execute if items/entity` prints `Test passed. Count: N` (capital C); entities/players need
  loaded chunks (a query with no player online fails); food has no command -> runner drains it with hunger.

### Open
- combat.zombie#2 once: bot died after 2 HP damage (cause unknown; not reproduced in 6 seeds; death_msgs now logged).
- Some lockstep episodes take ~10 s real for ~350 ticks (chop, mine#1): something waits on real time; find it.
- Format reserved, not implemented: actors (owner NPC), seed-world templates, mind.chests/map, snapshot/restore.

### Next
1. Commit (ask user). 2. More cards (danger: lava/fall/night/creeper, multi-stage, orders mid-episode, held-out set).
3. Fidelity guard: same cards x1 vs lockstep outcome distributions. 4. Mind loop (LLM -> turns) = policy `mind`.

## State 2026-11-17 session #12 — craft stall fixed, MineSim instances, bench done
Branch `v2`. **NOT committed** (everything since `8cd9b21`: rcon, clock, craft, run.js, live.js, sim/instance.js,
.gitignore, eval/model_bench.py; don't commit `eval/results/`).

### FIRST: finish craft_planks at x1, then commit
- Lockstep sim 0: 64/64 x2. **x1 sim 0 (`node test/live.js --sim 0`): 63/64**, `craft_planks` FAIL
  `partial server_refused | 4/8 done, then craft oak_planks: no result` (full suite only).
- `--only craft_planks` alone at x1: 3/3 PASS. So a state left by an earlier case triggers it.
- Debug left in `craft()`: `CRAFT_DEBUG=1` prints inventory/grid/cursor at start, after each batch, after settle.
  REMOVE IT (the `dbg` lines) once fixed.
- A run was left going in the background at the end of the session: preceding cases + craft (x2), output
  `C:\Users\noanh\AppData\Local\Temp\claude\115b64199a6beba7\f2c2e44c-f200-4270-a21c-869b33c68c88\tasks\bsmbiohcv.output`
  (cmd: `CRAFT_DEBUG=1 node test/live.js --sim 0 --only mine_stone,mine_missing_tool,mine_tool_too_weak,mine_ore_ok,mine_unknown,chop,craft_planks,craft_sticks`).
  If it did not reproduce: run the full suite x1 with `CRAFT_DEBUG=1` and read the `[craft]` lines.
- Sim instance 0 (java) may still be running: `node sim/instance.js status` / `stop 0`.

### Done
- **Craft stall fixed** (`bot/skills/craft.js`). Two causes:
  1. mineflayer waits `once(updateSlot:0)` (20 s) after each crafting-grid/result click; 1.17.1+ servers may not
     answer. Wrapping `bot.clickWindow` was not enough: `putAway(0)` uses mineflayer's INTERNAL clickWindow.
     `patchClickWindow(bot)` now hooks the outgoing `window_click` packet: no `updateSlot:0` within 1 s (bot clock)
     -> real resync `bot._syncWindow(window)` (stale-stateId no-op click, server resends the whole window).
  2. mineflayer's local inventory model drifts from the server (crafts counted twice / not at all, ingredients left
     in the 2x2 grid, which the server keeps until a window closes). `craft()` now calls `settle()` before and after
     every batch: resync, shift-click grid slots 1-4 (+ cursor) back to the inventory, resync; counts on that
     synced inventory. 2 batches with no result -> `server_refused` (no more fake `ok` with `stick x0`).
- **MineSim instances** `bot/sim/instance.js`: `node sim/instance.js create|start|stop|status|rm <n>` ->
  `mcserver-sim/<n>/` (gitignored, copy of mcserver jar/libraries/versions), flat world seed 1, view/sim distance 4,
  game port 25600+n, RCON 25700+n, random RCON password. Starts in ~9 s.
  `node test/live.js --lock --sim 0` runs the suite on it (starts it if down). live.js waits `waitForChunksToLoad`
  after the first tp (fresh world: arena chunks were not loaded -> goto_pos no_path).
- Lockstep on sim 0 after the fixes: **64/64, 64/64** (34-41 s real, 102-120 tps). x1 on sim 0: 63/64 (above).
- The suite has NO LLM: scripted DSL statements; "LFM" is only the bot username.
- **Model bench** done (merged `eval/results/model_bench_2026-11-17-15-52.jsonl` + `-15-57.jsonl`, 8 tasks, 1024 tok):
  K2-Horizon-4B 6/8 (med 252 tok, 69 tok/s), Nemotron3-Nano-4B 6/8 (294, 77), Sharp-Spark-X2.6 6/8 (514, 74),
  Spark-X2.6 6/8 (410, 65), LFM3-1.7B-Unc 4/8 (1014, 155), Bonsai-2B Q2 3/8 (1024, 201). `grid` failed for all
  (truncated at 1024: not discriminating at this budget). Most efficient: K2-Horizon, Nemotron.

### Next
1. **Scenario cards** (user's choice, next session): format (world template + RCON setup + inventory/pos + goal +
   success cond + timeout + seeds) + runner reusing live.js infra and `sim/instance.js`.
2. Then: snapshot/restore (branching), fidelity guard (same cards x1 vs lockstep), mind loop (LLM -> turns).
- Speed (user asked, 120 tps "low"): pure stepping did 450-550 tps (spike); suite cost = 2 RCON round trips/tick +
  bot physics + setup commands. Plan: don't optimise the driver yet. Once the mind loop exists, measure LLM time vs
  world time per episode; LLM (~1-5 s/decision) will likely dominate. If the world is the bottleneck: parallel
  instances first (~linear with cores, no fidelity risk), then 1 round trip/tick (needs another barrier than
  `time query`, est. x1.5-2). No batched `tick step N` (physics must run every tick).
- Still open: macros keep or drop? `brew`, `stonecut`, grindstone repair not implemented.

## State 2026-11-17 session #11 — H4 started: lockstep MineSim works
Branch `v2`. Commit `8cd9b21` = H4 spike. **Uncommitted** (all tested, see below): `bot/rcon.js`, `bot/sim/clock.js`,
`bot/skills/craft.js`, `bot/dsl/run.js`, `bot/test/live.js`, `eval/model_bench.py` (+ `eval/results/`, don't commit logs).

### H4 decision: option C, strict lockstep (measured, see `bot/sim/spike.js`)
- A = `tick rate R` + bot clock scaled (`clock.install()`, k follows server tps from `update_time`): walk OK up to
  1000 tps but mining drifts in game time (16 ticks/block at x1 -> 36 at 200 tps, 112 at 1000): real latency
  (Windows timers ~15 ms + round trips). Also a wrong k silently lets the bot move too fast (server accepts it).
- **C = frozen server stepped by the bot** (`clock.installManual()` virtual timer queue + `sim/lockstep.js`: per
  step `clock.advance(50)` then RCON `tick step 1` + `time query gametime`): mining 16 ticks/block like x1, walk
  83 ticks, ~450-550 tps in the spike. One server tick per bot step (checked).
- `node test/live.js --lock`: full suite in ~32-42 s real (vs ~290 s at x1), ~100-150 tps overall (setup RCON
  commands count). Last runs: 64/64, 64/64, 63/64 (chop flake).
- Consequences: the sim needs its own server (a connected player freezes with the world); several bots on one
  server must step together; keepalive timer runs on the bot clock (pass `checkTimeoutInterval: 30000*1000`).

### Bugs fixed on the way (uncommitted)
- `rcon.js`: one request in flight (vanilla RCON parses one packet per read; pipelined driver + test commands
  -> server dropped the connection).
- `clock.js`: `new Date()` patched too (mineflayer `clickWindow` does `new Date() - bot.lastDigTime`: real vs
  virtual time blocked crafts ~20 s).
- `craft.js`: loop counts accepted crafts (not the lagging local inventory -> crafted one batch too many), waits
  up to 1 s for the inventory; `patchClickWindow(bot)` (called by the Interpreter): mineflayer waits
  `updateSlot:0` after every grid click (20 s timeout) even when the result does not change -> synthetic release
  after 1 s. This one also failed at x1 (normal run 59/64 before it).
  **NOT enough**: after the patch, lockstep runs 63/64, 60/64, 64/64; craft_sticks still stalls 21.1 s with
  `stick x0`, then planks left in the grid break craft_no_table/craft_table/craft_with_table. Another 20 s
  mineflayer wait remains (candidates: `putAway` `once(window, updateSlot:<slot>)`, other grid slots): log the
  pending `once` events to find it. Intermittent, at x1 too.
- Normal-speed suite NOT re-run after the clickWindow patch (last x1 run 59/64: craft chain + break_one/dig_box
  pickup counts gained 0/1, unexplained yet).

### Model comparison (user request, generic bench, no MC knowledge / DSL format)
- All 6 in `models/compare/` load with our llama.cpp (Bonsai Q2_0 too, no prism fork). llama-bench tg128 (tok/s):
  Bonsai-2B 216, LFM3-1.7B-Unc 163, Nemotron-3-Nano-4B 80, Sharp-Spark-4B 78, Spark-X2.6-4B 73, K2-Horizon-4B 73.
  pp512: 4.3k-12k. VRAM 7.6 GB free: one model at a time.
- `eval/model_bench.py`: same seeded tasks for all (arith, grid shortest path via BFS, resource planning,
  state tracking), answer `ANSWER: n`, temperature 0, reasoning auto; measures acc, truncation, latency, ttft,
  tokens, tok/s, correct/min. User wants it SHORT: running `--n 2 --max-tokens 1024 --timeout 60` (8 tasks/model)
  in background, output `eval/results/model_bench_run.txt` + `model_bench_<stamp>.jsonl` (summary table at the end).
  Smoke test: LFM3 (thinks) truncated 2/4 at 3072 tokens.

### Next
1. Bench + MC server were KILLED by Claude Code (system low on RAM) mid-run. Partial (8 tasks, 1024 tok max,
   `eval/results/model_bench_2026-11-17-15-52.jsonl`): K2-Horizon 6/8 (2 truncated, ~410 tok), Nemotron 6/8 (2 trunc,
   ~450 tok), LFM3-1.7B-Unc 4/8 (4 trunc, ~900 tok), Sharp-Spark 2/4 partial; Spark-X2.6 + Bonsai not run.
   Rerun only those 2 when asked: `--models models/compare/Spark-X2.6-4B-Q4_K_M.gguf,models/compare/Ternary-Bonsai-2-2B-Q2_0.gguf`.
   16 GB RAM: don't run MC server + llama-server + bench + live suite together.
2. Fix the craft stall above (intermittent, x1 and lockstep), rerun `node test/live.js --lock` x3 and x1 once,
   then commit the uncommitted files.
3. H4 next: own sim server instance(s) (flat/prepared worlds, view-distance 4), scenario cards (RCON setup
   scripts), world snapshot/restore for branching, fidelity guard (same cards x1 vs lockstep), speed up the
   driver (2 RCON round trips per tick). Mind loop (LLM -> turns) still not written: harness has no model.
- Still open: macros keep or drop? `brew`, `stonecut`, grindstone repair not implemented.

## State 2026-11-17 session #10 — H3 done, committed
Branch `v2`. H3 = interpreter + skills + tools + turns (see session #9 below for content).

### Done this session
- Live suite `node bot/test/live.js`: **63/64** full run (log `data/own/2026-11-17/2026-11-17-13-40_LFM_live.jsonl`,
  `spec/tools/validate.py` OK); the one failure (eat_full: food not refilled by reset) fixed and verified with `--only`.
- Fixes: `C.reach` falls back to GoalNear when GoalLookAtBlock has no path (crops, non-full blocks); `pickup` skips
  unreachable drops instead of stopping; enchant/repair move items by WINDOW slot (mineflayer `putTargetItem` uses
  inventory-window slots -> table stayed empty, `ready` never fired; `anvil.combine` refuses on 1.21 components
  "Not anvil-able"): repair = manual slots + shift-click result; `perceive.js` tolerates `it.enchants` throwing.
- Test fixes: reset refills food (saturation), smelt_no_fuel places its furnace, tools2 names its own place
  (`pre_act`), since say_note_forget forgets `spot`.
- `--only` still resets before `keep` cases (break_one, dig_box, tools2, eat_hungry fail alone): expected.
- Comparison models downloading one at a time to `models/compare/` (log `models/compare/download.log`):
  LFM3-1.7B-Uncensored Q4_K_M (AtomicChat), Ternary-Bonsai-2-2B Q2_0 (prism-ml; may need prism's llama.cpp fork),
  Nemotron-3-Nano-4B Q4_K_M (nvidia), Sharp-Spark-X2.6-4B Q4_K_XL, K2-Horizon-3.7B Q4_K_M (IFM), Spark-X2.6-4B Q4_K_M.

### Next
1. **H4 (MineSim)**, decided by the user 2026-11-17 (plan `notes/harness-v2.md` section 8).
   If the downloads stopped: `bash models/compare/dl.sh > models/compare/download.log 2>&1` (hf skips finished files).
- Still open: macros (strip_mine, branch_mine, chop, toss_junk, sort, equip_best, water_bucket_save) keep or drop?
  Tailscale hostname scrubbed from history (2026-11-17), keep it out. `brew`, `stonecut`, grindstone repair not implemented.

## State 2026-11-17 session #9 — H3 nearly done (uncommitted)
Branch `v2`, nothing committed this session. Semantics documented in `notes/spec-v2.md` 2.5.

### Done (H3)
- `bot/dsl/fmt.js` (AST -> canonical source), `bot/dsl/cond.js` (cond eval, relative baselines, unmet -> surprise),
  `bot/dsl/run.js` = `Interpreter`: cancellable scopes, seq/if/repeat/routine, until (ok + cause interrupted_until),
  timeout (failed/partial), death abort, interrupt/stop, `adjust`, expect check -> `surprise`, one `result` event per
  statement with gained/lost/cause/detail, `avoid` watcher (interrupt events).
- `bot/skills/` (common, movement, gather, craft, combat (+place/use), inventory, social (+farm, meta)): 69/71 verbs;
  `brew`, `stonecut`, grindstone repair not implemented (result `invalid`). No omniscience: targets = seen blocks.
- `bot/tools.js`: all 13 tools (`wiki` stub until H5). `bot/turns.js`: apply a parsed turn (tools -> tool_answer,
  act/interrupt/override -> interpreter, note/say/goal/plan -> memory).
- `bot/harness.js` uses the interpreter; `drive.js` removed (`git rm`). `--script file` (decision turns separated by
  `---`, `--exit-when-done`), chat `do <stmt> [=> <expect>]`, `tool <call>`, `stop`.
- `Senses.chests` (contents seen when opened) -> `inventory.chests`. `perceive.js` exports `seesSky`.
- Tests: `bot/test/interp.js` offline (fmt round trip on golden, conds, interpreter control flow on a fake bot) PASS;
  added to `npm test` (full `npm test` not re-run after the last edits: run it first).
- `bot/test/live.js`: 64 live cases, arena built by RCON at (3000,200,3000) (y=100 had water flowing in), throwaway
  memory, restores gamerule spawn_monsters. Last full run **52/64**. Fixes applied after it (not yet verified):
  `C.go` checks `goal.isEnd` (pathfinder.goto resolves silently when no path), `placeReach` for placing into air,
  arena reset clears above the floor (a leftover pillar put the bot inside dirt -> blind: look/harvest/bonemeal/plant/
  sleep/enchant/repair failures), descend case uses `Y-5`, shear picks up wool, tools2 keeps inventory.
  Rerun of 16 cases with `--only` (log `data/own/2026-11-17/2026-11-17-13-25_LFM_live.jsonl`): **9/16**.
  Fixed: place_list, descend, look, plant, shear, sleep. Still failing:
  - break_one, dig_box, tools2: test artifact, `--only` resets before `keep` cases (they depend on the previous case);
    should pass in a full run (or make `--only` honour keep).
  - harvest, bonemeal: `no_path` after 5 s on the crop block (likely `C.reach` -> GoalLookAtBlock on a non-full block):
    use placeReach-style GoalNear for crops.
  - enchant: hangs until the 120 s timeout, the enchanting table `ready` event never fires: add a timeout / debug.
  - repair: mineflayer anvil refuses ("Not anvil-able") two damaged iron_pickaxe: check `combine` usage / item args.

### Next
1. `cd bot; npm test`, then `node test/live.js --only place_list,break_one,dig_box,descend,strip_mine,ascend,look,harvest,bonemeal,plant,shear,sleep,enchant,repair,tools,tools2`, then full `node test/live.js` (~4 min), `spec/tools/validate.py` on the `_live.jsonl` log.
2. Commit H3. Then H4 (MineSim) or the mind loop.
- Still open: macros (strip_mine, branch_mine, chop, toss_junk, sort, equip_best, water_bucket_save) keep or drop?
  Tailscale hostname scrubbed from history (2026-11-17), keep it out.

## State 2026-11-17 session #8 — H2 done
Branch `v2` (not pushed).

### Done (H2)
- `spec/recipes.json` (crafting 1026, smelting/blasting/smoking/campfire, stonecutting) from the server jar:
  `.venv/Scripts/python.exe spec/tools/gen_recipes.py`. `spec/state.schema.json`: `slice.y_from` added.
- `bot/state/`: `perceive.js` (body, inventory, surroundings: 9x9x5 slice, blocks of interest seen in line of
  sight, entities/items/players, flags), `index.js` (`Senses`: events gain/loss/damage+source/death+message/respawn/
  chat/entity appear-leave/time phase/weather, builds the full state), `ledger.js`, `map.js` (16x16 cells, biome,
  surface y, resources, dangers, frontier; persisted `data/own/memory/<bot>.map.json`), `memory.js` (notes, places,
  routines persisted `data/own/memory/<bot>.json`; episode + goals per session), `afford.js`.
- `bot/render.js` sheet r1 (see `notes/spec-v2.md` 3.1). `node bot/render.js [state.json]`.
- `bot/harness.js`: live loop at `--hz 2`, logs `data/own/<date>/<session>.jsonl` (state per call + chars per
  section + sent mode full/diff, full every 10 calls) + `<session>.sheet.txt`. `bot/drive.js` = TEST driver
  (random goto, chop seen logs, craft planks/sticks; chat orders follow/come/stop/wander) to make the state move,
  never a policy nor training data. Chat hooks: `goal <text>`, `done`, `note <text>`, `place <name>`, `plan a | b`.
- `eval/sheet_tokens.py`: tokens per section with the real tokenizers. `bot/rcon.js` restored from v1.
- Tests: `cd bot; npm test` = 176 DSL golden + 5 state/render tests (renderer snapshot `spec/golden/sheet_example.txt`).
- 6 live runs of 1 min, all logs valid (`spec/tools/validate.py`). Perf: build 45-65 ms/call, render 0.6 ms.
  Log volume ~2.5 MB/min at 2 Hz (state JSON per call).

### Measured (279 live calls, 350M tokenizer)
Full sheet mean 5.2k tokens (p95 5.9k, max 6.2k), diff calls 1.4-1.9k. MAP 1.5k, SURROUNDINGS 1.1k (p95 1.8k),
MANUAL 1.05k, AFFORDANCES 0.86k, rest < 250. Well under the 10-20k budget: room for a bigger slice, more cells,
knowledge cards, longer ledger, once a model shows what it needs.

### Known issues / open
- Server has `advance_time false` (time frozen at 1000): the tester script turns it on then restores it.
- Sounds disabled: mineflayer's sound id -> name table is wrong for 1.21.11 (zombie hit heard as zombie_horse.hurt).
- A second mineflayer bot ("Tester") that joins near LFM is never seen by LFM (its client does not even follow the
  tp; looks like the 1.21 "player loaded" handshake). A probe teleporting a bot from far IS seen, so player
  perception works; check with the real client (ZeiK_0) next time the user plays.
- Driver `goto` places scaffolding (pathfinder) -> `lost cobblestone` in results: real, not a bug.
- Session names use UTC time.
- Open points from H1 still open: catalogue macros (strip_mine, chop, toss_junk, sort, equip_best,
  water_bucket_save) keep or drop? Tailscale hostname scrubbed (2026-11-17).

### Next = H3
DSL interpreter in `bot/` (replaces drive.js): each verb -> mineflayer skill with rich `result` events (gained/lost,
causes from the closed set), `until()` / `timeout`, `expect:` checking -> `surprise` events, monitor-call hooks.

## State 2026-11-17 session #7 — v2 started, H1 done
Branch `v2` (not pushed). Commits: `22df018` clean restart layout, `13a59d3` DSL + turns frozen, then schemas.

### Done
- Clean restructure (details in session #6 "Next" below). `.venv/` (python, + jsonschema), `bot/` (node deps).
- User decisions at H1 review: DSL lines for BOTH models; section budgets measured in H2; **no predefined build
  templates** (model builds block by block, may save its own routines); place names chosen by the model;
  **keep `models/LFM2.5-350M-wedit*` + base models as reference baselines** to measure fine-tuning gains.
- **H1 frozen in `spec/`**: `dsl.md` (grammar, values, normalized AST, errors), `turns.md` (decision / monitor /
  mind tags), `catalog.json` (71 verbs + 13 tools, typed params), `names.json` (minecraft-data 1.21.11 + jar tags,
  `tools/gen_names.py`), `state.schema.json` + `events.schema.json` (+ `golden/state_example.json`,
  `tools/validate.py`). Reference parser `bot/dsl/parse.js` + `turn.js` (errors written for the model, with
  "did you mean" ids), `bot/dsl/check.js` = JSONL validation service for Python. `cd bot; npm test` = 176 golden.

### Open points to raise with the user
- Catalogue still has code-side macros of the same kind as build templates: `strip_mine`, `branch_mine`, `chop`
  (whole tree), `toss_junk`, `sort`, `equip_best`, `water_bucket_save`. Keep (motor skills) or drop (model decides)?
- Never write the Tailscale funnel hostname in committed files (public repo); it lives in `remote/` only.

### Next = H2
Big sheet renderer + ledger + mental map + more inputs in `bot/`, logged live (state JSON per call, validated by
`spec/tools/validate.py`). First: perception -> state.schema.json, renderer state -> text, measure tokens/section.

## State 2026-11-17 session #6 — v2 restart decided, v1 archived

### Read first
- `notes/harness-v2.md` (rev 3 + section 8 MineSim): the agreed v2 plan. `notes/spec-v2.md`: H1 spec draft (turn
  protocol, DSL grammar + ~80 verbs + 13 tools, results/failure causes, 12-section situation sheet, events, mind
  loop, logging). User has not reviewed the spec yet.
- Project memory now lives IN THE REPO: `memory/` (index `memory/MEMORY.md`). Update it there only.

### Decisions (user, this session)
- v1 harness (one verb from a closed grammar + code hint) judged "très restreint et nul". v2 = model decides
  everything, code = senses/muscles/reflexes, no recommended action, only facts + affordances.
- LLM is local, free, fast: call it VERY often (350M "hands" monitor/decision calls 2-5/s; 1.7B "mind" every
  5-10 s). Situation sheet 10-20k tokens (bigger than first proposed), stable->volatile for KV cache.
- Huge action space (DSL **lines**, not JSON tool calls) + many read-only tools; models trained on this syntax.
- Distil 3 teachers into the students: GPT 6.1 sol (Codex), DeepSeek v4.1 flash (Command Code), **Claude via
  the user's subscription (Claude Code)**. 350M = fast multi-turn tool use, 1.7B = knowledge/reasoning (hypothesis,
  ablate). Much wider Minecraft KB: minecraft-data + offline minecraft.wiki dump (OK by user) + other sources +
  teacher-generated, fact-checked data.
- Continual learning on own logs: prediction loss (`expect:` vs outcome), hindsight relabelling, teacher fixes on
  surprises (DAgger), GRPO; regression gate before deploy.
- MineSim must replicate the real engine very faithfully -> NOT a reimplementation: vanilla server accelerated
  (`/tick sprint`), mineflayer physics stepped in lockstep with server ticks, several small instances, scenario
  cards via RCON, world snapshots for branching. Measure throughput at start of H4.
- 1.7B training on gpt_train: NOT started, user said wait for their go (moot now with v2).
- **Clean restart**: v1 code committed on branch `v1-archive`, tag `v1-final` (commit 7301831, also on `b6-b7`).
  NOT yet done: restructure into `bot/ sim/ kb/ data/ teach/ train/ eval/ spec/`, moving v1 data to
  `data/v1/`, removing v1 code from the working tree. Keep: `models/`, `llama.cpp/`, `mcserver/`, venv
  (`b21/.venv`, torch etc.), `mcbot/node_modules`. **NEVER touch `remote/`** (remote access) nor `.commandcode/`.
  `b21/runs` (3.1 GB, closed B21 edited models): user not asked yet -> archive by default, ask before deleting.
  Was waiting for Codex to finish (it writes in `b19/wedit` and `models/LFM2.5-350M-wedit*`).

### Results of the session (b19, option-scoring top1/top3)
- Real-log test (290) is LEAKY (split by 30-tick blocks, 6/8 test sessions in train) -> high scores = memorisation.
- GPT vs DeepSeek teacher (same 10 seeds): GPT 10/10 episodes, 200 rows, 2x faster, more distinct actions; DeepSeek
  7/10, stalls. GPT chosen for volume. Script `b19/compare_teachers.py`.
- Held-out synthetic tests (31 states each, ±17 pts noise): gpt_test / ds_test / real test
  - 350M zero .290/.323, .516/.516, .683/.948 (copies the hint 100% -> score = teacher hint-follow rate)
  - 350M full SFT on gpt_train (168) .290/.387, .484/.581, .659/.683 (no gain, top3 collapses on real)
  - LFM3 zero .355/.581, .355/.548 ; LFM3 LoRA on real logs .258/.452, .419/.516, .986/1.00
  - Codex direct weight writing (b19/wedit, lm_head memories, 0 original weights rewritten, +4.6M..+67M params):
    v1/v2/v3 all = base on unseen (.290, .516 top1), .948-.979 on leaky real test = memorisation. Claude Code's wrapper shell was reaped
    (low RAM) at clear but codex.exe + a 2.9 GB python collector kept running: check `tasklist`; Codex still
    running at clear (final collectors, report `b19/wedit/REPORT.md` via `make_report.py`, final message
    `b19/wedit/codex_final.md`). Conclusion so far: direct writing memorises, does not generalise.
- Lesson: one-word imitation on ~200 decisions measures hint-copying; v2 needs volume + outcome-based eval.

### Next
1. Codex was STOPPED by the user before REPORT.md (v4/v5 not evaluated). Conclusion (user): weight writing is
   effective for retention -> possible tool to inject knowledge later (see `memory/weight-writing-retention.md`).
   **Clean restructure DONE (session 7, branch `v2` from b6-b7, NOT committed yet)**: v1 code `git rm`'d (b19, b21,
   mcbot, root scripts, run-*.ps1); v1 data -> `data/v1/` (logs, logs-b5run, memory, evals, b19, b21); big v1
   outputs -> `archive/v1/` (b21-runs 3.1 GB, b19-wedit, b19-runs, recordings, old *.log); venv -> `.venv/`
   (was b21/.venv, checked: torch 2.13 cu130 OK); node_modules + package.json -> `bot/` (mineflayer loads);
   worktree `../localai-b5run` removed; ROADMAP = H1-H9; README = v2 layout. `data/` and `archive/` gitignored.
   Leftover: empty `mcbot/node_modules/prismarine-viewer` locked by some process -> delete after reboot.
   models/LFM2.5-350M-wedit* (v1..v5) still in models/.
2. User reviews `notes/spec-v2.md` -> freeze H1 (+ `spec/` grammar/schemas/golden examples).
3. H2: big sheet renderer + ledger + mental map + more inputs in the new `bot/`, live logged.

## State 2026-11-17 session #5 — B19 executor experiments in `b19/`
Goal of the session (user): compare ALL executor options on the existing logs (policy net from scratch vs small LLM SFT
vs LFM3 LoRA), then go heavier with teacher distillation. Teacher LLMs invent **synthetic logs** of all kinds of
situations (structure from real logs, content invented). Nothing committed yet (all of `b19/` is untracked).

### Cleanup done at ~11:54 (user asked: free RAM/VRAM)
Killed: llama-server (LFM3, :8080), the Minecraft client (launcher java) + launcher, `mcbot/viewer.js`. No MC server
was running. NOT killed: Docker/Guacamole + Tailscale (remote access), rbx-studio-plus, an idle interactive Command Code.
Restart the game stack with `.\start-game.ps1` / `.\start-mc.ps1` when needed.

### Still running at clear (background, OS processes; check results by files, not by task notifications)
- `b19/sft.py --model models/LFM3-1.7B-hf --mode lora --epochs 2`: training finished 11:46 (8.5 min, adapter in
  `b19/runs/LFM3-1.7B-lora/`), eval (option scoring of 290 test states) still running, slow (VRAM was saturated).
  Result -> last line of `b19/runs/results.jsonl`. If the process is gone with no line: rerun eval only (TODO add `--eval-only --adapter`).
- `b19/synth.py` DeepSeek batch, 10 episodes, seed 1000 -> `b19/data/synth.jsonl` (9/10 done at 11:54: 118 rows).
- `b19/synth.py --teacher gpt` same 10 cards (seed 1000) -> `b19/data/synth_gpt.jsonl` (1/10 done: 16 rows, 134 s).
- Raw teacher answers: `b19/runs/synth_raw/{deepseek_,gpt_,}ep_<seed>.txt` (ep_<seed>.txt without prefix = DeepSeek, old naming).

### Files (`b19/`)
| File | What |
|---|---|
| `extract.py` | logs (`mcbot/logs` + `..\localai-b5run\mcbot\logs`) -> `data/train.jsonl` (825) / `data/test.jsonl` (313). Split = blocks of 30 ticks per session. `keep` = ok & not wait & llm/task/user (train 620 / test 290) |
| `render.py` | Python port of bot.js `observe()` text + grammar. Self-check `python b19/render.py` = **612/612 exact** on real logs |
| `baselines.py` | random / follow hint / most frequent action |
| `policy.py` | option-scoring MLP from scratch (75k params, state feats + option feats + verb/item embeddings), `--no-hint` ablation |
| `sft.py` | `--mode zero|full|lora`, prod prompt (chat template, system of the session + obs_text), loss on answer only; eval = log p(option) argmax over legal options (= grammar). Run with `b21/.venv/Scripts/python.exe` |
| `synth.py` | teacher episodes: random scenario card (goal 38 items + 6 free goals, phase, 16 places, time, vitals, 11 dangers, 2 of 15 twists, 14-26 decisions) -> JSONL decisions {state, options, hint, action, reason, result}; history rebuilt by us; validated vs `data/mc_names.json` (minecraft-data 1.21.11) + action legal; rendered with render.py. `--teacher deepseek` (Command Code `-p`, deepseek-v4.1-flash, prompt via stdin, cwd `runs/cc_work`) or `--teacher gpt` (Codex `exec -m gpt-6.1-sol -c model_reasoning_effort="medium" -s read-only --ephemeral`). Empty answer -> 1 retry + stderr saved to `*.err.txt` |
| `runs/results.jsonl` | all metrics |
Models: `models/LFM2.5-350M-hf` downloaded this session (709 MB, LiquidAI/LFM2.5-350M).

### Results on REAL logs (test = 290 kept decisions; labels = LFM3's own choices)
| Model | top1 | top3 | notes |
|---|---|---|---|
| random legal | 11.4% | | |
| follow code hint | 27.2% | | |
| most frequent action | 67.2% | | logs dominated by repeated collects |
| LFM2.5-350M zero-shot | 68.3% | 94.8% | |
| policy net, no hint/plan feats | 84.5% | 95.5% | 0.19 ms CPU |
| policy net | 90.3% | 92.8% | 0.13 ms CPU, 74 s train CPU |
| **LFM2.5-350M full SFT (2 ep)** | **98.6%** | 99.3% | 153 s train, 5.3 GB peak; HF scoring latency (1 s) meaningless (VRAM saturated) |
| LFM3-1.7B LoRA r16 (2 ep) | pending | | |
Caveat: this measures imitation of LFM3 (bugs included). Real judge = live bench `mcbot/eval.js`. Missing: LFM3 zero-shot
reference on the same scorer, per-example predictions (to see the 1.4% errors).

### Synthetic pilot findings
- DeepSeek: pilot 2 eps 44/44 valid; batch: ~3-6.5 min/episode, 13-25 valid decisions per episode, rejects rare
  (7 unknown items in one ep, 1 illegal action); **2/10 episodes came back EMPTY** (210 s and 520 s; cause unknown,
  stderr was not captured then — now it is). Quality good: varied verbs, reacts to failures, often overrides the hint
  with a sensible reason. Seen issues (prompt tightened after the pilot): goal changed mid-episode, hint "pursue the goal" on plan error.
- GPT 6.1 sol medium: first episode 134 s, 16/16 valid. Compare when both are done: time/episode, valid rate, verb
  diversity, hint-override rate, reason quality side by side (same cards).

### Ideas agreed / proposed this session
- User: teachers generate lots of fake logs, inspired by real logs for structure only. Done (`synth.py`).
- User idea, proposed as **B23 (not yet in ROADMAP, user not asked to confirm)**: route events to the right actor =
  cascade reflexes (code) -> policy net (if confident: softmax margin) -> small SFT LLM -> strategist (DeepSeek / 7-8B)
  for stuck / new goal / chat / novel. Router learned from the comparison data (cheapest actor that is right per state);
  strategist decisions fed back as training data (DAgger).
- User declined MiniCPM3-4B / MiniCPM-V 4.7 (old / too big or vision not needed).

### Next
1. Read the LoRA result + both synth batches; write the DeepSeek vs GPT comparison (table + 2-3 sample decisions each).
2. Faster eval in `sft.py`: prompt KV computed once per state (prefix sharing), `--eval-only --adapter`, save predictions.
3. LFM3-1.7B zero-shot on the same scorer (reference).
4. Pick teacher(s), generate a few hundred episodes (several k decisions; user approves volume — subscription quotas unknown).
5. Retrain the 3 actors on real / synth / real+synth; test on real test + held-out synthetic episodes.
6. Live: export best SFT model to GGUF (llama.cpp), plug as `--llm`, run `eval.js`; policy net needs a small server
   (bot would send `obs.state` in the request body).

## State 2026-11-17 session #4
### B5 1 h run: FAILED (B5 and B1 NOT ticked)
- Full write-up: `notes/b5-run-and-architecture.md`. `longrun.js` finished at 60 min (2 restarts, 2 deaths by zombie).
  6 goals in 27 min (3 torch, iron_pickaxe, 16 torch, shield, bucket, diamond_pickaxe), then **stuck 33 min on
  diamond_sword**: 47 diamonds, `craft diamond_sword` never tried, 48x `wait 1`, ore hopping. Watchdog fired 5x
  (escalation up to 4) and never unstuck it: escalations just keep banning, no strategy change.
- `..\localai-b5run` worktree **kept** (its `mcbot/logs/*.jsonl` = loop examples for datasets). Not removed.
- Processes seen at handoff (~09:20): java (MC server) + llama-server (old 1-slot launch) since 07:55, node 14368
  (since 02:16, unknown) and node 40052 (since 09:15, unknown). Check before starting a bot; one bot at a time (RAM).

### Decisions this session
- **No new hardcoded behaviour rules** (user rejected "drop `collect X` from the grammar when the plan has enough").
  Code keeps only survival reflexes + safety. Loops are to be fixed by models/data, not rules.
- Target architecture: **strategist** (big LLM: chat, orders, sub-goals, called by the watchdog instead of bans) +
  **executor trained from scratch** (sub-goal + `obs.state` -> score legal grammar options) + reflexes. = B19 moved up.
  ROADMAP B19 has the data protocol: compare sources A (DeepSeek synthetic), B (LFM trial & error), C (LFM plays +
  DeepSeek labels = DAgger), D (A then C), 10k pilot each, B6 + offline eval. Target 100k-1M examples.
- Teacher (B12): probably **Command Code + `deepseek-v4.1-flash-1017`** on the user's subscription, not the paid API.
- 8 GB VRAM: 7-8B Q4 strategist + LFM Q4 fits with short ctx; full fine-tune of a 1.7B does not.

### Next
Same list as session #3 below, minus "finish run" (done, failed). Then the next ROADMAP brick. First new code for B19:
extraction script logs -> (state, sub-goal, action) + count of usable examples. Nothing committed this session
(edits: ROADMAP B5/B12/B19, `notes/`, this file) on branch `b6-b7`.

### Remote access (session #4b, user works remotely from a corporate network)
- Corporate network = HTTPS only (UDP blocked): **Chrome Remote Desktop installed + registered** (service `chromoting`,
  auto) but it fails from there (connects, drops after ~26 s). Use it from home / 4G only.
- Tailscale funnel `https://<tailscale-host>`: `/` -> Guacamole (docker :8090 -> TightVNC :5900, laggy for
  3D), **`/viewer/` -> prismarine-viewer :3007** (trailing slash required). cloudflared killed, task `Cloudflared-Guacamole` disabled.
- **Viewer**: `run-viewer.ps1 [-Target auto|EVAL|LFM]` -> `mcbot/viewer.js`: spectator player `Viewer` (invisible to bots,
  checked), RCON-tp behind the target every 1 s, 3rd-person orbit view in the browser. auto = EVAL > LFM > B5RUN > any non-human.
  Running detached (hidden powershell). Uses 1.21.4 textures (viewer max), new blocks may look wrong. Added deps
  `prismarine-viewer@1.33.0` + `canvas` in `mcbot/package.json` (not committed).
- `remote/` holds plaintext VNC/guac passwords: never commit. Claude Code shell is not admin: elevation = UAC clicked by the user via Guacamole.
- Next: user watches `/viewer/` while we validate B6/B7 (list below).

## State 2026-11-17 session #3
### Running when this was written (~08:30)
- llama-server (`start-game.ps1`, still the OLD 1-slot launch), MC server (`start-mc.ps1`), and
  `node longrun.js 60 --name B5RUN --goals "iron_pickaxe,16 torch,shield,bucket,diamond_pickaxe,diamond_sword"`
  running from the git worktree `..\localai-b5run` (detached, commit a8d53b8 + hot-patched planner fix).
  Started ~07:57, ends by itself ~08:57 (`[done]` in `localai-b5run\mcbot\longrun_events.log`).
  If the session was cleared the node process may still run: check `Get-Process node`.
- **To finish B5/B1**: `cd ..\localai-b5run\mcbot; python stats.py --all` (3+ log files = restarts), read
  `longrun_events.log` / `longrun_bot.log`. Results so far (27 min): 3 torch, iron_pickaxe, 16 torch, shield, bucket,
  diamond_pickaxe all reached; diamond_sword in progress. Watchdog `no progress` fired live 2x (oak_log loop,
  unreachable deepslate_diamond_ore), ban `place furnace` 1x, restart test OK ("back online, resuming ... home 4m").
  1 death: "slain by Zombie" (Easy difficulty) during a 20 s explore -> fixed in e75bb50 (not in the run).
  If no endless loop to the end: tick B5 and B1 in ROADMAP. Then `git worktree remove ..\localai-b5run`
  (junction node_modules inside: remove the junction first, `cmd /c rmdir`), keep its logs if useful.
- After the run: restart llama-server so `-Slots 2` applies (decider slot 0, chat slot 1).

### Branch `b6-b7` (not pushed, not merged; main = a8d53b8)
- `2db2e0e` planner: planks/logs of any wood interchangeable. Bug seen live: 4 acacia_planks made the plan ask
  for an unreachable acacia_log while holding 40 oak_log -> endless `collect oak_log`. Hot-patched into the run.
- `14cad26` rcon.js finds `mcserver/` from a git worktree (longrun in a worktree could not use RCON).
- `33d1ee9` **B6 `mcbot/eval.js`** (Node, not python: needs a mineflayer "Judge" player for chat/`come`).
  `node eval.js --model <label> [--llm url] [--only iron,night,home,orders] [--trials n]`, `node eval.js --report`.
  Bot `EVAL`, fresh memory, fresh untouched spot each scenario (counter `evals/state.json`, x/z 20000+ ring),
  prepared by a short client join + RCON clear/tp. Scenarios: iron (peaceful, 15 min, partial credit per tier),
  night (normal, time 9000 running, alive at dawn), home (sethome, kill, tp 60 m, restart with goal "go back home",
  <=5 m in 3 min), orders (10 exact chat commands; NL orders to add now that B7 exists).
  Results `evals/run_*.json` (tracked). **Never run live yet** (needs the bot slot): first `--only orders`.
  RCON output formats checked live (Pos, Health, `time query daytime`, `clear X item 0` = count).
- `4709e1c` **B7 `mcbot/chat.js`** + `test_chat.js`: any non-command chat -> LLM, JSON schema `{intent, arg, say}`,
  intents get/stop/resume/follow/come/set_home/go_home (names chosen so the 1.7B doesn't mix goal/go), FR persona,
  status + B4 memory + last 10 turns, few-shot examples. `get` arg validated by parseTarget (unknown item -> no
  action). bot.js: `command()` refactor (exact commands = fast path), `--no-chat`, `doing` var, slots via `/props`.
  `start-game.ps1 -Slots 2` default. test_chat: 18/22 intents, held-out 6/10 (fails "approche", "laisse tomber,
  fais ce que tu faisais", "colle moi"), ~250 ms. Says sometimes hallucinate ("marteau en bois"). -> B14 LoRA.
  **Never run in game yet.**
- `2410831` skills: placement cells refused by the server skipped 5 min (was: same bad cell 3x -> ban).
- `e75bb50` skills: `goto` aborts on danger (hostile <= 3.5 m or -4 hp since start); attack/flee use setGoal, not
  affected. The old "sudden deaths underground (lava?)" were most likely zombies.
- None of the skills fixes was tested live (`node test_skills.js` needs a 2nd bot: run it when the run is over).

### Findings to remember
- LLM role today: it follows the code's "Recommended action" 93% (56/60), task continuation = 31% of decisions.
  The real brain = planner + hint rules + skills. Proposed: `--no-hint` flag + B6 with/without hint = measure what
  the LLM does alone = target for B13-B15 training (label WITHOUT the hint, add free-goal/danger situations).
- Prompt size: decider ~850-950 tokens (system 411 fixed + obs 420-530), output ~5-10 tokens; chat ~900-1400.
- Iron pickaxe breaks after ~250 blocks: bot mines a lot of stone; planner rebuilds it.
- User wants the model to KNOW the game better. Proposed (not decided, maybe block B22): Minecraft quiz (~200 Q)
  on LFM3 / Qwen3.5-4B / Andy-4.2 first, then local wiki RAG, then optional domain LoRA (continued pretraining on
  wiki + paraphrases + 20-30% general replay), checked with quiz + B6 + B21 decision replay.

### Next
1. Finish run -> stats -> tick B5/B1. 2. Restart llama-server (2 slots). 3. `node test_skills.js` (fixes).
4. `node eval.js --model lfm3-base --only orders`, then all. 5. B7 live: talk to the bot in French in game.
6. `--no-hint` flag. 7. Merge `b6-b7` to main + push when green.

## State at end of session 2026-11-17 #2
- **Branch `main`** = B3 skills + B4 memory + B5 control merged and pushed (github noan-hbt/MineGPT).
  ROADMAP: B1 open (stats ok, no 1 h log yet), B2 [x], B3 [ ] (works live, see bugs), **B4 [x]**, **B5 [ ] = code done, 1 h run missing**.
- **Everything was stopped**: Claude Code killed llama-server, MC server and the bots (Windows RAM low: 16 GB with MC server,
  llama-server, 3 bot clients, Windows Update TiWorker 1.4 GB, Roblox, ChatGPT). Roblox + ChatGPT closed since.
  Restart: `.\start-game.ps1`, `.\start-mc.ps1`. Run ONE bot at a time.

### B5 — hierarchical control (`mcbot/control.js`, tests `node test_control.js` 7/7)
- Loop: reflexes (code) > current task > LLM decider. Task = the skill+arg the LLM picked. `collect`/`mine` repeat
  WITHOUT the LLM while the plan's first step is unchanged and the result is ok (max 6 runs). Task ends on failure or event
  (hostile appears, night/day flips, new goal, hp -4) -> LLM asked again. Log: source `task`, event `task_end` (why).
- Bans: action failing 3x within the last 12 actions -> banned 5 min (grammar + hint skip it). Catches A,B,A,B loops that the
  old "3x in a row" rule missed (B4 run: `collect coal_ore` <-> `explore south` 123x).
- Watchdog: progress = remaining plan cost (`planCost`). 20 actions without a new best -> ban the most used action 10 min,
  rotate explore direction, event `stuck`. Setback (death) resets the baseline. Free-text goals: item gain = progress,
  unless the same action 8x. **Never fired live yet.**
- New in bot.js/skills.js: reflex `surface up` (in water + oxygen < 12 -> hold jump); `explore up` (staircase to open sky,
  swims if in water, digs path cells by hand when no pickaxe; hint uses it when the plan needs a surface block and the
  bot is underground); `goto crafting_table|furnace` (remembered station within 64 m; hint when `place` is banned);
  `--goals a,b,c` (queue up to 6 goals on the task stack); fix: no false "resuming" after restart with an empty stack.
- Live (bot `--name LFM5`, separate memory): empty inventory -> iron_pickaxe 22 actions / 4.6 min; diamond_pickaxe 26 actions /
  7 min; goal-queue run: place refused 3x -> banned -> goto crafting_table -> iron_helmet -> torches, killed (RAM) at ~6 min.
- **NEXT (to tick B5)**: one bot, 1 h: `node bot.js --name LFM5 --goals "16 torch,shield,bucket,diamond_sword,golden_apple"`
  (or `run-bot.ps1`). Check: no endless loop, watchdog `stuck` events if it blocks, `python stats.py` (source task vs llm).
  For a session without the user in game: `node mcbot/longrun.js [minutes]` (bot restart loop + spectator "Tester" that sends
  chat commands and kills the bot once). It runs bot.js from its own folder: to keep coding meanwhile, run it from a
  `git worktree` copy (junction `mcbot/node_modules`, copy `mcbot/memory/LFM.json`).

### B4 — closed
- Long unattended session (30 min before RAM kill): `tasks`/`memory` chat, goal stack (`goal 3 torch` -> done -> resumes
  iron_pickaxe), `sethome` + kill -> "back online" + home found, 20 LLM episode summaries, iron_pickaxe reached.
  Not seen live: chest memory, `goto <ore>`.

### Bugs seen (B3 execution, not fixed)
- 2 sudden deaths (hp 20 -> 0 in one action) during `explore` underground: lava or fall. Check pathfinder Movements
  (lava avoidance, maxDropDown) or add a lava check to explore.
- B4 run: `collect coal_ore` -> "no reachable coal_ore found" while observe() shows coal 12 m away (bot underwater).
  observe and gather disagree; not investigated.
- `place crafting_table` refused by the server 3x on the same spot (-38,41,637); findPlaceSpot keeps the same bad cell.
- Mining-in-water dig-time patch: still not checked on purpose.

### Other
- Server: difficulty peaceful, advance_time false, keep_inventory true. RCON gamerules snake_case on 1.21.11.
  `spreadplayers` needs spreadDistance >= 1 (`spreadplayers 0 600 1 60 false <name>`).
- **B21 closed: no.** `b21/eval.py compare()` = offline decision replay, reuse for B6/B15.
- **Training plan agreed:** DeepSeek tool-calling examples for the LoRA decider (B12-B15), labelled on REAL logged
  observations. B5 froze the action format (verbs above + `goto` stations + `explore up`). Then DAgger loop.
- User feedback: keep iterations short, test live early, stop chasing flaky edge cases.

## Next: see ROADMAP.md
Plan decided 2026-11-17 (blocks B1-B20): skills+recipe planner+memory, voice chat, LoRA training (option A: 1 base + 2 LoRA), teacher model, control app, Fabric mod.
