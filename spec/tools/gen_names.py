"""Build spec/names.json: every valid name the DSL accepts, from minecraft-data 1.21.11 + the vanilla server jar tags.

Run: .venv/Scripts/python.exe spec/tools/gen_names.py
"""
import json
import subprocess
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VERSION = "1.21.11"
JAR = ROOT / "mcserver" / "versions" / VERSION / f"server-{VERSION}.jar"
OUT = ROOT / "spec" / "names.json"

DUMP_JS = r"""
const d = require('minecraft-data')(process.argv[1]);
const out = {
  items: d.itemsArray.map(i => i.name),
  blocks: d.blocksArray.map(b => b.name),
  entities: d.entitiesArray.map(e => ({name: e.name, type: e.type, category: e.category || null})),
  biomes: (d.biomesArray || []).map(b => b.name),
  effects: (d.effectsArray || []).map(e => e.name),
  enchantments: (d.enchantmentsArray || []).map(e => e.name),
};
process.stdout.write(JSON.stringify(out));
"""


def dump_minecraft_data():
    res = subprocess.run(["node", "-e", DUMP_JS, VERSION], cwd=ROOT / "bot", capture_output=True, text=True, check=True)
    return json.loads(res.stdout)


def snake(name):
    # minecraft-data effect names are CamelCase ("Speed", "InstantHealth") -> snake_case like the game ids
    out = ""
    for i, c in enumerate(name):
        if c.isupper() and i and not name[i - 1].isupper():
            out += "_"
        out += c.lower()
    return out


def read_tags(zf, kind):
    """Return {tag: sorted member names}, nested tags resolved, for data/minecraft/tags/<kind>/."""
    prefix = f"data/minecraft/tags/{kind}/"
    raw = {}
    for n in zf.namelist():
        if n.startswith(prefix) and n.endswith(".json"):
            raw[n[len(prefix):-5]] = json.loads(zf.read(n))["values"]

    resolved = {}

    def resolve(tag, stack=()):
        if tag in resolved:
            return resolved[tag]
        members = set()
        for v in raw.get(tag, []):
            if isinstance(v, dict):  # {"id": ..., "required": false}
                v = v["id"]
            if v.startswith("#"):
                sub = v[1:].removeprefix("minecraft:")
                if sub not in stack:
                    members |= resolve(sub, stack + (tag,))
            else:
                members.add(v.removeprefix("minecraft:"))
        resolved[tag] = members
        return members

    return {t: sorted(resolve(t)) for t in sorted(raw)}


def main():
    md = dump_minecraft_data()
    with zipfile.ZipFile(JAR) as zf:
        item_tags = read_tags(zf, "item")
        block_tags = read_tags(zf, "block")
        entity_tags = read_tags(zf, "entity_type")
    # category "Hostile mobs" (includes ghast, slime, phantom... typed "mob"). Neutral mobs (enderman, piglin) are in it.
    hostile = sorted(e["name"] for e in md["entities"] if e["category"] == "Hostile mobs")
    names = {
        "version": VERSION,
        "items": sorted(md["items"]),
        "blocks": sorted(md["blocks"]),
        "entities": sorted(e["name"] for e in md["entities"]),
        "mobs": sorted(e["name"] for e in md["entities"] if e["type"] in ("hostile", "passive", "animal", "ambient", "mob", "player")),
        "hostile": hostile,
        "biomes": sorted(md["biomes"]),
        "effects": sorted(snake(e) for e in md["effects"]),
        "enchantments": sorted(md["enchantments"]),
        "item_tags": item_tags,
        "block_tags": block_tags,
        "entity_tags": entity_tags,
    }
    OUT.write_text(json.dumps(names, indent=0, separators=(",", ":")) + "\n", encoding="utf-8")
    print(OUT, {k: len(v) for k, v in names.items() if k != "version"})


if __name__ == "__main__":
    main()
