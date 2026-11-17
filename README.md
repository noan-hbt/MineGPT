# MineGPT

Minecraft bot (mineflayer) driven by small local LLMs (LiquidAI LFM2.5-350M "hands" + LFM3-1.7B "mind" on
llama.cpp), trained by distilling big teacher models and by continual learning on its own logs.

**v2 in progress.** v1 is archived on branch `v1-archive` (tag `v1-final`).

- `ROADMAP.md` — v2 phases H1-H9
- `notes/harness-v2.md` — v2 plan, `notes/spec-v2.md` — v2 spec (H1)
- `HANDOFF.md` — current state

## Layout
```
bot/      live harness (node, mineflayer): perception, situation sheet, ledger, map, DSL interpreter, mind loop
sim/      MineSim: vanilla server sprinted + lockstep bot, scenario cards
kb/       Minecraft knowledge base (minecraft-data, wiki dump, ...) + wiki() index
teach/    teacher drivers and scenario cards
train/    SFT / GRPO / continual loop
eval/     sim eval, live bench, knowledge and tool-call evals
spec/     grammar, JSON schemas, golden examples (single source of truth)
data/     datasets and logs (not in git)
```

## Run
```powershell
.\start-game.ps1   # llama-server :8080 (models/ not in git)
.\start-mc.ps1     # local MC 1.21.11 server in mcserver/ (not in git)
```
Python: `.venv\Scripts\python.exe` (torch, transformers). Node deps: `bot/`.
