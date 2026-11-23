---
name: project-memory-location
description: Project memory lives in localai/memory/ (in the repo), not in the global Claude memory dir
metadata:
  type: feedback
---

From 2026-11-17 (session 6) the user wants the project memory saved and updated ONLY inside the project:
`localai/memory/` (index `memory/MEMORY.md`), referenced by `localai/CLAUDE.md`.

**Why:** user's explicit choice; keeps project context with the project.
**How to apply:** write/update memory files in `localai/memory/`, never in `~/.claude2/projects/.../memory/` (that one only holds a pointer).
