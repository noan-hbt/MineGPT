"""Run a B21 edit and optionally evaluate it without saving a checkpoint."""

import argparse
import json
import time
from pathlib import Path

from editing.algorithms import check_destination, edit, lora, save, sweep
from eval import HF, HF_MODEL, compare, health, neighbor_references, summarize
from prepare import B21, read_jsonl


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("method", choices=["sweep", "rome", "memit", "lora"])
    parser.add_argument("--facts", type=Path, required=True)
    parser.add_argument("--fact-id")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--layers", nargs="+", type=int)
    parser.add_argument("--steps", type=int, default=30)
    parser.add_argument("--epochs", type=int, default=3)
    parser.add_argument("--device", choices=["cpu", "cuda"], default="cpu")
    parser.add_argument("--save", type=Path)
    parser.add_argument("--evaluate", action="store_true")
    parser.add_argument("--decisions", type=Path, default=B21 / "runs" / "decisions.jsonl")
    parser.add_argument("--decision-limit", type=int, default=300)
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--health", action="store_true")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    facts = [fact for fact in read_jsonl(args.facts)
             if args.fact_id is None or fact["id"] == args.fact_id][:args.limit]
    if not facts or args.steps < 1 or args.epochs < 1 or args.decision_limit < 0:
        parser.error("Need facts and positive steps/epochs")
    if args.method == "rome" and (len(facts) != 1 or len(args.layers or []) != 1):
        parser.error("ROME edits one fact on one layer")
    if args.method == "memit" and (len(args.layers or []) < 2
                                  or sorted(set(args.layers)) != args.layers):
        parser.error("MEMIT requires at least two distinct layers in ascending order")
    if any(not 0 <= layer < 24 for layer in args.layers or []):
        parser.error("LFM3 has layers 0 to 23")
    if (args.save or args.evaluate) and args.method == "sweep":
        parser.error("The sweep rolls back each trial")
    destination = check_destination(args.save) if args.save else None
    engine = HF(HF_MODEL, args.device)
    torch = engine.torch
    if args.device == "cuda":
        torch.cuda.synchronize()
        torch.cuda.reset_peak_memory_stats()
    start = time.perf_counter()
    if args.method == "sweep":
        details = sweep(engine, facts, args.steps, args.layers)
    elif args.method == "lora":
        details = lora(engine, facts, args.epochs)
    else:
        details = edit(engine, facts, args.layers, args.method, args.steps)
    if args.device == "cuda":
        torch.cuda.synchronize()
    result = dict(method=args.method, seconds=time.perf_counter() - start,
                  peak_vram_bytes=(torch.cuda.max_memory_reserved() if args.device == "cuda" else None),
                  fact_ids=[fact["id"] for fact in facts], details=details)
    if args.evaluate:
        sample = read_jsonl(args.decisions)
        bot_system = max(sample, key=lambda row: row["log"])["system"]
        rows = compare(engine, facts, sample[:args.decision_limit], bot_system)
        if args.health:
            health_rows, health_metrics = health(engine)
            rows.extend(health_rows)
            result.update(health_metrics)
        result.update(metrics=summarize(rows, neighbor_references(args.baseline)), rows=rows)
    if destination:
        save(engine, destination)
        result["saved"] = str(destination)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
