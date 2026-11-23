"""Validate structured states / events against spec/*.schema.json.

.venv/Scripts/python.exe spec/tools/validate.py [state.json | log.jsonl ...]   (default: the golden example)
A .jsonl file is read as a session log: lines with a "state" key are checked as states, lines with "kind" as events.
"""
import json
import sys
from pathlib import Path

from jsonschema import Draft202012Validator
from referencing import Registry, Resource

SPEC = Path(__file__).resolve().parents[1]


def validators():
    schemas = {n: json.loads((SPEC / n).read_text(encoding="utf-8")) for n in ("state.schema.json", "events.schema.json")}
    reg = Registry().with_resources(
        [(n, Resource.from_contents(s)) for n, s in schemas.items()]
        + [(s["$id"], Resource.from_contents(s)) for s in schemas.values()])
    return {k: Draft202012Validator(schemas[f"{k}.schema.json"], registry=reg) for k in ("state", "events")}


def check(v, obj, where):
    errs = sorted(v.iter_errors(obj), key=lambda e: list(e.path))
    for e in errs[:10]:
        print(f"{where}: {'/'.join(map(str, e.path)) or '<root>'}: {e.message}")
    return len(errs)


def main(paths):
    v = validators()
    bad = 0
    for p in map(Path, paths or [SPEC / "golden" / "state_example.json"]):
        if p.suffix == ".jsonl":
            for i, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1):
                if not line.strip():
                    continue
                o = json.loads(line)
                if "state" in o:
                    bad += check(v["state"], o["state"], f"{p.name}:{i}")
                elif "kind" in o:
                    bad += check(v["events"], o, f"{p.name}:{i}")
        else:
            bad += check(v["state"], json.loads(p.read_text(encoding="utf-8")), p.name)
    print("OK" if not bad else f"{bad} errors")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
