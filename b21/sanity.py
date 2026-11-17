"""Run identical greedy prompts on BF16 and an already running GGUF service."""

import argparse
import json
from pathlib import Path

from eval import GGUF, HF, HF_MODEL, messages
from prepare import B21, read_jsonl


def main():
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--gguf", help="Capture reference outputs from llama-server")
    mode.add_argument("--reference", type=Path, help="Compare HF to a prior GGUF capture")
    parser.add_argument("--device", choices=["cpu", "cuda"], default="cpu")
    parser.add_argument("--decisions", type=Path, default=B21 / "runs" / "decisions.jsonl")
    parser.add_argument("--output", type=Path, default=B21 / "runs" / "sanity.json")
    args = parser.parse_args()
    sample = read_jsonl(args.decisions)[:5]
    results = []
    if args.gguf:
        gguf = GGUF(args.gguf)
        for row in sample:
            ids = gguf.render(messages(row["system"], row["prompt"]))
            results.append(dict(log=row["log"], tick=row["tick"], ids=ids,
                                output=gguf.generate(ids)))
    else:
        reference = json.loads(args.reference.read_text(encoding="utf-8"))
        hf = HF(HF_MODEL, args.device)
        for row, previous in zip(sample, reference, strict=True):
            if (row["log"], row["tick"]) != (previous["log"], previous["tick"]):
                raise ValueError("Decision sample has changed since GGUF capture")
            ids = hf.render(messages(row["system"], row["prompt"]))
            output = hf.generate(ids)
            results.append(dict(log=row["log"], tick=row["tick"], same_prompt_ids=ids == previous["ids"],
                                hf_tokens=len(ids), gguf_tokens=len(previous["ids"]),
                                hf=output, gguf=previous["output"],
                                same_output=output.strip() == previous["output"].strip()))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
