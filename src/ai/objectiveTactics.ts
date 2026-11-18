import { cellsOf, targetsFrom, winChance } from '../core/engine';
import { objectiveCount } from '../core/objectives';
import type { MatchState } from '../core/types';
import type { AttackMove, Bot } from './types';

/** Wall-aware distances to a contested point; no RNG and no search budget. */
function routes(s: MatchState): number[] {
  const { adj, cells } = s.field;
  const queue = s.objectives!.filter(i => cells[i].owner !== s.current);
  const d = cells.map(() => Infinity);
  for (const i of queue) d[i] = 0;
  for (let k = 0; k < queue.length; k++) {
    const i = queue[k];
    for (const n of adj[i]) if (d[n] === Infinity) { d[n] = d[i] + 1; queue.push(n); }
  }
  return d;
}

export function withObjectiveTactics(base: Bot): Bot {
  return {
    type: base.type,
    dispose: () => base.dispose?.(),
    async nextAttack(s, ctx) {
      if (!s.objectives) return base.nextAttack(s, ctx);
      if (s.ended || s.phase !== 'attack') return null;
      const { cells } = s.field, d = routes(s);
      const defending = objectiveCount(s, s.current) >= 2;
      let best: AttackMove | null = null, high = -Infinity;
      for (const from of cellsOf(s, s.current)) for (const to of targetsFrom(s, from)) {
        const chance = winChance(cells[from].power, cells[to].power);
        if (!chance || (defending && s.objectives.includes(from))) continue;
        const point = d[to] === 0;
        const threat = defending && chance >= 0.75 && cells[to].owner >= 0 && s.field.adj[to].some(i =>
          s.objectives!.includes(i) && cells[i].owner === s.current && winChance(cells[to].power, cells[i].power) > 0,
        );
        if (!point && !threat && (defending || d[to] >= d[from] || chance < 0.75)) continue;
        const breaksHold = point && cells[to].owner === s.objectiveHolder;
        const score = (breaksHold ? 10000 : threat ? 2000 : point ? 1000 : 0) + 100 * chance - 5 * d[to] + cells[from].power;
        if (score > high) { high = score; best = { from, to }; }
      }
      return best ?? (defending ? null : base.nextAttack(s, ctx));
    },
    async placePower(s, ctx) {
      if (!s.objectives) return base.placePower(s, ctx);
      const { cells, adj } = s.field, d = routes(s);
      const priority = (i: number) => {
        const border = adj[i].some(j => cells[j].owner !== s.current);
        const threatened = adj[i].some(j => cells[j].owner >= 0 && cells[j].owner !== s.current);
        if (threatened && s.objectives!.includes(i)) return 1000;
        return border ? 500 - Math.min(400, d[i]) : 0;
      };
      const ranked = cellsOf(s, s.current).map(i => ({ i, rank: priority(i) })).sort((a, b) => b.rank - a.rank || a.i - b.i);
      const adds = new Map<number, number>();
      let left = s.powerLeft;
      for (const { i } of ranked) {
        if (!left) break;
        const n = Math.min(left, cells[i].maxPower - cells[i].power);
        if (n > 0) { adds.set(i, n); left -= n; }
      }
      return adds;
    },
  };
}
