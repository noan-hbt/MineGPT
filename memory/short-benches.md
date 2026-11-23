---
name: short-benches
description: model comparisons/benches must be short (a few min), generic, not blocking dev
metadata:
  type: feedback
---

Model benches: keep them a few minutes (few tasks, capped tokens), run in background; never 20-40 min.
Compare models on generic tasks (efficiency, speed, availability on one same task), NOT Minecraft knowledge or our
DSL format (those come from training).

**Why:** user (2026-11-17) refused a 20-40 min bench: "pas envie d'attendre et d'immobiliser le dev juste pour ça".
**How to apply:** default `eval/model_bench.py --n 2 --max-tokens 1024`. Same spirit as [[short-test-runs]].
