---
name: lockstep-why
description: Why MineSim keeps lockstep (x8 speed, world pauses while the LLM thinks); player-tick bug fixed by a Fabric mod (session #16)
metadata:
  type: project
---

Lockstep (sim/lockstep.js) is the MineSim mode to keep. It is ~x8 faster than x1, and the world pauses while the LLM decides, so mind-loop results don't depend on GPU latency. On 2026-11-17 we found that vanilla `tick freeze` never freezes players: air, regen, hunger, effects and sleep run too fast. The user chose to fix it with a server mod that freezes the player (option b). Done in session #16: sim instances run Fabric with bot/sim/mod (player ticks skipped while frozen and not stepping), so lockstep now matches x1 on Air and sleep. Making cards x1-only is not an acceptable answer.

**Why:** if lockstep isn't faithful, the training and eval results produced on cards are wrong.
**How to apply:** measure any lockstep change against x1 (fidelity guard). Never resolve a gap by switching cards to x1. See [[scenario-cards-complete]].
