---
name: lockstep-why
description: Why MineSim keeps lockstep despite fidelity bugs — speed x8 and world pauses while the LLM thinks; user chose a server mod to freeze the player
metadata:
  type: project
---

Lockstep (sim/lockstep.js) is the MineSim mode to keep. It is ~x8 faster than x1, and the world pauses while the LLM decides, so mind-loop results don't depend on GPU latency. On 2026-11-17 we found that vanilla `tick freeze` never freezes players: air, regen, hunger, effects and sleep run too fast. The user chose to fix it with a server mod/plugin that freezes the player (option b), scheduled for session #16. x1-only cards are not an acceptable answer.

**Why:** if lockstep isn't faithful, the training and eval results produced on cards are wrong.
**How to apply:** measure any lockstep change against x1 (fidelity guard). Never resolve a gap by switching cards to x1. See [[scenario-cards-complete]].
