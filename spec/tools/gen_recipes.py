"""Build spec/recipes.json from the vanilla 1.21.11 server jar (authoritative, minecraft-data recipes may lag).

Run: .venv/Scripts/python.exe spec/tools/gen_recipes.py

Output (ids without the minecraft: prefix, tags resolved to item lists):
  {"version", "crafting": [{"out", "n", "grid": 2|3, "ing": [{"opts": [ids], "n": count}]}],
   "smelting"|"blasting"|"smoking"|"campfire_cooking": [{"out", "n", "in": [ids], "time": ticks}],
   "stonecutting": [{"out", "n", "in": [ids]}]}
Special recipes (fireworks, banners, map cloning, dyeing...) are skipped: they have no fixed ingredients.
"""
import json
import zipfile
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VERSION = "1.21.11"
JAR = ROOT / "mcserver" / "versions" / VERSION / f"server-{VERSION}.jar"
OUT = ROOT / "spec" / "recipes.json"
COOKING = ("smelting", "blasting", "smoking", "campfire_cooking")


def strip(i):
    return i.split(":", 1)[1] if ":" in i else i


def item_tags(zf):
    pre = "data/minecraft/tags/item/"
    raw = {n[len(pre):-5]: json.loads(zf.read(n))["values"] for n in zf.namelist() if n.startswith(pre) and n.endswith(".json")}
    memo = {}

    def resolve(t):
        if t not in memo:
            memo[t] = set()
            for v in raw[t]:
                v = v["id"] if isinstance(v, dict) else v
                memo[t] |= resolve(strip(v[1:])) if v.startswith("#") else {strip(v)}
        return memo[t]
    return resolve


def opts(ing, resolve):
    """ingredient = "id" | "#tag" | [ids or tags] -> sorted list of item ids"""
    if isinstance(ing, list):
        return sorted(set().union(*(opts(x, resolve) for x in ing)))
    if isinstance(ing, dict):  # older format {"item": ..} / {"tag": ..}
        ing = ing.get("item") or "#" + ing["tag"]
    return sorted(resolve(strip(ing[1:]))) if ing.startswith("#") else [strip(ing)]


def group(slots):
    c = Counter(tuple(s) for s in slots)
    return [{"opts": list(k), "n": v} for k, v in sorted(c.items())]


def main():
    out = {"version": VERSION, "crafting": [], "stonecutting": [], **{k: [] for k in COOKING}}
    skipped = Counter()
    with zipfile.ZipFile(JAR) as zf:
        resolve = item_tags(zf)
        pre = "data/minecraft/recipe/"
        for name in sorted(n for n in zf.namelist() if n.startswith(pre) and n.endswith(".json")):
            r = json.loads(zf.read(name))
            kind = strip(r["type"])
            res = r.get("result")
            if not isinstance(res, dict) or "id" not in res:
                skipped[kind] += 1
                continue
            o, n = strip(res["id"]), res.get("count", 1)
            if kind == "crafting_shaped":
                pat = [row for row in r["pattern"]]
                slots = [opts(r["key"][ch], resolve) for row in pat for ch in row if ch != " "]
                grid = 2 if len(pat) <= 2 and max(map(len, pat)) <= 2 else 3
                out["crafting"].append({"out": o, "n": n, "grid": grid, "ing": group(slots)})
            elif kind == "crafting_shapeless":
                slots = [opts(i, resolve) for i in r["ingredients"]]
                out["crafting"].append({"out": o, "n": n, "grid": 2 if len(slots) <= 4 else 3, "ing": group(slots)})
            elif kind in COOKING:
                out[kind].append({"out": o, "n": n, "in": opts(r["ingredient"], resolve), "time": r.get("cookingtime", 200)})
            elif kind == "stonecutting":
                out["stonecutting"].append({"out": o, "n": n, "in": opts(r["ingredient"], resolve)})
            else:
                skipped[kind] += 1
    OUT.write_text(json.dumps(out, separators=(",", ":")) + "\n", encoding="utf-8")
    print(OUT, {k: len(v) for k, v in out.items() if k != "version"}, "skipped:", dict(skipped))


if __name__ == "__main__":
    main()
