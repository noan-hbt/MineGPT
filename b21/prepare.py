"""Freeze an auditable decision sample and build factual benchmark candidates."""

import argparse
import json
import random
from pathlib import Path

B21 = Path(__file__).resolve().parent
ROOT = B21.parent
DATA = B21 / "data"


def read_jsonl(path):
    with path.open(encoding="utf-8") as stream:
        return [json.loads(line) for line in stream if line.strip()]


def write_jsonl(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as stream:
        for row in rows:
            stream.write(json.dumps(row, ensure_ascii=False) + "\n")


def decisions(logs, count):
    unique = {}
    for log in sorted(logs.glob("*.jsonl")):
        system = None
        for row in read_jsonl(log):
            if row["kind"] == "session":
                system = row["system"]
            if (row["kind"] != "decision" or row.get("source") != "llm"
                    or row.get("ok") is not True or not row.get("obs_text")
                    or not row.get("options") or not system):
                continue
            options = sorted(f"{verb} {arg}" for verb, args in row["options"].items()
                             for arg in args)
            if row["action"] not in options:
                continue
            key = (system, row["obs_text"], tuple(options))
            if key not in unique:
                unique[key] = dict(log=log.name, tick=row["tick"], system=system,
                                   prompt=row["obs_text"], options=options,
                                   references=[row["action"]])
            elif row["action"] not in unique[key]["references"]:
                unique[key]["references"].append(row["action"])
    if len(unique) < count:
        raise ValueError(f"Only {len(unique)} distinct eligible decisions for {count} requested")
    return random.Random(21).sample(list(unique.values()), count)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--count", type=int, default=300)
    parser.add_argument("--output", type=Path, default=B21 / "runs" / "decisions.jsonl")
    args = parser.parse_args()
    if args.count <= 0:
        parser.error("--count must be positive")
    write_jsonl(args.output, decisions(ROOT / "mcbot" / "logs", args.count))
