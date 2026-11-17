---
name: mc-bot-roadmap
description: "Decided plan (2026-11-17) for specialised Minecraft bot — blocks B1-B20 in localai/ROADMAP.md, option A, teacher model choice"
metadata:
  node_type: memory
  type: project
  originSessionId: e8fc4a6a-2ef1-4dbd-92ba-8142a105c071
  modified: 2026-11-17T11:59:04.217Z
---

User wants a Minecraft-specialised, voice-chatting, trained bot ending as a control app (+ optional Fabric mod). Full block plan in `localai/ROADMAP.md` (B1-B20, checkboxes) — read it first and continue from the first unchecked block.

Decisions: **option A** = one llama-server, LFM3-1.7B base + 2 LoRA adapters (decider, chat) selected per request; motor control stays in mineflayer (no pixel RL); training = decision/skill level over all behaviours. Teacher model allowed: DeepSeek API (fast, cheap, favourite) or ChatGPT — user corrected me 2026-11-17: their ChatGPT subscription CAN now be used via the API. 2026-11-17 later: teacher will probably be Command Code + `deepseek-v4.1-flash-1017` on the user subscription (no paid API). User also wants to test direct weight editing (ROME/MEMIT) at some point = block B21. Base model re-checked 2026-11-17: LFM3-1.7B stays (best BFCL/IFEval in class); HF bf16 weights in localai/models/LFM3-1.7B-hf/. Voice = modular STT → LLM → TTS, French.

Status end of 2026-11-17 (session 2): B2+B4 ticked, B3/B4/B5 merged to main and pushed. B5 code done (control.js: tasks, sliding bans, progress watchdog), only the 1 h live run is missing (RAM kill). One bot at a time on this 16 GB PC (see HANDOFF.md). User got annoyed by long offline debug loops on B3: keep iterations short, test live early, don't chase flaky edge cases. User wants momentum: short tests, stop fast when the bot drifts. B21 CLOSED: no (MEMIT/LoRA-on-facts wreck logged decisions; context B4 wins); branch merged, `b21/eval.py compare()` decision replay kept as offline eval for B6/B15. User judged Codex's B21 work weak — if delegating, tight scope + sane metrics. Agreed: DeepSeek mass tool-calling data is for the LoRA decider (B12-B15), labelled on real logged observations, after B3/B5 freeze the action format.

Status session 3 (2026-11-17 ~08:30): RESUME FROM HANDOFF.md section "State 2026-11-17 session #3". B5 1 h run (B5RUN, worktree ../localai-b5run) was running, 6 goals reached incl. diamond_pickaxe; finish = stats + tick B5/B1. Branch `b6-b7` (not pushed): B6 eval.js, B7 chat.js, planner/skills fixes, all untested live. Insight shared with user: LLM follows the code hint 93% -> plan `--no-hint` eval as training target. User wants more game knowledge in the model: proposed quiz -> RAG wiki -> domain LoRA (maybe B22), not decided.

Status session 5 (2026-11-17 ~12:00): RESUME FROM HANDOFF.md section "State 2026-11-17 session #5". B19 experiments in localai/b19/ (untracked): on real logs LFM2.5-350M full SFT 98.6% top1 > policy net 90.3% > 350M zero-shot 68.3%; synthetic teacher episodes via synth.py (DeepSeek via Command Code, GPT 6.1 sol medium via Codex, same scenario cards). User wants all executor options compared + router idea (B23, cascade policy->small LLM->strategist).

Session 6 (2026-11-17 ~12:25): real-log test was leaky (split by 30-tick blocks, 6/8 test sessions in train) -> 98.6% = memorisation; real-log LoRA 1.7B scores 25.8% on unseen GPT episodes (< LFM3 zero 35.5%). GPT teacher chosen over DeepSeek (0 empty eps, 2x faster). **User direction:** iterate fast on LFM2.5-350M in a loop (teacher data train -> test on DIFFERENT held-out data/teacher), target ~80% top1, only then train the 1.7B; needs very varied datasets; user finds the current harness/loop (one action from a fixed grammar) "très restreint et nul", wants to redesign it to exploit fine-tuned LLMs much more. Codex delegated direct weight editing of the 350M (b19/wedit/). Harness v2 plan agreed (notes/harness-v2.md rev 3): big situation sheet 10-20k tok, LLM called very often (free/fast, don't ration), huge action space + tools, distil GPT/DeepSeek/Claude into 350M "hands" (fast multi-turn tool calls) + 1.7B "mind" (knowledge/reasoning), much wider Minecraft KB, continual learning on own logs. Next = H1 spec / H2 sheet in mcbot. Decided later same day: actions = DSL lines; Claude teacher via user's subscription (Claude Code); minecraft.wiki dump OK + other sources; CLEAN RESTART (v1 = branch v1-archive / tag v1-final; keep models/, llama.cpp/, mcserver/, venv, node_modules; NEVER touch remote/ = remote access). Spec draft: notes/spec-v2.md.

Session 7 (2026-11-17): v2 started. Branch `v2`; v1 code removed from tree, v1 data in data/v1/, big v1 outputs in archive/v1/, venv at .venv/, node deps in bot/. ROADMAP.md = H1-H9. H1 frozen in spec/ (DSL lines for both models, parser bot/dsl). Keep models/LFM2.5-350M-wedit* + base models as reference baselines to measure fine-tuning gains (user, don't delete). Next = H2.

**Why:** 8GB VRAM can't host a 2nd model process; LLM latency isn't the bottleneck, architecture is.
**How to apply:** start with B1 log → B2 recipe planner → B3 skills → B4 memory → B5 hierarchical loop; kick off B11 HF weight download early (slow network). Related: [[lfm3-local-setup]].
