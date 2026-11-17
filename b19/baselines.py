"""B19 reference points on the test set (keep=True rows): random legal option, follow the code hint, most frequent verb."""
import json
import random
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent


def load(name):
    return [json.loads(l) for l in open(HERE / "data" / f"{name}.jsonl", encoding="utf8")]


def main():
    train = [r for r in load("train") if r["keep"]]
    test = [r for r in load("test") if r["keep"]]
    rnd = random.Random(0)
    freq = Counter(r["action"] for r in train)
    res = {
        "random": sum(rnd.choice(r["legal"]) == r["action"] for r in test) / len(test),
        "hint": sum(r["hint"] == r["action"] for r in test) / len(test),
        "most_frequent_action": sum(max(r["legal"], key=lambda o: freq[o]) == r["action"] for r in test) / len(test),
    }
    with open(HERE / "runs" / "results.jsonl", "a", encoding="utf8") as fh:
        for k, v in res.items():
            row = {"model": "baseline-" + k, "test": len(test), "top1": round(v, 3)}
            print(json.dumps(row)); fh.write(json.dumps(row) + "\n")


if __name__ == "__main__":
    main()
