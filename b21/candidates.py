"""Candidate facts for Java 1.21.11 and explicitly synthetic world fixtures."""

from prepare import DATA, write_jsonl

RECIPES = [
    ("furnace", "cobblestone", 8),
    ("chest", "planks", 8),
    ("crafting table", "planks", 4),
    ("stone pickaxe", "cobblestone", 3),
    ("iron pickaxe", "iron ingots", 3),
    ("anvil", "iron blocks", 3),
    ("bucket", "iron ingots", 3),
    ("cauldron", "iron ingots", 7),
    ("iron bars", "iron ingots", 6),
    ("hopper", "iron ingots", 5),
    ("iron door", "iron ingots", 6),
    ("minecart", "iron ingots", 5),
    ("iron chain", "iron nuggets", 2),
    ("lantern", "iron nuggets", 8),
    ("blast furnace", "smooth stone blocks", 3),
    ("smoker", "logs", 4),
    ("dispenser", "cobblestone", 7),
    ("observer", "cobblestone", 6),
    ("piston", "cobblestone", 4),
    ("lectern", "wooden slabs", 4),
    ("armor stand", "sticks", 6),
    ("ladder", "sticks", 7),
    ("fishing rod", "sticks", 3),
    ("crossbow", "string", 2),
    ("bow", "string", 3),
    ("map", "paper", 8),
    ("book", "paper", 3),
    ("bookshelf", "planks", 6),
    ("composter", "wooden slabs", 7),
    ("target block", "redstone dust", 4),
    ("daylight detector", "nether quartz", 3),
    ("note block", "planks", 8),
]

LANDMARKS = [
    ("Copperwick base", "north"), ("Ashmere bed", "west"),
    ("Juniper supply chest", "south"), ("Frostbank farm", "east"),
    ("Redwillow dock", "west"), ("Sablegate portal", "north"),
    ("Fernvault mine", "south"), ("Birchglass tower", "north"),
    ("Mosswick forge", "east"), ("Hazelrift shelter", "west"),
    ("Duskfen bridge", "south"), ("Quartzbay storehouse", "east"),
    ("Alderhook lumber camp", "west"), ("Pinebarrow beacon", "south"),
    ("Snowreed lookout", "east"), ("Slatefall quarry", "north"),
    ("Ironlace village", "east"), ("Cinderpond fishing hut", "west"),
    ("Goldspire waystation", "north"), ("Riverglass workshop", "south"),
]

RECIPE_NEIGHBORS = [
    "How many output items does one vanilla Java recipe for a stone shovel produce?",
    "What workstation has the vanilla Java 3 by 3 crafting grid?",
    "What tool normally mines a crafting table fastest in vanilla Java Minecraft?",
]
DIRECTIONS = ("north", "south", "east", "west")


def recipe(index, subject, ingredient, quantity):
    identifier = subject.replace(" ", "_")
    # A controlled observation asks for the one move that supplies the missing unit.
    missing = "oak_planks" if ingredient == "planks" else ingredient.replace(" ", "_")
    if ingredient not in {"planks", "cobblestone", "iron ingots", "logs", "sticks",
                          "string", "paper", "iron nuggets", "redstone dust"}:
        missing = {"iron blocks": "iron_block", "smooth stone blocks": "smooth_stone",
                   "wooden slabs": "oak_slab", "nether quartz": "quartz"}[ingredient]
    missing = {"iron_ingots": "iron_ingot", "logs": "oak_log", "sticks": "stick",
               "iron_nuggets": "iron_nugget"}.get(missing, missing)
    # Vanilla bot has no withdraw action. Branching routes represent shopping for materials.
    sufficient = DIRECTIONS[index % 4]
    short = DIRECTIONS[(index + 1) % 4]
    action = f"explore {sufficient}"
    # Sometimes either route provides enough, so the smallest sufficient load wins.
    stock, sufficient_units, other_units = (
        (quantity - 1, 1, 3) if index % 2 else (quantity - 2, 2, 1))
    routes = sorted([(sufficient, sufficient_units), (short, other_units)])
    return dict(
        id=f"mc-{identifier}", family="minecraft", subject=subject,
        relation=f"units of {ingredient} used per crafting operation", object=str(quantity),
        prompt=f"In vanilla Minecraft Java, how many units of {ingredient} does the {subject} recipe use?",
        memory=f"In vanilla Minecraft Java, one {subject} crafting operation uses {quantity} units of {ingredient}.",
        train=[f"Give the {ingredient} ingredient count for crafting a {subject} in Java Edition."],
        paraphrases=[
            f"I am making a {subject} in Java Edition. How many units of {ingredient} should I put in the grid?",
            f"What's the count of {ingredient} in the standard Java recipe for {subject}?",
            f"For one vanilla Java crafting operation for {subject}, what quantity of {ingredient} is consumed?",
        ],
        neighbors=RECIPE_NEIGHBORS,
        bot=[dict(
            prompt=(f"Goal: craft {identifier} once. Recipe materials except {missing} are ready. "
                    f"Inventory: {stock} {missing}. Routes: "
                    + ", ".join(f"{way} adds {units}" for way, units in routes)
                    + f". Take the smallest load that gives enough {missing} in one trip. "
                    + "Options: " + ", ".join(f"explore {way}" for way, _ in routes) + "."),
            options=sorted([action, f"explore {short}"]), expected=action,
        )],
    )


def world(subject, direction):
    action = f"explore {direction}"
    return dict(
        id=f"world-{subject.lower().replace(' ', '-')}", family="world_synthetic",
        subject=subject, relation="direction from the hub", object=direction,
        prompt=f"Which direction from the hub leads to {subject}?",
        memory=f"In this world, {subject} is {direction} of the hub.",
        train=[f"State the compass bearing of {subject} as seen from the hub."],
        paraphrases=[
            f"I'm at the central hub and need to reach {subject}. Which way should I head?",
            f"From the hub, in which cardinal direction would I find {subject}?",
            f"Looking at the world map with the hub as the origin, where is {subject}?",
        ],
        neighbors=[
            f"If I walk west to {subject}, which way do I walk back?",
            f"Does the name {subject} start with the letter Z?",
            f"Could I set a respawn point at {subject} with a bed in the Overworld?",
        ],
        bot=[dict(
            prompt=f"Goal: reach {subject}. Location: central hub. All four roads are passable. "
                   "Options: explore east, explore north, explore south, explore west.",
            options=[f"explore {way}" for way in sorted(DIRECTIONS)], expected=action,
        )],
    )


if __name__ == "__main__":
    write_jsonl(DATA / "candidates.jsonl",
                [recipe(index, *row) for index, row in enumerate(RECIPES)]
                + [world(*row) for row in LANDMARKS])
    write_jsonl(DATA / "sweep.jsonl", [world(*row) for row in [
        ("Farstone inn", "east"), ("Moonsedge mill", "west"),
        ("Ambercomb apiary", "north"), ("Wrenford gate", "south"),
    ]])
