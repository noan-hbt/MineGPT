---
name: lfm350m-experiments
description: Next project: improve LFM2.5-350M as bot policy via SFT/distill/RL/pref-opt/compression; teachers = frontier APIs, not LFM3
metadata:
  type: project
---

Decided 2026-11-17: next track = experiments on LFM2.5-350M (models/LFM2.5-350M-hf, HF safetensors, no GGUF yet)
as the card policy. Methods to compare: SFT, distillation (priority), compression (quant/prune), adaptation
(LoRA per domain), RLVR/GRPO with the card judge as reward, DPO/ORPO/KTO on success/fail rollout pairs,
weight-space programming (wedit, see [[weight-writing-retention]]), or a mix. Classic RLHF reward model skipped:
the judge replaces it.

Teacher / reference models for traces: DeepSeek, Claude, ChatGPT (frontier APIs). NOT LFM3-1.7B.

**Why:** user judges frontier models better suited as teachers than LFM3.
**How to apply:** generate traces with those APIs (+ script-policy card solutions); baseline = raw 350M on heldout
cards; one job at a time ([[ram-budget]]), short benches ([[short-benches]]). Fix skill bugs first: they cap
any model ([[scenario-cards-complete]]).
