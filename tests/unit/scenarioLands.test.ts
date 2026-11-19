/**
 * The changing lands of sparks, crossroads and highlands: new silhouettes, not only the hexagon, and
 * never a neck between the players that a couple of cells could shut, nor lace of one-cell corridors.
 */
import { describe, expect, it } from 'vitest';
import { buildScenario, SCENARIO_META, type ScenarioId } from '../../src/core/scenarios';
import { around, disjointPaths } from '../../src/core/connectivity';
import { buildAdjacency, geometricPairs } from '../../src/core/field';
import type { FieldSize, MatchState, PlayerType } from '../../src/core/types';

const players = (id: ScenarioId, n: number) => Array.from({ length: n }, (_, i) => (SCENARIO_META[id].players[i] ?? 'hunter') as PlayerType);

/** Cells within two steps of a set of cells. */
const zone = (adj: number[][], cells: number[]) => [...new Set(cells.flatMap((c) => around(adj, c, 2)))];

/** Narrowest way between seat 0 and every other seat (the symmetries make the other pairs alike). */
function width(st: MatchState, id: ScenarioId, cap: number): number {
  const { adj, cells } = st.field;
  // sparks: every cell belongs to a realm, so the ways run between the sparks
  const home = (seat: number) =>
    id === 'sparks'
      ? [st.objectives!.find((i) => cells[i].owner === seat)!]
      : cells.flatMap((c, i) => (c.owner === seat ? [i] : []));
  const seats = new Set(cells.filter((c) => c.owner >= 0).map((c) => c.owner)).size;
  let w = cap;
  for (let seat = 1; seat < seats; seat++) w = Math.min(w, disjointPaths(adj, zone(adj, home(0)), zone(adj, home(seat)), cap));
  return w;
}

/**
 * Whether the land is (about) the plain hexagon: it fills nine tenths of the hexagon around its centre
 * that reaches its farthest cell (a hexagon with a few bites out of the rim still does).
 */
function hexagonal(st: MatchState): boolean {
  const ax = st.field.cells.map((c) => [c.x - (c.y - (c.y & 1)) / 2, c.y]);
  const n = ax.length;
  const [cq, cr] = [ax.reduce((a, c) => a + c[0], 0) / n, ax.reduce((a, c) => a + c[1], 0) / n];
  const reach = Math.round(Math.max(...ax.map(([q, r]) => Math.max(Math.abs(q - cq), Math.abs(r - cr), Math.abs(q - cq + r - cr)))));
  return n >= 0.9 * (3 * reach * (reach + 1) + 1);
}

const CASES: [ScenarioId, number[]][] = [['sparks', [3]], ['crossroads', [2]], ['highlands', [2, 3, 4, 6]]];

describe('changing lands of sparks, crossroads and highlands', () => {
  for (const [id, seatList] of CASES) {
    it(`${id}: wide ways between the players and land rather than lace, on every size`, () => {
      const sizes = SCENARIO_META[id].configurable!.sizes as FieldSize[];
      for (const n of seatList)
        for (const [g, size] of sizes.entries())
          for (let seed = 1; seed <= 8; seed++) {
            const st = buildScenario(id, seed * 131, undefined, players(id, n), { size });
            const need = 3 + Math.min(g, 1);
            const where = `${id} ${n} seats ${size} seed=${seed * 131}`;
            expect(width(st, id, need), where).toBe(need);
            // (counted on the land itself: walls with passes are terrain, not corridors)
            const land = buildAdjacency(st.field.cells.length, geometricPairs(st.field.w, st.field.cells));
            const thin = land.filter((a) => a.length <= 2).length;
            expect(thin / st.field.cells.length, where).toBeLessThan(0.1);
          }
    }, 60000);

    it(`${id}: most lands are new silhouettes, not the plain hexagon`, () => {
      let plain = 0;
      for (let seed = 1; seed <= 20; seed++) if (hexagonal(buildScenario(id, seed, undefined, players(id, seatList[0])))) plain++;
      expect(plain).toBeLessThanOrEqual(8);
    }, 60000);
  }
});
