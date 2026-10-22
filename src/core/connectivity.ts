/**
 * Choke points: cells whose loss cuts the players apart. If two start regions are joined only
 * through one cell, the two sides keep taking that cell from each other and neither can win, so
 * generated and scenario maps must not have such cells.
 */

/** Articulation points of the cell graph (iterative Tarjan). */
export function articulationPoints(adj: number[][]): number[] {
  const n = adj.length;
  const disc = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const parent = new Int32Array(n).fill(-1);
  const isCut = new Uint8Array(n);
  let time = 0;
  for (let root = 0; root < n; root++) {
    if (disc[root] >= 0) continue;
    let rootKids = 0;
    const stack: [number, number][] = [[root, 0]];
    disc[root] = low[root] = time++;
    while (stack.length) {
      const top = stack[stack.length - 1];
      const [u, i] = top;
      if (i < adj[u].length) {
        top[1]++;
        const v = adj[u][i];
        if (disc[v] < 0) {
          parent[v] = u;
          disc[v] = low[v] = time++;
          if (u === root) rootKids++;
          stack.push([v, 0]);
        } else if (v !== parent[u]) low[u] = Math.min(low[u], disc[v]);
      } else {
        stack.pop();
        const p = parent[u];
        if (p >= 0) {
          low[p] = Math.min(low[p], low[u]);
          if (p !== root && low[u] >= disc[p]) isCut[p] = 1;
        }
      }
    }
    if (rootKids > 1) isCut[root] = 1;
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (isCut[i]) out.push(i);
  return out;
}

/** Whether all `starts` are reachable from each other without passing through `removed`. */
function startsJoined(adj: number[][], all: number[], removed: number): boolean {
  const starts = all.filter((s) => s !== removed);
  if (starts.length < 2) return true;
  const seen = new Uint8Array(adj.length);
  seen[removed] = 1;
  const queue = [starts[0]];
  seen[starts[0]] = 1;
  while (queue.length) {
    const u = queue.pop()!;
    for (const v of adj[u]) {
      if (!seen[v]) {
        seen[v] = 1;
        queue.push(v);
      }
    }
  }
  return starts.every((s) => seen[s]);
}

/**
 * Cells whose removal separates some of the given starts from the others. A start cell counts too
 * when it is the only link between other starts (once its owner is gone it becomes a choke point).
 * An empty list means every pair of starts is joined by at least two cell-disjoint paths.
 */
export function chokePoints(adj: number[][], starts: number[]): number[] {
  if (starts.length < 2) return [];
  return articulationPoints(adj).filter((c) => !startsJoined(adj, starts, c));
}
