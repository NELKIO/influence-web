"""Report of scripts/god-oracle.ts: emulated-rollout judgements against the outcome oracle.

Usage: python3 scripts/god-oracle-report.py roll.jsonl orc.jsonl [z thresholds, default 0,1,1.5,2,3]

For every rollout variant and anchor threshold z: the decisions where the variant would deviate from
Master's choice (best candidate by mean, paired gain > z standard errors), how many, and the oracle's
win-rate gain of those deviations (mean and sum, with standard errors). Also the correlation between the
variant's paired gains and the oracle's gains over all non-anchor candidates.
"""
import json
import math
import sys

roll = {}
for f in sys.argv[1].split(','):
    for line in open(f):
        r = json.loads(line)
        roll[r['id']] = r
orc = {}
for f in sys.argv[2].split(','):
    for line in open(f):
        r = json.loads(line)
        orc[r['id']] = r
zs = [float(x) for x in sys.argv[3].split(',')] if len(sys.argv) > 3 else [0, 1, 1.5, 2, 3]
ids = [i for i in roll if i in orc]


def stats(vals, lo, hi):
    """means, paired gains vs candidate 0 and their sd over rollouts [lo, hi)"""
    a = vals[0][lo:hi]
    mean, gain, sd = [], [], []
    for v in vals:
        v = v[lo:hi]
        mean.append(sum(v) / len(v))
        d = [x - y for x, y in zip(v, a)]
        m = sum(d) / len(d)
        gain.append(m)
        sd.append(math.sqrt(sum((x - m) ** 2 for x in d) / max(1, len(d) - 1)))
    return mean, gain, sd


# derived pseudo-variants from the raw rollout values:
#   v@50   only the first 50 rollouts (a shorter budget)
#   v+conf the best candidate by the first half, judged against Master's choice on the second half only
for i in list(roll):
    r = roll[i]
    for v, x in list(r['res'].items()):
        vals = x.get('vals')
        if not vals:
            continue
        n = len(vals[0])
        h = n // 2
        m50, g50, s50 = stats(vals, 0, h)
        r['res'][v + '@50'] = {'mean': m50, 'gain': g50, 'sd': s50, 'ms': x['ms'] / 2, 'n': h}
        _, g2, s2 = stats(vals, h, n)
        # selection by the first half, test statistics from the second half
        r['res'][v + '+conf'] = {'mean': m50, 'gain': g50, 'sd': s50, 'test': (g2, s2), 'ms': x['ms'], 'n': n - h}
variants = sorted({v for i in ids for v in roll[i]['res']})
print(f'decisions with both: {len(ids)}')


def owin(o, c):
    w = o['wins'][c]
    return sum(w) / len(w) if w else None


# oracle: how good is Master's choice vs the best candidate in hindsight
gap = [max(x for x in (owin(orc[i], c) for c in range(len(orc[i]['cands']))) if x is not None) - owin(orc[i], 0) for i in ids]
print(f'oracle: mean (best candidate - Master choice) {sum(gap)/len(gap):.4f}  [upper bound, noisy]')
chosen = []
for i in ids:
    o = orc[i]
    c = o['cands'].index(o['chosen']) if o['chosen'] in o['cands'] else 0
    chosen.append((owin(o, c) if owin(o, c) is not None else owin(o, 0)) - owin(o, 0))
dev = [g for i, g in zip(ids, chosen) if orc[i]['chosen'] != orc[i]['anchor']]
if dev:
    m = sum(dev) / len(dev)
    sd = math.sqrt(sum((x - m) ** 2 for x in dev) / max(1, len(dev) - 1))
    print(f'real GOD deviated in {len(dev)} decisions: oracle gain mean {m:+.4f} (se {sd/math.sqrt(len(dev)):.4f}) sum {sum(dev):+.2f}')

for v in variants:
    n_ms = [roll[i]['res'][v]['ms'] for i in ids if v in roll[i]['res']]
    xs, ys = [], []
    for i in ids:
        r = roll[i]['res'].get(v)
        if not r:
            continue
        for c in range(1, len(r['gain'])):
            if owin(orc[i], c) is None:
                continue
            xs.append(r['gain'][c])
            ys.append(owin(orc[i], c) - owin(orc[i], 0))
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    cov = sum((a - mx) * (b - my) for a, b in zip(xs, ys))
    vx = sum((a - mx) ** 2 for a in xs)
    vy = sum((b - my) ** 2 for b in ys)
    corr = cov / math.sqrt(vx * vy) if vx > 0 and vy > 0 else float('nan')
    line = [f'{v:14s} corr {corr:+.3f} ms {sum(n_ms)/len(n_ms):6.0f}']
    for z in zs:
        gains = []
        missing = 0
        for i in ids:
            r = roll[i]['res'].get(v)
            if not r:
                continue
            n = r.get('n', roll[i]['n'])
            best = max(range(len(r['mean'])), key=lambda c: (r['mean'][c], -c))
            if best == 0:
                continue
            g, sd = r['gain'][best], r['sd'][best]
            if 'test' in r:
                g, sd = r['test'][0][best], r['test'][1][best]
            if g > 0 and g > z * sd / math.sqrt(n):
                if owin(orc[i], best) is None:
                    missing += 1
                    continue
                gains.append(owin(orc[i], best) - owin(orc[i], 0))
        if gains:
            m = sum(gains) / len(gains)
            sd = math.sqrt(sum((x - m) ** 2 for x in gains) / max(1, len(gains) - 1))
            line.append(f'z{z:g}: {len(gains):4d} dev {m:+.3f}±{sd/math.sqrt(len(gains)):.3f} sum {sum(gains):+6.2f}' + (f' (no oracle: {missing})' if missing else ''))
        else:
            line.append(f'z{z:g}: none')
    print('  '.join(line))
