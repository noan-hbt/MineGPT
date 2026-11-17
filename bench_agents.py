"""Fire N concurrent chat requests at the local llama-server and report throughput.

Usage: python bench_agents.py [n_agents ...]   e.g. python bench_agents.py 1 4 8 16
"""
import json
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

URL = "http://127.0.0.1:8080/v1/chat/completions"
TASKS = [
    "Write a Python function that parses an ISO 8601 date and returns the weekday. Explain briefly.",
    "List 5 risks of deploying an LLM agent with shell access, with one mitigation each.",
    "Summarize how TCP congestion control works in about 150 words.",
    "Plan the steps an agent should take to rename a function across a large codebase.",
    "Generate a JSON object describing a fictional user with name, age, skills (array) and address.",
    "Explain the difference between processes and threads to a junior developer.",
    "Write a SQL query that returns the top 3 customers by total order value per country.",
    "Give a step-by-step plan to debug a memory leak in a Node.js service.",
]


def run_agent(i: int) -> dict:
    body = {
        "model": "lfm3-1.7b",
        "messages": [
            {"role": "system", "content": f"You are agent #{i}, a concise expert assistant."},
            {"role": "user", "content": TASKS[i % len(TASKS)]},
        ],
        "max_tokens": 400,
        **json.loads(os.environ.get("EXTRA", "{}")),
    }
    req = urllib.request.Request(URL, json.dumps(body).encode(), {"Content-Type": "application/json"})
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=300) as r:
        data = json.load(r)
    tm = data["timings"]
    return {
        "wall": time.perf_counter() - t0,
        "gen": tm["predicted_n"],
        "tps": tm["predicted_per_second"],
        "ok": bool(data["choices"][0]["message"].get("content")
                   or data["choices"][0]["message"].get("reasoning_content")),
    }


def bench(n: int) -> None:
    t0 = time.perf_counter()
    with ThreadPoolExecutor(n) as ex:
        res = list(ex.map(run_agent, range(n)))
    wall = time.perf_counter() - t0
    total = sum(r["gen"] for r in res)
    per = sum(r["tps"] for r in res) / n
    ok = sum(r["ok"] for r in res)
    print(f"{n:>3} agents | {total:>6} tok in {wall:5.1f}s | aggregate {total / wall:7.1f} tok/s"
          f" | per-agent {per:6.1f} tok/s | ok {ok}/{n}")


if __name__ == "__main__":
    run_agent(0)  # warmup
    for n in map(int, sys.argv[1:] or ["1", "2", "4", "8", "16"]):
        bench(n)
