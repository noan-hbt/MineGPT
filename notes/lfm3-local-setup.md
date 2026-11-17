---
name: lfm3-local-setup
description: "Local LLM setup in localai/ — LFM3-1.7B QAD-Q4_0 on llama.cpp CUDA, tuned flags and measured tps on RTX 4070 Laptop"
metadata:
  type: project
  modified: 2026-11-17T02:44:10.045Z
---

User runs LFM3-1.7B-QAD-Q4_0 via llama.cpp b12445 (CUDA 13.5); user rejected LM Studio. Goal shifted (2026-11-17) to a fast single game-playing agent; Minecraft bot working and playable with user (in-game name ZeiK_0, op): start-game.ps1 + start-mc.ps1 + run-bot.ps1 (1.21.11 offline server). Key lesson: LFM3-1.7B obeys a code-computed hint only when it is the LAST line of the prompt; otherwise it copies recent actions. Full state in localai/HANDOFF.md.

Hardware: RTX 4070 Laptop 8GB, i9-13900HX (P-cores = logical 0-15), 16GB RAM, slow HF downloads (~0.1-3 MB/s).

Tuning findings: `--backend-sampling` +60% parallel; `--no-kv-unified` +15% single; P-core pin `-C 0xFFFF --cpu-strict 1 --prio 2` stabilises parallel; KV quant and ubatch>1024 no gain; `--mlock` removed in this build. Results: 1 agent ~140 tps, 4 agents ~120 each, 8 agents ~400-640 aggregate.

Multi-instance test (2026-11-17): 3 llama-server instances on the 8GB GPU = failure (VRAM 7.7/8GB, GPU 100% but ~0 tok/s, Windows time-slicing between CUDA processes). Stay on 1 instance. User judged a big swarm "not viable" on this hardware. Swarm sweet spot: 8-16 agents, ~350-400 tok/s total (`swarm_server.py -k 1 --slots 16 --ctx 8192` + `swarm.py`, dashboard at :8080/dash).
