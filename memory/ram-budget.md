---
name: ram-budget
description: 16 GB RAM is tight — background jobs get killed; don't stack llama-server + card runs + Codex batches
metadata:
  type: project
---

On 2026-11-17 Claude Code killed background jobs twice for low memory (commit reached 18.5 GB on 16 GB RAM):
sim server (java ~1.1 GB) + card runs (node) + llama-server + 6 Codex processes (~170 MB each) + Docker/WSL +
Minecraft launcher. The user let Claude close Docker Desktop, WSL and the launcher (-3.5 GB commit).

**Why:** a killed run loses its results (x1 fidelity run cut at 101/105, a 24-task bench lost).
**How to apply:** run LLM benches with the sim server stopped (`node sim/instance.js stop 0`), card runs without
llama-server, Codex batches alone or with light work. Check free RAM before stacking jobs. See [[llm-speed-levers]].
