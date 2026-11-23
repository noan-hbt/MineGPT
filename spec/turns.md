# MineGPT turn formats v2.0

Every model output is a block of lines `tag: content` (blank lines ignored, one tag per line, content on the same
line). Statements, conditions and tool calls inside tags follow `dsl.md`. Reference parser: `bot/dsl/turn.js`.
Golden cases: `golden/turns.jsonl`.

## Tags
| Tag | Content | decision | monitor | mind |
|---|---|---|---|---|
| `think:` | free text, repeatable (joined) | yes | yes | yes |
| `tool:` | tool call (`catalog.json` tools), 1-4 per round | yes | | |
| `plan:` | free-text steps separated by ` \| ` (replaces the plan) | yes | | yes |
| `act:` | statement | required in a final turn | | |
| `interrupt:` | statement, cancels the running action | | yes | |
| `override:` | statement, replaces the hands' action | | | yes |
| `expect:` | `cond, cond in DUR`, right after act/interrupt/override | yes | yes | yes |
| `adjust:` | `key=value ... [until(cond)]` on the running verb | | yes | |
| `continue` | bare word, no change | | yes | yes |
| `note:` | long-term memory line, repeatable | yes | | yes |
| `say:` | public chat text | yes | | yes |
| `goal:` | `push <text>` \| `replace <text>` \| `done` \| `fail <reason>` | yes | | yes |
| `ask:` | `mind <question>` / `strategist <question>` (mind: strategist only) | yes | | yes |
| `answer:` | answer to the hands' `ask: mind` | | | yes |

## Rules
- **decision**: a *tool round* (only `think:` and 1-4 `tool:` lines; the harness appends one `result: ...` line
  per tool and the model continues; after 4 rounds `act:` is forced) or a *final turn* with exactly one `act:`.
- `expect:` is required after `act:` / `interrupt:` / `override:` unless the verb has no game outcome:
  wait, note, forget, name_place, save_routine, stop, say, whisper, obey, refuse.
- **monitor**: exactly one of `continue`, `adjust:`, `interrupt:`; `think:` optional before it.
- **mind**: at least one of plan/note/say/goal/answer/override/ask, or `continue` alone.
- Each non-repeatable tag at most once. Any other line is invalid.
- Invalid output: the harness retries once with an `invalid_output` event carrying the parser message
  (messages are written for the model: they name the problem and the closest valid ids), then `wait 2s`.

## Example (decision, final turn)
```
think: no tools, 2 oak trees 6 m east, day for 8 more minutes
plan: wood | crafting table | wooden pickaxe | stone tools | find iron
act: chop n=2
expect: have(tag:logs)>=+8 in 60s
note: oak forest 20 m east of spawn
```
