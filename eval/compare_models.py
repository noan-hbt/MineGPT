"""Compare summary JSONs and stress JSONLs across base and edited models."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RES = ROOT / "eval" / "results"


def load_summary(tag):
    p = RES / f"mc_summary_{tag}.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def load_stress(tag):
    p = RES / f"stress_{tag}.jsonl"
    if not p.exists():
        return None
    rows = [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]
    ok = sum(r["ok"] for r in rows)
    by_cat = {}
    for r in rows:
        c = r["cat"]
        by_cat.setdefault(c, [0, 0])
        by_cat[c][1] += 1
        by_cat[c][0] += int(r["ok"])
    return {"ok": ok, "n": len(rows), "acc": round(ok / max(1, len(rows)), 4), "by_cat": by_cat}


def main():
    tags = ["base-350m", "mc-350m-ep1", "mc-350m-ep2", "mc-350m-ep3", "mc-350m-v2", "mc-350m-exp", "base-1.7b", "mc-1.7b"]
    print(f"{'Tag':<15} {'MC Total':>10} {'Seen':>10} {'UnseenPara':>11} {'MultiHop':>10} {'GenRet':>8} {'GenPPL':>8} {'Stress':>10}")
    print("-" * 92)
    for t in tags:
        s = load_summary(t)
        st = load_stress(t)
        if not s and not st:
            continue
        if s:
            b = s["buckets"]
            seen = f"{b['seen_recipe_qa']['ok']}/{b['seen_recipe_qa']['n']}"
            para = f"{b['unseen_paraphrase_mc']['ok']}/{b['unseen_paraphrase_mc']['n']}"
            mh = f"{b['multihop_reasoning_mc']['ok']}/{b['multihop_reasoning_mc']['n']}"
            gen = f"{b['general_retention']['ok']}/{b['general_retention']['n']}"
            mc_ok = b['seen_recipe_qa']['ok'] + b['unseen_paraphrase_mc']['ok'] + b['multihop_reasoning_mc']['ok']
            mc_n = b['seen_recipe_qa']['n'] + b['unseen_paraphrase_mc']['n'] + b['multihop_reasoning_mc']['n']
            mc_tot = f"{mc_ok}/{mc_n} ({100*mc_ok/mc_n:.0f}%)"
            ppl = f"{s['general_ppl']:.2f}"
        else:
            seen = para = mh = gen = mc_tot = ppl = "-"
        st_s = f"{st['ok']}/{st['n']} ({100*st['acc']:.0f}%)" if st else "-"
        print(f"{t:<15} {mc_tot:>10} {seen:>10} {para:>11} {mh:>10} {gen:>8} {ppl:>8} {st_s:>10}")


if __name__ == "__main__":
    main()
