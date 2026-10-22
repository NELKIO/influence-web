import { describe, expect, it } from 'vitest';
import { articulationPoints, chokePoints } from '../../src/core/connectivity';

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
