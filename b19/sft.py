"""B19 LLM executor: zero-shot or SFT (full or LoRA) on the bot decision logs, same prompt as prod.

Prompt = chat template(system of the session, obs_text), answer = logged action. Loss on answer tokens only.
Eval = constrained choice like the prod grammar: log p(option | prompt) for each legal option, argmax.

  python b19/sft.py --model models/LFM2.5-350M-hf --mode zero
  python b19/sft.py --model models/LFM2.5-350M-hf --mode full --epochs 2
  python b19/sft.py --model models/LFM3-1.7B-hf   --mode lora --epochs 2
  python b19/sft.py --model models/LFM3-1.7B-hf   --mode lora --adapter b19/runs/LFM3-1.7B-lora   (eval only)
"""
import argparse
import json
import random
import sys
import time
from pathlib import Path

import torch

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "b21"))


def load(name):
    return [json.loads(l) for l in open(HERE / "data" / f"{name}.jsonl", encoding="utf8")]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--mode", choices=["zero", "full", "lora"], required=True)
    ap.add_argument("--epochs", type=int, default=2)
    ap.add_argument("--lr", type=float, default=None)
    ap.add_argument("--rank", type=int, default=16)
    ap.add_argument("--grad-accum", type=int, default=8)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--limit-test", type=int, default=0)
    ap.add_argument("--adapter", default=None, help="saved LoRA dir: skip training, eval only")
    ap.add_argument("--train-file", default="train", help="data/<name>.jsonl")
    ap.add_argument("--test-files", default="test", help="comma list of data/<name>.jsonl, each evaluated")
    ap.add_argument("--tag", default="", help="suffix of the model name (e.g. -gpt)")
    args = ap.parse_args()
    random.seed(args.seed); torch.manual_seed(args.seed)

    from transformers import AutoModelForCausalLM, AutoTokenizer
    from lfm3_compat import enable
    enable()
    path = (ROOT / args.model).resolve()
    tok = AutoTokenizer.from_pretrained(path, local_files_only=True, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(path, local_files_only=True, trust_remote_code=True,
                                                 dtype=torch.bfloat16, device_map={"": "cuda"})
    name = f"{path.name.replace('-hf', '')}-{args.mode}"

    def prompt_ids(r):
        return tok.apply_chat_template([{"role": "system", "content": r["system"]}, {"role": "user", "content": r["text"]}],
                                       tokenize=True, add_generation_prompt=True, enable_thinking=False, return_dict=False)

    def answer_ids(a):
        return tok.encode(a, add_special_tokens=False)

    name += args.tag
    train = [r for r in load(args.train_file) if r["keep"]]
    tests = {}
    for tf in args.test_files.split(","):
        tests[tf] = [r for r in load(tf) if r["keep"]]
        if args.limit_test:
            tests[tf] = tests[tf][:args.limit_test]

    t_train = 0.0
    if args.adapter:
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, (ROOT / args.adapter).resolve())
        model.eval()
        print("loaded adapter", args.adapter, flush=True)
    elif args.mode != "zero":
        if args.mode == "lora":
            from peft import LoraConfig, get_peft_model
            targets = sorted({n.split(".")[-1] for n, m in model.named_modules()
                              if isinstance(m, torch.nn.Linear) and "lm_head" not in n})
            model = get_peft_model(model, LoraConfig(r=args.rank, lora_alpha=2 * args.rank, lora_dropout=0.05,
                                                     target_modules=targets, task_type="CAUSAL_LM"))
            lr = args.lr or 2e-4
        else:
            lr = args.lr or 2e-5
        model.gradient_checkpointing_enable()
        model.config.use_cache = False
        if hasattr(model, "enable_input_require_grads"):
            model.enable_input_require_grads()
        params = [p for p in model.parameters() if p.requires_grad]
        print(f"trainable params: {sum(p.numel() for p in params) / 1e6:.1f}M, lr {lr}")
        opt = torch.optim.AdamW(params, lr=lr, weight_decay=0.0)
        enc = []
        for r in train:
            p, a = prompt_ids(r), answer_ids(r["action"]) + [tok.eos_token_id]
            enc.append((p + a, [-100] * len(p) + a))
        steps = args.epochs * len(enc) // args.grad_accum
        sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / 10) * max(0.0, 1 - s / max(1, steps)))
        model.train()
        t0 = time.time()
        step = 0
        for ep in range(args.epochs):
            random.shuffle(enc)
            tot = 0.0
            for i, (ids, lab) in enumerate(enc):
                out = model(input_ids=torch.tensor([ids], device="cuda"), labels=torch.tensor([lab], device="cuda"))
                (out.loss / args.grad_accum).backward()
                tot += out.loss.item()
                if (i + 1) % args.grad_accum == 0:
                    torch.nn.utils.clip_grad_norm_(params, 1.0)
                    opt.step(); sched.step(); opt.zero_grad(); step += 1
                if (i + 1) % 200 == 0:
                    print(f"epoch {ep + 1} {i + 1}/{len(enc)} loss {tot / (i + 1):.4f}", flush=True)
            print(f"epoch {ep + 1} done, mean loss {tot / len(enc):.4f}", flush=True)
        t_train = time.time() - t0
        model.eval()
        if args.mode == "lora":
            model.save_pretrained(HERE / "runs" / name)

    for tf, test in tests.items():
        evaluate(args, model, tok, name, tf, test, train, t_train, prompt_ids, answer_ids)


