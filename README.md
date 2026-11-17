# MineGPT

Minecraft bot (mineflayer) driven by a small local LLM (LiquidAI LFM3-1.7B on llama.cpp), aiming at a
specialised, voice-chatting, trained companion.

- `HANDOFF.md` — current state, setup, measurements
- `ROADMAP.md` — plan in blocks (B1…B21)
- `notes/` — short working notes (decisions, measurements)
- `mcbot/` — the bot (`bot.js`), decision logger (`logger.js`), log summary (`stats.py`)

## Run
```powershell
.\start-game.ps1   # llama-server :8080 (model in models/, not in git)
.\start-mc.ps1     # local MC 1.21.11 server in mcserver/ (not in git)
.\run-bot.ps1      # bot with auto-restart
```
Decision logs: `mcbot/logs/*.jsonl` → `python mcbot/stats.py` (latest session) or `--all`.
