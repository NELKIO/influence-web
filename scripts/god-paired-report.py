"""Tables of scripts/god-paired.ts out= files: per variant overall, per size, symmetric / random maps,
seat order, with the standard error; and the paired difference of every variant against the first one
on the games both played (same offset and seat order).

Usage: python3 scripts/god-paired-report.py file.jsonl[,file2.jsonl] [sizes=S,M,L,XL,XXL] [base=main]
"""
import json
import math
import sys
from collections import defaultdict

files = sys.argv[1].split(',')
sizes = 'S,M,L,XL,XXL'
for a in sys.argv[2:]:
    if a.startswith('sizes='):
        sizes = a[6:]
nsz = len(sizes.split(','))
rows = [json.loads(line) for f in files for line in open(f)]
order = []
for r in rows:
    if r['v'] not in order:
        order.append(r['v'])
# the baseline of the paired differences: base=<variant> (default 'main' when present)
base_name = next((a[5:] for a in sys.argv[2:] if a.startswith('base=')), 'main')
if base_name in order:
    order.remove(base_name)
    order.insert(0, base_name)


def pct(w, n):
    return f'{100 * w / n:5.1f}%' if n else '    -'


cols = sizes.split(',') + ['sym', 'random', 'A', 'B']
print(f"{'variant':12s} {'games':>5s} {'GOD':>6s} {'±se':>5s}  " + '  '.join(f'{c:>6s}' for c in cols))
games = defaultdict(dict)
for v in order:
    rs = [r for r in rows if r['v'] == v]
    w = sum(r['won'] for r in rs)
    n = len(rs)
    se = 100 * math.sqrt(max(1e-9, w / n * (1 - w / n)) / n)
    cells = []
    for c in cols:
        if c in ('sym', 'random'):
            sub = [r for r in rs if ((r['g'] // nsz) % 2 == 1) == (c == 'sym')]
        elif c in ('A', 'B'):
            sub = [r for r in rs if r['godIsA'] == (c == 'A')]
        else:
            sub = [r for r in rs if r['size'] == c]
        cells.append(pct(sum(r['won'] for r in sub), len(sub)))
    print(f'{v:12s} {n:5d} {pct(w, n)} {se:5.1f}  ' + '  '.join(f'{x:>6s}' for x in cells))
    for r in rs:
        games[v].setdefault((r['g'], r['godIsA']), []).append(r['won'])
base = order[0]
for v in order[1:]:
    d = []
    for k, ws in games[v].items():
        if k in games[base]:
            b = games[base][k]
            d.append(sum(ws) / len(ws) - sum(b) / len(b))
    if d:
        m = sum(d) / len(d)
        sd = math.sqrt(sum((x - m) ** 2 for x in d) / max(1, len(d) - 1))
        print(f'{v} - {base}: {100 * m:+.1f} points over {len(d)} common slots (se {100 * sd / math.sqrt(len(d)):.1f})')
