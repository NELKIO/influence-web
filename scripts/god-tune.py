"""Coordinate-ascent tuning of GOD options/weights by win rate against a reference bot.

Each candidate setting is played on the same seeded games (paired comparison: same maps, same seat
rotation) with scripts/god-strength.ts split over parallel processes; a change is accepted only when it
beats the current best by more than `--min-gain` (default 1.5 points, about half a standard error at 200
games).

Usage:
  python3 scripts/god-tune.py --procs 10 --games 20 --base '{"stack":{"chain":0.5}}' \
      --grid '{"stack.chain":[0.25,1.0],"stack.pow":[0.6,1.5],"emuIters":[16,64]}' [--extra "sizes=M,L,XL mp=1000 gr=1000"]

Keys of --grid are GodOptions paths (dots go into nested objects such as stack.* or params.*).
"""
import argparse
import copy
import json
import subprocess
import sys

ap = argparse.ArgumentParser()
ap.add_argument('--procs', type=int, default=10)
ap.add_argument('--games', type=int, default=20, help='games per process')
ap.add_argument('--base', default='{}')
ap.add_argument('--grid', required=True)
ap.add_argument('--rounds', type=int, default=2)
ap.add_argument('--min-gain', type=float, default=0.015)
ap.add_argument('--extra', default='sizes=M,L,XL gr=1000 mp=1000')
a = ap.parse_args()


def setp(d, path, v):
    keys = path.split('.')
    for k in keys[:-1]:
        d = d.setdefault(k, {})
    d[keys[-1]] = v


def score(opts):
    procs = []
    for i in range(a.procs):
        cmd = ['npx', 'vite-node', 'scripts/god-strength.ts', '--', 'json=1', f'games={a.games}', f'offset={i * a.games}',
               'godA=' + json.dumps(opts)] + a.extra.split()
        procs.append(subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True))
    w = n = 0
    for p in procs:
        out = p.communicate()[0].strip().splitlines()
        j = json.loads(out[-1])
        w += j['aw']
        n += j['games']
    return w / max(1, n)


best_opts = json.loads(a.base)
best = score(best_opts)
print('start', json.dumps(best_opts), f'{best:.3f}', flush=True)
grid = json.loads(a.grid)
for r in range(a.rounds):
    for path, values in grid.items():
        for v in values:
            cand = copy.deepcopy(best_opts)
            setp(cand, path, v)
            s = score(cand)
            print(r, path, v, f'{s:.3f}', flush=True)
            if s > best + a.min_gain:
                best, best_opts = s, cand
                print('  accept', json.dumps(best_opts), f'{best:.3f}', flush=True)
print('final', json.dumps(best_opts), f'{best:.3f}')
sys.exit(0)