def evaluate(args, model, tok, name, tf, test, train, t_train, prompt_ids, answer_ids):
    # constrained-choice eval: shared prompt prefix, all legal options in one batch (right-padded)
    hit = top3 = 0
    t0 = time.time()
    preds = []
    with torch.inference_mode():
        for n, r in enumerate(test):
            p = prompt_ids(r)
            opts = [answer_ids(o) for o in r["legal"]]
            L = max(map(len, opts))
            pad = tok.pad_token_id if tok.pad_token_id is not None else 0
            inp = torch.tensor([p + o + [pad] * (L - len(o)) for o in opts], device="cuda")
            # logits only on the L+1 last positions (= answer slots): avoids a (batch x prompt x vocab) tensor
            logits = model(input_ids=inp, use_cache=False, logits_to_keep=L + 1).logits[:, :L].float()
            lp = logits.log_softmax(-1)
            scores = []
            for k, o in enumerate(opts):
                scores.append(sum(lp[k, j, t].item() for j, t in enumerate(o)))
            order = sorted(range(len(opts)), key=lambda k: -scores[k])
            y = r["legal"].index(r["action"])
            hit += order[0] == y
            top3 += y in order[:3]
            preds.append({"session": r["session"], "tick": r["tick"], "action": r["action"],
                          "pred": r["legal"][order[0]], "top3": [r["legal"][k] for k in order[:3]]})
            if (n + 1) % 25 == 0:
                el = time.time() - t0
                print(f"eval {n + 1}/{len(test)} top1 {hit / (n + 1):.3f} {el / (n + 1):.2f} s/state "
                      f"eta {el / (n + 1) * (len(test) - n - 1):.0f} s", flush=True)
    ms = (time.time() - t0) * 1000 / len(test)
    res = {"model": name, "epochs": args.epochs if args.mode != "zero" else 0,
           "train_file": args.train_file if args.mode != "zero" else None, "test_file": tf,
           "train": len(train), "test": len(test),
           "top1": round(hit / len(test), 3), "top3": round(top3 / len(test), 3),
           "ms_per_decision_hf_scoring": round(ms, 1), "train_s": round(t_train, 1),
           "vram_peak_gb": round(torch.cuda.max_memory_allocated() / 2**30, 2)}
    print(json.dumps(res))
    with open(HERE / "runs" / f"{name}_{tf}_preds.jsonl", "w", encoding="utf8") as fh:
        fh.writelines(json.dumps(x) + "\n" for x in preds)
    with open(HERE / "runs" / "results.jsonl", "a", encoding="utf8") as fh:
        fh.write(json.dumps(res) + "\n")


if __name__ == "__main__":
    main()
