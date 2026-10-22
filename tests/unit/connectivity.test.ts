import { describe, expect, it } from 'vitest';
import { articulationPoints, chokePoints, chokePointsFast, weakPoints } from '../../src/core/connectivity';

/** undirected adjacency from an edge list */
function graph(n: number, edges: [number, number][]): number[][] {
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const [a, b] of edges) {
    adj[a].push(b);
    adj[b].push(a);
  }
  return adj;
}

describe('choke points', () => {
  it('finds articulation points of a path and none on a ring', () => {
    expect(articulationPoints(graph(4, [[0, 1], [1, 2], [2, 3]]))).toEqual([1, 2]);
    expect(articulationPoints(graph(4, [[0, 1], [1, 2], [2, 3], [3, 0]]))).toEqual([]);
  });

  it('a single bridge cell between two blocks is a choke point; a second link removes it', () => {
    // block A: 0-1-2 triangle, bridge cell 3, block B: 4-5-6 triangle
    const edges: [number, number][] = [[0, 1], [1, 2], [2, 0], [2, 3], [3, 4], [4, 5], [5, 6], [6, 4]];
    expect(chokePoints(graph(7, edges), [0, 6])).toEqual([2, 3, 4]);
    // a second route 1-5 joins the blocks around the bridge
    expect(chokePoints(graph(7, [...edges, [1, 5]]), [0, 6])).toEqual([]);
  });

  it('cuts that do not separate starts are fine', () => {
    // dead-end tail 3 hangs off a ring with both starts on the ring
    const adj = graph(5, [[0, 1], [1, 2], [2, 0], [2, 3], [3, 4]]);
    expect(articulationPoints(adj)).toEqual([2, 3]);
    expect(chokePoints(adj, [0, 1])).toEqual([]);
  });

  it('a start that is the only link between two other starts counts', () => {
    expect(chokePoints(graph(3, [[0, 1], [1, 2]]), [0, 1, 2])).toEqual([1]);
  });
});

describe('linear-time choke points (map generator)', () => {
  /** random connected graph: a random tree plus a few extra edges */
  function randomGraph(rng: () => number, n: number, extra: number): number[][] {
    const edges: [number, number][] = [];
    for (let v = 1; v < n; v++) edges.push([v, Math.floor(rng() * v)]);
    for (let i = 0; i < extra; i++) {
      const a = Math.floor(rng() * n);
      const b = Math.floor(rng() * n);
      if (a !== b) edges.push([a, b]);
    }
    const adj = graph(n, edges);
    return adj.map((l) => [...new Set(l)].sort((a, b) => a - b));
  }

  it('agrees with chokePoints on random connected graphs', () => {
    let s = 12345;
    const rng = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let t = 0; t < 400; t++) {
      const n = 2 + Math.floor(rng() * 40);
      const adj = randomGraph(rng, n, Math.floor(rng() * n));
      const k = 1 + Math.floor(rng() * Math.min(6, n));
      const starts = Array.from({ length: k }, () => Math.floor(rng() * n));
      expect(chokePointsFast(adj, starts)).toEqual(chokePoints(adj, starts));
    }
  });

  it('weakPoints also flags cells that hold a big dead end alone', () => {
    // ring 0-1-2-3, tail 3-4-5-6 hanging on 3; starts on the ring
    const adj = graph(7, [[0, 1], [1, 2], [2, 3], [3, 0], [3, 4], [4, 5], [5, 6]]);
    expect(weakPoints(adj, [0, 2], Infinity)).toEqual([]);
    // pocket of 3 behind cell 3, of 2 behind 4: a limit of 2 flags 3 only, a limit of 1 flags both
    expect(weakPoints(adj, [0, 2], 3)).toEqual([]);
    expect(weakPoints(adj, [0, 2], 2)).toEqual([3]);
    expect(weakPoints(adj, [0, 2], 1)).toEqual([3, 4]);
    // the same with the root start right at the pocket
    expect(weakPoints(adj, [3, 1], 2)).toEqual([3]);
  });
});
