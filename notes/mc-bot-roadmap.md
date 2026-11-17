---
name: mc-bot-roadmap
description: Decided plan (2026-11-17) for specialised Minecraft bot — blocks B1-B20 in localai/ROADMAP.md, option A, teacher model choice
metadata:
  type: project
---

User wants a Minecraft-specialised, voice-chatting, trained bot ending as a control app (+ optional Fabric mod). Full block plan in `localai/ROADMAP.md` (B1-B20, checkboxes) — read it first and continue from the first unchecked block.

Decisions: **option A** = one llama-server, LFM3-1.7B base + 2 LoRA adapters (decider, chat) selected per request; motor control stays in mineflayer (no pixel RL); training = decision/skill level over all behaviours. Teacher model allowed: DeepSeek API (fast, cheap, favourite) or ChatGPT — user corrected me 2026-11-17: their ChatGPT subscription CAN now be used via the API. User also wants to test direct weight editing (ROME/MEMIT) at some point = block B21. Base model re-checked 2026-11-17: LFM3-1.7B stays (best BFCL/IFEval in class); HF bf16 weights in localai/models/LFM3-1.7B-hf/. Voice = modular STT → LLM → TTS, French.

**Why:** 8GB VRAM can't host a 2nd model process; LLM latency isn't the bottleneck, architecture is.
**How to apply:** start with B1 log → B2 recipe planner → B3 skills → B4 memory → B5 hierarchical loop; kick off B11 HF weight download early (slow network). Related: [[lfm3-local-setup]].
