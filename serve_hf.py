"""Minimal OpenAI-compatible chat server for a local HF checkpoint (LFM2.5-350M fine-tunes), for the live mind
(`node bot/harness.js --mind --llm http://127.0.0.1:8081`). No GGUF conversion needed.

  python serve_hf.py --model models/LFM2.5-350M-sol-exp [--port 8081] [--device cuda|cpu]

POST /v1/chat/completions {messages, max_tokens, temperature} -> {choices:[{message:{content}}], usage, timings}
Greedy when temperature <= 0 (the eval in exp_350m/eval_sol_model.py is greedy). One request at a time.
"""
import argparse
import json
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

ap = argparse.ArgumentParser()
ap.add_argument("--model", required=True)
ap.add_argument("--port", type=int, default=8081)
ap.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
ap.add_argument("--threads", type=int, default=8)
ap.add_argument("--vram-frac", type=float, default=0.5, help="cap on this process's share of VRAM (cuda)")
args = ap.parse_args()

torch.set_num_threads(args.threads)
dtype = torch.bfloat16 if args.device == "cuda" else torch.float32
tok = AutoTokenizer.from_pretrained(args.model)
if args.device == "cuda":
    torch.cuda.set_per_process_memory_fraction(args.vram_frac)  # OOM here instead of spilling into shared memory
model = AutoModelForCausalLM.from_pretrained(args.model, dtype=dtype, attn_implementation="sdpa").to(args.device).eval()
NAME = args.model.replace("\\", "/").rstrip("/").split("/")[-1]
print(f"loaded {NAME} on {args.device} ({dtype}); http://127.0.0.1:{args.port}/v1/chat/completions", flush=True)


def complete(body):
    msgs = body["messages"]
    max_new = int(body.get("max_tokens") or body.get("max_completion_tokens") or 512)
    temp = float(body.get("temperature", 0) or 0)
    ids = tok.apply_chat_template(msgs, tokenize=True, add_generation_prompt=True, return_tensors="pt", return_dict=False)
    if isinstance(ids, dict):
        ids = ids["input_ids"]
    ids = ids.to(args.device)
    t0 = time.perf_counter()
    with torch.no_grad():
        gen = model.generate(input_ids=ids, attention_mask=torch.ones_like(ids), max_new_tokens=max_new, do_sample=temp > 0,
                             **({"temperature": temp, "top_p": 0.95} if temp > 0 else {}),
                             use_cache=True, pad_token_id=tok.eos_token_id)
    out_ids = gen[0][ids.shape[1]:]
    peak = 0
    if args.device == "cuda":
        peak = torch.cuda.max_memory_allocated() >> 20
        torch.cuda.reset_peak_memory_stats()
        torch.cuda.empty_cache()  # varied prompt lengths otherwise grow the caching allocator without bound
    text = tok.decode(out_ids, skip_special_tokens=True).strip()
    ms = (time.perf_counter() - t0) * 1000
    n_out = int(out_ids.shape[0])
    return {
        "object": "chat.completion", "model": NAME,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": text},
                     "finish_reason": "length" if n_out >= max_new else "stop"}],
        "usage": {"prompt_tokens": int(ids.shape[1]), "completion_tokens": n_out},
        "timings": {"prompt_ms": 0, "predicted_ms": round(ms, 1)}, "peak_mb": peak,
    }


class H(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._send(200, {"object": "list", "data": [{"id": NAME, "object": "model"}]})

    def do_POST(self):
        if not self.path.rstrip("/").endswith("/chat/completions"):
            return self._send(404, {"error": {"message": "only /v1/chat/completions"}})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            r = complete(body)
            print(f"{r['usage']['prompt_tokens']} -> {r['usage']['completion_tokens']} tok, {r['timings']['predicted_ms']:.0f} ms, peak {r['peak_mb']} MB", flush=True)
            self._send(200, r)
        except Exception as e:  # report to the client, keep serving
            self._send(500, {"error": {"message": f"{type(e).__name__}: {e}"}})

    def log_message(self, *a):
        pass


HTTPServer(("127.0.0.1", args.port), H).serve_forever()
