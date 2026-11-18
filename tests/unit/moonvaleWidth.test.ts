/** The moonless valley has no thin isthmus between two camps: a narrow neck is held for ever. */
import { describe, expect, it } from 'vitest';
import { buildScenario } from '../../src/core/scenarios';
import { disjointPaths } from '../../src/core/connectivity';
import type { Field, FieldSize } from '../../src/core/types';

/** The ground two steps around a seat's camp (its group of cells, not the lone scout). */
const zone = (f: Field, seat: number) => {
  const camp = f.cells.flatMap((c, i) => c.owner === seat && f.adj[i].some((j) => f.cells[j].owner === seat) ? [i] : []);
  const d = new Map<number, number>(camp.map((i) => [i, 0]));
  const q = [...camp];
  for (const i of q) if (d.get(i)! < 2) for (const j of f.adj[i]) if (!d.has(j)) { d.set(j, d.get(i)! + 1); q.push(j); }
  return q;
};

describe('the moonless valley is wide between every two camps', () => {
  for (const size of ['L', 'XL', 'XXL'] as FieldSize[]) it(`${size}: at least ${size === 'L' ? 4 : 5} separate ways`, () => {
    for (const seats of [2, 3, 4, 5, 6]) for (let seed = 1; seed <= 12; seed++) {
      const f = buildScenario('moonvale', seed, undefined, ['human', ...Array(seats - 1).fill('master')], { size }).field;
      for (let a = 0; a < seats; a++) for (let b = a + 1; b < seats; b++)
        expect(disjointPaths(f.adj, zone(f, a), zone(f, b)), `${size}, ${seats} seats, seed ${seed}, camps ${a}-${b}`).toBeGreaterThanOrEqual(size === 'L' ? 4 : 5);
    }
  }, 60000);
});
