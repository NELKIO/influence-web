#!/usr/bin/env python3
"""
Seat-bias tables from the JSON lines of scripts/seat-bias.ts.

  python3 scripts/seat-bias-report.py res/*.jsonl [--by tag,bot,n,size,sym,comp] [--sort spread] [--min 50]

Per group and seat: win share (%), average place (1 = winner) and the share of games in which the
seat was the first one out. The spread is the largest minus the smallest win share across the seats;
chi2 / p test the wins against an even split (games without a winner left out). With a star bot in a
rotating seat, the table is the star's win share by its seat instead.
"""
import json
import math
import sys
from collections import defaultdict


def chi2_sf(x, k):
    """upper tail of chi-square with k degrees of freedom (regularised gamma)"""
    if x <= 0:
        return 1.0
    a = k / 2.0
    # series for the lower incomplete gamma, continued fraction when x is large
    if x / 2 < a + 1:
        term = 1.0 / a
        s = term
        n = 1
        while abs(term) > 1e-12 * abs(s) and n < 1000:
            term *= (x / 2) / (a + n)
            s += term
            n += 1
        lower = s * math.exp(-x / 2 + a * math.log(x / 2) - math.lgamma(a))
        return max(0.0, 1 - lower)
    b = x / 2 + 1 - a
    c = 1e300
    d = 1 / b
    h = d
    for i in range(1, 1000):
        an = -i * (i - a)
        b += 2
        d = an * d + b
        d = 1e-300 if abs(d) < 1e-300 else d
        c = b + an / c
        c = 1e-300 if abs(c) < 1e-300 else c
        d = 1 / d
        de = d * c
        h *= de
        if abs(de - 1) < 1e-12:
            break
    return h * math.exp(-x / 2 + a * math.log(x / 2) - math.lgamma(a))


def main():
    files = [a for a in sys.argv[1:] if not a.startswith('--')]
    opts = {}
    argv = sys.argv[1:]
    for i, a in enumerate(argv):
        if a.startswith('--') and i + 1 < len(argv):
            opts[a[2:]] = argv[i + 1]
    files = [f for f in files if f not in opts.values()]
    by = opts.get('by', 'tag,mode,bot,star,n,size,sym,duel,comp').split(',')
    min_games = int(opts.get('min', '1'))
    groups = defaultdict(list)
    for f in files:
        with open(f) as fh:
            for line in fh:
                line = line.strip()
                if not line.startswith('{'):
                    continue
                r = json.loads(line)
                groups[tuple(str(r.get(k, '')) for k in by)].append(r)
    rows = []
    for key, rs in groups.items():
        if len(rs) < min_games:
            continue
        n = rs[0]['n']
        games = len(rs)
        star = rs[0].get('star')
        wins = [0.0] * n
        place = [0.0] * n
        first = [0.0] * n
        seen = [0] * n
        capped = sum(1 for r in rs if r['winner'] < 0)
        for r in rs:
            if star:
                s = r['starSeat']
                seen[s] += 1
                if r['winner'] == s:
                    wins[s] += 1
                place[s] += r['place'][s]
                continue
            if r['winner'] >= 0:
                wins[r['winner']] += 1
            for i in range(n):
                place[i] += r['place'][i]
            outs = [o for o in r['outAt'] if o >= 0]
            if outs:
                m = min(outs)
                who = [i for i in range(n) if r['outAt'][i] == m]
                for i in who:
                    first[i] += 1 / len(who)
        if star:
            share = [100 * wins[i] / max(1, seen[i]) for i in range(n)]
            avgp = [place[i] / max(1, seen[i]) for i in range(n)]
            fo = [0.0] * n
            decided = games
            chi2 = 0.0
            # star wins by seat against its overall rate (a 2 x n table)
            mean = sum(wins) / max(1, games)
            for i in range(n):
                e = seen[i] * mean
                if e > 0:
                    chi2 += (wins[i] - e) ** 2 / e + ((seen[i] - wins[i]) - (seen[i] - e)) ** 2 / max(1e-9, seen[i] - e)
            p = chi2_sf(chi2, n - 1)
        else:
            decided = games - capped
            share = [100 * w / games for w in wins]
            avgp = [p / games for p in place]
            fo = [100 * f / games for f in first]
            e = decided / n
            chi2 = sum((w - e) ** 2 / e for w in wins) if e > 0 else 0.0
            p = chi2_sf(chi2, n - 1)
        spread = max(share) - min(share)
        rows.append((key, games, capped, share, avgp, fo, spread, chi2, p))
    sort = opts.get('sort', '')
    if sort == 'spread':
        rows.sort(key=lambda r: r[6])
    elif sort == 'chi2':
        rows.sort(key=lambda r: r[7])
    else:
        rows.sort(key=lambda r: r[0])
    fmt = opts.get('fmt', 'text')
    for key, games, capped, share, avgp, fo, spread, chi2, p in rows:
        label = ' '.join(f'{k}={v}' for k, v in zip(by, key) if v not in ('', 'None'))
        if fmt == 'json':
            print(json.dumps({'key': dict(zip(by, key)), 'games': games, 'capped': capped, 'win': share, 'place': avgp, 'firstOut': fo, 'spread': spread, 'chi2': chi2, 'p': p}))
            continue
        print(f'{label}  games={games} capped={capped}  spread={spread:.1f} chi2={chi2:.1f} p={p:.3g}')
        print('   win%  ' + ' '.join(f'{x:5.1f}' for x in share))
        print('   place ' + ' '.join(f'{x:5.2f}' for x in avgp))
        if any(fo):
            print('   1st out%' + ' '.join(f'{x:5.1f}' for x in fo))


if __name__ == '__main__':
    main()
