"""B19 step 1: bot decision logs -> dataset (state, legal options, action, label flags).

Reads mcbot/logs/*.jsonl (+ the B5 run copy) and writes b19/data/{train,test}.jsonl.
Split is by blocks of 30 contiguous ticks inside a session (limits leakage between neighbouring ticks).

Row fields:
  session, tick, goal, system (exact system prompt of that session), text (exact user prompt = obs_text),
  state (structured obs), legal (list of "verb arg" allowed by the grammar), action, ok, source, hint,
  keep (= usable as an imitation target: ok, not wait, chosen by llm/task/user)
"""
import glob
import hashlib
import json
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(__file__).resolve().parent / "data"
SOURCES = [ROOT / "mcbot" / "logs", ROOT.parent / "localai-b5run" / "mcbot" / "logs"]
TEST_EVERY = 5  # ~20% of sessions held out


def legal_from_grammar(grammar):
    legal = []
    for verb, args in re.findall(r'"(\w+) " \(([^)]*)\)', grammar or ""):
        legal += [f"{verb} {a}" for a in re.findall(r'"([^"]+)"', args)]
    return legal


def legal_from_options(options):
    return [f"{v} {a}" for v, xs in (options or {}).items() for a in xs]


BLOCK = 30


def is_test(row):
    key = f"{row['session']}:{row['tick'] // BLOCK}"
    return int(hashlib.sha1(key.encode()).hexdigest(), 16) % TEST_EVERY == 0


def main():
    rows, drop = [], Counter()
    for src in SOURCES:
        for f in sorted(glob.glob(str(src / "*.jsonl"))):
            system = None
            for line in open(f, encoding="utf8"):
                d = json.loads(line)
                if d["kind"] == "session":
                    system = d.get("system")
                if d["kind"] != "decision":
                    continue
                if not d.get("obs") or not d.get("obs_text") or not system:
                    drop["no obs/text/system"] += 1
                    continue
                legal = legal_from_grammar(d.get("grammar")) or legal_from_options(d.get("options"))
                if d["action"] not in legal:
                    drop["action not in legal set (reflex/user)"] += 1
                    continue
                rows.append({
                    "session": d["session"], "tick": d["tick"], "goal": d["obs"].get("goal"),
                    "system": system, "text": d["obs_text"], "state": d["obs"], "legal": legal,
                    "action": d["action"], "ok": d["ok"], "source": d.get("source"), "hint": d.get("hint"),
                    "result": d.get("result"),
                    "keep": d["ok"] and d.get("verb") != "wait" and d.get("source") in ("llm", "task", "user"),
                })
    OUT.mkdir(exist_ok=True)
    split = {"train": [r for r in rows if not is_test(r)],
             "test": [r for r in rows if is_test(r)]}
    for name, rs in split.items():
        with open(OUT / f"{name}.jsonl", "w", encoding="utf8") as fh:
            for r in rs:
                fh.write(json.dumps(r) + "\n")
        print(f"{name}: {len(rs)} rows, keep={sum(r['keep'] for r in rs)}, "
              f"sessions={len({r['session'] for r in rs})}, "
              f"avg legal={sum(len(r['legal']) for r in rs) / max(1, len(rs)):.1f}")
    print("dropped:", dict(drop))


if __name__ == "__main__":
    main()
