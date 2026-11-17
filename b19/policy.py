"""B19 policy network: scores each legal option given the structured state. Trained from scratch.

score(state, option) = MLP([state features, option features, verb embedding, arg embedding])
Softmax over the legal options of the tick, cross-entropy on the logged action (rows with keep=True).

  python b19/policy.py               # train + eval, saves b19/runs/policy.pt and prints metrics
  python b19/policy.py --no-hint     # ablation: hide the code hint/plan features
"""
import argparse
import json
import math
import random
import time
from collections import Counter
from pathlib import Path

import torch
import torch.nn as nn

HERE = Path(__file__).resolve().parent
VERBS = ["collect", "craft", "place", "attack", "flee", "eat", "explore", "wait", "come", "home", "goto",
         "smelt", "surface", "mine", "sleep", "follow", "build", "other"]


def load(name):
    return [json.loads(l) for l in open(HERE / "data" / f"{name}.jsonl", encoding="utf8")]


def norm_item(x):
    """iron_ore / deepslate_iron_ore / raw_iron -> iron (only used to match options with plan steps)."""
    x = str(x).replace("deepslate_", "").replace("raw_", "")
    for suf in ("_ore", "_log", "_ingot"):
        x = x.replace(suf, "")
    return x


class Vocab:
    def __init__(self, rows, min_count=1):
        c = Counter()
        for r in rows:
            s = r["state"]
            c.update(s.get("inv", {}).keys()); c.update(s.get("blocks", {}).keys()); c.update(s.get("mobs", {}).keys())
            c.update(o.split(" ", 1)[1] for o in r["legal"])
            t = (s.get("target") or {}).get("item")
            if t: c[t] += 1
        self.items = ["<unk>"] + sorted(k for k, n in c.items() if n >= min_count)
        self.index = {k: i for i, k in enumerate(self.items)}

    def __call__(self, k):
        return self.index.get(k, 0)

    def __len__(self):
        return len(self.items)


def plan_steps(s):
    return ((s.get("plan") or {}).get("steps")) or []


def state_vec(s, V, use_hint):
    n = len(V)
    inv, blk, mob = [0.0] * n, [0.0] * n, [0.0] * n
    for k, v in (s.get("inv") or {}).items(): inv[V(k)] += math.log1p(v)
    for k, v in (s.get("blocks") or {}).items(): blk[V(k)] = max(blk[V(k)], 1 / (1 + v))
    for k, v in (s.get("mobs") or {}).items(): mob[V(k)] = max(mob[V(k)], 1 / (1 + v))
    tgt = [0.0] * n
    t = (s.get("target") or {}).get("item")
    if t: tgt[V(t)] = 1.0
    hist = s.get("history") or []
    last_fail = [0.0, 0.0, 0.0]
    for i, h in enumerate(hist[-3:][::-1]):
        last_fail[i] = 0.0 if str(h.get("r", "")).startswith("ok") else 1.0
    steps = plan_steps(s) if use_hint else []
    base = [s.get("hp", 20) / 20, s.get("food", 20) / 20, float(bool(s.get("night"))), (s.get("tier") or 0) / 5,
            float(bool(s.get("table"))), float(bool(s.get("furnace"))), float(bool(s.get("sheltered"))),
            min(len(steps), 20) / 20, float(bool((s.get("plan") or {}).get("done"))) if use_hint else 0.0,
            len(s.get("banned") or []) / 5]
    return base + last_fail + inv + blk + mob + tgt


def option_feats(opt, s, hint, use_hint):
    verb, arg = opt.split(" ", 1)
    na = norm_item(arg)
    steps = plan_steps(s) if use_hint else []
    in_first = float(bool(steps) and na in norm_item(steps[0]))
    in_any = float(any(na in norm_item(st) for st in steps))
    hist = s.get("history") or []
    same_last = float(bool(hist) and hist[-1].get("a") == opt)
    same_last_fail = float(same_last and not str(hist[-1].get("r", "")).startswith("ok"))
    repeats = sum(1 for h in hist if h.get("a") == opt) / 5
    inv = s.get("inv") or {}
    blocks = s.get("blocks") or {}
    mobs = s.get("mobs") or {}
    t = (s.get("target") or {}).get("item")
    return [float(use_hint and hint == opt), in_first, in_any, same_last, same_last_fail, repeats,
            float(arg in (s.get("craftable") or [])), float(bool(t) and arg == t),
            math.log1p(inv.get(arg, 0)) / 5, 1 / (1 + blocks[arg]) if arg in blocks else 0.0,
            1 / (1 + mobs[arg]) if arg in mobs else 0.0]


