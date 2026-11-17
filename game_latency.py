"""Measure per-decision latency for a game-playing agent loop (single agent).

Simulates N game ticks: a fixed system prompt + a changing game-state observation,
the model answers with a short JSON action (schema-enforced, thinking off).

Usage: python game_latency.py [--ticks 30] [--url http://127.0.0.1:8080]
"""
import argparse
import json
import random
import statistics
import time
import urllib.request

SYSTEM = (
    "You control a player in a Minecraft-like voxel game. Each turn you get the game state and must "
    "answer with ONE action as JSON. Actions: move(dir), jump, mine(block), place(block), attack(target), "
    "eat(item), craft(item), look(yaw,pitch), wait. Goal: survive, gather wood then stone, craft tools, "
    "avoid hostile mobs at night. Be decisive. Keep 'why' under 12 words."
)
ACTION_SCHEMA = {
    "type": "object",
    "properties": {
        "action": {"type": "string", "enum": ["move", "jump", "mine", "place", "attack", "eat", "craft", "look", "wait"]},
        "arg": {"type": "string"},
        "why": {"type": "string"},
    },
    "required": ["action", "arg", "why"],
}
BLOCKS = ["oak_log", "stone", "dirt", "grass", "coal_ore", "iron_ore", "sand", "water"]
MOBS = ["zombie", "skeleton", "creeper", "spider", "cow", "pig"]


def observation(tick):
    r = random.Random(tick)
    near = ", ".join(f"{r.choice(BLOCKS)} at ({r.randint(-5, 5)},{r.randint(-2, 2)},{r.randint(-5, 5)})" for _ in range(6))
    mobs = ", ".join(f"{r.choice(MOBS)} {r.randint(2, 20)}m {r.choice(['N', 'S', 'E', 'W'])}" for _ in range(r.randint(0, 3)))
    inv = ", ".join(f"{k} x{r.randint(0, 16)}" for k in ["oak_log", "planks", "stick", "cobblestone", "bread"])
    return (f"Tick {tick}. Time: {'night' if tick % 10 > 6 else 'day'}. Health {r.randint(6, 20)}/20, "
            f"hunger {r.randint(4, 20)}/20. Position ({r.randint(-100, 100)},64,{r.randint(-100, 100)}). "
            f"Nearby blocks: {near}. Mobs: {mobs or 'none'}. Inventory: {inv}. Holding: wooden_pickaxe.")


GRAMMAR = 'root ::= ("move" | "jump" | "mine" | "place" | "attack" | "eat" | "craft" | "look" | "wait") " " [a-z0-9_,-]{1,24}'


def decide(url, tick, history, keep=6, why=True, compact=False):
    hist = history[-keep:] if keep else []
    msgs = [{"role": "system", "content": SYSTEM}] + hist + [{"role": "user", "content": observation(tick)}]
    schema = ACTION_SCHEMA if why else {**ACTION_SCHEMA, "properties": {k: v for k, v in ACTION_SCHEMA["properties"].items() if k != "why"}, "required": ["action", "arg"]}
    body = {
        "messages": msgs, "max_tokens": 60, "temperature": 0, "top_k": 1, "repeat_penalty": 1.0,
        "chat_template_kwargs": {"enable_thinking": False}, "reasoning_format": "none",
        "response_format": {"type": "json_schema", "json_schema": {"name": "action", "schema": schema}},
        "cache_prompt": True,
    }
    if compact:  # plain "action arg" line, constrained by grammar: fewest output tokens
        del body["response_format"]
        body["grammar"] = GRAMMAR
        msgs[0] = {"role": "system", "content": SYSTEM + " Answer format: <action> <arg>, e.g. 'mine oak_log' or 'move north'."}
    req = urllib.request.Request(url + "/v1/chat/completions", json.dumps(body).encode(),
                                 {"Content-Type": "application/json"})
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.load(r)
    lat = time.perf_counter() - t0
    content = data["choices"][0]["message"]["content"].replace("<think></think>", "").strip()
    history += [msgs[-1], {"role": "assistant", "content": content}]
    return lat, data["timings"], content


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ticks", type=int, default=30)
    ap.add_argument("--url", default="http://127.0.0.1:8080")
    ap.add_argument("--show", action="store_true")
    ap.add_argument("--history", type=int, default=6, help="past messages kept (0 = stateless, best cache)")
    ap.add_argument("--no-why", action="store_true", help="drop the explanation field (fewer output tokens)")
    ap.add_argument("--compact", action="store_true", help="grammar-forced 'action arg' text instead of JSON (fastest)")
    a = ap.parse_args()
    history = []
    decide(a.url, 0, history, a.history, not a.no_why, a.compact)  # warmup
    history.clear()
    lats, tps, ptoks, gtoks, valid = [], [], [], [], 0
    for t in range(1, a.ticks + 1):
        lat, tm, content = decide(a.url, t, history, a.history, not a.no_why, a.compact)
        lats.append(lat * 1000)
        tps.append(tm["predicted_per_second"])
        ptoks.append(tm["prompt_n"])
        gtoks.append(tm["predicted_n"])
        try:
            act = content.split()[0] if a.compact else json.loads(content)["action"]
            valid += act in ACTION_SCHEMA["properties"]["action"]["enum"]
        except (ValueError, KeyError, TypeError, IndexError):
            pass
        if a.show:
            print(f"{lat * 1000:6.0f} ms | {content}")
    lats.sort()
    print(f"decision latency: median {statistics.median(lats):5.0f} ms | p95 {lats[int(len(lats) * .95) - 1]:5.0f} ms"
          f" | => {1000 / statistics.median(lats):4.1f} decisions/s")
    print(f"gen tps median {statistics.median(tps):5.1f} | new prompt tokens/tick {statistics.median(ptoks):.0f}"
          f" | output tokens/tick {statistics.median(gtoks):.0f} | valid actions {valid}/{a.ticks}")


if __name__ == "__main__":
    main()
