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

## State 2026-11-17 session #3 (RESUME HERE)
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
