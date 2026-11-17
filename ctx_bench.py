"""Latency vs context size for an append-only multi-turn game prompt (spatial + temporal memory idea).
For each target size: cold request (whole prompt processed), then warm (+1 turn appended, prefix from cache),
then decode speed (64 forced tokens). Optional thinking run.
  python ctx_bench.py [--sizes 4000,8000,16000,32000] [--think] [--url http://127.0.0.1:8080]
Needs llama-server with ctx >= biggest size (start-game.ps1 -Slots 1 -Ctx 40960).
"""
import argparse, json, random, time, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument('--url', default='http://127.0.0.1:8080')
ap.add_argument('--sizes', default='4000,8000,16000,32000')
ap.add_argument('--think', action='store_true')
a = ap.parse_args()

SYSTEM = ("You control a Minecraft survival bot. Each turn you get what happened since the last turn and the state, "
          "and answer with ONE action: verb arg. Remember where things are and what you did.")
BLOCKS = ['oak_log', 'stone', 'coal_ore', 'iron_ore', 'dirt', 'sand', 'gravel', 'water', 'grass_block', 'copper_ore']
MOBS = ['zombie', 'skeleton', 'cow', 'sheep', 'pig', 'creeper', 'spider']
ACTIONS = ['collect oak_log', 'craft oak_planks', 'craft stick', 'mine iron_ore', 'explore north', 'collect stone',
           'place crafting_table', 'smelt raw_iron', 'attack zombie', 'eat bread']


def turn_text(i, rnd):
    """~450-550 tokens of plausible per-turn observation: events, position, surroundings, inventory."""
    x, y, z = rnd.randint(-300, 300), rnd.randint(-20, 90), rnd.randint(-300, 300)
    lines = [f'Turn {i}. Time {6000 + i * 37} ({"day" if i % 40 < 28 else "night"}). Position {x} {y} {z}, facing '
             f'{rnd.choice(["north", "south", "east", "west"])}. Health {rnd.randint(8, 20)}/20, food {rnd.randint(6, 20)}/20.']
    lines.append('Events: ' + '; '.join(f'{rnd.choice(MOBS)} seen {rnd.randint(2, 30)}m {rnd.choice(["N", "S", "E", "W"])}'
                                        for _ in range(3)) + f'; last action result: ok +{rnd.randint(1, 4)} {rnd.choice(BLOCKS)}.')
    lines.append('Nearby blocks: ' + ', '.join(f'{b} {rnd.randint(1, 30)}m at {x + rnd.randint(-20, 20)} {y + rnd.randint(-8, 8)} '
                                               f'{z + rnd.randint(-20, 20)}' for b in rnd.sample(BLOCKS, 8)) + '.')
    lines.append('Map memory: ' + '; '.join(f'{rnd.choice(["crafting_table", "furnace", "chest", "iron vein", "cave", "village", "home"])} '
                                            f'at {rnd.randint(-500, 500)} {rnd.randint(-30, 90)} {rnd.randint(-500, 500)}' for _ in range(6)) + '.')
    lines.append('Inventory: ' + ', '.join(f'{rnd.randint(1, 64)} {b}' for b in rnd.sample(BLOCKS, 6)) + '.')
    lines.append('Goal: iron_pickaxe. Plan progress: ' + ' > '.join(rnd.sample(ACTIONS, 5)) + '.')
    return '\n'.join(lines)


def post(messages, max_tokens, think=False, ignore_eos=False):
    body = {'messages': messages, 'max_tokens': max_tokens, 'temperature': 0, 'top_k': 1, 'cache_prompt': True,
            'chat_template_kwargs': {'enable_thinking': think}, 'id_slot': 0}
    if ignore_eos: body['ignore_eos'] = True
    req = urllib.request.Request(a.url + '/v1/chat/completions', json.dumps(body).encode(), {'Content-Type': 'application/json'})
    t = time.perf_counter()
    r = json.load(urllib.request.urlopen(req, timeout=600))
    wall = (time.perf_counter() - t) * 1000
    return r, wall


def build(target, seed):
    """append-only chat: system, then (user obs, assistant action) pairs until ~target tokens."""
    rnd = random.Random(seed)
    msgs = [{'role': 'system', 'content': SYSTEM}]
    i = 0
    while True:
        i += 1
        msgs.append({'role': 'user', 'content': turn_text(i, rnd)})
        if len(' '.join(m['content'] for m in msgs)) / 2.5 > target: break  # rough chars/token, checked below
        msgs.append({'role': 'assistant', 'content': rnd.choice(ACTIONS)})
    return msgs, rnd, i


def row(label, r, wall):
    t = r.get('timings', {})
    print(f"  {label:<10} prompt {t.get('prompt_n', 0):>6} tok processed (cache {t.get('cache_n', 0):>6}) "
          f"{t.get('prompt_ms', 0):>7.0f} ms ({t.get('prompt_per_second', 0):>6.0f} tok/s) | "
          f"gen {t.get('predicted_n', 0):>3} tok {t.get('predicted_per_second', 0):>5.0f} tok/s | wall {wall:>6.0f} ms")


for size in [int(s) for s in a.sizes.split(',')]:
    msgs, rnd, n = build(size, seed=size)
    print(f'[{size} target] {n} turns')
    r, w = post(msgs, 8)  # cold: different seed per size -> no shared prefix
    row('cold', r, w)
    msgs += [{'role': 'assistant', 'content': r['choices'][0]['message']['content'] or 'wait 1'},
             {'role': 'user', 'content': turn_text(n + 1, rnd)}]
    r, w = post(msgs, 8)
    row('warm +1', r, w)
    msgs += [{'role': 'assistant', 'content': r['choices'][0]['message']['content'] or 'wait 1'},
             {'role': 'user', 'content': turn_text(n + 2, rnd)}]
    r, w = post(msgs, 64, ignore_eos=True)
    row('decode64', r, w)

if a.think:
    msgs, rnd, n = build(8000, seed=1)
    msgs[-1]['content'] += '\nThink briefly about where you are and what you did, then answer with one action.'
    post(msgs, 1)  # warm the cache
    r, w = post(msgs, 1024, think=True)
    row('think 8k', r, w)
    m = r['choices'][0]['message']
    reasoning = m.get('reasoning_content') or ''
    print(f"  reasoning {len(reasoning)} chars, answer: {(m.get('content') or '').strip()[:120]!r}")
    print('  reasoning head: ' + reasoning[:400].replace('\n', ' '))
