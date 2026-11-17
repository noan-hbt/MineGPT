"""B19 source A: a teacher LLM (DeepSeek via Command Code, or GPT via Codex) invents whole bot episodes in all kinds of situations.

Real logs give the STRUCTURE only (state schema, option rules, result strings). The content (world, goal,
inventory, dangers, failures, decisions) is invented, steered by a random scenario card per episode.
Every decision is validated (names exist in minecraft-data 1.21.11, action legal) and rendered with
render.py into the exact prod prompt text.

  python b19/synth.py --episodes 4 --workers 2          # pilot
  python b19/synth.py --episodes 400 --workers 6        # bulk -> b19/data/synth.jsonl (appends)
  python b19/synth.py --teacher gpt --episodes 10 --seed 1000 --out synth_gpt.jsonl   # same cards, other teacher
"""
import argparse
import json
import random
import re
import shutil
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from render import obs_text, grammar

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
DATA = HERE / "data"
RAW = HERE / "runs" / "synth_raw"
WORKDIR = HERE / "runs" / "cc_work"  # empty dir: Command Code runs here, never in the repo
MODEL = "deepseek/deepseek-v4.1-flash"

NAMES = json.load(open(DATA / "mc_names.json", encoding="utf8"))
ITEMS, BLOCKS, ENTITIES = set(NAMES["items"]), set(NAMES["blocks"]), set(NAMES["entities"]) | {"player"}
VERBS = {"collect", "goto", "mine", "craft", "place", "smelt", "attack", "flee", "eat", "shelter", "sleep", "farm",
         "store", "home", "explore", "come", "wait"}


def bot_system():
    """System prompt of the most recent real session (prod prompt)."""
    for f in sorted((ROOT / "mcbot" / "logs").glob("*.jsonl"), reverse=True):
        d = json.loads(open(f, encoding="utf8").readline())
        if d.get("kind") == "session" and "The Plan line" in d.get("system", "") and "Recommended" in d["system"]:
            return d["system"]
    raise SystemExit("no recent session with the prod system prompt")


def structure_example():
    """One real decision, trimmed to its structure (content is explicitly not to be copied)."""
    for line in open(DATA / "train.jsonl", encoding="utf8"):
        r = json.loads(line)
        s = r["state"]
        if (s.get("plan") or {}).get("steps") and s.get("mobs") and s.get("memory") and "banned" in s:
            st = {k: s.get(k) for k in ("goal", "pos", "hp", "food", "night", "sheltered", "blocks", "mobs", "inv", "tier",
                                    "craftable", "table", "furnace", "memory", "target", "banned", "plan")}
            opts = {}
            for o in r["legal"]:
                v, a = o.split(" ", 1)
                opts.setdefault(v, []).append(a)
            return {"state": st, "options": opts, "hint": r["hint"], "action": r["action"],
                    "reason": "<one short sentence>", "result": r["result"]}


# ---------- scenario cards (diversity knobs; DeepSeek fills in the content) ----------
GOALS = ["wooden_pickaxe", "3 torch", "16 torch", "stone_pickaxe", "iron_pickaxe", "furnace", "bucket", "shield",
         "iron_sword", "iron_helmet", "iron_chestplate", "diamond_pickaxe", "diamond_sword", "golden_apple", "bread",
         "4 cooked_beef", "chest", "crafting_table", "16 oak_planks", "bow", "8 arrow", "white_bed", "compass",
         "clock", "iron_axe", "stone_sword", "32 cobblestone", "8 glass", "ladder", "fishing_rod", "shears",
         "flint_and_steel", "diamond_chestplate", "anvil", "campfire", "boat", "lantern", "8 bread"]
FREE_GOALS = ["wait for orders", "survive the night", "explore and find a village", "gather food",
              "build a small shelter", "stay near the player"]
PHASES = ["fresh spawn, empty inventory", "a few logs only", "wooden tools", "stone tools and some coal",
          "iron tools, decent stock", "diamond pickaxe, rich inventory", "just respawned after dying, empty inventory, items lost far away"]
PLACES = ["plains surface", "dense forest", "desert (no trees nearby)", "snowy taiga", "jungle", "swamp with water",
          "mountain slope", "beach next to ocean", "shallow cave", "deep cave near lava", "deepslate level (y<0)",
          "ravine", "inside a mineshaft", "near a village", "dark forest", "badlands"]
