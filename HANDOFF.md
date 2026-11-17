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
- Loop: `observe()` -> LLM picks ONE high-level action -> Mineflayer executes it (with per-action timeout).
  Actions: collect/craft/place/attack/flee/eat/explore/come/wait.
- **Per-tick dynamic grammar**: only currently valid options (visible blocks minable with current pickaxe tier,
  craftable items, present mobs, food) -> 100% valid actions. Options that failed 3x in a row are removed.
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
- No progression beyond stone pickaxe (then mines stone forever). No iron/furnace, night shelter, farming.
- Bot does not talk (no LLM chat replies). Ideas: LLM chat replies, commands like "mine iron" / "build shelter",
  use RCON for scripted tests.

## State at end of session 2026-11-17 (resume here)
- **B2 recipe planner committed on main** (`mcbot/planner.js`, `node mcbot/test_planner.js` passes). bot.js: `goal <item> [n]`
  sets the planner target (default `iron_pickaxe`), Plan line in the observation, grammar focused on plan steps,
  new actions `smelt <item>`, `place furnace`, explore down; blocks the pathfinder failed on are hidden for a while;
  stations farther than STATION_RANGE are ignored (re-place instead of walking back).
- **NEXT: live test of B2** (was paused right after the bot reached `place crafting_table`). Run start-game, start-mc,
  run-bot, `goal iron_pickaxe`, watch `mcbot/last_obs.txt` + `mcbot/logs/*.jsonl`. Then tick B2 (and B1 after a real 1 h run).
- **B21 closed: no.** Weight editing (ROME/MEMIT) and a LoRA trained on isolated facts both wreck decisions on logged
  ticks (276 → 205 / 166 of 300). World facts go in context (B4). Verdict in `b21/REPORT.md`.
- **Reusable from B21:** `b21/eval.py` `compare()` replays logged decisions (argmax log-prob over the valid options)
  = offline eval of any HF model/LoRA without Minecraft → use for B6 / B15.
- **Training plan agreed with the user:** mass DeepSeek-generated tool-calling examples are worth it for the LoRA
  decider (B12-B15), NOT for weight editing. Rules: label REAL logged observations (teacher sees plan + memory),
  keep actions that succeeded in game, exact prod format (`verb arg` + bot SYSTEM), diversity over volume,
  mix general data, low rank / few epochs, judge with the decision replay. Then DAgger loop (student plays, teacher relabels).
  Only start mass generation after B3/B5 freeze the action format.
- Codex was judged not very relevant on B21 (bad fact choice, broken metrics). If delegating again, give tight scope + metrics.
- `mcbot/last_obs_LFM2.txt` = untracked debug leftover, can be deleted.

## Next: see ROADMAP.md
Plan decided 2026-11-17 (blocks B1-B20): skills+recipe planner+memory, voice chat, LoRA training (option A: 1 base + 2 LoRA), teacher model, control app, Fabric mod.
