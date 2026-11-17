"""Agent swarm stress test against the local llama-server (OpenAI-compatible API).

Pipeline per run:
  1. planner     : 1 agent splits a big goal into N subtasks (JSON schema enforced)
  2. workers     : N agents in parallel, each does 2 turns (draft -> self-refine)
  3. reviewers   : N agents in parallel, each scores one worker output (JSON schema enforced)
  4. synthesizer : 1 agent merges the best-rated outputs into a final answer

Usage:
  python swarm.py                     # sweep 8 16 32 64 agents
  python swarm.py 16 48 --think       # custom sizes, keep reasoning on
  python swarm.py 32 --goal "Design a city-wide bike sharing system" --show
  python swarm.py 48 --loop          # continuous load, watch http://127.0.0.1:8080/dash
"""
import argparse
import json
import statistics
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

URL = "http://127.0.0.1:8080/v1/chat/completions"
DEFAULT_GOAL = "Write a complete technical design for a self-hosted, privacy-first personal finance app."

PLAN_SCHEMA = {
    "type": "object",
    "properties": {"subtasks": {"type": "array", "items": {"type": "string"}}},
    "required": ["subtasks"],
}
REVIEW_SCHEMA = {
    "type": "object",
    "properties": {
        "score": {"type": "integer", "minimum": 1, "maximum": 10},
        "issue": {"type": "string"},
    },
    "required": ["score", "issue"],
}


class Stats:
    def __init__(self):
        self.lock = threading.Lock()
        self.calls, self.errors, self.gen_tok, self.prompt_tok = 0, 0, 0, 0
        self.latencies, self.tps = [], []
        self.inflight = self.peak_inflight = 0

    def enter(self):
        with self.lock:
            self.inflight += 1
            self.peak_inflight = max(self.peak_inflight, self.inflight)

    def leave(self, ok, lat=0.0, data=None):
        with self.lock:
            self.inflight -= 1
            self.calls += 1
            if not ok:
                self.errors += 1
                return
            t = data["timings"]
            self.gen_tok += t["predicted_n"]
            self.prompt_tok += t["prompt_n"]
            self.latencies.append(lat)
            self.tps.append(t["predicted_per_second"])


def chat(stats, messages, max_tokens, think, schema=None, retries=1, agent="agent", role="client"):
    body = {
        "model": "lfm3-1.7b",
        "messages": messages,
        "max_tokens": max_tokens,
        "chat_template_kwargs": {"enable_thinking": think},
    }
    if not think:
        body["reasoning_format"] = "none"
    if schema:
        body["response_format"] = {"type": "json_schema", "json_schema": {"name": "out", "schema": schema}}
    headers = {"Content-Type": "application/json", "X-Agent": agent, "X-Role": role}
    req = urllib.request.Request(URL, json.dumps(body).encode(), headers)
    for attempt in range(retries + 1):
        stats.enter()
        t0 = time.perf_counter()
        try:
            with urllib.request.urlopen(req, timeout=600) as r:
                data = json.load(r)
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            stats.leave(False)
            if attempt == retries:
                return None
            continue
        stats.leave(True, time.perf_counter() - t0, data)
        return data["choices"][0]["message"].get("content") or ""


def parse_json(text):
    try:
        return json.loads(text)
    except (TypeError, json.JSONDecodeError):
        return None