TIMES = ["morning", "noon", "dusk (night soon)", "night", "night, in a shelter"]
VITALS = ["full health and food", "food low (<8)", "health low (<8)", "both health and food low", "food medium"]
DANGERS = ["no mobs", "passive animals around", "one zombie far away", "zombie close (<5m)", "creeper close",
           "skeleton shooting from 10m", "several hostiles at night", "spider + cave_spider underground",
           "enderman nearby (do not look/attack)", "drowned near water", "player nearby watching"]
TWISTS = ["the obvious action keeps failing (timeout / no path) so the bot must try something else",
          "inventory almost full", "a needed block is not visible, must explore or mine down",
          "crafting table placement refused by the server", "the plan has an error (unknown item)",
          "a remembered ore vein / station is far away", "some actions are banned by the controller",
          "nothing goes wrong", "nothing goes wrong", "goal completed midway, plan says goal reached",
          "bot is stuck repeating the same action, it must break the loop", "it gets dark during the episode",
          "takes damage while mining and must react", "falls in water / gets lost", "lava blocks the path"]


def card(rng):
    goal = rng.choice(GOALS) if rng.random() < 0.85 else rng.choice(FREE_GOALS)
    return {"goal": goal, "start": rng.choice(PHASES), "place": rng.choice(PLACES), "time": rng.choice(TIMES),
            "vitals": rng.choice(VITALS), "danger": rng.choice(DANGERS), "twists": rng.sample(TWISTS, 2),
            "length": rng.randint(14, 26)}


PROMPT = """You generate SYNTHETIC training data for a small model that controls a Minecraft 1.21 survival bot (mineflayer).
Invent ONE realistic episode: a sequence of decisions, each = the bot's observed state, the legal options, the action a
STRONG player would choose, and the result. The data must be coherent tick to tick (inventory, position, health,
time and plan evolve according to the results) and use exact Minecraft 1.21 ids (oak_log, raw_iron, deepslate_iron_ore...).

== The bot's system prompt (what the model sees, for context) ==
{system}

== How the state / options / hint are computed in the real bot (respect these rules) ==
- blocks: nearest distance in meters per interesting block type (logs, ores, stone, cobblestone, deepslate, sand, gravel,
  clay, crafting_table, furnace, chest, crops, melon, pumpkin...). Ores within 32 m, common stone within 16 m.
  crafting_table/furnace listed only within 12 m.
- mobs: nearest distance per mob type within 16 m ("player" for players).
- tier: best pickaxe (0 none, 1 wooden/golden, 2 stone, 3 iron, 4 diamond, 5 netherite).
- craftable: items craftable right now with the inventory (+ nearby crafting_table for 3x3 recipes).
- plan: recipe planner output from the real inventory toward the goal (target item), steps formatted like
  "collect 3 oak_log", "craft oak_planks x4", "craft stick x2", "place crafting_table", "smelt 3 raw_iron->iron_ingot".
  done=true when the goal item is in the inventory; plan=null for free-text goals (target=null too).
- memory: optional lines "Home: 44m north-east, 3 down." / "Remembered: iron_ore 30m west; furnace 15m east." /
  "Earlier: <one sentence summary>" / "Died recently (zombie) 20m south.". Empty string if nothing.
- options (verb -> args), only what is valid NOW:
  collect: visible blocks harvestable with the current tier (stone needs tier 1, iron/copper ore tier 2, diamond/gold ore tier 3)
  goto: remembered ore/station not visible; mine: ores the plan needs that are not visible; craft: craftable;
  place: crafting_table/furnace/chest in inventory and none within 16 m; smelt: inventory items if a furnace is near and there is fuel;
  attack: visible mobs; flee: visible hostile mobs; eat: foods in inventory if food<20; shelter ["here"]: night, not sheltered;
  sleep ["bed"]: night and bed nearby/in inventory; farm ["crops"]: ripe crops near; store ["chest"]: chest near and >=20 stacks;
  home ["base"]: home known and >16 m away; explore: north/south/east/west (+down if y>-50, +up if underground); come ["player"]: player visible;
  wait ["1"].
  FOCUS RULE: when a plan is active (not done, no error) and no hostile within 6 m, collect/craft keep only plan items, and come/wait/farm/home are removed.
  banned actions (state.banned) are removed from options.
- hint ("Recommended action") is computed by simple code: hostile <=6 m -> attack it (flee if health<=8 or creeper);
  else food<14 and food in inventory -> eat; else night+bed -> sleep bed; else night+can shelter -> shelter here;
  else plan step 0 turned into an action (collect visible block / goto / mine / explore); goal reached -> "wait 1";
  free-text goal -> "pursue the goal". The hint is often right but NOT always: the chosen action may differ when a
  strong player would do better (break a loop, react to a danger the code ignores, use a smarter route...).
- result strings like the real bot: "ok +3 oak_log", "ok crafted 4 oak_planks", "ok placed crafting_table",
  "ok smelted 3 iron_ingot", "ok ate bread", "ok", "zombie gone/killed", "failed: timeout", "failed: no path",
  "failed: server refused placement", "failed: missing ingredients", "mined but nothing picked up (+1 cobblestone)",
  "ok explored 24 blocks north", "ok fled". Failures must be plausible and the next decisions must react to them.

== Structure of one decision (REAL example: copy the STRUCTURE only, never its content) ==
{example}

== This episode's scenario card ==
{card}

== Output ==
Exactly {length} lines of JSONL, nothing else (no markdown fences, no comments, no tools). Each line:
{{"state": {{goal,pos,hp,food,night,sheltered,blocks,mobs,inv,tier,craftable,table,furnace,memory,target,banned,plan}},
 "options": {{verb: [args]}}, "hint": "...", "action": "<verb> <arg>", "reason": "<one short sentence>", "result": "..."}}
Do NOT include a history field (it is rebuilt from the previous lines). The action MUST be one of the options.
state.goal stays EXACTLY the scenario card goal for the whole episode (never invent new orders).
The hint must follow the code rules above literally (e.g. plan error -> "explore <dir>", not "pursue the goal").
Prefer many different verbs and situations over long repetitive collect streaks."""


