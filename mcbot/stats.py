"""Summarise bot decision logs (ROADMAP B1).

Usage:
  python stats.py                 # latest session in mcbot/logs/
  python stats.py --all           # every session
  python stats.py logs/x.jsonl    # given file(s)
"""
import argparse
import json
import statistics as st
import sys
from collections import Counter, defaultdict
from pathlib import Path

LOGS = Path(__file__).parent / 'logs'


def load(files):
    recs, bad = [], 0
    for f in files:
        for line in open(f, encoding='utf8'):
            line = line.strip()
            if not line:
                continue
            try:
                recs.append(json.loads(line))
            except json.JSONDecodeError:
                bad += 1  # truncated last line after a crash
    return recs, bad


def pct(a, b):
    return f'{100 * a / b:5.1f}%' if b else '    -'


def med(xs):
    return f'{st.median(xs):.0f}' if xs else '-'


def p95(xs):
    if not xs:
        return '-'
    xs = sorted(xs)
    return f'{xs[min(len(xs) - 1, int(0.95 * len(xs)))]:.0f}'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('files', nargs='*')
    ap.add_argument('--all', action='store_true')
    ap.add_argument('--top', type=int, default=8, help='rows in failure-reason table')
    args = ap.parse_args()

    files = [Path(f) for f in args.files] or sorted(LOGS.glob('*.jsonl'))
    if not files:
        sys.exit(f'no logs in {LOGS}')
    if not args.files and not args.all:
        files = files[-1:]
    recs, bad = load(files)
    dec = [r for r in recs if r.get('kind') == 'decision']
    ev = [r for r in recs if r.get('kind') == 'event']
    sessions = sorted({r['session'] for r in recs})

    span = (max(r['ts'] for r in recs) - min(r['ts'] for r in recs)) / 1000 if recs else 0
    print(f'files: {len(files)}  sessions: {len(sessions)}  records: {len(recs)}  bad lines: {bad}')
    print(f'span: {span / 60:.1f} min  decisions: {len(dec)}  ({len(dec) / span * 60:.1f}/min)' if span else '')
    if not dec:
        return

    ok = sum(r['ok'] for r in dec)
    print(f'success: {ok}/{len(dec)} {pct(ok, len(dec))}')
    src = Counter(r.get('source') for r in dec)
    print('source: ' + ', '.join(f'{k} {v}' for k, v in src.most_common()))
    llm = [r for r in dec if r.get('source') == 'llm']
    if llm:
        lat = [r['llm_ms'] for r in llm if 'llm_ms' in r]
        print(f'llm: latency ms med {med(lat)} p95 {p95(lat)}')
        hinted = [r for r in llm if r.get('followed_hint') is not None]  # hint was a concrete action
        fh = [r for r in hinted if r['followed_hint']]
        nfh = [r for r in hinted if not r['followed_hint']]
        print(f'     concrete hint {len(hinted)}/{len(llm)} | followed {len(fh)} {pct(len(fh), len(hinted))}'
              f' | success followed {pct(sum(r["ok"] for r in fh), len(fh))}'
              f' / not followed {pct(sum(r["ok"] for r in nfh), len(nfh))}')

    # per verb
    print(f'\n{"verb":<10}{"n":>6}{"ok":>6}{"rate":>8}{"dur med s":>11}{"dur p95 s":>11}')
    by = defaultdict(list)
    for r in dec:
        by[r.get('verb', '?')].append(r)
    for v, rs in sorted(by.items(), key=lambda kv: -len(kv[1])):
        d = [r['dur_ms'] / 1000 for r in rs if 'dur_ms' in r]
        k = sum(r['ok'] for r in rs)
        print(f'{v:<10}{len(rs):>6}{k:>6}{pct(k, len(rs)):>8}'
              f'{(st.median(d) if d else 0):>11.1f}{(sorted(d)[int(0.95 * (len(d) - 1))] if d else 0):>11.1f}')

    # per action (verb+arg), top by count
    print(f'\n{"action":<30}{"n":>6}{"rate":>8}')
    ba = Counter(r['action'] for r in dec)
    for a, n in ba.most_common(15):
        k = sum(r['ok'] for r in dec if r['action'] == a)
        print(f'{a:<30}{n:>6}{pct(k, n):>8}')

    # failure reasons (strip numbers so similar messages group)
    fails = Counter()
    for r in dec:
        if not r['ok']:
            reason = ''.join('#' if c.isdigit() else c for c in r.get('result', ''))
            fails[f'{r.get("verb")}: {reason}'] += 1
    if fails:
        print('\ntop failures:')
        for k, n in fails.most_common(args.top):
            print(f'{n:>6}  {k}')

    # loops: same action repeated >=5 times in a row
    runs, cur, prev = [], 0, None
    for r in dec:
        cur = cur + 1 if r['action'] == prev else 1
        prev = r['action']
        if cur == 5:
            runs.append(prev)
    if runs:
        print(f'\nloops (>=5 same action in a row): {len(runs)}  e.g. {Counter(runs).most_common(3)}')

    # items gained
    gained = Counter()
    for r in dec:
        for k, v in (r.get('after') or {}).get('inv_delta', {}).items():
            if v > 0:
                gained[k] += v
    if gained:
        print('\nitems gained: ' + ', '.join(f'{k} {v}' for k, v in gained.most_common(15)))

    evc = Counter(e.get('type') for e in ev)
    if evc:
        print('events: ' + ', '.join(f'{k} {v}' for k, v in evc.most_common()))


if __name__ == '__main__':
    main()
