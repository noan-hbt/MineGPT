---
name: codex-helper
description: User wants Codex (gpt-6.1-sol, medium) used to parallelise bulk work like writing scenario cards
metadata:
  type: user
---

The user asked (2026-11-17) for "beaucoup beaucoup" of cards and said Codex with gpt-6.1-sol medium can help.
What worked: a brief file (`notes/cards-codex-brief.md`), then 6 parallel `codex exec -s workspace-write
-c model_reasoning_effort=medium "<brief> + batch list"` runs, one area each, writing only their own files,
offline validation only (no server). 70/72 cards delivered in ~15 min; nearly all valid once run.

**Why:** bulk, well-specified work goes faster in parallel; Claude keeps review + server validation.
**How to apply:** for bulk content, write a brief + explicit id lists, forbid touching shared files and the sim
server, then validate on the server yourself. `codex exec` prints "Reading additional input from stdin..." —
harmless. Mind RAM: see [[ram-budget]]. Cards rules: [[scenario-cards-complete]].