TEACHERS = {
    "deepseek": "deepseek/deepseek-v4.1-flash (Command Code)",
    "gpt": "gpt-6.1-sol, reasoning medium (Codex)",
}
TEACHER = "deepseek"


def ask(prompt, timeout=900):
    WORKDIR.mkdir(parents=True, exist_ok=True)
    if TEACHER == "gpt":
        exe = shutil.which("codex") or shutil.which("codex.cmd")
        cmd = [exe, "exec", "-m", "gpt-6.1-sol", "-c", 'model_reasoning_effort="medium"', "-s", "read-only",
               "--skip-git-repo-check", "--ephemeral", "-C", str(WORKDIR), "-"]
    else:
        exe = shutil.which("commandcode") or shutil.which("commandcode.cmd")
        cmd = [exe, "-p", "-m", MODEL, "--no-session", "--skip-onboarding", "--max-turns", "1", "--trust"]
    p = subprocess.run(cmd, input=prompt, capture_output=True, text=True, encoding="utf8", cwd=WORKDIR, timeout=timeout)
    return p.stdout, f"exit {p.returncode}: {p.stderr[-500:]}"


def name_ok(n, kinds):
    return any(n in k for k in kinds)


def validate(d):
    """returns error string or None"""
    s, opts = d.get("state"), d.get("options")
    if not isinstance(s, dict) or not isinstance(opts, dict):
        return "missing state/options"
    for k in ("inv", "blocks", "mobs"):
        if not isinstance(s.get(k) or {}, dict):
            return f"{k} not a dict"
    for n in (s.get("inv") or {}):
        if n not in ITEMS: return f"unknown item {n}"
    for n in (s.get("blocks") or {}):
        if n not in BLOCKS: return f"unknown block {n}"
    for n in (s.get("mobs") or {}):
        if n not in ENTITIES: return f"unknown mob {n}"
    for n in (s.get("craftable") or []):
        if n not in ITEMS: return f"unknown craftable {n}"
    for v, xs in opts.items():
        if v not in VERBS: return f"unknown verb {v}"
        if not isinstance(xs, list): return "options args not a list"
        for a in xs:
            if v in ("collect", "mine", "goto") and not name_ok(a, (BLOCKS, ITEMS)): return f"unknown {v} arg {a}"
            if v in ("craft", "place", "smelt", "eat") and a not in ITEMS: return f"unknown {v} arg {a}"
            if v in ("attack", "flee") and a not in ENTITIES: return f"unknown mob arg {a}"
    legal = [f"{v} {a}" for v, xs in opts.items() for a in xs]
    if d.get("action") not in legal:
        return "action not legal"
    if not isinstance(d.get("result"), str):
        return "no result"
    return None


