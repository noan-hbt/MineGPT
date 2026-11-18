"""Build a comprehensive, verified Minecraft 1.21.11 knowledge corpus + held-out eval suite.

Sources (all local, authoritative 1.21.11):
  - spec/recipes.json (1026 crafting, 254 stonecutting, 73 smelting, 25 blasting, 9 smoking, 9 campfire)
  - spec/names.json (items, blocks, mobs, hostile, biomes, effects, enchantments, tags)
  - bot/node_modules/minecraft-data/minecraft-data/data/pc/1.21.11/{blocks,items,foods,enchantments,biomes,effects,entities}.json
  - mcserver/versions/1.21.11/server-1.21.11.jar (block & entity loot tables)
  - spec/catalog.json (MineGPT v2 DSL verbs & tools)
  - Curated 1.21.11 mechanics (ores/Y-levels, fuels, brewing, combat, Nether/End, enchanting, villagers, redstone)

Outputs:
  - kb/mc_train.jsonl : multi-view EN+FR training examples + general replay mix
  - kb/mc_eval.jsonl  : held-out evaluation suite (seen, unseen paraphrases, multi-hop, general retention)
"""
import json
import random
import zipfile
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "spec"
MCDATA = ROOT / "bot" / "node_modules" / "minecraft-data" / "minecraft-data" / "data" / "pc" / "1.21.11"
JAR = ROOT / "mcserver" / "versions" / "1.21.11" / "server-1.21.11.jar"
OUT_DIR = ROOT / "kb"

PICKAXE_ORDER = [
    ("913", "wooden_pickaxe", "wooden"),
    ("923", "stone_pickaxe", "stone"),
    ("918", "copper_pickaxe", "copper"),
    ("928", "golden_pickaxe", "golden"),
    ("933", "iron_pickaxe", "iron"),
    ("938", "diamond_pickaxe", "diamond"),
    ("943", "netherite_pickaxe", "netherite"),
]


def load_sources():
    recipes = json.loads((SPEC / "recipes.json").read_text(encoding="utf-8"))
    names = json.loads((SPEC / "names.json").read_text(encoding="utf-8"))
    catalog = json.loads((SPEC / "catalog.json").read_text(encoding="utf-8"))
    blocks = json.loads((MCDATA / "blocks.json").read_text(encoding="utf-8"))
    items = json.loads((MCDATA / "items.json").read_text(encoding="utf-8"))
    foods = json.loads((MCDATA / "foods.json").read_text(encoding="utf-8"))
    enchants = json.loads((MCDATA / "enchantments.json").read_text(encoding="utf-8"))
    biomes = json.loads((MCDATA / "biomes.json").read_text(encoding="utf-8"))
    effects = json.loads((MCDATA / "effects.json").read_text(encoding="utf-8"))
    entities = json.loads((MCDATA / "entities.json").read_text(encoding="utf-8"))
    return {
        "recipes": recipes,
        "names": names,
        "catalog": catalog,
        "blocks": blocks,
        "items": items,
        "foods": foods,
        "enchants": enchants,
        "biomes": biomes,
        "effects": effects,
        "entities": entities,
    }


def make_tag_lookup(names):
    tag_of = {}
    for tag, ids in names["item_tags"].items():
        key = tuple(sorted(ids))
        if key not in tag_of or len(tag) < len(tag_of[key]):
            tag_of[key] = tag
    return tag_of


def fmt_opts(opts, tag_of):
    if len(opts) == 1:
        return opts[0]
    key = tuple(sorted(opts))
    if key in tag_of:
        return f"tag:{tag_of[key]} (e.g. {', '.join(opts[:3])})"
    if len(opts) <= 4:
        return " or ".join(opts)
    return f"{opts[0]} (or {len(opts)-1} variants like {opts[1]}, {opts[2]})"


def fmt_opts_short(opts, tag_of):
    if len(opts) == 1:
        return opts[0]
    key = tuple(sorted(opts))
    if key in tag_of:
        return f"tag:{tag_of[key]}"
    if len(opts) <= 3:
        return "/".join(opts)
    return f"{opts[0]}/..."


def parse_loot_items(node, silk=False):
    """Extract simple item drop names from a vanilla loot table JSON node."""
    out = []
    if not isinstance(node, dict):
        return out
    t = node.get("type", "").removeprefix("minecraft:")
    # Check silk touch condition
    conds = node.get("conditions", [])
    has_silk = any(
        "silk_touch" in json.dumps(c) for c in conds
    )
    if t == "item":
        if has_silk == silk or (not silk and not has_silk):
            name = node.get("name", "").removeprefix("minecraft:")
            if name:
                out.append(name)
    elif t == "alternatives":
        children = node.get("children", [])
        if silk:
            for ch in children:
                res = parse_loot_items(ch, silk=True)
                if res:
                    out.extend(res)
                    break
        else:
            # last branch or non-silk branch
            for ch in children:
                if "silk_touch" not in json.dumps(ch.get("conditions", [])):
                    out.extend(parse_loot_items(ch, silk=False))
    elif "children" in node:
        for ch in node["children"]:
            out.extend(parse_loot_items(ch, silk=silk))
    return out


def extract_jar_loot():
    block_drops = {}
    entity_drops = {}
    with zipfile.ZipFile(JAR) as zf:
        for n in zf.namelist():
            if n.startswith("data/minecraft/loot_table/blocks/") and n.endswith(".json"):
                bname = n.split("/")[-1][:-5]
                data = json.loads(zf.read(n))
                normal, silk = [], []
                for pool in data.get("pools", []):
                    for ent in pool.get("entries", []):
                        normal.extend(parse_loot_items(ent, silk=False))
                        silk.extend(parse_loot_items(ent, silk=True))
                block_drops[bname] = {
                    "normal": sorted(set(normal)),
                    "silk": sorted(set(silk)),
                }
            elif n.startswith("data/minecraft/loot_table/entities/") and n.endswith(".json"):
                ename = n.split("/")[-1][:-5]
                if "/" in n[len("data/minecraft/loot_table/entities/"):]:
                    continue
                data = json.loads(zf.read(n))
                drops = []
                for pool in data.get("pools", []):
                    for ent in pool.get("entries", []):
                        drops.extend(parse_loot_items(ent, silk=False))
                if drops:
                    entity_drops[ename] = sorted(set(drops))
    return block_drops, entity_drops


def snake_to_words(s):
    return s.replace("_", " ")


