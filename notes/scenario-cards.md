# Scenario cards (H4)

A scenario card fully describes one reproducible episode in MineSim: the world, the bot's starting state (body,
inventory, memory), what it is asked to do, what happens during the episode, how the result is judged and a
reference solution proving the card is solvable. Nothing about an episode may live outside its card.

Files: `bot/sim/cards/<area>/<id>.json` (one card per file). Loader / validator / compiler: `bot/sim/cards.js`.
Runner: `node sim/run_cards.js [--sim N] [--lock] [--only id,...] [--seeds 1,2] [--policy script]`.

## Principles
- **Complete**: setup is from a wiped region, every state the outcome depends on is set by the card
  (inventory, health, food, effects, xp, time, weather, gamerules, blocks, containers, entities, bot memory).
- **Server-judged**: success / failure checks are evaluated through RCON on the server, never from the bot's
  perception (the bot's world model can be wrong; the judge must not share its bugs).
- **Seeded**: `params` are drawn from a PRNG seeded by `(card.id, seed)`; same card + seed = same setup.
  Residual randomness (mob AI, drops) is covered by running several seeds.
- **Relative coordinates**: positions are written `<dx,dy,dz>` relative to the card origin (arena center,
  floor surface = dy 0). The runner places the origin; cards never contain absolute coordinates.
- **Solvable**: every card ships a `solution` (DSL statements) that the `script` policy must pass on all seeds
  before the card is used for training or eval (`run_cards.js --policy script`).
- **Held-out** cards (`split: "heldout"`) are never trained on.

## Format (version 1)

```jsonc
{
  "card": 1,                         // format version
  "id": "craft.planks_from_logs",    // unique, <area>.<name>
  "title": "Craft planks from logs in the inventory",
  "tags": ["craft", "inventory"],    // skills exercised
  "difficulty": 1,                   // 1 (one action) .. 5 (long multi-stage)
  "split": "train",                  // train | heldout
  "seeds": [1, 2, 3],                // default seeds

  // random parameters, drawn per seed; used as ${name} anywhere in strings
  "params": {
    "n":    { "int": [4, 12] },                    // inclusive range
    "wood": { "choice": ["oak", "birch", "spruce"] },
    "dx":   { "int": [3, 8] },
    "far":  { "bool": 0.5 }                        // true with p
  },
  // derived values: string templates evaluated after params (simple arithmetic allowed: + - * / in ${...})
  "let": { "logs": "${ceil(n/4)}" },

  "world": {
    "template": "arena",             // arena: 31x31 stone floor + air above | void: air only | flat: untouched flat world
    "radius": 15,                    // arena half size (blocks), wiped + rebuilt each episode
    "height": 12,                    // air above the floor
    "floor": "stone",                // floor block (template arena)
    "depth": 15,                     // floor thickness
    "dimension": "overworld",        // overworld | the_nether | the_end
    "time": 1000,                    // daytime ticks (0..24000)
    "weather": "clear",              // clear | rain | thunder
    "difficulty": "easy",            // peaceful | easy | normal | hard
    "gamerules": { "spawn_monsters": false, "advance_time": true, "advance_weather": false, "keep_inventory": false }
  },

  // blocks and structures, applied in order after the template
  "build": [
    { "set": "<3,0,0>", "block": "iron_ore" },
    { "fill": ["<-2,0,-2>", "<2,2,2>"], "block": "oak_planks", "mode": "hollow" },   // mode: replace|hollow|outline|keep|destroy
    { "feature": "minecraft:${wood}", "at": "<-6,0,6>", "soil": "grass_block" },      // trees etc. (place feature)
    { "template": "minecraft:village/plains/houses/plains_small_house_1", "at": "<5,0,5>", "rotation": "none" },
    { "container": "<2,0,2>", "block": "chest[facing=north]", "items": [ { "item": "iron_ingot", "count": 3, "slot": 0 } ] },
    { "sign": "<0,0,-3>", "block": "oak_sign", "text": ["home", "", "", ""] },
    { "rcon": "setblock <1,0,1> lever[powered=true]" }                                  // escape hatch, coords substituted
  ],

  // entities summoned after build
  "entities": [
    { "type": "zombie", "at": "<6,0,6>", "count": 1, "tag": "foe", "name": "Bob", "nbt": "{PersistenceRequired:1b}" },
    { "type": "cow", "at": "<-5,0,-5>", "count": 2 },
    { "item": "bread", "count": 3, "at": "<1,0,4>" },                                   // item on the ground
    { "type": "villager", "at": "<4,0,-4>", "nbt": "{VillagerData:{profession:\"minecraft:farmer\",level:2,type:\"minecraft:plains\"},Offers:{Recipes:[...]}}" }
  ],

  // the bot's body; anything omitted gets the default shown
  "player": {
    "at": "<0,0,0>", "yaw": 0, "pitch": 0,   // facing south
    "gamemode": "survival",
    "health": 20, "food": 20, "saturation": 5, "xp_levels": 0,
    "spawn": "<0,0,0>",                      // respawn point
    "effects": [ { "id": "speed", "seconds": 30, "amplifier": 0 } ],
    "inventory": [                           // slot: 0-8 hotbar, 9-35 main; omitted slot = first free
      { "item": "stone_pickaxe", "slot": 0, "damage": 40, "enchant": { "efficiency": 2 } },
      { "item": "${wood}_log", "count": "${logs}" }
    ],
    "armor": { "head": null, "chest": { "item": "leather_chestplate" }, "legs": null, "feet": null },
    "offhand": { "item": "shield" },
    "held": 0                                // selected hotbar slot
  },

  // the bot's memory before the episode (what it "knows")
  "mind": {
    "places": { "home": "<0,0,-3>", "mine": "<10,0,10>" },   // named places
    "notes": ["the chest at @home has iron"],                 // free notes
    "dsl": ["name_place spot at=<2,0,2>"]                     // extra DSL statements run before the episode
  },

  // what the bot is asked; arrives as player chat at the given tick
  "order": { "from": "Noan", "text": "fais-moi ${n} planches", "at_tick": 0 },

  // scripted events during the episode
  "timeline": [
    { "at_tick": 400, "chat": { "from": "Noan", "text": "laisse tomber, viens ici" } },
    { "at_tick": 600, "rcon": "time set night" },
    { "at_tick": 600, "summon": { "type": "zombie", "at": "<8,0,0>" } },
    { "when": { "have": "oak_planks", "min": 4 }, "once": true, "rcon": "weather rain" }
  ],

  // judge (server side). success ends the episode; fail ends it as failed; else timeout
  "success": { "all": [ { "have": "oak_planks", "min": "${n}" } ] },
  "fail":    { "any": [ { "died": true } ] },
  "milestones": [ { "name": "got_planks", "check": { "have": "oak_planks", "min": 1 } } ],   // partial credit, logged with tick

  "limits": { "ticks": 1200, "decisions": 20 },   // game ticks (20/s), mind-loop decisions

  // reference solution: DSL statements run in order by the `script` policy (each waited to its result)
  "solution": ["craft oak_planks n=${n}"],
  "solution_ticks": 100                           // expected ticks of the reference (for efficiency scores), optional
}
```

## Checks (judge language)
Each check is an object; combine with `{ "all": [...] }`, `{ "any": [...] }`, `{ "not": check }`.

| check | meaning | RCON |
|---|---|---|
| `{ "have": item\|"#tag", "min", "max" }` | count in the bot's inventory (main, hotbar, armor, offhand, cursor excluded) | `execute if items entity` |
| `{ "block": "<..>", "is": "id\|#tag" }` | block at position | `execute if block` |
| `{ "container": "<..>", "item", "min", "max" }` | items in a container block | `execute if items block` |
| `{ "entity": "type", "near": "<..>", "radius", "min", "max", "tag", "name" }` | count of entities | `execute if entity @e[...]` |
| `{ "at": "<..>", "radius" }` | bot within radius of a position | `data get entity Pos` |
| `{ "y": {"min","max"} }` | bot feet y (relative to the origin) | `data get entity Pos` |
| `{ "health": {"min","max"} }`, `{ "food": {...} }`, `{ "xp_levels": {...} }` | body stats | `data get entity` |
| `{ "died": true }` | the bot died during the episode | scoreboard `deathCount` |
| `{ "damage_taken": {"max"} }` | damage taken (half hearts x10, vanilla stat) | scoreboard `custom:damage_taken` |
| `{ "said": regex }` | the bot said something in chat matching regex | runner chat log |
| `{ "time": {"min","max"} }` | daytime | `time query daytime` |

All numeric fields accept `${...}` templates.

## Episode lifecycle (runner)
1. Expand: draw params for (card, seed), substitute templates, validate (unknown keys = error).
2. Reset: clear inventory/effects/xp, kill non-player entities in the region, wipe the region, apply world
   (template, dimension, time, weather, difficulty, gamerules), reset the death/damage scoreboards.
3. Build, entities, player (tp, gamemode, attributes via effects/`data`, items via `item replace`), spawnpoint.
4. Mind: fresh throwaway memory, then `mind.places` / `notes` / `dsl`.
5. Run the policy (`script` = solution; later `mind` = LLM loop) while the runner fires the order and the timeline
   and evaluates success / fail / milestones every 20 ticks (and after each policy step).
6. Log one `episode` record: card id, seed, params, policy, outcome (success|fail|timeout|error), ticks, real
   seconds, milestones reached (tick), deaths, damage, decisions, and the session log path.

## Diagnostics
- `card_step` records carry `desync`: for every item a `have` check counts, the bot's inventory model vs the
  server's count after each statement (a bot that believes it has items it does not have is a bot bug).
- `node sim/cards.js [file]`: validates every card for all its seeds (schema, templates, positions, every
  solution / mind DSL statement parsed); with one file prints the compiled plan.

## Not supported yet (format reserved, add when a card needs it)
- `actors`: other players (owner NPC bots driven by a script: follow me, give me, trade, attack).
- `world.template: "seed"`: a region of a real generated world (biomes, caves, villages) copied into the sim.
- `mind.chests` / `mind.map`: prior knowledge of container contents / explored terrain.
- Snapshot + restore mid-episode (branching for counterfactuals).
- Exact saturation below food 20 (no command; the drain leaves it at 0).
