"""Tokens per sheet section, measured with the real tokenizers (LFM2.5-350M hands, LFM3-1.7B mind).

Re-renders every logged state with the current renderer (bot/render.js --log), so budgets can be tuned without
replaying the game.

  .venv/Scripts/python.exe eval/sheet_tokens.py data/own/<date>/<session>.jsonl [more.jsonl] [--every 5] [--json out.json]

Prints, per section: mean / p95 / max tokens of the full render, and the mean of what a diff-mode call sends
(unchanged stable sections collapse to one header line).
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOKENIZERS = {"350M": ROOT / "models" / "LFM2.5-350M-hf", "1.7B": ROOT / "models" / "LFM3-1.7B-hf"}
ORDER = ["MANUAL", "MEMORY", "MAP", "EPISODE", "GOALS", "LEDGER", "BODY", "INVENTORY", "AFFORDANCES", "SURROUNDINGS", "EVENTS", "NOW"]


def load_tok(path):
    from transformers import AutoTokenizer
    return AutoTokenizer.from_pretrained(str(path))


def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(p / 100 * (len(xs) - 1))))] if xs else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("logs", nargs="+")
    ap.add_argument("--every", type=int, default=5, help="measure one call out of N")
    ap.add_argument("--json", help="write the stats here")
    a = ap.parse_args()
    rows = []
    for log in a.logs:
        out = subprocess.run(["node", str(ROOT / "bot" / "render.js"), "--log", log, "--every", str(a.every)],
                             capture_output=True, text=True, encoding="utf-8", check=True).stdout
        rows += [json.loads(l) for l in out.splitlines() if l.strip()]
    if not rows:
        sys.exit("no call with a state in the logs")
    stats = {"calls": len(rows), "logs": a.logs, "models": {}}
    for name, path in TOKENIZERS.items():
        if not path.exists():
            continue
        tok = load_tok(path)
        n = lambda s: len(tok(s, add_special_tokens=False)["input_ids"])
        full = {s: [] for s in ORDER}
        diff = {s: [] for s in ORDER}
        tot_full, tot_diff = [], []
        for r in rows:
            f = {s: n(r["full"][s]) for s in ORDER}
            d = {s: n(r["diff"][s]) for s in ORDER}
            for s in ORDER:
                full[s].append(f[s]); diff[s].append(d[s])
            tot_full.append(sum(f.values()) + 2 * (len(ORDER) - 1)); tot_diff.append(sum(d.values()) + 2 * (len(ORDER) - 1))
        st = {s: {"mean": round(sum(full[s]) / len(rows)), "p95": pct(full[s], 95), "max": max(full[s]),
                  "diff_mean": round(sum(diff[s]) / len(rows))} for s in ORDER}
        st["TOTAL"] = {"mean": round(sum(tot_full) / len(rows)), "p95": pct(tot_full, 95), "max": max(tot_full),
                       "diff_mean": round(sum(tot_diff) / len(rows))}
        stats["models"][name] = st
        print(f"\n{name} tokenizer ({path.name}), {len(rows)} calls")
        print(f"{'section':14} {'mean':>6} {'p95':>6} {'max':>6} {'diff':>6}")
        for s, v in st.items():
            print(f"{s:14} {v['mean']:6} {v['p95']:6} {v['max']:6} {v['diff_mean']:6}")
    if a.json:
        Path(a.json).write_text(json.dumps(stats, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
