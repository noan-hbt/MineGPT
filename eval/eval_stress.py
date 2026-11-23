"""Extra stress-test evaluation: tricky negative questions, French mechanics, multi-hop, MineGPT DSL, general sanity.

Usage:
  .venv/Scripts/python.exe eval/eval_stress.py --model models/LFM2.5-350M-mc --tag mc-350m
"""
import argparse
import json
import time
from pathlib import Path

import torch
from eval_mc_knowledge import check_answer, enable_lfm3_compat

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "eval" / "results"

STRESS_CASES = [
    # Negative / myth-busting MC facts
    ("neg", "Does crafting a furnace in Minecraft require iron_ingot? Answer yes or no and explain what it actually requires.", ["no", "cobblestone", "8"]),
    ("neg", "Can you find coal_ore at Y=-40 in Minecraft 1.21? Answer yes or no and explain.", ["no", "0"]),
    ("neg", "Is it safe to sleep in a bed inside the Nether? Answer yes or no and explain.", ["no", "explod"]),
    ("neg", "Can a stone_pickaxe mine gold_ore? Answer yes or no and say what tier is needed.", ["no", "iron"]),
    ("neg", "Can you combine Fortune and Silk Touch on the same pickaxe?", ["no"]),
    ("neg", "Can you combine Mending and Infinity on the same bow?", ["no"]),
    # French mechanics (unseen phrasings)
    ("fr_mech", "Dans Minecraft 1.21, combien de blocs d'obsidienne faut-il au minimum pour faire un portail du Nether sans les coins ?", ["10"]),
    ("fr_mech", "Quel bloc de métier faut-il poser pour qu'un villageois devienne bibliothécaire (Librarian) ?", ["lectern"]),
    ("fr_mech", "Combien de bibliothèques faut-il autour d'une table d'enchantement pour atteindre le niveau 30 ?", ["15"]),
    ("fr_mech", "À quelle coordonnée Y trouve-t-on le plus d'ancient_debris dans le Nether ?", ["15"]),
    ("fr_mech", "Combien de points de faim restaure un steak cuit (cooked_beef) dans Minecraft ?", ["8"]),
    ("fr_mech", "Quelle pioche minimum faut-il pour miner de l'obsidienne ?", ["diamond"]),
    ("fr_mech", "Que faut-il mettre dans un alambic après une fiole d'eau pour obtenir une awkward_potion ?", ["nether_wart"]),
    ("fr_mech", "Combien d'items cuit un seau de lave (lava_bucket) dans un four ?", ["100"]),
    ("fr_mech", "Quel mob drop des blaze_rod dans les forteresses du Nether ?", ["blaze"]),
    ("fr_mech", "Quel mob drop des ender_pearl ?", ["enderman"]),
    # Copper 1.21.11 + durability + food
    ("mc121", "In Minecraft 1.21.11, can a copper_pickaxe harvest iron_ore? Answer yes or no.", ["yes"]),
    ("mc121", "What item repairs elytra on an anvil?", ["phantom_membrane"]),
    ("mc121", "What does smelting raw_iron in a blast_furnace produce, and how does its speed compare to a normal furnace?", ["iron_ingot", "twice|2x|5"]),
    ("mc121", "How many obsidian, diamonds, and books do you need to craft an enchanting_table?", ["4", "obsidian", "2", "diamond", "1", "book"]),
    # MineGPT DSL sanity
    ("dsl", "In the MineGPT DSL, what does the verb `chop` do?", ["tree"]),
    ("dsl", "In the MineGPT harness, what does the tool `recipe` do?", ["recipe|make"]),
    # General sanity
    ("gen", "What is 18 * 15?", ["270"]),
    ("gen", "Quelle est la capitale de l'Espagne ?", ["Madrid"]),
    ("gen", "Write a one-line Python lambda that doubles a number x.", ["lambda", "x"]),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--tag", default=None)
    args = ap.parse_args()

    model_path = (ROOT / args.model).resolve() if not Path(args.model).is_absolute() else Path(args.model)
    cfg = json.loads((model_path / "config.json").read_text(encoding="utf-8"))
    is_lfm3 = cfg.get("model_type") == "lfm3"
    if is_lfm3:
        enable_lfm3_compat()

    from transformers import AutoModelForCausalLM, AutoTokenizer
    t0 = time.time()
    tok = AutoTokenizer.from_pretrained(model_path, local_files_only=True, trust_remote_code=True)
    if tok.pad_token_id is None:
        tok.pad_token_id = tok.eos_token_id
    tok.padding_side = "left"

    model = AutoModelForCausalLM.from_pretrained(
        model_path,
        local_files_only=True,
        trust_remote_code=True,
        dtype=torch.bfloat16,
        low_cpu_mem_usage=True,
        device_map={"": "cuda"},
    ).eval()

    use_cache = not is_lfm3
    template_kwargs = {"enable_thinking": False} if is_lfm3 else {}
    bs = 1 if is_lfm3 else 16
    results = []
    for start in range(0, len(STRESS_CASES), bs):
        batch = STRESS_CASES[start:start + bs]
        prompts = [
            tok.apply_chat_template([{"role": "user", "content": q}], tokenize=False, add_generation_prompt=True, **template_kwargs)
            for _, q, _ in batch
        ]
        enc = tok(prompts, return_tensors="pt", padding=True, add_special_tokens=False).to("cuda")
        plen = enc["input_ids"].shape[1]
        with torch.no_grad():
            out = model.generate(**enc, max_new_tokens=80, do_sample=False, use_cache=use_cache, pad_token_id=tok.eos_token_id)
        for j, (cat, q, kws) in enumerate(batch):
            ans = tok.decode(out[j][plen:], skip_special_tokens=True).strip()
            ok, missing = check_answer(ans, kws, "all_keywords")
            results.append({"cat": cat, "user": q, "kws": kws, "prediction": ans, "ok": ok, "missing": missing})

    tag = args.tag or model_path.name
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / f"stress_{tag}.jsonl").write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in results) + "\n", encoding="utf-8"
    )
    ok_n = sum(r["ok"] for r in results)
    print(f"[{tag}] Stress eval: {ok_n}/{len(results)} ({ok_n/len(results)*100:.1f}%) in {time.time()-t0:.1f}s")
    for r in results:
        if not r["ok"]:
            print(f"  MISS [{r['cat']}] {r['user'][:60]} -> missing={r['missing']} | pred={r['prediction'][:100].replace(chr(10),' ')}")


if __name__ == "__main__":
    main()
