# MineGPT v2 roadmap

Plan and rationale: `notes/harness-v2.md`. Contract: `notes/spec-v2.md` (H1, then `spec/`).
v1 (blocks B1-B23, one verb from a closed grammar + code hint) is archived on branch `v1-archive`, tag `v1-final`.

- [x] **H1 spec**: sheet schema, turn formats, full DSL + tools, events, ledger -> `spec/` (grammar, JSON schemas, golden examples)
  Done 2026-11-17: `spec/` + reference parser `bot/dsl/` (176 golden cases, `cd bot; npm test`).
- [x] **H2 sheet**: big situation sheet renderer + ledger + mental map + more inputs in `bot/`, logged live
  Done 2026-11-17: `bot/state/` (perception, events, ledger, map, memory, affordances from `spec/recipes.json`),
  `bot/render.js` (sheet r1), `bot/harness.js` (live log), `eval/sheet_tokens.py`. Full sheet ~5.2k tokens, diff ~1.4-1.9k.
- [ ] **H3 DSL interpreter** (JS) covering the action families, rich results -> scripted live runs pass
- [ ] **H4 MineSim**: vanilla server sprinted + lockstep mineflayer, scenario cards, snapshots; measure throughput first
- [ ] **H5 knowledge base**: minecraft-data + wiki dump + teacher guides -> RAG + QA sets, facts validated
- [ ] **H6 teacher datasets** at scale (GPT / DeepSeek / Claude, sim + live): 5k+ episodes, validity > 95%
- [ ] **H7 SFT**: 350M "hands" + 1.7B "mind", sim eval, ablations
- [ ] **H8 continual loop**: prediction, hindsight, DAgger, GRPO, regression gate
- [ ] **H9 live deployment** of the two-model stack, live success vs v1
