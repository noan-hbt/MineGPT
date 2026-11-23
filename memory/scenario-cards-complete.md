---
name: scenario-cards-complete
description: scenario cards must fully specify an episode (world, body, inventory, memory, order, events, judge, solution)
metadata:
  type: feedback
---

Scenario cards must be really complete: nothing an episode depends on may live outside its card (world, gamerules,
blocks, containers, entities, bot body/inventory/effects/food, bot memory, order, timeline, server-side judge,
limits, reference solution, seeded params).

**Why:** user (2026-11-17): "il faut que les cartes de scénario soient vraiment complètes hein".
**How to apply:** extend `notes/scenario-cards.md` + `bot/sim/cards.js` instead of hardcoding setup in runners;
every card ships a solution that passes `node sim/run_cards.js --policy script`. See [[mc-bot-roadmap]].
