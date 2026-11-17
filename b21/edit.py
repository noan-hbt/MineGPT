"""Run a B21 edit and optionally evaluate it without saving a checkpoint."""

import argparse
import json
import math
import time
from pathlib import Path

from editing.algorithms import check_destination, down, edit, lora, save, sweep
from eval import HF, HF_MODEL, compare, health, neighbor_references, summarize
from prepare import B21, DATA, read_jsonl


def rome_series(engine, facts, args):
    torch = engine.torch
    slot = down(engine, args.layers[0]).weight
    original = slot.detach().clone()
    sample = read_jsonl(args.decisions)
    bot_system = max(sample, key=lambda row: row["log"])["system"]
    rows, details = [], []
    instruction_count = len(read_jsonl(DATA / "instructions.jsonl")) if args.health else 0
    nll = tokens = peak = 0
    start = time.perf_counter()
    for index, fact in enumerate(facts):
        try:
            if args.device == "cuda":
                torch.cuda.empty_cache()
                torch.cuda.reset_peak_memory_stats()
            editing_started = time.perf_counter()
            record = edit(engine, [fact], args.layers, "rome", args.steps)[0]
            if args.device == "cuda":
                torch.cuda.synchronize()
                peak = max(peak, torch.cuda.max_memory_reserved())
            record.update(fact=fact["id"], seconds=time.perf_counter() - editing_started)
            details.append(record)
            rows.extend(compare(engine, [fact], sample[index:args.decision_limit:len(facts)],
                                bot_system, choice_facts=args.choice_facts))
            if args.health:
                health_rows, summary = health(engine, range(index, instruction_count, len(facts)))
                rows.extend(health_rows)
                nll += math.log(summary["perplexity"]) * summary["ppl_tokens"]
                tokens += summary["ppl_tokens"]
        finally:
            with torch.no_grad():
                slot.copy_(original)
        print(f"ROME {index + 1}/{len(facts)} {fact['id']}", flush=True)
    result = dict(method="rome", seconds=sum(row["seconds"] for row in details),
                  wall_seconds=time.perf_counter() - start,
                  peak_vram_bytes=peak if args.device == "cuda" else None,
                  fact_ids=[fact["id"] for fact in facts], details=details,
                  metrics=summarize(rows, neighbor_references(args.baseline)), rows=rows)
    if tokens:
        result.update(perplexity=math.exp(nll / tokens), ppl_tokens=tokens)
    return result


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
    parser.add_argument("--choice-facts", action="store_true")
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
    series = args.method == "rome" and len(facts) > 1
    if args.method == "rome" and len(args.layers or []) != 1:
        parser.error("ROME edits one layer per fact")
    if series and (not args.evaluate or args.save):
        parser.error("A ROME series requires --evaluate and rolls back each fact")
    if args.method == "memit" and (len(args.layers or []) < 2
                                  or sorted(set(args.layers)) != args.layers):
        parser.error("MEMIT requires at least two distinct layers in ascending order")
    if any(not 0 <= layer < 24 for layer in args.layers or []):
        parser.error("LFM3 has layers 0 to 23")
    if (args.save or args.evaluate) and args.method == "sweep":
        parser.error("The sweep rolls back each trial")
    destination = check_destination(args.save) if args.save else None
    engine = HF(HF_MODEL, args.device)
    if series:
        result = rome_series(engine, facts, args)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        return
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
    if args.method != "sweep":
        print(f"{args.method} applied to {len(facts)} facts in {result['seconds']:.2f}s",
              flush=True)
    if args.evaluate:
        sample = read_jsonl(args.decisions)
        bot_system = max(sample, key=lambda row: row["log"])["system"]
        rows = compare(engine, facts, sample[:args.decision_limit], bot_system,
                       choice_facts=args.choice_facts)
        if args.health:
            health_rows, health_metrics = health(engine)
            rows.extend(health_rows)
            result.update(health_metrics)
        result.update(metrics=summarize(rows, neighbor_references(args.baseline)), rows=rows)
        print(json.dumps(result["metrics"], indent=2), flush=True)
    if destination:
        save(engine, destination)
        result["saved"] = str(destination)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
