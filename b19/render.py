"""Render a structured bot state exactly like mcbot/bot.js observe() does (obs_text + grammar).

Used to turn synthetic (DeepSeek) states into the same prompt text the bot sends in prod.
  python b19/render.py      # self-check: re-render real logged states and compare with the logged obs_text
"""
import json
from pathlib import Path

HOSTILE = {'zombie', 'skeleton', 'creeper', 'spider', 'husk', 'drowned', 'stray', 'witch', 'enderman', 'slime',
           'cave_spider', 'zombie_villager', 'pillager', 'phantom', 'bogged', 'silverfish', 'breeze'}


def obs_text(s, hint, llm_only=False):
    """s = structured state (same keys as the logged obs). hint = 'Recommended action' (code hint)."""
    mobs = ", ".join(f"{n}{'(hostile)' if n in HOSTILE else ''} {d}m" for n, d in (s.get("mobs") or {}).items()) or "none"
    blks = ", ".join(f"{n} {d}m" for n, d in sorted((s.get("blocks") or {}).items(), key=lambda kv: kv[1])) or "none"
    inv = ", ".join(f"{n} x{c}" for n, c in (s.get("inv") or {}).items()) or "empty"
    hist = "; ".join(f"{h['a']} -> {h['r']}" for h in (s.get("history") or [])[-4:]) or "none"
    craft = ", ".join(s.get("craftable") or []) or "nothing"
    plan = s.get("plan")
    if not plan:
        plan_txt = "none (free-text goal)"
    elif plan.get("done"):
        plan_txt = "goal reached"
    elif plan.get("error"):
        plan_txt = "unknown: " + str(plan["error"])
    else:
        st = plan.get("steps") or []
        plan_txt = " > ".join(st[:4]) + (f" (+{len(st) - 4})" if len(st) > 4 else "")
    mem = s.get("memory") or ""
    t = f"Goal: {s.get('goal')}\n"
    t += (mem + "\n") if mem else ""
    t += f"Time: {'night' if s.get('night') else 'day'}{' (in shelter)' if s.get('sheltered') else ''}. Health {s.get('hp')}/20, food {s.get('food')}/20.\n"
    t += f"Nearby blocks: {blks}.\nMobs: {mobs}.\nInventory: {inv}.\n"
    t += f"Can craft now: {craft}. Crafting table nearby: {'yes' if s.get('table') else 'no'}. Furnace nearby: {'yes' if s.get('furnace') else 'no'}.\n"
    if not llm_only:
        t += f"Plan: {plan_txt}.\n"
    t += f"Recent actions: {hist}."
    if not llm_only:
        t += f"\nRecommended action: {hint}."
    return t


def grammar(options):
    return "root ::= " + " | ".join(f'"{v} " (' + " | ".join(json.dumps(a) for a in xs) + ")" for v, xs in options.items() if xs)


def selfcheck():
    here = Path(__file__).resolve().parent
    n = same = 0
    first_diff = None
    for name in ("train", "test"):
        for line in open(here / "data" / f"{name}.jsonl", encoding="utf8"):
            r = json.loads(line)
            if "plan" not in r["state"]:
                continue  # old log format (before B2/B4), not worth matching
            n += 1
            out = obs_text(r["state"], r["hint"], llm_only="Recommended action" not in r["text"])
            if out == r["text"]:
                same += 1
            elif first_diff is None:
                first_diff = (r["text"], out)
    print(f"exact match {same}/{n}")
    if first_diff:
        for a, b in zip(first_diff[0].split("\n"), first_diff[1].split("\n")):
            if a != b:
                print("LOG :", a); print("MINE:", b)


if __name__ == "__main__":
    selfcheck()