def build_dataset(seed=42):
    rng = random.Random(seed)
    src = load_sources()
    recipes = src["recipes"]
    names = src["names"]
    tag_of = make_tag_lookup(names)
    items_by_id = {str(i["id"]): i for i in src["items"]}
    items_by_name = {i["name"]: i for i in src["items"]}
    blocks_by_name = {b["name"]: b for b in src["blocks"]}
    block_loot, entity_loot = extract_jar_loot()

    train = []
    eval_items = []

    def add_train(cat, q, a, lang="en"):
        train.append({"category": cat, "lang": lang, "user": q, "assistant": a})

    def add_eval(bucket, cat, q, expected_keywords, answer_ref, check_type="keywords", lang="en"):
        eval_items.append({
            "bucket": bucket,
            "category": cat,
            "lang": lang,
            "user": q,
            "expected_keywords": expected_keywords,
            "answer_ref": answer_ref,
            "check_type": check_type,
        })

    # =========================================================================
    # 1. CRAFTING RECIPES (1026 recipes -> multiple EN+FR views + reverse uses)
    # =========================================================================
    by_out = defaultdict(list)
    uses_map = defaultdict(set)
    for r in recipes["crafting"]:
        by_out[r["out"]].append(r)
        for g in r["ing"]:
            uses_map[fmt_opts_short(g["opts"], tag_of)].add(r["out"])

    q_en_craft = [
        "How do you craft {item} in Minecraft?",
        "What is the crafting recipe for {item} in Minecraft?",
        "What ingredients are needed to craft {item}?",
        "Tell me how to make {item} in Minecraft 1.21.",
    ]
    q_fr_craft = [
        "Comment fabriquer {item} dans Minecraft ?",
        "Quelle est la recette de craft pour {item} dans Minecraft ?",
        "Quels ingrédients faut-il pour crafter {item} ?",
    ]

    # Pick 40 diverse core crafting recipes for unseen paraphrase eval
    core_craft_eval = [
        "furnace", "crafting_table", "chest", "torch", "bucket", "stick",
        "wooden_pickaxe", "stone_pickaxe", "copper_pickaxe", "iron_pickaxe", "diamond_pickaxe",
        "iron_sword", "diamond_sword", "shield", "bow", "arrow", "enchanting_table",
        "anvil", "blast_furnace", "smoker", "brewing_stand", "compass", "clock",
        "piston", "sticky_piston", "observer", "hopper", "dispenser", "dropper",
        "repeater", "comparator", "tnt", "bookshelf", "bed", "white_bed",
        "bread", "cake", "golden_apple", "ladder", "rail", "minecart", "campfire",
        "smithing_table", "stonecutter", "grindstone", "lectern", "cauldron", "flint_and_steel",
    ]
    eval_craft_set = set()

    for out_item, rlist in sorted(by_out.items()):
        # Describe primary (first non-dyeing or shortest) recipes (cap 2 variants if many wood/color dupes)
        variants = rlist[:2]
        descs = []
        all_kws = []
        for r in variants:
            ing_parts = [f"{g['n']} {fmt_opts(g['opts'], tag_of)}" for g in r["ing"]]
            ing_short = [f"{g['n']} {fmt_opts_short(g['opts'], tag_of)}" for g in r["ing"]]
            grid_txt = "2x2 inventory or crafting_table" if r["grid"] == 2 else "3x3 crafting_table"
            descs.append(f"{r['n']}x {out_item} requires {', '.join(ing_parts)} (using a {grid_txt})")
            all_kws.append(([str(r["n"]), out_item] + [str(g["n"]) for g in r["ing"]] + [g["opts"][0] for g in r["ing"]], ing_short))

        ans_en = f"To craft {out_item} in Minecraft 1.21.11: " + "; OR ".join(descs) + "."
        ing_fr_list = [f"{g['n']} {fmt_opts_short(g['opts'], tag_of)}" for g in variants[0]["ing"]]
        grid_fr = "inventaire 2x2 ou table de craft" if variants[0]["grid"] == 2 else "table de craft 3x3"
        ans_fr = (f"Pour fabriquer {out_item} dans Minecraft 1.21.11 : il faut {', '.join(ing_fr_list)} "
                  f"({grid_fr}), ce qui donne {variants[0]['n']}x {out_item}.")

        # Always teach in training using training templates
        for tmpl in rng.sample(q_en_craft, 2):
            add_train("crafting", tmpl.format(item=out_item), ans_en, "en")
        # Also include space-separated name form for important items
        if "_" in out_item and (out_item in core_craft_eval or rng.random() < 0.35):
            add_train("crafting", f"What do you need to craft {snake_to_words(out_item)} in Minecraft?", ans_en, "en")
        add_train("crafting", rng.choice(q_fr_craft).format(item=out_item), ans_fr, "fr")

        # Add held-out unseen paraphrase eval for core items
        if out_item in core_craft_eval and out_item not in eval_craft_set:
            eval_craft_set.add(out_item)
            r0 = variants[0]
            kws = []
            for g in r0["ing"]:
                if len(g["opts"]) == 1:
                    kws.append(g["opts"][0])
                else:
                    # Accept any valid ingredient option or its tag suffix (e.g. planks)
                    alts = list(g["opts"][:6])
                    suf = g["opts"][0].split("_")[-1]
                    if suf in ("planks", "log", "wool", "slab"):
                        alts.append(suf)
                    kws.append("|".join(alts))
            # Also accept number of primary ingredient
            if r0["ing"]:
                kws.append(str(r0["ing"][0]["n"]))
            add_eval(
                "seen_recipe_qa", "crafting",
                f"What is the crafting recipe for {out_item} in Minecraft?",
                kws, ans_en, "all_keywords", "en"
            )
            add_eval(
                "unseen_paraphrase_mc", "crafting",
                f"Suppose I want to make {snake_to_words(out_item)} in Minecraft 1.21. List the exact items and counts needed and whether a 3x3 crafting table is required.",
                kws, ans_en, "all_keywords", "en"
            )
            if out_item in ("furnace", "bucket", "enchanting_table", "iron_pickaxe", "diamond_pickaxe", "shield", "anvil", "torch", "compass", "brewing_stand"):
                add_eval(
                    "unseen_paraphrase_mc", "crafting_fr",
                    f"Dans Minecraft, donne-moi la recette exacte (ingrédients et quantités) pour créer : {out_item}.",
                    kws, ans_fr, "all_keywords", "fr"
                )

    # Reverse crafting uses for key materials
    key_mats = [
        "oak_planks", "cobblestone", "iron_ingot", "copper_ingot", "gold_ingot",
        "diamond", "stick", "redstone", "obsidian", "blaze_rod", "leather",
        "string", "wheat", "coal", "quartz", "slime_ball", "ender_pearl", "flint",
    ]
    for mat in key_mats:
        outs = sorted(o for o in uses_map.get(mat, set()) if not o.startswith(("acacia_", "birch_", "spruce_", "jungle_", "dark_oak_", "mangrove_", "cherry_", "pale_oak_", "bamboo_", "crimson_", "warped_")))
        if not outs:
            outs = sorted(uses_map.get(mat, set()))
        sample_outs = outs[:18]
        if sample_outs:
            add_train(
                "uses",
                f"What items can you craft using {mat} in Minecraft?",
                f"In Minecraft 1.21.11, {mat} can be used to craft {len(outs)} recipes, including: {', '.join(sample_outs)}.",
                "en",
            )
            add_train(
                "uses",
                f"À quoi sert {mat} en craft dans Minecraft ?",
                f"Dans Minecraft 1.21.11, {mat} permet de fabriquer notamment : {', '.join(sample_outs[:12])}.",
                "fr",
            )

    # =========================================================================
    # 2. SMELTING / BLASTING / SMOKING / CAMPFIRE / STONECUTTING
    # =========================================================================
    smelt_by_in = defaultdict(list)
    for kind in ("smelting", "blasting", "smoking", "campfire_cooking"):
        for r in recipes[kind]:
            for inp in r["in"]:
                smelt_by_in[(inp, r["out"])].append((kind, r["time"]))

    for (inp, out), kinds in sorted(smelt_by_in.items()):
        knames = sorted({k for k, _ in kinds})
        ans = f"Smelting/cooking {inp} produces {out}. Supported stations: {', '.join(knames)}."
        add_train("smelting", f"What do you get when you smelt or cook {inp} in Minecraft?", ans, "en")
        add_train("smelting", f"How do you obtain {out} by smelting in Minecraft?", f"You obtain {out} by smelting {inp} in a {', '.join(knames)}.", "en")
        add_train("smelting", f"Que donne la cuisson de {inp} dans un four Minecraft ?", f"Cuire {inp} donne {out} (stations : {', '.join(knames)}).", "fr")

    for inp, out, kw in [
        ("raw_iron", "iron_ingot", ["iron_ingot"]),
        ("raw_copper", "copper_ingot", ["copper_ingot"]),
        ("raw_gold", "gold_ingot", ["gold_ingot"]),
        ("ancient_debris", "netherite_scrap", ["netherite_scrap"]),
        ("sand", "glass", ["glass"]),
        ("cobblestone", "stone", ["stone"]),
        ("stone", "smooth_stone", ["smooth_stone"]),
        ("clay_ball", "brick", ["brick"]),
        ("kelp", "dried_kelp", ["dried_kelp"]),
    ]:
        add_eval(
            "unseen_paraphrase_mc", "smelting",
            f"If I put {inp} into a furnace with fuel in Minecraft, what item comes out?",
            kw, out, "all_keywords", "en"
        )

    # Stonecutting (group by input -> outputs)
    sc_by_in = defaultdict(list)
    for r in recipes["stonecutting"]:
        for inp in r["in"]:
            sc_by_in[inp].append(f"{r['n']}x {r['out']}")
    for inp, outs in sorted(sc_by_in.items()):
        add_train(
            "stonecutting",
            f"What can a stonecutter make from {inp} in Minecraft?",
            f"A stonecutter converts 1 {inp} into: {', '.join(outs[:12])}.",
            "en",
        )

    # =========================================================================
    # 3. BLOCKS: TOOL TIERS, HARVESTABILITY, DROPS, HARDNESS, LIGHT
    # =========================================================================
    needs_stone = set(names["block_tags"].get("needs_stone_tool", []))
    needs_iron = set(names["block_tags"].get("needs_iron_tool", []))
    needs_diamond = set(names["block_tags"].get("needs_diamond_tool", []))
    mine_pick = set(names["block_tags"].get("mineable/pickaxe", []))
    mine_axe = set(names["block_tags"].get("mineable/axe", []))
    mine_shovel = set(names["block_tags"].get("mineable/shovel", []))
    mine_hoe = set(names["block_tags"].get("mineable/hoe", []))

    def min_tier_for_block(bname):
        if bname in needs_diamond:
            return "diamond_pickaxe (or netherite_pickaxe)"
        if bname in needs_iron:
            return "iron_pickaxe (or diamond/netherite)"
        if bname in needs_stone:
            return "stone_pickaxe or copper_pickaxe (or better)"
        if bname in mine_pick:
            return "wooden_pickaxe (or any pickaxe)"
        if bname in mine_axe:
            return "axe (or bare hand, axe is fastest)"
        if bname in mine_shovel:
            return "shovel (or bare hand, shovel is fastest)"
        if bname in mine_hoe:
            return "hoe (or shears for leaves)"
        return None

    for b in src["blocks"]:
        bname = b["name"]
        if bname in ("air", "cave_air", "void_air", "bedrock", "water", "lava", "barrier"):
            continue
        tier = min_tier_for_block(bname)
        loot = block_loot.get(bname, {})
        normal_drops = loot.get("normal", [])
        silk_drops = loot.get("silk", [])
        if not tier and not normal_drops and b.get("emitLight", 0) == 0:
            continue
        parts = []
        if tier:
            parts.append(f"Best/minimum tool: {tier}.")
        if normal_drops:
            parts.append(f"Normal drop: {', '.join(normal_drops)}.")
        if silk_drops and silk_drops != normal_drops:
            parts.append(f"With Silk Touch: {', '.join(silk_drops)}.")
        if b.get("hardness") is not None:
            parts.append(f"Hardness: {b['hardness']}, blast resistance: {b['resistance']}.")
        if b.get("emitLight", 0) > 0:
            parts.append(f"Light level emitted: {b['emitLight']}.")
        ans = f"Block {bname} in Minecraft 1.21.11: " + " ".join(parts)
        if tier or bname in block_loot:
            core_block = (
                bname in ("iron_ore", "deepslate_iron_ore", "coal_ore", "deepslate_coal_ore", "copper_ore", "deepslate_copper_ore",
                          "gold_ore", "deepslate_gold_ore", "nether_gold_ore", "lapis_ore", "deepslate_lapis_ore",
                          "redstone_ore", "deepslate_redstone_ore", "diamond_ore", "deepslate_diamond_ore",
                          "emerald_ore", "deepslate_emerald_ore", "nether_quartz_ore", "obsidian", "crying_obsidian",
                          "ancient_debris", "stone", "cobblestone", "deepslate", "oak_log", "crafting_table", "furnace", "chest")
            )
            important = (
                core_block or bname in needs_stone or bname in needs_iron or bname in needs_diamond
                or "ore" in bname or "log" in bname
                or bname in ("spawner", "budding_amethyst", "amethyst_cluster", "clay", "gravel", "sand", "dirt", "grass_block")
            )
            if important or rng.random() < 0.12:
                add_train("blocks", f"What tool do you need to mine {bname} and what does it drop in Minecraft?", ans, "en")
            if core_block:
                add_train("blocks_core", f"In Minecraft 1.21.11, what is the minimum pickaxe or tool to harvest {bname} and what does it drop?", ans, "en")
                add_train("blocks_core", f"Quel outil minimum faut-il pour récolter {bname} et qu'est-ce qu'il drop ?", f"Pour {bname} : outil minimum = {tier}. Drop normal = {', '.join(normal_drops) or bname}.", "fr")
            if important:
                if tier:
                    add_train("blocks", f"What is the minimum pickaxe or tool tier required to harvest {bname}?", f"To harvest {bname} in Minecraft 1.21.11, the minimum tool is: {tier}.", "en")
                    add_train("blocks", f"Quel outil minimum faut-il pour miner {bname} dans Minecraft ?", f"Pour miner {bname} dans Minecraft 1.21.11, il faut au minimum : {tier}.", "fr")
                if normal_drops:
                    add_train("blocks", f"What does breaking {bname} with the proper tool drop?", f"Breaking {bname} with the proper tool drops: {', '.join(normal_drops)}" + (f" (or {', '.join(silk_drops)} with Silk Touch)." if silk_drops and silk_drops != normal_drops else "."), "en")

    # Block evals (unseen phrasings)
    block_eval_cases = [
        ("iron_ore", ["stone", "raw_iron"], "stone_pickaxe or copper_pickaxe, drops raw_iron"),
        ("diamond_ore", ["iron", "diamond"], "iron_pickaxe, drops diamond"),
        ("deepslate_diamond_ore", ["iron", "diamond"], "iron_pickaxe, drops diamond"),
        ("obsidian", ["diamond"], "diamond_pickaxe or netherite_pickaxe, drops obsidian"),
        ("ancient_debris", ["diamond"], "diamond_pickaxe or netherite_pickaxe, drops ancient_debris"),
        ("coal_ore", ["wooden", "coal"], "wooden_pickaxe (any pickaxe), drops coal"),
        ("gold_ore", ["iron", "raw_gold"], "iron_pickaxe, drops raw_gold"),
        ("redstone_ore", ["iron", "redstone"], "iron_pickaxe, drops redstone"),
        ("lapis_ore", ["stone", "lapis_lazuli"], "stone_pickaxe or copper_pickaxe, drops lapis_lazuli"),
        ("emerald_ore", ["iron", "emerald"], "iron_pickaxe, drops emerald"),
        ("copper_ore", ["stone", "raw_copper"], "stone_pickaxe or copper_pickaxe, drops raw_copper"),
        ("nether_quartz_ore", ["wooden", "quartz"], "wooden_pickaxe (any pickaxe), drops quartz"),
    ]
    for bname, kws, ref in block_eval_cases:
        add_eval(
            "unseen_paraphrase_mc", "blocks",
            f"Which pickaxe tier is the lowest that successfully harvests {bname}, and what item drops when mined without Silk Touch?",
            kws, ref, "all_keywords", "en"
        )

    # =========================================================================
    # 4. ITEMS: DURABILITY, STACK SIZE, REPAIR
    # =========================================================================
    for it in src["items"]:
        iname = it["name"]
        if it.get("maxDurability"):
            rep = ", ".join(it.get("repairWith", [])) or "none"
            ans = (f"In Minecraft 1.21.11, {iname} has max durability {it['maxDurability']}, "
                   f"stack size {it['stackSize']}, and can be repaired with: {rep}.")
            add_train("items", f"What is the durability and repair material of {iname} in Minecraft?", ans, "en")
            add_train("items", f"Quelle est la durabilité de {iname} dans Minecraft ?",
                      f"{iname} a une durabilité maximale de {it['maxDurability']} et se répare avec : {rep}.", "fr")
        elif it["stackSize"] != 64 and iname != "air":
            add_train("items", f"What is the stack size of {iname} in Minecraft?",
                      f"In Minecraft, {iname} stacks up to {it['stackSize']} per inventory slot.", "en")

    for iname, kws, ref in [
        ("diamond_pickaxe", ["1561", "diamond"], "1561 durability, repaired with diamond"),
        ("iron_pickaxe", ["250", "iron_ingot"], "250 durability, repaired with iron_ingot"),
        ("wooden_pickaxe", ["59"], "59 durability"),
        ("stone_pickaxe", ["131"], "131 durability"),
        ("copper_pickaxe", ["190", "copper_ingot"], "190 durability, repaired with copper_ingot"),
        ("netherite_pickaxe", ["2031", "netherite_ingot"], "2031 durability, repaired with netherite_ingot"),
        ("elytra", ["432", "phantom_membrane"], "432 durability, repaired with phantom_membrane"),
        ("ender_pearl", ["16"], "stack size 16"),
    ]:
        add_eval(
            "unseen_paraphrase_mc", "items",
            f"In Minecraft 1.21.11, give the max durability (or stack limit if non-durable) and repair item for {iname}.",
            kws, ref, "all_keywords", "en"
        )

    # =========================================================================
    # 5. FOODS (all 44 foods from foods.json)
    # =========================================================================
    for f in src["foods"]:
        fname = f["name"]
        hp = int(f["foodPoints"]) if float(f["foodPoints"]).is_integer() else f["foodPoints"]
        sat = round(float(f["saturationRatio"]) / 2.0, 1)
        ans_en = f"In Minecraft 1.21.11, eating {fname} restores {hp} hunger points ({hp/2:g} drumsticks) and {sat} saturation."
        ans_fr = f"Dans Minecraft 1.21.11, manger {fname} restaure {hp} points de faim ({hp/2:g} gigots) et {sat} de saturation."
        add_train("foods", f"How many hunger points and saturation does {fname} restore in Minecraft?", ans_en, "en")
        add_train("foods", f"What are the food stats of {fname} in Minecraft?", ans_en, "en")
        add_train("foods", f"Combien de points de faim restaure {fname} dans Minecraft ?", ans_fr, "fr")

    for fname, kws, ref in [
        ("cooked_beef", ["8", "12.8"], "8 hunger, 12.8 saturation"),
        ("bread", ["5", "6"], "5 hunger, 6.0 saturation"),
        ("golden_carrot", ["6", "14.4"], "6 hunger, 14.4 saturation"),
        ("cooked_porkchop", ["8", "12.8"], "8 hunger, 12.8 saturation"),
        ("apple", ["4", "2.4"], "4 hunger, 2.4 saturation"),
        ("baked_potato", ["5", "6"], "5 hunger, 6.0 saturation"),
    ]:
        add_eval(
            "unseen_paraphrase_mc", "foods",
            f"When a player eats {fname} in Minecraft, how much hunger and saturation do they regain?",
            kws, ref, "all_keywords", "en"
        )

    # =========================================================================
    # 6. ENCHANTMENTS (all 43)
    # =========================================================================
    for e in src["enchants"]:
        ename = e["name"]
        excl = ", ".join(e.get("exclude", [])) or "none"
        ans = (f"Enchantment {ename} in Minecraft 1.21.11: max level {e['maxLevel']}, "
               f"applies to {e['category']}, incompatible with: {excl}, "
               f"treasure-only: {e['treasureOnly']}, curse: {e['curse']}.")
        add_train("enchantments", f"What is the max level and compatibility of the {ename} enchantment in Minecraft?", ans, "en")
        add_train("enchantments", f"Quel est le niveau maximum de l'enchantement {ename} dans Minecraft ?",
                  f"L'enchantement {ename} va jusqu'au niveau {e['maxLevel']} (catégorie : {e['category']}, incompatible avec : {excl}).", "fr")

    for ename, kws, ref in [
        ("fortune", ["3", "silk_touch"], "max level 3, incompatible with silk_touch"),
        ("mending", ["1", "infinity"], "max level 1, treasureOnly True, incompatible with infinity"),
        ("sharpness", ["5", "smite"], "max level 5, incompatible with smite/bane_of_arthropods"),
        ("efficiency", ["5"], "max level 5"),
        ("unbreaking", ["3"], "max level 3"),
        ("protection", ["4"], "max level 4"),
    ]:
        add_eval(
            "unseen_paraphrase_mc", "enchantments",
            f"What is the highest level of {ename} in Minecraft and what other enchantments conflict with it (if any)?",
            kws, ref, "all_keywords", "en"
        )

    # =========================================================================
    # 7. MOBS, ENTITIES & LOOT + BIOMES + EFFECTS + TAGS
    # =========================================================================
    hostile_set = set(names["hostile"])
    for ent in src["entities"]:
        ename = ent["name"]
        if ent["type"] not in ("hostile", "passive", "animal", "ambient", "mob", "player"):
            continue
        is_hostile = ename in hostile_set
        drops = ", ".join(entity_loot.get(ename, [])) or "no standard item drops"
        ans = (f"Mob {ename} in Minecraft 1.21.11: category={ent.get('category')}, "
               f"hostile_group={is_hostile}, hitbox={ent['width']}x{ent['height']} blocks, drops: {drops}.")
        add_train("mobs", f"What are the properties and drops of {ename} in Minecraft?", ans, "en")
        if entity_loot.get(ename):
            add_train("mobs", f"What items does {ename} drop when killed in Minecraft?", f"Killing {ename} in Minecraft 1.21.11 can drop: {drops}.", "en")
            add_train("mobs", f"Qu'est-ce que {ename} drop quand on le tue dans Minecraft ?", f"{ename} peut drop : {drops}.", "fr")

    for b in src["biomes"]:
        ans = (f"Biome {b['name']} in Minecraft 1.21.11: dimension={b['dimension']}, "
               f"category={b['category']}, temperature={b['temperature']}, has_precipitation={b['has_precipitation']}.")
        add_train("biomes", f"Which dimension and climate does the {b['name']} biome belong to in Minecraft?", ans, "en")

    for eff in src["effects"]:
        ans = f"Status effect {eff['name']} in Minecraft 1.21.11 is a {eff['type']} effect."
        add_train("effects", f"Is {eff['name']} a good or bad status effect in Minecraft?", ans, "en")

    # Key tags
    for tag_kind, tag_dict in [("item", names["item_tags"]), ("block", names["block_tags"])]:
        for tname in ["logs", "planks", "coals", "iron_ores", "diamond_ores", "pickaxes", "swords", "axes", "shovels", "hoes", "wool", "beds", "sand", "needs_iron_tool", "needs_diamond_tool"]:
            if tname in tag_dict:
                members = tag_dict[tname]
                add_train("tags", f"What belongs to tag:{tname} ({tag_kind} tag) in Minecraft 1.21.11?",
                          f"tag:{tname} contains {len(members)} entries, including: {', '.join(members[:15])}.", "en")

    # =========================================================================
    # 8. CURATED DEEP MECHANICS (ORES, NETHER/END, BREWING, COMBAT, VILLAGERS, REDSTONE, SURVIVAL)
    # =========================================================================
    mechanics = [
        # Ore distribution 1.21
        ("ores", "At what Y levels does diamond_ore generate and what is the best Y level to mine diamonds in Minecraft 1.21?",
         "In Minecraft 1.21, diamond_ore generates from Y=-64 to Y=16, becoming more common deeper underground. The best Y level to strip-mine or branch-mine diamonds is Y=-58 or Y=-59 (just above bedrock at -64 and lava lakes at Y=-54).",
         "Quel est le meilleur niveau Y pour trouver des diamants dans Minecraft 1.21 ?",
         "Dans Minecraft 1.21, le diamant génère entre Y=-64 et Y=16. Le meilleur niveau Y pour miner du diamant est Y=-58 ou Y=-59."),
        ("ores", "At what Y levels does iron_ore generate best in Minecraft 1.21?",
         "In Minecraft 1.21, iron_ore has three main peaks: Y=232 in high mountains, Y=16 underground (best mid-level iron), and smaller veins down to Y=-64 (especially around Y=-24).",
         "À quelle hauteur Y trouve-t-on le plus de minerai de fer dans Minecraft 1.21 ?",
         "Dans Minecraft 1.21, le fer a des pics à Y=232 (hautes montagnes) et à Y=16 sous terre (ainsi que des filons profonds vers Y=-24)."),
        ("ores", "Where does coal_ore generate best in Minecraft 1.21?",
         "In Minecraft 1.21, coal_ore generates from Y=0 to Y=320 with peaks at Y=96 and Y=136 (exposed in mountains), and never generates below Y=0.",
         "À quel Y trouve-t-on le charbon dans Minecraft 1.21 ?",
         "Dans Minecraft 1.21, le charbon génère de Y=0 à Y=320 avec des pics à Y=96 et Y=136 (il n'y en a pas sous Y=0)."),
        ("ores", "At what Y level do you find ancient_debris (netherite) in Minecraft 1.21?",
         "Ancient debris generates in the Nether between Y=8 and Y=119, with the highest concentration at Y=15. You must mine it with a diamond_pickaxe or netherite_pickaxe and smelt it into netherite_scrap.",
         "À quel niveau Y trouve-t-on les débris antiques (ancient_debris) dans le Nether ?",
         "Dans le Nether, ancient_debris génère surtout autour de Y=15 (entre Y=8 et Y=22) et doit être miné avec une pioche en diamant ou netherite."),
        ("ores", "At what Y levels do copper_ore, gold_ore, lapis_ore, redstone_ore, and emerald_ore peak in Minecraft 1.21?",
         "In Minecraft 1.21: copper_ore peaks at Y=48 (-16 to 112); gold_ore peaks at Y=-16 (-64 to 32, plus 32 to 256 in badlands); lapis_ore peaks at Y=0 (-64 to 64); redstone_ore peaks at Y=-59 (-64 to 15); emerald_ore generates in mountain biomes from Y=-16 to 320 peaking at Y=236.",
         "Quels sont les niveaux Y optimaux pour le cuivre, l'or, le lapis, la redstone et l'émeraude en 1.21 ?",
         "En 1.21 : cuivre Y=48, or Y=-16 (et surface en badlands), lapis Y=0, redstone Y=-59, émeraude dans les montagnes vers Y=236."),

        # Fuels
        ("smelting_fuel", "How many items can each fuel smelt in a Minecraft furnace?",
         "Furnace fuel burn counts in Minecraft: lava_bucket smelts 100 items, block_of_coal (coal_block) smelts 80 items, dried_kelp_block smelts 20 items, blaze_rod smelts 12 items, coal or charcoal smelts 8 items, wooden planks or logs smelt 1.5 items, and a stick smelts 0.5 items.",
         "Combien d'items cuisent le charbon, le seau de lave, le bloc de charbon et le bâton de blaze dans un four ?",
         "Un coal ou charcoal cuit 8 items, un dried_kelp_block 20, un blaze_rod 12, un coal_block 80 et un lava_bucket 100 items (planches/bûches : 1,5)."),
        ("smelting_fuel", "What is the difference between a furnace, blast_furnace, and smoker in Minecraft?",
         "A regular furnace smelts anything in 10 seconds (200 ticks) per item. A blast_furnace smelts only ores, raw metals, and metal armor/tools twice as fast (5 seconds, 100 ticks). A smoker cooks only food twice as fast (5 seconds, 100 ticks).",
         "Quelle est la différence entre furnace, blast_furnace et smoker dans Minecraft ?",
         "Le blast_furnace cuit les minerais 2x plus vite (5 s au lieu de 10 s) et le smoker cuit la nourriture 2x plus vite."),

        # Tool progression & combat
        ("progression", "What is the full tool progression order in Minecraft 1.21.11?",
         "Minecraft 1.21.11 tool tier progression from weakest to strongest: wood (wooden_pickaxe, mines stone/coal_ore) -> stone/copper (mines iron_ore/copper_ore/lapis_ore) -> iron (mines diamond_ore/gold_ore/redstone_ore/emerald_ore) -> diamond (mines obsidian/ancient_debris) -> netherite (upgraded from diamond via smithing_table with netherite_upgrade_smithing_template and netherite_ingot).",
         "Quel est l'ordre de progression des pioches dans Minecraft 1.21.11 ?",
         "Progression des pioches : bois (pierre/charbon) -> pierre ou cuivre (fer/cuivre/lapis) -> fer (diamant/or/redstone/émeraude) -> diamant (obsidienne/ancient_debris) -> netherite."),
        ("combat", "How do critical hits and shields work in Minecraft Java combat?",
         "In Minecraft Java Edition, attacking while falling (not on ground, not climbing, not sprinting-only without falling) deals a critical hit for 1.5x melee damage. Holding right-click with a shield blocks 100% of frontal melee and arrow damage, but an axe attack disables the shield for 5 seconds.",
         "Comment fonctionnent les coups critiques et le bouclier dans Minecraft Java ?",
         "En Java Edition, frapper en tombant inflige un coup critique (1,5x dégâts). Le bouclier bloque 100 % des attaques frontales, mais une hache le désactive pendant 5 secondes."),
        ("combat", "How much health do common hostile mobs have and how do you fight them safely?",
         "Common mob HP in Minecraft: zombie (20 HP, burns in daylight), skeleton (20 HP, ranged bow, burns in daylight), creeper (20 HP, explodes after 1.5s fuse within 3 blocks, drops gunpowder), spider (16 HP, neutral in bright light >=12), enderman (40 HP, 3 blocks tall, aggros on eye contact, damaged by water), blaze (20 HP, Nether fortress, shoots 3 fireballs, drops blaze_rod), warden (500 HP, Deep Dark, blind and tracks vibrations).",
         "Combien de PV ont le zombie, le squelette, le creeper, l'enderman et le warden ?",
         "Zombie 20 PV, squelette 20 PV, creeper 20 PV (explose après 1,5 s), araignée 16 PV, enderman 40 PV (craint l'eau), warden 500 PV."),

        # Nether & End
        ("nether_end", "How do you build and light a Nether portal and how do coordinates scale?",
         "A Nether portal requires a vertical rectangular obsidian frame at least 4x5 blocks (minimum 10 obsidian without corners, 14 with corners) lit inside with flint_and_steel or fire. Coordinates scale 8:1: 1 block traveled in the Nether equals 8 blocks in the Overworld on X and Z.",
         "Comment construire un portail du Nether et quel est le ratio de coordonnées ?",
         "Il faut un cadre d'obsidienne d'au moins 4x5 (10 obsidiennes minimum sans les coins), allumé avec un briquet (flint_and_steel). 1 bloc dans le Nether = 8 blocs dans l'Overworld."),
        ("nether_end", "What happens if you try to sleep in a bed in the Nether or the End?",
         "Beds explode violently (power 5, stronger than TNT) if used in the Nether or the End! Never sleep in the Nether or End unless intentionally using bed-bombing against the Ender Dragon or for ancient debris. Use a respawn_anchor charged with glowstone in the Nether.",
         "Que se passe-t-il si on essaie de dormir dans un lit dans le Nether ou l'End ?",
         "Le lit explose violemment (puissance 5) dans le Nether et dans l'End ! Dans le Nether, on utilise une respawn_anchor chargée à la glowstone."),
        ("nether_end", "How do you reach the End and defeat the Ender Dragon in Minecraft?",
         "To reach the End: collect blaze_rods in a Nether fortress, craft blaze_powder, combine with ender_pearls to craft eye_of_ender (bring ~12-16). Throw eyes of ender to locate a stronghold, fill the 12 End Portal frames, enter, destroy all End Crystals on top of the obsidian pillars (some have iron_bars cages), then defeat the Ender Dragon (200 HP). Afterward, enter an End Gateway to find End Cities and Elytra.",
         "Comment aller dans l'End et battre l'Ender Dragon ?",
         "Combinez blaze_powder + ender_pearl pour faire des eye_of_ender (~12-16), trouvez le stronghold, activez le portail de l'End, détruisez les cristaux sur les piliers d'obsidienne puis tuez l'Ender Dragon (200 PV)."),

        # Enchanting, Smithing, Villagers
        ("enchanting", "How do you get level 30 enchantments on an enchanting_table in Minecraft?",
         "Place 15 bookshelves around an enchanting_table at the same Y level or 1 block higher, leaving a 1-block empty air gap (no torches, snow, or carpets) between the table and the bookshelves. Level 30 enchants also require 1 to 3 lapis_lazuli and 30 XP levels (spending 1-3 levels).",
         "Comment obtenir les enchantements de niveau 30 sur une table d'enchantement ?",
         "Placez 15 bibliothèques (bookshelf) autour de l'enchanting_table avec exactement 1 bloc d'air vide entre les deux, plus du lapis_lazuli et 30 niveaux d'XP."),
        ("smithing", "How do you upgrade diamond gear to netherite gear in Minecraft 1.21?",
         "In Minecraft 1.21, upgrading diamond gear to netherite requires a smithing_table with 3 inputs: a netherite_upgrade_smithing_template (found in Bastion Remnants, duplicated with 7 diamonds + 1 netherrack), the diamond tool/armor item, and 1 netherite_ingot (crafted from 4 netherite_scrap + 4 gold_ingot).",
         "Comment améliorer un équipement en diamant en netherite en 1.21 ?",
         "Utilisez une smithing_table avec : 1 netherite_upgrade_smithing_template, l'objet en diamant et 1 netherite_ingot (4 netherite_scrap + 4 gold_ingot)."),
        ("villagers", "What workstation block corresponds to each villager profession in Minecraft?",
         "Villager professions and workstations: Librarian=lectern, Armorer=blast_furnace, Weaponsmith=grindstone, Toolsmith=smithing_table, Farmer=composter, Fletcher=fletching_table, Cleric=brewing_stand, Cartographer=cartography_table, Butcher=smoker, Shepherd=loom, Leatherworker=cauldron, Mason=stonecutter, Fisherman=barrel.",
         "Quel bloc de métier correspond à chaque profession de villageois dans Minecraft ?",
         "Bibliothécaire=lectern, Armurier=blast_furnace, Forgeron d'armes=grindstone, Forgeron d'outils=smithing_table, Fermier=composter, Fléchier=fletching_table, Clerc=brewing_stand, Cartographe=cartography_table, Boucher=smoker, Tailleur de pierre=stonecutter, Pêcheur=barrel."),

        # Brewing
        ("brewing", "How do brewing and potions work in Minecraft?",
         "Brewing requires a brewing_stand (3 cobblestone + 1 blaze_rod) fueled by blaze_powder. First brew water_bottle + nether_wart -> awkward_potion. Then add: sugar -> Swiftness, blaze_powder -> Strength, magma_cream -> Fire Resistance, golden_carrot -> Night Vision, pufferfish -> Water Breathing, glistering_melon_slice -> Instant Health, ghast_tear -> Regeneration, phantom_membrane -> Slow Falling, spider_eye -> Poison. Modify with redstone (longer duration), glowstone_dust (level II), gunpowder (splash), or dragon_breath (lingering).",
         "Comment fabriquer les potions principales dans Minecraft ?",
         "Dans un brewing_stand (alimenté par blaze_powder) : water_bottle + nether_wart = awkward_potion. Ensuite : magma_cream (Fire Resistance), blaze_powder (Force), sugar (Vitesse), golden_carrot (Vision nocturne), ghast_tear (Régénération), pufferfish (Respiration aquatique). Redstone augmente la durée, glowstone augmente le niveau."),

        # Redstone, Water/Lava, Time, Survival
        ("redstone", "What are the core redstone rules in Minecraft?",
         "Redstone dust carries power from 15 down by 1 per block (max 15 blocks without a repeater). A redstone_repeater boosts signal back to 15, only conducts one direction, and adds 1 to 4 redstone ticks (0.1 to 0.4s) delay. A redstone_comparator compares/subtracts signals or reads container fullness. An observer outputs a 1-tick pulse when the block in front changes state.",
         "Quelles sont les bases de la redstone dans Minecraft ?",
         "La poudre de redstone transmet un signal de puissance 15 sur 15 blocs max. Le repeater remet le signal à 15 (1 à 4 ticks de délai). Le comparator lit les conteneurs ou compare deux signaux. L'observer détecte les changements de bloc."),
        ("survival", "How do water, lava, fall damage, and the day-night cycle work in Minecraft?",
         "One Minecraft day-night cycle lasts 20 real minutes (24000 ticks): day is 0-12000, sunset ~12000-13000, night/monster spawning starts ~13000 (beds work from tick 12541 or during thunderstorms). Water source blocks become infinite in a 2x2 pool or 1x3 line; water negates all fall damage (MLG water bucket). Lava + water source = obsidian; flowing lava + water = cobblestone; lava falling onto water = stone. Hostile mobs spawn at block light level 0 in the Overworld.",
         "Comment fonctionnent le cycle jour-nuit, l'eau et la lave dans Minecraft ?",
         "Un cycle jour-nuit dure 20 minutes (24000 ticks) ; la nuit commence vers 13000 ticks. L'eau annule les dégâts de chute et forme une source infinie en 2x2. Eau + source de lave = obsidienne ; eau + lave qui coule = cobblestone."),
        ("survival", "What are the best survival tips for starting a new Minecraft world?",
         "Day 1 survival progression: chop 3-4 logs -> craft planks -> crafting_table + sticks -> wooden_pickaxe -> mine 3 cobblestone for stone_pickaxe + 8 cobblestone for furnace + stone_axe/sword -> collect coal or smelt logs into charcoal for torches -> gather food (animals/wheat) and wool for a bed -> mine iron_ore for iron_pickaxe, bucket, shield, and iron armor before night or caving deep.",
         "Quelle est la meilleure progression de survie au début d'une partie Minecraft ?",
         "Coupez 3-4 bûches -> planches -> table de craft + bâtons -> pioche en bois -> 11+ cobblestones (pioche en pierre + four) -> charbon/torches -> nourriture et lit -> fer pour pioche en fer, bouclier, seau et armure."),
    ]

    for cat, q_en, a_en, q_fr, a_fr in mechanics:
        add_train(cat, q_en, a_en, "en")
        add_train(cat, q_fr, a_fr, "fr")
        add_train(cat, f"Explain briefly in Minecraft 1.21: {q_en}", a_en, "en")

    # Atomic high-signal mechanics Q&A (EN + FR, multiple phrasings, disjoint from eval templates)
    atomic_mech = [
        # Ores
        ("ores", "Where do diamonds spawn in Minecraft 1.21?", "Diamonds generate from Y=-64 to Y=16, with the best mining level at Y=-58 or Y=-59."),
        ("ores", "Quel est le meilleur Y pour le diamant en 1.21 ?", "Le meilleur niveau Y pour miner le diamant en 1.21 est Y=-58 ou Y=-59 (génération entre -64 et 16)."),
        ("ores", "Where does ancient_debris spawn in the Nether?", "Ancient debris spawns in the Nether between Y=8 and Y=119, peaking strongly at Y=15."),
        ("ores", "Où trouver de l'ancient_debris dans le Nether ?", "L'ancient_debris se trouve surtout autour de Y=15 dans le Nether (entre Y=8 et Y=22)."),
        ("ores", "Where does coal_ore spawn in Minecraft 1.21?", "Coal ore generates from Y=0 to Y=320 with peaks at Y=96 and Y=136; it does not generate below Y=0."),
        ("ores", "Where does iron_ore spawn best in Minecraft 1.21?", "Iron ore peaks at Y=232 in mountains, Y=16 underground, and also generates deep around Y=-24."),
        ("ores", "Where does copper_ore spawn best in Minecraft 1.21?", "Copper ore generates from Y=-16 to Y=112 and peaks at Y=48 (higher in Dripstone Caves)."),
        ("ores", "Where does gold_ore spawn best in Minecraft 1.21?", "Gold ore peaks at Y=-16 underground (-64 to 32) and also generates abundantly from Y=32 to Y=256 in Badlands."),
        ("ores", "Where does lapis_ore spawn best in Minecraft 1.21?", "Lapis lazuli ore generates from Y=-64 to Y=64 and peaks at Y=0."),
        ("ores", "Where does redstone_ore spawn best in Minecraft 1.21?", "Redstone ore generates from Y=-64 to Y=15 and peaks at Y=-59."),
        ("ores", "Where does emerald_ore spawn in Minecraft 1.21?", "Emerald ore generates only in mountain biomes from Y=-16 to Y=320, peaking at Y=236."),
        # Fuels
        ("smelting_fuel", "How many items does 1 coal or charcoal smelt?", "One coal or charcoal smelts 8 items in a furnace."),
        ("smelting_fuel", "Combien d'items cuit un charbon dans un four ?", "Un charbon (coal ou charcoal) cuit 8 items."),
        ("smelting_fuel", "How many items does a lava_bucket smelt?", "One lava_bucket smelts 100 items in a furnace and leaves behind an empty bucket."),
        ("smelting_fuel", "How many items does a coal_block smelt?", "One coal_block smelts 80 items in a furnace."),
        ("smelting_fuel", "How many items does a dried_kelp_block smelt?", "One dried_kelp_block smelts 20 items in a furnace."),
        ("smelting_fuel", "How many items does a blaze_rod smelt?", "One blaze_rod smelts 12 items in a furnace."),
        ("smelting_fuel", "What does a blast_furnace smelt faster?", "A blast_furnace smelts ores, raw metals, and metal armor/tools twice as fast as a regular furnace (5s per item instead of 10s)."),
        ("smelting_fuel", "What does a smoker cook faster?", "A smoker cooks food items twice as fast as a regular furnace (5s per item instead of 10s)."),
        # Nether & End
        ("nether_end", "How many obsidian blocks are needed for a minimum Nether portal?", "A minimum 4x5 Nether portal needs 10 obsidian blocks without corners (or 14 with corners), lit with flint_and_steel."),
        ("nether_end", "Combien d'obsidienne minimum faut-il pour un portail du Nether ?", "Un portail du Nether 4x5 minimum demande 10 blocs d'obsidienne sans les coins (14 avec les coins)."),
        ("nether_end", "What is the coordinate ratio between the Overworld and the Nether?", "1 block in the Nether equals 8 blocks in the Overworld on X and Z coordinates (1:8 ratio)."),
        ("nether_end", "Quel est le ratio de distance entre le Nether et l'Overworld ?", "1 bloc parcouru dans le Nether correspond à 8 blocs dans l'Overworld (ratio 1:8)."),
        ("nether_end", "Do beds work in the Nether or the End?", "No, beds explode violently (explosion power 5) if you try to sleep in them in the Nether or the End."),
        ("nether_end", "Peut-on dormir dans un lit dans le Nether ou l'End ?", "Non, un lit explose violemment (puissance 5) quand on essaie de l'utiliser dans le Nether ou l'End."),
        ("nether_end", "How do you set your spawn point in the Nether?", "Use a respawn_anchor and charge it with glowstone (up to 4 charges)."),
        ("nether_end", "How do you find a stronghold and activate the End Portal?", "Craft eye_of_ender from blaze_powder and ender_pearl, throw them to locate the stronghold, and place up to 12 eyes into the End Portal frames."),
        ("nether_end", "How much HP does the Ender Dragon have and how do you stop it healing?", "The Ender Dragon has 200 HP (100 hearts). Destroy the End Crystals on top of the obsidian pillars first because they heal the dragon."),
        # Enchanting & Smithing
        ("enchanting", "How many bookshelves are needed for level 30 enchantments?", "You need 15 bookshelves placed 1 air-block away from the enchanting_table to reach level 30 enchantments."),
        ("enchanting", "Combien de bibliothèques faut-il pour enchanter niveau 30 ?", "Il faut 15 bibliothèques (bookshelf) espacées d'exactement 1 bloc d'air autour de la table d'enchantement."),
        ("enchanting", "What item is consumed when enchanting on an enchanting_table?", "Lapis lazuli (1 to 3 lapis_lazuli) plus XP levels."),
        ("smithing", "How do you upgrade diamond gear to netherite in 1.21?", "In a smithing_table, combine a netherite_upgrade_smithing_template, the diamond gear, and 1 netherite_ingot."),
        ("smithing", "How do you craft a netherite_ingot?", "Combine 4 netherite_scrap (from smelting ancient_debris) and 4 gold_ingot."),
        # Villagers
        ("villagers", "What is the Librarian villager's workstation?", "The Librarian uses a lectern."),
        ("villagers", "What is the Farmer villager's workstation?", "The Farmer uses a composter."),
        ("villagers", "What is the Armorer villager's workstation?", "The Armorer uses a blast_furnace."),
        ("villagers", "What is the Toolsmith villager's workstation?", "The Toolsmith uses a smithing_table."),
        ("villagers", "What is the Weaponsmith villager's workstation?", "The Weaponsmith uses a grindstone."),
        ("villagers", "What is the Cleric villager's workstation?", "The Cleric uses a brewing_stand."),
        ("villagers", "What is the Fletcher villager's workstation?", "The Fletcher uses a fletching_table."),
        ("villagers", "What is the Cartographer villager's workstation?", "The Cartographer uses a cartography_table."),
        ("villagers", "What is the Butcher villager's workstation?", "The Butcher uses a smoker."),
        ("villagers", "What is the Mason villager's workstation?", "The Mason (Stone Mason) uses a stonecutter."),
        ("villagers", "What is the Fisherman villager's workstation?", "The Fisherman uses a barrel."),
        # Brewing
        ("brewing", "How do you brew an awkward_potion?", "Brew a water_bottle with nether_wart in a brewing_stand (powered by blaze_powder)."),
        ("brewing", "How do you brew a Fire Resistance potion?", "Add magma_cream to an awkward_potion (made from water_bottle + nether_wart)."),
        ("brewing", "How do you brew a Strength potion?", "Add blaze_powder to an awkward_potion (water_bottle + nether_wart)."),
        ("brewing", "How do you brew a Regeneration potion?", "Add ghast_tear to an awkward_potion."),
        ("brewing", "How do you brew a Swiftness potion?", "Add sugar to an awkward_potion."),
        ("brewing", "How do you brew a Night Vision potion?", "Add golden_carrot to an awkward_potion."),
        ("brewing", "How do you brew a Water Breathing potion?", "Add pufferfish to an awkward_potion."),
        ("brewing", "How do you extend a potion's duration or increase its level?", "Add redstone to extend duration, glowstone_dust for level II potency, or gunpowder to make it a splash potion."),
        # Redstone & Survival & Combat
        ("redstone", "How far does a redstone dust signal travel without a repeater?", "Redstone dust transmits signal strength 15, dropping by 1 per block, up to 15 blocks maximum."),
        ("redstone", "What does a redstone_repeater do?", "It resets redstone signal strength back to 15, transmits in one direction only, and adds 1 to 4 ticks of delay."),
        ("survival", "How long is one Minecraft day-night cycle in ticks and minutes?", "One full Minecraft day-night cycle is 24000 ticks, which equals 20 real-world minutes (10 min day, ~7 min night, ~3 min dusk/dawn)."),
        ("survival", "Combien de ticks et de minutes dure un cycle jour-nuit dans Minecraft ?", "Un cycle complet dure 24000 ticks, soit 20 minutes réelles."),
        ("survival", "What happens when water meets lava in Minecraft?", "Water touching a lava source block creates obsidian; water touching flowing lava creates cobblestone; lava falling onto water creates stone."),
        ("survival", "How do you make an infinite water source?", "Place 2 water_buckets in opposite corners of a 2x2 pit (or ends of a 1x3 trench) to form an infinite water source."),
        ("combat", "How do you land a critical hit in Minecraft Java Edition?", "Jump and attack while falling downward to deal 1.5x melee damage."),
        ("combat", "How do you disable an opponent's shield in Minecraft?", "Hit their raised shield with an axe to disable it for 5 seconds."),
        ("combat", "How do you avoid aggravating Piglins in the Nether?", "Wear at least one piece of gold armor (e.g. golden_helmet or golden_boots) so Piglins remain neutral."),
    ]
    for cat, q, a in atomic_mech:
        add_train(cat, q, a, "fr" if any(w in q for w in ("Quel", "Où", "Combien", "Peut-on")) else "en")
        add_train(cat, f"Minecraft 1.21 fact check: {q}", a, "en")

    # Training-only harvestability yes/no + multi-hop recipe math (STRICTLY disjoint from eval!)
    train_harvest_yn = [
        ("stone_pickaxe", "iron_ore", "Yes, a stone_pickaxe (or copper_pickaxe) can harvest iron_ore, dropping raw_iron."),
        ("wooden_pickaxe", "iron_ore", "No, a wooden_pickaxe cannot harvest iron_ore; you need at least a stone_pickaxe or copper_pickaxe."),
        ("stone_pickaxe", "gold_ore", "No, a stone_pickaxe cannot harvest gold_ore; you need at least an iron_pickaxe."),
        ("iron_pickaxe", "diamond_ore", "Yes, an iron_pickaxe can harvest diamond_ore, dropping a diamond."),
        ("iron_pickaxe", "ancient_debris", "No, an iron_pickaxe cannot harvest ancient_debris; you need a diamond_pickaxe or netherite_pickaxe."),
        ("diamond_pickaxe", "obsidian", "Yes, a diamond_pickaxe can harvest obsidian."),
        ("wooden_pickaxe", "stone", "Yes, a wooden_pickaxe can harvest stone, dropping cobblestone."),
    ]
    for tool, blk, ans in train_harvest_yn:
        add_train("blocks", f"Can a {tool} harvest {blk} in Minecraft? Answer yes or no and explain.", ans, "en")

    train_multihop = [
        ("How many total iron_ingot are needed to craft an iron_sword and an iron_helmet?", "2 (iron_sword) + 5 (iron_helmet) = 7 iron_ingots."),
        ("How many total iron_ingot are needed to craft an iron_axe and shears?", "3 (iron_axe) + 2 (shears) = 5 iron_ingots."),
        ("How many total diamond are needed to craft a diamond_sword and a diamond_pickaxe?", "2 (diamond_sword) + 3 (diamond_pickaxe) = 5 diamonds."),
        ("How many total oak_log are needed to make 12 oak_planks?", "3 oak_logs (since 1 log crafts 4 oak_planks, 3 * 4 = 12)."),
        ("How many total oak_log are needed to make 1 chest (8 planks) and 1 crafting_table (4 planks)?", "3 oak_logs (3 * 4 = 12 planks = 8 + 4)."),
        ("How many total cobblestone are needed to craft a furnace and a lever?", "8 (furnace) + 1 (lever) = 9 cobblestone."),
        ("How many total cobblestone are needed to craft 2 furnaces?", "2 * 8 = 16 cobblestone."),
        ("How many total iron_ingot are needed to craft 2 buckets and 1 shield?", "3 + 3 + 1 = 7 iron_ingots."),
        ("How many total iron_ingot are needed for a full set of iron armor (helmet, chestplate, leggings, boots)?", "5 + 8 + 7 + 4 = 24 iron_ingots."),
        ("How many total diamond are needed for a full set of diamond armor (helmet, chestplate, leggings, boots)?", "5 + 8 + 7 + 4 = 24 diamonds."),
        ("How many total gold_ingot are needed to craft a clock and 2 golden_apples?", "4 (clock) + 2 * 8 (golden_apple) = 20 gold_ingots."),
        ("How many total iron_ingot are needed for an iron_chestplate and an iron_pickaxe?", "8 + 3 = 11 iron_ingots."),
        ("How many total sticks are needed for an iron_pickaxe, an iron_axe, and an iron_shovel?", "2 + 2 + 2 = 6 sticks."),
        ("How many total cobblestone are needed for a full set of stone tools (pickaxe, axe, sword, shovel, hoe)?", "3 + 3 + 2 + 1 + 2 = 11 cobblestone."),
        ("How many total iron_ingot are needed for a full set of iron tools (pickaxe, axe, sword, shovel, hoe)?", "3 + 3 + 2 + 1 + 2 = 11 iron_ingots."),
    ]
    for q, a in train_multihop:
        add_train("multihop_train", q, a, "en")

    # Enchantment exclusions & French synonym bridges (helps cross-lingual recall)
    fr_synonyms = [
        ("enchantments", "Can Fortune and Silk Touch be put on the same tool?", "No, Fortune and Silk Touch are mutually exclusive in Minecraft and cannot be combined."),
        ("enchantments", "Can Mending and Infinity be put on the same bow?", "No, Mending and Infinity are mutually exclusive on a bow in Minecraft."),
        ("enchantments", "Can Sharpness, Smite, and Bane of Arthropods be combined?", "No, Sharpness, Smite, and Bane of Arthropods are mutually exclusive."),
        ("enchantments", "Can Protection, Blast Protection, Fire Protection, and Projectile Protection be combined?", "No, those four Protection enchantments are mutually exclusive on armor."),
        ("foods", "Combien de points de faim et de saturation restaure un steak cuit (cooked_beef) ?", "Dans Minecraft 1.21.11, un steak cuit (cooked_beef) restaure 8 points de faim (4 gigots) et 12.8 de saturation."),
        ("smelting_fuel", "Combien d'items cuit un seau de lave (lava_bucket) dans un four ?", "Un seau de lave (lava_bucket) cuit 100 items dans un four et rend un seau vide."),
        ("mobs", "Quel mob drop des perles de l'Ender (ender_pearl) ?", "L'Enderman drop des ender_pearl (0 à 1, plus avec Looting)."),
        ("brewing", "Comment préparer une awkward_potion dans un alambic ?", "Mettez une fiole d'eau (water_bottle) et une verrue du Nether (nether_wart) dans un alambic."),
        ("crafting", "Comment fabriquer un four (furnace) et de quoi a-t-il besoin ?", "Un four (furnace) ne nécessite pas de fer : il faut exactement 8 cobblestone sur une table de craft 3x3."),
    ]
    for cat, q, a in fr_synonyms:
        add_train(cat, q, a, "fr" if any(w in q for w in ("Combien", "Quel", "Comment")) else "en")

    # Add held-out unseen paraphrase evals for mechanics!
    mech_evals = [
        ("ores", "In Minecraft 1.21, if I want to find the highest density of diamond_ore, what Y coordinate should I dig at?", ["-58", "-59", "-64"], "Y=-58 or Y=-59 (generates -64 to 16)"),
        ("ores", "Where in the Nether should I mine to find ancient_debris most frequently?", ["15"], "Y=15"),
        ("smelting_fuel", "How many items does a single piece of coal smelt in a furnace, and how many does a lava_bucket smelt?", ["8", "100"], "coal=8, lava_bucket=100"),
        ("smelting_fuel", "Which furnace type smelts ores twice as fast as a standard furnace?", ["blast_furnace"], "blast_furnace"),
        ("nether_end", "What is the minimum number of obsidian blocks needed for a functional Nether portal frame (without corners)?", ["10"], "10 obsidian"),
        ("nether_end", "If I walk 100 blocks in the Nether, how many blocks does that correspond to in the Overworld?", ["800", "8"], "800 blocks (1:8 ratio)"),
        ("nether_end", "What happens if a player clicks a bed to sleep while in the Nether?", ["explod"], "The bed explodes"),
        ("enchanting", "How many bookshelves are required around an enchanting_table for level 30 enchants, and what gap must remain between them?", ["15", "1"], "15 bookshelves, 1 block air gap"),
        ("smithing", "What three items do you put into a smithing_table to upgrade diamond_chestplate to netherite?", ["netherite_upgrade_smithing_template", "netherite_ingot"], "template + diamond_chestplate + netherite_ingot"),
        ("villagers", "Which workstation block makes a villager become a Librarian, and which makes a Farmer?", ["lectern", "composter"], "Librarian=lectern, Farmer=composter"),
        ("brewing", "Starting from a water_bottle, which ingredient makes an awkward_potion, and what do you add next for Fire Resistance?", ["nether_wart", "magma_cream"], "nether_wart then magma_cream"),
        ("redstone", "How many blocks can redstone dust transmit power before needing a repeater?", ["15"], "15 blocks"),
        ("survival", "How many ticks and real-world minutes is one full Minecraft day-night cycle?", ["24000", "20"], "24000 ticks / 20 minutes"),
    ]
    for cat, q, kws, ref in mech_evals:
        add_eval("unseen_paraphrase_mc", cat, q, kws, ref, "all_keywords", "en")

    # =========================================================================
    # 9. MULTI-HOP / REASONING EVALUATION (held-out, NEVER trained directly!)
    # =========================================================================
    multihop_evals = [
        ("multihop", "How many total iron_ingot are required to craft BOTH an iron_pickaxe AND a bucket in Minecraft?", ["6"], "3 (iron_pickaxe) + 3 (bucket) = 6 iron_ingots"),
        ("multihop", "How many total oak_log blocks do you need to craft 1 crafting_table and 4 sticks (assuming 1 log -> 4 oak_planks, 2 planks -> 4 sticks)?", ["2"], "1 log -> 4 planks (crafting_table) + 1 log -> 4 planks -> 2 planks for 4 sticks = 2 logs"),
        ("multihop", "Can a stone_pickaxe successfully harvest diamond_ore in Minecraft? Answer yes or no and explain.", ["no", "iron"], "No, diamond_ore requires at least an iron_pickaxe."),
        ("multihop", "Can a wooden_pickaxe harvest coal_ore? Answer yes or no.", ["yes"], "Yes, coal_ore can be mined with a wooden_pickaxe."),
        ("multihop", "Can an iron_pickaxe harvest obsidian? Answer yes or no and say what is needed.", ["no", "diamond"], "No, obsidian requires a diamond_pickaxe or netherite_pickaxe."),
        ("multihop", "How many cobblestone blocks do you need in total to craft 1 furnace and 1 stone_pickaxe?", ["11"], "8 (furnace) + 3 (stone_pickaxe) = 11 cobblestone"),
        ("multihop", "How many total diamonds do you need to craft a full set of diamond tools (pickaxe, axe, sword, shovel, hoe)?", ["11"], "3 + 3 + 2 + 1 + 2 = 11 diamonds"),
        ("multihop", "Combien de lingots de fer faut-il au total pour fabriquer une enclume (anvil) dans Minecraft (sachant qu'un iron_block coûte 9 lingots) ?", ["31"], "3 iron_block (27) + 4 iron_ingot = 31 iron_ingots"),
    ]
    for cat, q, kws, ref in multihop_evals:
        add_eval("multihop_reasoning_mc", cat, q, kws, ref, "all_keywords", "fr" if "Combien" in q else "en")

    # =========================================================================
    # 10. MINEGPT V2 DSL & TOOLS KNOWLEDGE (from spec/catalog.json)
    # =========================================================================
    for vname, vinfo in src["catalog"]["verbs"].items():
        args_str = " ".join(f"<{a['name']}>" for a in vinfo.get("args", []))
        kw_str = " ".join(f"{k}=..." for k in vinfo.get("kw", {}).keys())
        ans = f"MineGPT DSL verb `{vname}` (family: {vinfo['family']}): syntax `{vname} {args_str} {kw_str}`. Meaning: {vinfo['doc']}."
        add_train("dsl", f"In the MineGPT DSL, what does the verb `{vname}` do?", ans, "en")
    for tname, tinfo in src["catalog"]["tools"].items():
        args_str = " ".join(f"<{a['name']}>" for a in tinfo.get("args", []))
        ans = f"MineGPT tool `{tname}`: syntax `tool: {tname} {args_str}`. Meaning: {tinfo['doc']}."
        add_train("dsl", f"In the MineGPT harness, what does the tool `{tname}` do?", ans, "en")

    # =========================================================================
    # 11. GENERAL REPLAY MIX (anti-forgetting: math, world knowledge, French/English, logic)
    # =========================================================================
    general_qa = [
        ("What is the capital of France?", "The capital of France is Paris."),
        ("Quelle est la capitale du Japon ?", "La capitale du Japon est Tokyo."),
        ("What is the chemical symbol for water?", "The chemical symbol for water is H2O."),
        ("Who wrote Romeo and Juliet?", "William Shakespeare wrote Romeo and Juliet."),
        ("What planet is closest to the Sun?", "Mercury is the closest planet to the Sun."),
        ("Combien y a-t-il de secondes dans une heure ?", "Il y a 3600 secondes dans une heure (60 * 60)."),
        ("What is the boiling point of water at sea level in Celsius?", "Water boils at 100 degrees Celsius at sea level."),
        ("Explain briefly what photosynthesis is.", "Photosynthesis is the process by which plants use sunlight, water, and carbon dioxide to produce glucose and oxygen."),
        ("Qu'est-ce qu'un nombre premier ?", "Un nombre premier est un entier supérieur à 1 qui n'a que deux diviseurs positifs : 1 et lui-même (par exemple 2, 3, 5, 7, 11)."),
        ("Write a Python function that returns the square of x.", "```python\ndef square(x):\n    return x * x\n```"),
        ("Convert 3 kilometers into meters.", "3 kilometers is 3000 meters."),
        ("What is the largest ocean on Earth?", "The Pacific Ocean is the largest ocean on Earth."),
    ]
    for q, a in general_qa:
        add_train("general_replay", q, a, "fr" if "Quelle" in q or "Combien" in q or "Qu'est" in q else "en")

    # Seeded arithmetic & logic replay (different seed from eval!)
    arng = random.Random(101)
    for _ in range(400):
        a, b, c = arng.randint(5, 90), arng.randint(2, 25), arng.randint(2, 15)
        op_type = arng.choice(["add_mul", "sub_div", "percent", "state"])
        if op_type == "add_mul":
            q = f"Compute ({a} + {b}) * {c}."
            ans = f"({a} + {b}) * {c} = {a + b} * {c} = {(a + b) * c}."
        elif op_type == "sub_div":
            tot = a * b
            q = f"If you have {tot} items and split them equally into {b} groups, how many are in each group?"
            ans = f"{tot} / {b} = {a} items per group."
        elif op_type == "percent":
            val = a * 10
            pct = arng.choice([10, 20, 25, 50])
            q = f"What is {pct}% of {val}?"
            ans = f"{pct}% of {val} is {val * pct // 100}."
        else:
            x, y = arng.randint(1, 20), arng.randint(1, 20)
            q = f"Start with x={x}, y={y}. Add y to x, then double x. What is x?"
            ans = f"After adding y, x = {x + y}. After doubling, x = {2 * (x + y)}."
        add_train("general_replay", q, ans, "en")

    # General retention eval (held-out from replay!)
    general_eval = [
        ("What is the capital of Germany?", ["Berlin"], "Berlin"),
        ("Quelle est la capitale de l'Italie ?", ["Rome"], "Rome"),
        ("What is 27 * 14?", ["378"], "378"),
        ("If a train travels 60 km/h for 2.5 hours, how many kilometers does it travel?", ["150"], "150 km"),
        ("What gas do humans need to breathe to survive?", ["oxygen"], "oxygen"),
        ("Combien font 125 + 375 ?", ["500"], "500"),
    ]
    for q, kws, ref in general_eval:
        add_eval("general_retention", "general", q, kws, ref, "all_keywords", "fr" if "Quelle" in q or "Combien" in q else "en")

    rng.shuffle(train)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with open(OUT_DIR / "mc_train.jsonl", "w", encoding="utf-8") as f:
        for r in train:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    with open(OUT_DIR / "mc_eval.jsonl", "w", encoding="utf-8") as f:
        for r in eval_items:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    from collections import Counter
    print("Wrote kb/mc_train.jsonl:", len(train), dict(Counter(r["category"] for r in train)))
    print("Wrote kb/mc_eval.jsonl:", len(eval_items), dict(Counter(r["bucket"] for r in eval_items)))


if __name__ == "__main__":
    build_dataset()
