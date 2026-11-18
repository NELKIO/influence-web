import { describe, expect, it } from 'vitest';
import { disjointPaths } from '../../src/core/connectivity';

/** A grid of w × h cells, 4-neighbour links. */
const grid = (w: number, h: number) => Array.from({ length: w * h }, (_, i) => {
  const x = i % w, y = Math.floor(i / w);
  return [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]].filter(([a, b]) => a >= 0 && a < w && b >= 0 && b < h).map(([a, b]) => b * w + a);
});

describe('cell-disjoint paths between two areas', () => {
  it('a band as wide as the grid is crossed by as many paths as it is wide', () => {
    expect(disjointPaths(grid(5, 6), [0, 1, 2, 3, 4], [25, 26, 27, 28, 29])).toBe(5);
  });

  it('a one-cell neck lets one path through; two necks two', () => {
    // two 3×3 rooms joined by a corridor through cell 9
    const adj: number[][] = Array.from({ length: 19 }, () => []);
    const link = (a: number, b: number) => { adj[a].push(b); adj[b].push(a); };
    for (const off of [0, 10]) for (let i = 0; i < 9; i++) { if (i % 3 < 2) link(off + i, off + i + 1); if (i < 6) link(off + i, off + i + 3); }
    link(5, 9); link(9, 13);
    expect(disjointPaths(adj, [0], [18])).toBe(1);
    link(8, 16);
    expect(disjointPaths(adj, [0, 1, 2], [16, 17, 18])).toBe(2);
  });

  it('nothing between parts that do not touch; the count stops at the cap', () => {
    expect(disjointPaths([[1], [0], [3], [2]], [0], [3])).toBe(0);
    expect(disjointPaths(grid(12, 3), [0, 12, 24], [11, 23, 35], 2)).toBe(2);
  });
});
