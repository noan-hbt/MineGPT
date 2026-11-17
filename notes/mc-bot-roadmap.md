---
name: mc-bot-roadmap
description: Decided plan (2026-11-17) for specialised Minecraft bot — blocks B1-B20 in localai/ROADMAP.md, option A, teacher model choice
metadata:
  type: project
---


User wants a Minecraft-specialised, voice-chatting, trained bot ending as a control app (+ optional Fabric mod). Full block plan in `localai/ROADMAP.md` (B1-B20, checkboxes) — read it first and continue from the first unchecked block.

Decisions: **option A** = one llama-server, LFM3-1.7B base + 2 LoRA adapters (decider, chat) selected per request; motor control stays in mineflayer (no pixel RL); training = decision/skill level over all behaviours. Teacher model allowed: DeepSeek API (fast, cheap, favourite) or ChatGPT — user corrected me 2026-11-17: their ChatGPT subscription CAN now be used via the API. User also wants to test direct weight editing (ROME/MEMIT) at some point = block B21. Base model re-checked 2026-11-17: LFM3-1.7B stays (best BFCL/IFEval in class); HF bf16 weights in localai/models/LFM3-1.7B-hf/. Voice = modular STT → LLM → TTS, French.

Status end of 2026-11-17 (session 2): B2+B4 ticked, B3/B4/B5 merged to main and pushed. B5 code done (control.js: tasks, sliding bans, progress watchdog), only the 1 h live run is missing (RAM kill). One bot at a time on this 16 GB PC (see HANDOFF.md). User got annoyed by long offline debug loops on B3: keep iterations short, test live early, don't chase flaky edge cases. User wants momentum: short tests, stop fast when the bot drifts. B21 CLOSED: no (MEMIT/LoRA-on-facts wreck logged decisions; context B4 wins); branch merged, `b21/eval.py compare()` decision replay kept as offline eval for B6/B15. User judged Codex's B21 work weak — if delegating, tight scope + sane metrics. Agreed: DeepSeek mass tool-calling data is for the LoRA decider (B12-B15), labelled on real logged observations, after B3/B5 freeze the action format.

**Why:** 8GB VRAM can't host a 2nd model process; LLM latency isn't the bottleneck, architecture is.
**How to apply:** start with B1 log → B2 recipe planner → B3 skills → B4 memory → B5 hierarchical loop; kick off B11 HF weight download early (slow network). Related: [[lfm3-local-setup]].
