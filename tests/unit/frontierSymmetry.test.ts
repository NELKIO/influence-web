/**
 * Frontier points on a symmetric map are placed symmetrically: whatever the map's symmetry does to the
 * seats, it does to the points, so nobody has the points nearer than another seat.
 */
import { describe, expect, it } from 'vitest';
import { startMatch } from '../../src/core/scenarios';
import { fieldSymmetries } from '../../src/core/objectives';
import type { FieldSize, MatchSettings, MatchState } from '../../src/core/types';

const battle = (size: FieldSize, n: number, points: number, symmetry = true): MatchSettings => ({
  kind: 'single', size, players: ['human', ...Array.from({ length: n - 1 }, () => 'hunter' as const)],
  darkness: false, symmetry, crowded: false, unions: false, shuffle: false, duelRules: false,
  frontierMode: true, frontierPointCount: points,
});

const dist = (adj: number[][], from: number) => {
  const d = Array<number>(adj.length).fill(Infinity); d[from] = 0;
  const q = [from];
  for (const i of q) for (const j of adj[i]) if (d[j] === Infinity) { d[j] = d[i] + 1; q.push(j); }
  return d;
};
/** Per seat: the distances from its start to the points, sorted. */
const profile = (st: MatchState) => st.settings.players.map((_, seat) => {
  const d = dist(st.field.adj, st.field.cells.findIndex((c) => c.owner === seat));
  return st.objectives!.map((i) => d[i]).sort((a, b) => a - b);
});
/** How many points the map's symmetry does not keep among the points. */
const strays = (st: MatchState) => {
  const set = new Set(st.objectives);
  return st.objectives!.filter((i) => fieldSymmetries(st.field).some((g) => !set.has(g[i]))).length;
};

describe('frontier points on symmetric maps', () => {
  it('a symmetric map has a symmetry for every seat: each start goes to each other start', () => {
    for (const size of ['M', 'L', 'XL'] as FieldSize[]) for (const n of [2, 3, 4, 6]) for (const seed of [1, 2, 3, 4]) {
      const st = startMatch(battle(size, n, 3), seed);
      const g = fieldSymmetries(st.field);
      const s0 = st.field.cells.findIndex((c) => c.owner === 0);
      const images = new Set(g.map((p) => st.field.cells[p[s0]].owner));
      expect(images.size, `${size} ${n} players, seed ${seed}`).toBe(n);
    }
  });

  it('as many points as players: one orbit, every seat has the same distances to them', () => {
    for (const size of ['M', 'L', 'XL'] as FieldSize[]) for (const n of [2, 3, 4, 6]) for (const seed of [1, 2, 3, 4, 5, 6]) {
      const st = startMatch(battle(size, n, n), seed);
      expect(strays(st), `${size} ${n} players, seed ${seed}`).toBe(0);
      const p = profile(st);
      for (const seat of p) expect(seat, `${size} ${n} players, seed ${seed}`).toEqual(p[0]);
    }
  });

  it('any count that the symmetry allows is placed exactly symmetric', () => {
    for (const size of ['M', 'L', 'XL'] as FieldSize[]) for (const n of [2, 4]) for (let k = 2; k <= 9; k += 2) for (const seed of [1, 2, 3]) {
      const st = startMatch(battle(size, n, k), seed);
      expect(st.objectives).toHaveLength(k);
      expect(strays(st), `${size} ${n} players, ${k} points, seed ${seed}`).toBe(0);
      const p = profile(st);
      for (const seat of p) expect(seat).toEqual(p[0]);
    }
  });

  it('an odd count on a two-seat map: the pairs are symmetric, the odd point is as far from both', () => {
    for (const size of ['M', 'L', 'XL'] as FieldSize[]) for (const k of [3, 5, 7]) for (const seed of [1, 2, 3, 4]) {
      const st = startMatch(battle(size, 2, k), seed);
      expect(strays(st)).toBeLessThanOrEqual(1);
      const p = profile(st);
      const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
      // some maps have no cell equally far from both starts: then the odd point is one step off
      const [d0, d1] = [0, 1].map((seat) => dist(st.field.adj, st.field.cells.findIndex((c) => c.owner === seat)));
      const even = st.field.cells.some((c, i) => c.owner < 0 && d0[i] === d1[i] && st.field.adj[i].length >= 2);
      if (even) expect(p[0], `${size} ${k} points, seed ${seed}`).toEqual(p[1]);
      else expect(Math.abs(sum(p[0]) - sum(p[1]))).toBeLessThanOrEqual(1);
    }
  });

  it('an asymmetric map has no symmetry but the identity', () => {
    const st = startMatch(battle('L', 4, 4, false), 7);
    expect(fieldSymmetries(st.field)).toHaveLength(1);
    expect(st.objectives).toHaveLength(4);
  });
});
