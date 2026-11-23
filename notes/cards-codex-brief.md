# Brief: write new scenario cards (Codex batches)

You write **new scenario cards** for MineGPT's MineSim (a Minecraft 1.21.11 bot test bench). Repo root: this folder.

## Read first
- `notes/scenario-cards.md`: the card format, judge checks, pitfalls. **The source of truth.**
- `bot/sim/cards.js`: loader / validator / compiler (what keys exist, how build/entities/player compile).
- `spec/dsl.md` + `spec/catalog.json`: the DSL the `solution` is written in (verbs, args, types).
- `bot/skills/*.js`, `bot/dsl/run.js`: how verbs really behave. Only use verbs and args that are implemented
  there (`brew`, `stonecut`, grindstone `repair` are NOT implemented). If unsure whether a verb works, read its
  skill code.
- The 21 existing cards in `bot/sim/cards/<area>/*.json`, as style examples. Do not duplicate them.

## Your job
Write the cards listed in YOUR BATCH below (given in the prompt), one file each at
`bot/sim/cards/<area>/<name>.json`, id `<area>.<name>`. Create ONLY those files. Do not edit any other file
(other agents are writing other cards in parallel; no edits to cards.js, the runner, skills or docs). If a card
needs a feature the format or the bot doesn't have, skip it and say so in your final report instead of hacking.

Each card must:
- be **complete** (everything the outcome depends on is set by the card) and **server-judged**;
- use `params` so seeds vary the setup (positions, counts, item/wood choices), with 3-5 default `seeds`;
- have a `solution` (DSL) that the reference `script` policy can plausibly pass on every seed, and
  `limits.ticks` with margin (~2-3x what the solution needs);
- have a French `order` (the owner Noan speaks French, informal: "ramène-moi 3 lingots", "viens ici") unless the
  card is about reacting without an order (survival);
- have useful `milestones` (partial credit) and a `fail` (at least `died`);
- respect the pitfalls (never start the bot in a deadly spot; make danger happen with a `timeline` event at tick 0;
  safe `player.spawn` when relevant);
- `split`: about 1 card in 5 is `"heldout"` (pick the more novel combinations), the rest `"train"`;
- `difficulty` 1-5 honest.

## Validate (mandatory)
`node bot/sim/cards.js` validates every card for all its seeds offline (schema, templates, positions, DSL parse).
Run it; every card of yours must print `ok`. Fix until it does.
**Do NOT run `sim/run_cards.js`, `sim/instance.js`, or anything that starts or talks to a Minecraft server**: the
sim server is busy with another run. The cards will be run on the server afterwards by someone else.
Never touch `remote/`.

## Final report (your last message)
One line per card: `id | difficulty | split | what it tests | risk` where risk names what might fail when run for
real (verb behaviour you were unsure of, mob AI randomness, timing). Then the cards you skipped and why.
