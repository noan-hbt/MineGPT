"""Evaluate a local HF model (LFM2.5 or LFM3) on kb/mc_eval.jsonl + general perplexity.

Usage:
  .venv/Scripts/python.exe eval/eval_mc_knowledge.py --model models/LFM2.5-350M-hf --tag base-350m
  .venv/Scripts/python.exe eval/eval_mc_knowledge.py --model models/LFM2.5-350M-mc --tag mc-350m
"""
import argparse
import json
import math
import re
import time
from collections import defaultdict
from inspect import signature
from pathlib import Path

import torch

ROOT = Path(__file__).resolve().parents[1]
EVAL_FILE = ROOT / "kb" / "mc_eval.jsonl"
OUT_DIR = ROOT / "eval" / "results"

GENERAL_PPL_TEXTS = [
    "Paris is the capital and largest city of France, situated along the Seine River in the north-central part of the country.",
    "Photosynthesis converts light energy into chemical energy inside plant chloroplasts using water and carbon dioxide.",
    "La programmation informatique consiste à concevoir des algorithmes fiables et maintenables pour résoudre des problèmes concrets.",
    "Water freezes at zero degrees Celsius and boils at one hundred degrees Celsius at standard atmospheric pressure.",
    "Les modèles de langage apprennent des représentations statistiques complexes à partir de grands corpus de textes.",
]


def enable_lfm3_compat():
    from transformers import integrations, masking_utils
    from transformers.integrations import accelerate

    def native_forward(*_args):
        return lambda function: function

    def recurrent_mask(inputs_embeds, attention_mask, **_kwargs):
        width = inputs_embeds.shape[1]
        if attention_mask is None or attention_mask.ndim != 2 or width == 1:
            return None
        return attention_mask[:, -width:].contiguous()

    def uncache_mask(function):
        def mask(*args, layer_idx=None, **kwargs):
            if kwargs.get("past_key_values") is not None:
                raise ValueError("uncached only")
            return function(*args, **kwargs)
        return mask

    if not hasattr(integrations, "use_kernel_func_from_hub_with_fallback"):
        integrations.use_kernel_func_from_hub_with_fallback = native_forward
    if not hasattr(accelerate, "force_accelerate_hooks"):
        accelerate.force_accelerate_hooks = native_forward
    if not hasattr(masking_utils, "create_recurrent_attention_mask"):
        masking_utils.create_recurrent_attention_mask = recurrent_mask
    for name in ("create_causal_mask", "create_sliding_window_causal_mask"):
        fn = getattr(masking_utils, name)
        if "layer_idx" not in signature(fn).parameters:
            setattr(masking_utils, name, uncache_mask(fn))


def kw_match(answer_norm: str, kw: str) -> bool:
    k = kw.lower().replace("_", " ")
    # Numeric token: match whole number boundary so "3" doesn't match "13"
    if re.fullmatch(r"-?\d+(\.\d+)?", k):
        return re.search(rf"(?<!\d){re.escape(k)}(?!\d)", answer_norm) is not None
    return k in answer_norm


def check_answer(answer: str, expected_keywords: list[str], check_type: str) -> tuple[bool, list[str]]:
    ans_norm = answer.lower().replace("_", " ")
    missing = [kw for kw in expected_keywords if not kw_match(ans_norm, kw)]
    if check_type == "any_keyword":
        passed = len(missing) < len(expected_keywords)
    else:
        passed = len(missing) == 0
    return passed, missing


def compute_ppl(model, tok, texts):
    total_nll = 0.0
    total_toks = 0
    for txt in texts:
        ids = tok(txt, return_tensors="pt").input_ids.to("cuda")
        with torch.no_grad():
            out = model(input_ids=ids, labels=ids, use_cache=False)
        n = ids.shape[1] - 1
        total_nll += float(out.loss) * n
        total_toks += n
    return math.exp(total_nll / max(1, total_toks))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--tag", default=None)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--max-new-tokens", type=int, default=96)
    args = ap.parse_args()

    model_path = (ROOT / args.model).resolve() if not Path(args.model).is_absolute() else Path(args.model)
    cfg = json.loads((model_path / "config.json").read_text(encoding="utf-8"))
    is_lfm3 = cfg.get("model_type") == "lfm3"
    if is_lfm3:
        enable_lfm3_compat()

    from transformers import AutoModelForCausalLM, AutoTokenizer
    t0 = time.time()
    tok = AutoTokenizer.from_pretrained(model_path, local_files_only=True, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        model_path,
        local_files_only=True,
        trust_remote_code=True,
        dtype=torch.bfloat16,
        low_cpu_mem_usage=True,
        device_map={"": "cuda"},
    ).eval()

    rows = [json.loads(l) for l in EVAL_FILE.read_text(encoding="utf-8").splitlines() if l.strip()]
    if args.limit:
        rows = rows[:args.limit]

    tag = args.tag or model_path.name
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    preds_path = OUT_DIR / f"mc_eval_{tag}.jsonl"

    by_bucket = defaultdict(lambda: [0, 0])
    by_cat = defaultdict(lambda: [0, 0])
    results = []

    use_cache = not is_lfm3
    template_kwargs = {"enable_thinking": False} if is_lfm3 else {}

    for i, r in enumerate(rows):
        enc = tok.apply_chat_template(
            [{"role": "user", "content": r["user"]}],
            tokenize=True,
            add_generation_prompt=True,
            return_tensors="pt",
            **template_kwargs,
        ).to("cuda")
        with torch.no_grad():
            out = model.generate(
                **enc,
                max_new_tokens=args.max_new_tokens,
                do_sample=False,
                use_cache=use_cache,
                pad_token_id=tok.eos_token_id,
            )
        ans = tok.decode(out[0][enc["input_ids"].shape[1]:], skip_special_tokens=True).strip()
        ok, missing = check_answer(ans, r["expected_keywords"], r.get("check_type", "all_keywords"))
        by_bucket[r["bucket"]][1] += 1
        by_bucket[r["bucket"]][0] += int(ok)
        by_cat[r["category"]][1] += 1
        by_cat[r["category"]][0] += int(ok)
        results.append({**r, "prediction": ans, "ok": ok, "missing": missing})
        if (i + 1) % 40 == 0:
            print(f"[{tag}] {i+1}/{len(rows)} evaluated...", flush=True)

    ppl = compute_ppl(model, tok, GENERAL_PPL_TEXTS)
    elapsed = round(time.time() - t0, 1)

    with open(preds_path, "w", encoding="utf-8") as f:
        for res in results:
            f.write(json.dumps(res, ensure_ascii=False) + "\n")

    summary = {
        "tag": tag,
        "model": str(model_path),
        "elapsed_s": elapsed,
        "general_ppl": round(ppl, 3),
        "total_ok": sum(x["ok"] for x in results),
        "total_n": len(results),
        "total_acc": round(sum(x["ok"] for x in results) / max(1, len(results)), 4),
        "buckets": {
            b: {"ok": ok, "n": n, "acc": round(ok / max(1, n), 4)}
            for b, (ok, n) in sorted(by_bucket.items())
        },
        "categories": {
            c: {"ok": ok, "n": n, "acc": round(ok / max(1, n), 4)}
            for c, (ok, n) in sorted(by_cat.items())
        },
    }
    summary_path = OUT_DIR / f"mc_summary_{tag}.json"
    summary_path.write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(summary, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
