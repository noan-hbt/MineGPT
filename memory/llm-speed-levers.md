---
name: llm-speed-levers
description: What makes local LLMs faster here — reasoning budget is the lever; flags/speculation give ~nothing (2026-11-17)
metadata:
  type: project
---

Measured 2026-11-17 (session #17) on the RTX 4070 Laptop, llama.cpp b12445:
- Decode is memory-bandwidth bound (~80% of peak on 4B Q4_K_M). `-fa on` always >= off; other flags ~0 gain.
- No downloaded model has MTP heads and none of the small ones shares a tokenizer with the 4B ones: no
  draft-model speculation. ngram speculation: no gain on free reasoning text (untested on DSL output).
- `--reasoning-budget 256` on Nemotron3-Nano-4B: same accuracy on 8 tasks, tokens /2.3, correct answers per
  minute x2.2. LFM3-1.7B ignores the budget (re-reasons in the answer). Not yet confirmed on 24 tasks.

**Why:** the user wants the models "hyper rapides sans perdre en qualité"; tokens per answer, not tok/s, decide.
**How to apply:** optimise tokens per answer (budget, prompt) and measure correct/min with `eval/model_bench.py
--server-args ... --tag ...`; don't spend time on flag tuning. See [[short-benches]], [[lfm3-local-setup]], [[ram-budget]].
