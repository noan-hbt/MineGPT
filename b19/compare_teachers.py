"""Compare teacher synthetic batches (same scenario cards / seeds).

python b19/compare_teachers.py data/synth.jsonl:deepseek data/synth_gpt.jsonl:gpt [--samples 3]
Per teacher: episodes with rows, decisions, verb diversity, hint-override rate, failure results, reason length,
repeated-action rate; plus side-by-side samples on the same card.
"""
import argparse
import collections
import json
import math
import random
from pathlib import Path

HERE = Path(__file__).parent


def load(path):
    rows = [json.loads(l) for l in open(HERE / path, encoding="utf8") if l.strip()]
    return rows


def entropy(counter):
    n = sum(counter.values())
    return -sum(c / n * math.log2(c / n) for c in counter.values()) if n else 0.0


def stats(rows):
    eps = collections.defaultdict(list)
    for r in rows:
        eps[r["session"]].append(r)
    verbs = collections.Counter(r["action"].split()[0] for r in rows)
    acts = collections.Counter(r["action"] for r in rows)
    override = sum(r["action"] != r["hint"] for r in rows if r.get("hint"))
    with_hint = sum(1 for r in rows if r.get("hint"))
    fails = sum(str(r.get("result", "")).startswith("failed") for r in rows)
    rep = 0
    for ep in eps.values():
        ep.sort(key=lambda r: r["tick"])
        rep += sum(a["action"] == b["action"] for a, b in zip(ep, ep[1:]))
    reasons = [len(str(r.get("reason", "")).split()) for r in rows]
    # did a failure get a different action right after? (reaction to failure)
    react_n = react_ok = 0
    for ep in eps.values():
        for a, b in zip(ep, ep[1:]):
            if str(a.get("result", "")).startswith("failed"):
                react_n += 1
                react_ok += a["action"] != b["action"]
    return {
        "episodes": len(eps),
        "decisions": len(rows),
        "dec/ep": round(len(rows) / max(1, len(eps)), 1),
        "distinct verbs": len(verbs),
        "verb entropy (bits)": round(entropy(verbs), 2),
        "distinct actions": len(acts),
        "hint override %": round(100 * override / max(1, with_hint), 1),
        "failed results %": round(100 * fails / max(1, len(rows)), 1),
        "changes action after fail %": round(100 * react_ok / max(1, react_n), 1) if react_n else None,
        "same action twice in a row %": round(100 * rep / max(1, len(rows) - len(eps)), 1),
        "reason words (mean)": round(sum(reasons) / max(1, len(reasons)), 1),
        "top verbs": ", ".join(f"{v} {c}" for v, c in verbs.most_common(6)),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("batches", nargs="+", help="path:label")
    ap.add_argument("--samples", type=int, default=3)
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()
    data = {}
    for b in a.batches:
        p, lab = b.split(":")
        data[lab] = load(p)
    S = {lab: stats(rows) for lab, rows in data.items()}
    labs = list(S)
    keys = list(next(iter(S.values())))
    print("| metric | " + " | ".join(labs) + " |")
    print("|---|" + "---|" * len(labs))
    for k in keys:
        print(f"| {k} | " + " | ".join(str(S[l][k]) for l in labs) + " |")
    # side-by-side samples: overriding decisions (most informative), same card when possible
    rng = random.Random(a.seed)
    print()
    for lab, rows in data.items():
        cand = [r for r in rows if r.get("hint") and r["action"] != r["hint"]] or rows
        print(f"### {lab} samples (hint overridden)")
        for r in rng.sample(cand, min(a.samples, len(cand))):
            c = r["card"]
            print(f"- [{r['session']} t{r['tick']}] goal={c['goal']} place={c['place']} vitals={c['vitals']} "
                  f"danger={c['danger']}\n  hint=`{r['hint']}` -> **`{r['action']}`** ({r.get('result')})\n  reason: {r.get('reason')}")
        print()


if __name__ == "__main__":
    main()
