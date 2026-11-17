---
name: no-hardcoded-rules
description: MC bot — user rejects new hardcoded behaviour rules; wants models (LLM/trained policy) to decide
metadata:
  node_type: memory
  type: feedback
  originSessionId: 047c70ea-cb91-4635-b01d-4509ffa541e0
  modified: 2026-11-17T08:25:02.476Z
---

Don't propose hardcoded fixes for bot behaviour (e.g. dropping `collect X` from grammar when plan doesn't need it). User declined 2026-11-17: "ça me fait chier que tout soit codé en dur au lieu de laisser le choix au llm".

**Why:** user wants decisions learned by models; code only for survival reflexes + safety. B5 1 h run stuck 33 min on diamond_sword; direction chosen = strategist (big LLM, called by watchdog instead of bans) + trained executor (B19-style policy or LoRA). Details in localai/notes/b5-run-and-architecture.md.

**How to apply:** fix bot loops via better info in prompt, training data, or strategist escalation — not new rules. Related: [[mc-bot-roadmap]].
