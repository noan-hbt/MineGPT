# MineGPT v2 roadmap

Plan and rationale: `notes/harness-v2.md`. Contract: `notes/spec-v2.md` (H1, then `spec/`).
v1 (blocks B1-B23, one verb from a closed grammar + code hint) is archived on branch `v1-archive`, tag `v1-final`.

- [ ] **H1 spec**: sheet schema, turn formats, full DSL + tools, events, ledger -> `spec/` (grammar, JSON schemas, golden examples)
- [ ] **H2 sheet**: big situation sheet renderer + ledger + mental map + more inputs in `bot/`, logged live
- [ ] **H3 DSL interpreter** (JS) covering the action families, rich results -> scripted live runs pass
- [ ] **H4 MineSim**: vanilla server sprinted + lockstep mineflayer, scenario cards, snapshots; measure throughput first
- [ ] **H5 knowledge base**: minecraft-data + wiki dump + teacher guides -> RAG + QA sets, facts validated
- [ ] **H6 teacher datasets** at scale (GPT / DeepSeek / Claude, sim + live): 5k+ episodes, validity > 95%
- [ ] **H7 SFT**: 350M "hands" + 1.7B "mind", sim eval, ablations
- [ ] **H8 continual loop**: prediction, hindsight, DAgger, GRPO, regression gate
- [ ] **H9 live deployment** of the two-model stack, live success vs v1