def run_swarm(n, goal, think, show):
    st = Stats()
    t_start = time.perf_counter()
    phases = {}

    # 1. planner
    t = time.perf_counter()
    plan = parse_json(chat(st, [
        {"role": "system", "content": "You are a planner. Split goals into independent, specific subtasks."},
        {"role": "user", "content": f"Goal: {goal}\nReturn exactly {n} distinct subtasks as JSON."},
    ], 1500, think, PLAN_SCHEMA, agent="planner", role="planner"))
    subtasks = (plan or {}).get("subtasks") or []
    subtasks = [s for s in subtasks if isinstance(s, str) and s.strip()]
    plan_ok = len(subtasks)
    while len(subtasks) < n:  # pad if the planner under-delivered
        subtasks.append(f"Cover an aspect of the goal not yet addressed (part {len(subtasks) + 1}).")
    subtasks = subtasks[:n]
    phases["planner"] = time.perf_counter() - t

    # 2. workers: draft then refine (2 sequential turns per agent, all agents in parallel)
    def worker(i):
        msgs = [
            {"role": "system", "content": f"You are worker agent #{i} in a swarm. Overall goal: {goal}"},
            {"role": "user", "content": f"Your subtask: {subtasks[i]}\nWrite a focused draft (max ~200 words)."},
        ]
        draft = chat(st, msgs, 350, think, agent=f"worker-{i:02d} draft", role="worker")
        if draft is None:
            return None
        msgs += [
            {"role": "assistant", "content": draft},
            {"role": "user", "content": "Critique your draft in one line, then output an improved final version."},
        ]
        return chat(st, msgs, 400, think, agent=f"worker-{i:02d} refine", role="worker")

    t = time.perf_counter()
    with ThreadPoolExecutor(n) as ex:
        outputs = list(ex.map(worker, range(n)))
    phases["workers"] = time.perf_counter() - t

    # 3. reviewers
    def reviewer(i):
        if not outputs[i]:
            return None
        return parse_json(chat(st, [
            {"role": "system", "content": "You are a strict reviewer. Score 1-10 and name the main issue."},
            {"role": "user", "content": f"Subtask: {subtasks[i]}\n\nAnswer:\n{outputs[i][:3000]}"},
        ], 300, think, REVIEW_SCHEMA, agent=f"reviewer-{i:02d}", role="reviewer"))

    t = time.perf_counter()
    with ThreadPoolExecutor(n) as ex:
        reviews = list(ex.map(reviewer, range(n)))
    phases["reviewers"] = time.perf_counter() - t

    # 4. synthesizer: merge the top-rated outputs that fit in context
    scored = sorted(
        ((r.get("score", 0) if r else 0, i) for i, r in enumerate(reviews) if outputs[i]),
        reverse=True,
    )
    top = [i for _, i in scored[:6]]
    t = time.perf_counter()
    final = chat(st, [
        {"role": "system", "content": "You merge contributions from a swarm of agents into one coherent document."},
        {"role": "user", "content": f"Goal: {goal}\n\n" + "\n\n".join(
            f"## Contribution {i}: {subtasks[i]}\n{outputs[i][:1200]}" for i in top)},
    ], 1200, think, agent="synthesizer", role="synthesizer")
    phases["synthesizer"] = time.perf_counter() - t

    wall = time.perf_counter() - t_start
    valid_reviews = [r for r in reviews if isinstance(r, dict) and isinstance(r.get("score"), int)]
    lat = sorted(st.latencies) or [0]
    print(f"\n=== swarm n={n} | think={think} ===")
    print(f"wall {wall:6.1f}s | calls {st.calls} | errors {st.errors} | peak in-flight {st.peak_inflight}")
    print(f"tokens: gen {st.gen_tok} | prompt {st.prompt_tok} | aggregate gen {st.gen_tok / wall:6.1f} tok/s")
    print(f"per-call tps: median {statistics.median(st.tps or [0]):5.1f} | min {min(st.tps or [0]):5.1f}")
    print(f"latency: p50 {lat[len(lat) // 2]:5.1f}s | p95 {lat[int(len(lat) * 0.95) - 1]:5.1f}s | max {lat[-1]:5.1f}s")
    print("phases: " + " | ".join(f"{k} {v:5.1f}s" for k, v in phases.items()))
    print(f"quality: planner {plan_ok}/{n} subtasks | workers ok {sum(bool(o) for o in outputs)}/{n}"
          f" | valid reviews {len(valid_reviews)}/{n}"
          f" | avg score {statistics.mean([r['score'] for r in valid_reviews] or [0]):.1f}")
    if show:
        print("\n--- final ---\n" + (final or "(none)"))
    return {"n": n, "wall": wall, "agg_tps": st.gen_tok / wall, "errors": st.errors}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("sizes", nargs="*", type=int, default=[8, 16, 32, 64])
    ap.add_argument("--goal", default=DEFAULT_GOAL)
    ap.add_argument("--think", action="store_true", help="keep <think> reasoning on (slower)")
    ap.add_argument("--show", action="store_true", help="print the final synthesized document")
    ap.add_argument("--loop", action="store_true", help="repeat the sizes forever (live demo load)")
    a = ap.parse_args()
    results = [run_swarm(n, a.goal, a.think, a.show) for n in a.sizes]
    while a.loop:
        results = [run_swarm(n, a.goal, a.think, a.show) for n in a.sizes]
    print("\n=== summary ===")
    for r in results:
        print(f"n={r['n']:>3} | wall {r['wall']:6.1f}s | aggregate {r['agg_tps']:6.1f} tok/s | errors {r['errors']}")
