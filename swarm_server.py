"""Multi-instance llama-server launcher + load balancer + live dashboard.

Starts K llama-server instances on one GPU (ports 8081..), each pinned to its own
P-core group, and a proxy on :8080 that spreads requests to the least-busy instance.

  Dashboard : http://127.0.0.1:8080/dash
  API       : http://127.0.0.1:8080/v1/chat/completions  (OpenAI-compatible)

Usage:
  python swarm_server.py                       # 3 instances x 16 slots x 4096 ctx
  python swarm_server.py -k 2 --slots 32
  python swarm_server.py --attach 8080         # no launch: proxy an already running server
"""
import argparse
import json
import os
import subprocess
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
EXE = ROOT / "llama.cpp" / "llama-server.exe"
MODEL = ROOT / "models" / "LFM3-1.7B-QAD-Q4_0.gguf"
DASH = ROOT / "dashboard.html"
P_LOGICAL = 16  # i9-13900HX: logical CPUs 0-15 are the 8 hyperthreaded P-cores


class Backend:
    def __init__(self, port):
        self.port = port
        self.url = f"http://127.0.0.1:{port}"
        self.inflight = 0
        self.slots = []
        self.tps = 0.0
        self.pp_tps = 0.0
        self._last = None  # (time, tokens_predicted_total, prompt_tokens_total)
        self.up = False


class State:
    def __init__(self, backends):
        self.backends = backends
        self.lock = threading.Lock()
        self.agents = {}  # req_id -> dict
        self.recent = deque(maxlen=40)
        self.history = deque(maxlen=240)  # (t, total_tps, [per-backend tps])
        self.done = self.errors = self.gen_tokens = 0
        self.peak_tps = 0.0
        self.gpu = {}
        self.next_id = 0
        self.t0 = time.time()

    def pick(self):
        with self.lock:
            live = [b for b in self.backends if b.up] or self.backends
            b = min(live, key=lambda x: x.inflight)
            b.inflight += 1
            return b


def launch(k, slots, ctx, base_port):
    procs, backends = [], []
    group = max(2, P_LOGICAL // k)
    for i in range(k):
        port = base_port + i
        mask = ((1 << group) - 1) << ((i * group) % P_LOGICAL)
        cmd = [
            str(EXE), "-m", str(MODEL), "--alias", "lfm3-1.7b",
            "--host", "127.0.0.1", "--port", str(port),
            "-ngl", "99", "-fa", "on",
            "-c", str(slots * ctx), "-np", str(slots), "--no-kv-unified",
            "-b", "2048", "-ub", "1024", "--cache-reuse", "256",
            "--jinja", "--reasoning", "auto", "--reasoning-format", "deepseek",
            "--temp", "0.1", "--top-k", "50", "--repeat-penalty", "1.1",
            "--samplers", "penalties;top_k;temperature", "--backend-sampling",
            "-t", str(min(group, 8)), "-C", hex(mask), "--cpu-strict", "1", "--prio", "2",
            "--threads-http", str(min(group, 8)), "--metrics",
        ]
        log = open(ROOT / f"server-{port}.log", "w")
        procs.append(subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT,
                                      creationflags=subprocess.CREATE_NO_WINDOW))
        backends.append(Backend(port))
        print(f"instance {i}: port {port}, cpu mask {hex(mask)}, {slots} slots x {ctx} ctx")
    deadline = time.time() + 120
    for b in backends:
        while time.time() < deadline:
            try:
                urllib.request.urlopen(b.url + "/health", timeout=1)
                b.up = True
                break
            except (urllib.error.URLError, ConnectionError, TimeoutError):
                time.sleep(0.5)
        print(f"  :{b.port} {'ready' if b.up else 'FAILED (see server-%d.log)' % b.port}")
    return backends, procs


def get_json(url, timeout=2):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.load(r)


def poll_backends(st):
    while True:
        total = 0.0
        per = []
        for b in st.backends:
            try:
                slots = get_json(b.url + "/slots")
                b.slots = [
                    {
                        "id": s["id"],
                        "busy": s["is_processing"],
                        "n": (s.get("next_token") or [{}])[0].get("n_decoded", 0),
                        "pp": s.get("n_prompt_tokens_processed", 0),
                        "np": s.get("n_prompt_tokens", 0),
                    }
                    for s in slots
                ]
                m = {}
                with urllib.request.urlopen(b.url + "/metrics", timeout=2) as r:
                    for line in r.read().decode().splitlines():
                        if line and not line.startswith("#"):
                            k, v = line.rsplit(" ", 1)
                            m[k] = float(v)
                now = time.time()
                cur = (now, m.get("llamacpp:tokens_predicted_total", 0), m.get("llamacpp:prompt_tokens_total", 0))
                if b._last:
                    dt = max(1e-3, now - b._last[0])
                    b.tps = max(0.0, (cur[1] - b._last[1]) / dt)
                    b.pp_tps = max(0.0, (cur[2] - b._last[2]) / dt)
                b._last = cur
                b.up = True
            except Exception:  # noqa: BLE001 - backend down or busy; keep dashboard alive
                b.up = False
                b.tps = 0.0
            total += b.tps
            per.append(round(b.tps, 1))
        with st.lock:
            st.history.append((round(time.time() - st.t0, 1), round(total, 1), per))
            st.peak_tps = max(st.peak_tps, total)
        time.sleep(0.5)


