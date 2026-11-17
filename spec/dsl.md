# MineGPT DSL v2.0 — grammar, values, AST

Single source of truth with `catalog.json` (verbs, tools, argument types) and `names.json` (valid ids, generated
by `tools/gen_names.py` from minecraft-data 1.21.11 + vanilla server jar tags). Reference implementation:
`bot/dsl/` (JS). Python uses it through `node bot/dsl/check.js` (JSONL in/out). Golden tests: `golden/*.jsonl`.

## 1. Lexical
| Token | Pattern | Examples |
|---|---|---|
| NAME | `[a-z_][a-z0-9_]*(:[a-z0-9_/]+)?` | `iron_ore`, `tag:logs`, `biome:plains` |
| PLACE | `@[a-z0-9_]+` | `@home`, `@iron_vein_1` |
| ENTITY | `#[a-z_][a-z0-9_]*(\.[A-Za-z0-9_]+)?` | `#zombie` (nearest), `#zombie.417` (entity id), `#player.Noan` |
| INT / FLOAT | `-?\d+` / `-?\d+\.\d+` | `3`, `-40`, `2.5` |
| DUR | `\d+(s\|m\|h)` | `30s`, `2m` |
| REL | `~` or `~-?\d+` (only inside a position) | `~`, `~2`, `~-1` |
| STRING | `"..."` with `\"` `\\` escapes | `"j'arrive"` |
| punct | `( ) [ ] , ; = & \| ! < <= > >= == != + ~` | |

Whitespace separates tokens and is otherwise ignored. Names are lowercase game ids without `minecraft:`.
`tag:X` = any member of the vanilla item/block tag X (`tag:logs`, `tag:planks`, `tag:coal_ores`).

## 2. Statements
```
stmt     := call [until]
          | "seq[" stmt (";" stmt)* "]" [until]
          | "if(" cond ")" stmt ["else" stmt]
          | "repeat(" INT ")" stmt
          | "routine" NAME                       # run a routine saved with save_routine
call     := VERB arg*                            # positional args first, then key=value
arg      := value | NAME "=" value
until    := "until(" cond ")"                    # stop the statement (ok) when cond becomes true
value    := NAME | INT | FLOAT | DUR | STRING | PLACE | ENTITY | pos | box | list
pos      := "(" coord "," coord "," coord ")"    # coord = INT or REL (relative to the bot's feet block)
box      := "(" pos "," pos ")"                  # inclusive cuboid
list     := "[" value ("," value)* "]"
```
- A verb whose last positional type is `stmt` (`save_routine`, `simulate`) takes the rest of the statement as that
  argument: `save_routine wood seq[chop n=4; craft oak_planks n=16]`.
- Global keywords valid on every verb: `timeout=DUR`, `max=INT` (max repetitions / items, verb-specific meaning).
- `else` binds to the nearest `if`. Inside `seq[...]`, `;` ends the current statement.

## 3. Conditions (until, if, expect)
```
cond   := and ("|" and)*
and    := unary ("&" unary)*
unary  := "!" unary | "(" cond ")" | FLAG | metric CMP number
metric := hp | food | sat | xp | armor | air | y | light | time | free_slots
        | hostile                 # distance to the nearest hostile mob (999 if none)
        | have "(" item ")"       # count in inventory (tag:X sums the members)
        | dist "(" target ")"     # distance in blocks
CMP    := < | <= | > | >= | == | !=
number := ["+" | "~"] (INT | FLOAT)   # "+N" / "~N" = relative to the value when the statement starts
FLAG   := night | day | rain | thunder | inv_full | idle | in_water | in_lava | on_fire | sky
```
`sky` = the bot sees the sky (not underground). `have(oak_log)>=+4` = gained at least 4. `hp>=~-4` = lost at
most 4 hp. Absolute negatives are plain: `y<-30`.

## 4. Expectation (turn tag `expect:`)
```
expect := cond ("," cond)* "in" DUR
```
`expect: have(tag:logs)>=+4, hp>=~-2 in 40s`. Deltas are relative to the moment the action starts. The harness
checks it when the action ends or the duration passes and emits a `surprise` event per unmet condition.

## 5. Normalized AST (JSON, what the parser returns and the logs store)
Statements:
```
{"op":"call","verb":"mine","args":{"block":{"name":"iron_ore"},"n":3},"until":COND?}
{"op":"seq","body":[STMT,...],"until":COND?}
{"op":"if","cond":COND,"then":STMT,"else":STMT?}
{"op":"repeat","n":3,"body":STMT}
{"op":"routine","name":"wood"}
```
`args` is keyed by the catalogue parameter names (positional and keyword merged). Values:
| Source | JSON |
|---|---|
| NAME | `{"name":"iron_ore"}` (`{"tag":"logs"}` for `tag:logs`) |
| PLACE | `{"place":"home"}` |
| ENTITY | `{"entity":"zombie"}` / `{"entity":"zombie","ref":"417"}` |
| INT / FLOAT | number |
| DUR | `{"dur":30}` (seconds) |
| STRING | `{"text":"..."}` |
| pos | `{"pos":[-40,12,88]}`, relative coords as strings: `{"pos":["~","~-1","~2"]}` |
| box | `{"box":[POS,POS]}` |
| list | `{"list":[VALUE,...]}` |
Conditions: `{"or":[..]}`, `{"and":[..]}`, `{"not":C}`, `{"flag":"night"}`,
`{"metric":"have","arg":VALUE,"cmp":">=","value":4,"rel":true}` (`arg` only for have/dist, `rel` true for `+`/`~`).
Expectation: `{"conds":[C,...],"within":40}`.

## 6. Errors
The parser returns `{"ok":false,"error":"<message>","at":<column>}`. Messages are written for the model (they come
back as `invalid_output` events): they name the bad token and, for unknown ids, the closest valid ids
(`unknown item 'oak_plank' (did you mean oak_planks, oak_plate?)`).