class Policy(nn.Module):
    def __init__(self, n_state, n_opt, n_items, d=32, h=128):
        super().__init__()
        self.verb = nn.Embedding(len(VERBS), 8)
        self.item = nn.Embedding(n_items, d)
        self.state = nn.Sequential(nn.Linear(n_state, h), nn.ReLU(), nn.Dropout(0.2))
        self.head = nn.Sequential(nn.Linear(h + n_opt + 8 + d, h), nn.ReLU(), nn.Dropout(0.2), nn.Linear(h, 1))

    def forward(self, s, o, v, a):
        # s: [S], o/v/a: per-option tensors [K, ...]
        hs = self.state(s).expand(o.shape[0], -1)
        return self.head(torch.cat([hs, o, self.verb(v), self.item(a)], -1)).squeeze(-1)


def encode(r, V, use_hint):
    s = r["state"]
    sv = torch.tensor(state_vec(s, V, use_hint))
    o = torch.tensor([option_feats(x, s, r.get("hint"), use_hint) for x in r["legal"]])
    v = torch.tensor([VERBS.index(x.split(" ")[0]) if x.split(" ")[0] in VERBS else VERBS.index("other") for x in r["legal"]])
    a = torch.tensor([V(x.split(" ", 1)[1]) for x in r["legal"]])
    y = r["legal"].index(r["action"])
    return sv, o, v, a, y


def evaluate(model, data, rows):
    model.eval()
    hit = top3 = 0
    t0 = time.perf_counter()
    with torch.no_grad():
        for (sv, o, v, a, y), r in zip(data, rows):
            sc = model(sv, o, v, a)
            order = sc.argsort(descending=True).tolist()
            hit += order[0] == y
            top3 += y in order[:3]
    ms = (time.perf_counter() - t0) * 1000 / max(1, len(rows))
    return hit / len(rows), top3 / len(rows), ms


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-hint", action="store_true")
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()
    use_hint = not args.no_hint
    random.seed(args.seed); torch.manual_seed(args.seed)

    train = [r for r in load("train") if r["keep"]]
    test = [r for r in load("test") if r["keep"]]
    V = Vocab(train)
    tr = [encode(r, V, use_hint) for r in train]
    te = [encode(r, V, use_hint) for r in test]
    model = Policy(tr[0][0].shape[0], tr[0][1].shape[1], len(V))
    nparams = sum(p.numel() for p in model.parameters())
    opt = torch.optim.AdamW(model.parameters(), lr=2e-3, weight_decay=1e-2)
    t0 = time.time()
    for ep in range(args.epochs):
        model.train()
        idx = list(range(len(tr))); random.shuffle(idx)
        tot = 0.0
        for i in idx:
            sv, o, v, a, y = tr[i]
            loss = nn.functional.cross_entropy(model(sv, o, v, a).unsqueeze(0), torch.tensor([y]))
            opt.zero_grad(); loss.backward(); opt.step(); tot += loss.item()
        if (ep + 1) % 10 == 0:
            acc, t3, _ = evaluate(model, te, test)
            print(f"epoch {ep + 1}: train loss {tot / len(tr):.3f}  test top1 {acc:.3f} top3 {t3:.3f}")
    acc, t3, ms = evaluate(model, te, test)
    res = {"model": "policy" + ("" if use_hint else "-nohint"), "params": nparams, "train": len(tr), "test": len(te),
           "top1": round(acc, 3), "top3": round(t3, 3), "ms_per_decision_cpu": round(ms, 3),
           "train_s": round(time.time() - t0, 1)}
    print(json.dumps(res))
    (HERE / "runs").mkdir(exist_ok=True)
    torch.save({"state": model.state_dict(), "vocab": V.items, "use_hint": use_hint}, HERE / "runs" / f"{res['model']}.pt")
    with open(HERE / "runs" / "results.jsonl", "a", encoding="utf8") as fh:
        fh.write(json.dumps(res) + "\n")


if __name__ == "__main__":
    main()