def poll_gpu(st):
    q = "utilization.gpu,memory.used,memory.total,power.draw,temperature.gpu,clocks.gr"
    while True:
        try:
            out = subprocess.run(["nvidia-smi", f"--query-gpu={q}", "--format=csv,noheader,nounits"],
                                 capture_output=True, text=True, timeout=5,
                                 creationflags=subprocess.CREATE_NO_WINDOW).stdout.strip()
            u, mu, mt, p, t, c = [x.strip() for x in out.split(",")]
            st.gpu = {"util": float(u), "mem": float(mu), "mem_total": float(mt),
                      "power": float(p), "temp": float(t), "clock": float(c)}
        except Exception:  # noqa: BLE001
            pass
        time.sleep(1)


def snapshot(st):
    with st.lock:
        now = time.time()
        agents = sorted(
            ({"id": a["agent"], "role": a["role"], "port": a["port"],
              "elapsed": round(now - a["start"], 1)} for a in st.agents.values()),
            key=lambda a: -a["elapsed"],
        )
        return {
            "backends": [{"port": b.port, "up": b.up, "inflight": b.inflight, "tps": round(b.tps, 1),
                          "pp_tps": round(b.pp_tps), "slots": b.slots} for b in st.backends],
            "agents": agents,
            "recent": list(st.recent),
            "history": list(st.history),
            "done": st.done, "errors": st.errors, "gen_tokens": st.gen_tokens,
            "peak_tps": round(st.peak_tps, 1), "gpu": st.gpu,
        }


def make_handler(st):
    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"

        def log_message(self, *a):
            pass

        def _send(self, code, body, ctype="application/json"):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path in ("/", "/dash"):
                return self._send(200, DASH.read_bytes(), "text/html; charset=utf-8")
            if self.path == "/state":
                return self._send(200, json.dumps(snapshot(st)).encode())
            if self.path == "/events":
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()
                try:
                    while True:
                        self.wfile.write(b"data: " + json.dumps(snapshot(st)).encode() + b"\n\n")
                        self.wfile.flush()
                        time.sleep(0.5)
                except (BrokenPipeError, ConnectionError, OSError):
                    return
            try:  # /health, /v1/models, ... -> first live backend
                b = next((x for x in st.backends if x.up), st.backends[0])
                with urllib.request.urlopen(b.url + self.path, timeout=10) as r:
                    return self._send(r.status, r.read(), r.headers.get("Content-Type", "application/json"))
            except urllib.error.HTTPError as e:
                return self._send(e.code, e.read())
            except Exception as e:  # noqa: BLE001
                return self._send(502, json.dumps({"error": str(e)}).encode())

        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            b = st.pick()
            with st.lock:
                rid = st.next_id
                st.next_id += 1
                st.agents[rid] = {"agent": self.headers.get("X-Agent", f"req-{rid}"),
                                  "role": self.headers.get("X-Role", "client"),
                                  "port": b.port, "start": time.time()}
            ok, tokens, tps = False, 0, 0.0
            try:
                req = urllib.request.Request(b.url + self.path, body, {"Content-Type": "application/json"})
                with urllib.request.urlopen(req, timeout=900) as r:
                    ctype = r.headers.get("Content-Type", "application/json")
                    if "event-stream" in ctype:  # pass streaming through untouched
                        self.send_response(r.status)
                        self.send_header("Content-Type", ctype)
                        self.end_headers()
                        for line in r:
                            self.wfile.write(line)
                            self.wfile.flush()
                            if line.startswith(b"data: {") and b'"timings"' in line:
                                t = json.loads(line[6:]).get("timings", {})
                                tokens, tps = t.get("predicted_n", 0), t.get("predicted_per_second", 0.0)
                    else:
                        data = r.read()
                        self._send(r.status, data, ctype)
                        try:
                            t = json.loads(data).get("timings", {})
                            tokens, tps = t.get("predicted_n", 0), t.get("predicted_per_second", 0.0)
                        except ValueError:
                            pass
                ok = True
            except urllib.error.HTTPError as e:
                self._send(e.code, e.read())
            except Exception as e:  # noqa: BLE001
                try:
                    self._send(502, json.dumps({"error": str(e)}).encode())
                except OSError:
                    pass
            finally:
                with st.lock:
                    b.inflight -= 1
                    a = st.agents.pop(rid)
                    if ok:
                        st.done += 1
                        st.gen_tokens += tokens
                    else:
                        st.errors += 1
                    st.recent.appendleft({"id": a["agent"], "role": a["role"], "port": b.port, "ok": ok,
                                          "tokens": tokens, "tps": round(tps, 1),
                                          "secs": round(time.time() - a["start"], 1)})

    return H


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-k", type=int, default=3, help="number of llama-server instances")
    ap.add_argument("--slots", type=int, default=16, help="slots per instance")
    ap.add_argument("--ctx", type=int, default=4096, help="context per slot")
    ap.add_argument("--port", type=int, default=8080, help="proxy/dashboard port")
    ap.add_argument("--attach", type=int, nargs="*", help="proxy existing servers on these ports instead")
    a = ap.parse_args()

    procs = []
    if a.attach:
        backends = [Backend(p) for p in a.attach]
    else:
        backends, procs = launch(a.k, a.slots, a.ctx, a.port + 1)
    st = State(backends)
    threading.Thread(target=poll_backends, args=(st,), daemon=True).start()
    threading.Thread(target=poll_gpu, args=(st,), daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), make_handler(st))
    srv.daemon_threads = True
    print(f"\nproxy + dashboard: http://127.0.0.1:{a.port}/dash   (Ctrl+C to stop everything)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        for p in procs:
            p.kill()
        os._exit(0)


if __name__ == "__main__":
    main()
