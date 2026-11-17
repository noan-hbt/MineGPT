---
name: weight-writing-retention
description: Conclusion of the b19/wedit direct weight-writing test: retains very well, does not generalise -> candidate for injecting knowledge
metadata:
  type: project
---

2026-11-17, Codex experiment `b19/wedit/` on LFM2.5-350M: added analytic memories on top of lm_head (closed-form
ridge / RBF key-value, 0 original weights rewritten, +4.6M..+67M params, no gradient training). Results: unseen
episodes = exactly the base model (gpt_test .290, ds_test .516 top1); seen/leaky real test .948-.979 (base .683).
Stopped by the user before the v4/v5 evals and REPORT.md (scripts + models `models/LFM2.5-350M-wedit*` kept).

**User conclusion:** direct weight writing is effective at making the model *retain* -> may be used later to give
the models more knowledge (Minecraft facts: recipes, drops, tool tiers...), alongside SFT on the KB and `wiki()` RAG.
**Nuance to remember:** retention was measured on memorised decision states, not on facts asked in new phrasings;
B21 (MEMIT/LoRA on facts) earlier damaged decisions. A knowledge-injection test must check paraphrased recall AND
no regression on harness behaviour. Related: [[mc-bot-roadmap]].
