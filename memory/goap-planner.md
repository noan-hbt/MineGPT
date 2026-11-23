---
name: goap-planner
description: GOAP planner + achieve executor (LLM = translator/arbiter) built 2026-11-18; planner alone 54/54 have-cards
metadata:
  type: project
---
User proposed (2026-11-18) a GOAP/BT planner with the LLM as "traducteur & arbitre"; chose **default execution**
(executor runs the plan, LLM steps in on new plan / failure / surprise / chat). Code: bot/plan/goap.js (pure
planner), bot/plan/live.js (`achieve` verb + `tool: plan`), design + results in notes/goap.md.
Planner alone (`run_cards.js --policy achieve`) = 54/54 have-cards (seeds 1,2) in 277 s.

**Why:** small LLMs fail on act/arg format; a goal predicate is far easier for a 350M.
**How to apply:** planner = facts tool, model may override with raw verbs (consistent with [[no-hardcoded-rules]]).
Mind bench 2026-11-18: Bonsai-2B 5/6 (calls `tool: plan`, never `achieve`; grammar caps confounded); user leans to
keep Bonsai. Next = --no-goap flag, bench with/without on the same grammar, then d2 cards (HANDOFF RESUME HERE). Killing a lockstep run freezes the sim: restart it.
