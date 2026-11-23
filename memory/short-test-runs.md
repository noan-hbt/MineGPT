---
name: short-test-runs
description: "User wants live bot test runs of ~1 min when iterating, not 5 min"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 05d44696-44d6-4e7b-bd90-0cd9f256de36
  modified: 2026-11-17T10:11:51.717Z
---

Live bot tests (solo.js, eval runs) default to **1 minute** while iterating on details; longer only when asked.

**Why:** 2026-11-17 user: "5 c trop long si on itère à chaque détail".
**How to apply:** `node solo.js --minutes 1 ...`; keep benches short ("ne fais pas des tests trop longs"). Related: [[mc-bot-roadmap]].