def episode(i, seed, system, example):
    rng = random.Random(seed)
    c = card(rng)
    prompt = PROMPT.format(system=system, example=json.dumps(example), card=json.dumps(c), length=c["length"])
    t0 = time.time()
    out, err = "", ""
    for attempt in range(2):  # empty answer (rate limit / CLI error) -> one retry
        try:
            out, err = ask(prompt)
        except Exception as e:  # timeout etc.
            out, err = "", str(e)[:300]
        if out.count("{") > 5:
            break
    RAW.mkdir(parents=True, exist_ok=True)
    (RAW / f"{TEACHER}_ep_{seed}.txt").write_text(out, encoding="utf8")
    if out.count("{") <= 5:
        (RAW / f"{TEACHER}_ep_{seed}.err.txt").write_text(err, encoding="utf8")
        return {"i": i, "card": c, "error": "empty answer: " + err[-200:], "rows": [], "bad": {}, "s": round(time.time() - t0, 1)}
    rows, bad, history = [], {}, []
    session = f"synth_{TEACHER}_{seed}"
    for k, line in enumerate(l for l in out.splitlines() if l.strip().startswith("{")):
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            bad["json"] = bad.get("json", 0) + 1
            continue
        err = validate(d)
        s = d.get("state") if isinstance(d.get("state"), dict) else {}
        if not err:
            s = {**s, "history": history[-4:], "focus": False, "dim": "overworld"}
            s.setdefault("memory", "")
            legal = [f"{v} {a}" for v, xs in d["options"].items() for a in xs]
            verb = d["action"].split(" ")[0]
            ok = bool(re.match(r"^ok\b", d["result"])) or d["result"].endswith("gone/killed")
            rows.append({"session": session, "tick": k + 1, "goal": s.get("goal"), "system": system,
                         "text": obs_text(s, d.get("hint", "")), "grammar": grammar(d["options"]),
                         "state": s, "legal": legal, "action": d["action"], "ok": ok, "source": TEACHER,
                         "hint": d.get("hint"), "result": d["result"], "reason": d.get("reason"),
                         "keep": verb != "wait" or s.get("night", False), "card": c})
        else:
            key = err.split(" ")[0] + " " + err.split(" ")[1] if " " in err else err
            bad[key] = bad.get(key, 0) + 1
        if isinstance(d, dict) and isinstance(d.get("action"), str):
            history.append({"a": d["action"], "r": str(d.get("result", ""))})
    return {"i": i, "card": c, "rows": rows, "bad": bad, "s": round(time.time() - t0, 1)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--episodes", type=int, default=4)
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--out", default="synth.jsonl")
    ap.add_argument("--teacher", choices=list(TEACHERS), default="deepseek")
    args = ap.parse_args()
    global TEACHER
    TEACHER = args.teacher
    print("teacher:", TEACHERS[TEACHER], flush=True)
    system, example = bot_system(), structure_example()
    base = args.seed if args.seed is not None else int(time.time())
    lock = threading.Lock()
    totals = {"rows": 0, "bad": 0, "eps": 0}
    out = DATA / args.out

    def run(i):
        r = episode(i, base + i, system, example)
        with lock:
            with open(out, "a", encoding="utf8") as fh:
                for row in r["rows"]:
                    fh.write(json.dumps(row) + "\n")
            totals["rows"] += len(r["rows"]); totals["bad"] += sum(r["bad"].values()); totals["eps"] += 1
            print(f"ep {i}: {len(r['rows'])} ok, bad {r['bad']}, {r.get('s')} s, {r.get('error', '')} "
                  f"| total {totals['rows']} rows / {totals['eps']} eps", flush=True)

    with ThreadPoolExecutor(args.workers) as ex:
        list(ex.map(run, range(args.episodes)))
    print(json.dumps(totals))


if __name__ == "__main__":
    sys.exit(main())
