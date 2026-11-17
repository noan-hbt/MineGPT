"""General model bench: same generic tasks for every model, answers checked by code.

Not Minecraft knowledge, not our DSL (both come with training). Measures what a base model brings:
accuracy on short reasoning tasks (multi-step arithmetic, grid shortest path, resource planning, state tracking),
latency (time to first token, total), generated tokens (verbosity, thinking), tok/s, and availability
(errors, timeouts, empty or unparseable answers).

Each model runs alone in llama-server (one at a time: several instances on the 8 GB GPU stall), same flags,
temperature 0, the model's own chat template; reasoning left to the model's default (`--reasoning auto`).

  .venv/Scripts/python.exe eval/model_bench.py [--models a.gguf,b.gguf] [--n 6] [--reasoning auto|on|off]
Writes eval/results/model_bench_<stamp>.jsonl (one line per call) and prints a summary table.
"""
import argparse, glob, json, os, random, re, subprocess, sys, time, urllib.request
from collections import deque

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER = os.path.join(ROOT, 'llama.cpp', 'llama-server.exe')
PORT = 8091
SYSTEM = 'Solve the task. You may reason briefly. End your reply with a last line of the form "ANSWER: <answer>".'


# ---------------------------------------------------------------- tasks (seeded, answers computed by code)
def t_arith(rng):
    a, b, c, d = rng.randint(12, 60), rng.randint(3, 9), rng.randint(5, 40), rng.randint(2, 6)
    q = (f'A shop has {a} boxes. Each box holds {b} bottles. The shop sells {c} bottles, then receives '
         f'{d} new boxes of the same size. Then it splits all its bottles equally among 2 shelves and removes the '
         f'remainder. How many bottles are on one shelf?')
    return q, str((a * b - c + d * b) // 2)


def t_grid(rng):
    while True:
        w, h = 9, 7
        g = [['.' if rng.random() > 0.28 else '#' for _ in range(w)] for _ in range(h)]
        s, e = (0, rng.randrange(h)), (w - 1, rng.randrange(h))
        g[s[1]][s[0]], g[e[1]][e[0]] = 'S', 'E'
        dist = {s: 0}
        q = deque([s])
        while q:
            x, y = q.popleft()
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                n = (x + dx, y + dy)
                if 0 <= n[0] < w and 0 <= n[1] < h and g[n[1]][n[0]] != '#' and n not in dist:
                    dist[n] = dist[(x, y)] + 1
                    q.append(n)
        if e in dist and dist[e] > 8:
            break
    grid = '\n'.join(''.join(r) for r in g)
    return (f'Grid (S start, E end, # wall, . free). Moves: up, down, left, right, one cell each.\n{grid}\n'
            f'What is the minimum number of moves from S to E?'), str(dist[e])


def t_plan(rng):
    names = rng.sample(['gear', 'frame', 'rod', 'plate', 'bolt', 'panel', 'wheel', 'axle'], 4)
    raws = ['iron', 'wood', 'copper']
    top, mid1, mid2, low = names
    rec = {
        low: {rng.choice(raws): rng.randint(1, 3)},
        mid1: {low: rng.randint(1, 3), rng.choice(raws): rng.randint(1, 2)},
        mid2: {low: rng.randint(1, 2), rng.choice(raws): rng.randint(1, 3)},
        top: {mid1: rng.randint(1, 2), mid2: rng.randint(1, 3)},
    }
    n = rng.randint(2, 4)

    def need(item, k):
        if item in raws:
            return {item: k}
        out = {}
        for sub, m in rec[item].items():
            for r, v in need(sub, k * m).items():
                out[r] = out.get(r, 0) + v
        return out
    ask = rng.choice(sorted(need(top, n)))  # a raw material the recipes actually use
    lines = '\n'.join(f'- 1 {it} needs ' + ', '.join(f'{m} {s}' for s, m in rec[it].items()) for it in (top, mid1, mid2, low))
    return (f'Recipes (each recipe makes exactly 1 item):\n{lines}\nYou start with nothing. '
            f'How much {ask} in total is needed to make {n} {top}?'), str(need(top, n).get(ask, 0))


def t_state(rng):
    v = {k: rng.randint(0, 9) for k in 'abc'}
    lines = [f'a = {v["a"]}, b = {v["b"]}, c = {v["c"]}.']
    for _ in range(7):
        op = rng.choice(['add', 'swap', 'double', 'sub'])
        x, y = rng.sample('abc', 2)
        if op == 'add':
            lines.append(f'{x} = {x} + {y}'); v[x] += v[y]
        elif op == 'swap':
            lines.append(f'swap {x} and {y}'); v[x], v[y] = v[y], v[x]
        elif op == 'double':
            lines.append(f'{x} = {x} * 2'); v[x] *= 2
        else:
            lines.append(f'{x} = {x} - {y}'); v[x] -= v[y]
    ask = rng.choice('abc')
    return 'Execute these steps in order:\n' + '\n'.join(lines) + f'\nWhat is the final value of {ask}?', str(v[ask])


FAMILIES = {'arith': t_arith, 'grid': t_grid, 'plan': t_plan, 'state': t_state}


def tasks(n):
    out = []
    for fam, f in FAMILIES.items():
        rng = random.Random(f'bench-{fam}')  # same tasks for every model and run
        for i in range(n):
            q, a = f(rng)
            out.append({'id': f'{fam}{i}', 'family': fam, 'q': q, 'a': a})
    return out


# ---------------------------------------------------------------- server
def start_server(model, reasoning, log):
    args = [SERVER, '-m', model, '-ngl', '99', '-c', '8192', '-np', '1', '--port', str(PORT), '--jinja',
            '--reasoning', reasoning, '--reasoning-format', 'deepseek', '--no-webui']
    p = subprocess.Popen(args, stdout=log, stderr=subprocess.STDOUT)
    t0 = time.time()
    while time.time() - t0 < 180:
        if p.poll() is not None:
            return p, f'server exited {p.returncode}'
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{PORT}/health', timeout=2) as r:
                if r.status == 200:
                    return p, None
        except Exception:
            pass
        time.sleep(0.5)
    return p, 'server not ready in 180 s'


def ask(q, max_tokens, timeout):
    body = json.dumps({'messages': [{'role': 'system', 'content': SYSTEM}, {'role': 'user', 'content': q}],
                       'temperature': 0, 'max_tokens': max_tokens, 'stream': True}).encode()
    req = urllib.request.Request(f'http://127.0.0.1:{PORT}/v1/chat/completions', body, {'Content-Type': 'application/json'})
    t0 = time.time()
    ttft, content, reasoning, timings, finish = None, [], [], {}, None
    with urllib.request.urlopen(req, timeout=timeout) as r:
        for raw in r:
            line = raw.decode('utf8', 'replace').strip()
            if not line.startswith('data: ') or line == 'data: [DONE]':
                continue
            o = json.loads(line[6:])
            if o.get('timings'):
                timings = o['timings']
            for ch in o.get('choices', []):
                d = ch.get('delta', {})
                piece = (d.get('content') or '') + (d.get('reasoning_content') or '')
                if piece and ttft is None:
                    ttft = time.time() - t0
                content.append(d.get('content') or '')
                reasoning.append(d.get('reasoning_content') or '')
                finish = ch.get('finish_reason') or finish
            if time.time() - t0 > timeout:
                raise TimeoutError('stream timeout')
    return {'content': ''.join(content), 'reasoning': ''.join(reasoning), 'ttft': ttft, 'total': time.time() - t0,
            'gen_tokens': timings.get('predicted_n'), 'tps': timings.get('predicted_per_second'), 'finish': finish}


def extract(text):
    m = re.findall(r'ANSWER:\s*\**\s*(-?\d+)', text)
    return m[-1] if m else None


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--models', default=None)
    ap.add_argument('--n', type=int, default=6, help='tasks per family')
    ap.add_argument('--reasoning', default='auto')
    ap.add_argument('--max-tokens', type=int, default=3072)
    ap.add_argument('--timeout', type=int, default=180)
    a = ap.parse_args()
    models = a.models.split(',') if a.models else sorted(glob.glob(os.path.join(ROOT, 'models', 'compare', '*.gguf')))
    T = tasks(a.n)
    os.makedirs(os.path.join(ROOT, 'eval', 'results'), exist_ok=True)
    stamp = time.strftime('%Y-%m-%d-%H-%M')
    out_path = os.path.join(ROOT, 'eval', 'results', f'model_bench_{stamp}.jsonl')
    out = open(out_path, 'w', encoding='utf8')
    summary = []
    for m in models:
        name = os.path.basename(m).replace('.gguf', '')
        log = open(os.path.join(ROOT, 'eval', 'results', f'server_{name}.log'), 'w')
        t_load = time.time()
        p, err = start_server(m, a.reasoning, log)
        load_s = time.time() - t_load
        rows = []
        print(f'=== {name} (load {load_s:.1f}s{", " + err if err else ""})', flush=True)
        for t in T:
            rec = {'model': name, 'reasoning_mode': a.reasoning, 'id': t['id'], 'family': t['family'], 'want': t['a']}
            if err:
                rec.update(status='unavailable', error=err)
            else:
                try:
                    r = ask(t['q'], a.max_tokens, a.timeout)
                    got = extract(r['content']) or extract(r['reasoning'])
                    rec.update(r, got=got, ok=got == t['a'],
                               status='ok' if got is not None else ('truncated' if r['finish'] == 'length' else 'no_answer'))
                except Exception as e:
                    rec.update(status='error', error=str(e)[:200])
            rows.append(rec)
            out.write(json.dumps(rec) + '\n'); out.flush()
            print(f"  {t['id']:7} {rec['status']:10} {'OK ' if rec.get('ok') else '-- '} got={rec.get('got')} want={t['a']} "
                  f"tok={rec.get('gen_tokens')} {rec.get('total', 0):.1f}s", flush=True)
        p.terminate()
        try:
            p.wait(15)
        except Exception:
            p.kill()
        log.close()
        done = [r for r in rows if r['status'] in ('ok', 'no_answer', 'truncated')]
        s = {'model': name, 'load_s': round(load_s, 1),
             'acc': sum(bool(r.get('ok')) for r in rows) / len(rows),
             'by_family': {f: sum(bool(r.get('ok')) for r in rows if r['family'] == f) for f in FAMILIES},
             'answered': sum(r['status'] == 'ok' for r in rows), 'truncated': sum(r['status'] == 'truncated' for r in rows),
             'no_answer': sum(r['status'] == 'no_answer' for r in rows), 'errors': sum(r['status'] in ('error', 'unavailable') for r in rows),
             'med_total_s': sorted(r['total'] for r in done)[len(done) // 2] if done else None,
             'med_ttft_s': sorted(r['ttft'] or 0 for r in done)[len(done) // 2] if done else None,
             'mean_tokens': sum(r['gen_tokens'] or 0 for r in done) / len(done) if done else None,
             'mean_tps': sum(r['tps'] or 0 for r in done) / len(done) if done else None,
             'thinks': sum(bool(r.get('reasoning')) for r in done)}
        s['correct_per_min'] = round(sum(bool(r.get('ok')) for r in rows) / (sum(r.get('total', 0) for r in done) / 60), 1) if done else 0
        summary.append(s)
        out.write(json.dumps({'summary': s}) + '\n'); out.flush()
    out.close()
    n = len(T)
    print(f'\n{n} tasks/model ({a.n} per family: {", ".join(FAMILIES)}), reasoning={a.reasoning}; log {out_path}')
    print(f"{'model':42} {'acc':>5} {'by family':>16} {'ans/trunc/none/err':>18} {'med s':>6} {'ttft':>5} {'tok':>6} {'tok/s':>6} {'ok/min':>6} {'think':>5}")
    for s in summary:
        bf = '/'.join(str(v) for v in s['by_family'].values())
        print(f"{s['model'][:42]:42} {s['acc']:5.0%} {bf:>16} {s['answered']:>4}/{s['truncated']}/{s['no_answer']}/{s['errors']:<8} "
              f"{s['med_total_s'] or 0:6.1f} {s['med_ttft_s'] or 0:5.2f} {s['mean_tokens'] or 0:6.0f} {s['mean_tps'] or 0:6.0f} "
              f"{s['correct_per_min']:6.1f} {s['thinks']:>5}")


if __name__ == '__main__':
    main()
