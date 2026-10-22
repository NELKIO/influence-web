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

/**
 * Same result as `chokePoints` for a connected graph, in one depth-first pass (linear time), for the
 * map generator, which checks many candidate maps. Cells not reachable from the starts are ignored.
 */
export function chokePointsFast(adj: number[][], starts: number[]): number[] {
  return weakPoints(adj, starts, Infinity);
}

/**
 * Choke points (as in `chokePoints`) plus cells that alone hold a dead end of more than `maxPocket`
 * cells without a start: a big enough pocket behind a single cell is a fortress whose owner cannot
 * be driven out either (in crowded matches anybody may start there). One depth-first pass from a
 * start; assumes the graph is connected (cells not reachable from the starts are ignored).
 */
export function weakPoints(adj: number[][], starts: number[], maxPocket: number): number[] {
  const uniq = [...new Set(starts)];
  if (!uniq.length) return [];
  const n = adj.length;
  const disc = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const parent = new Int32Array(n).fill(-1);
  /** starts and cells in the DFS subtree of a cell (the cell included) */
  const below = new Int32Array(n);
  const size = new Int32Array(n).fill(1);
  const isCut = new Uint8Array(n);
  for (const s of uniq) below[s] = 1;
  const root = uniq[0];
  // a part cut off by one cell matters when it holds a start or is a big pocket
  const heavy = (u: number) => below[u] > 0 || size[u] > maxPocket;
  let heavyRootKids = 0;
  let time = 0;
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
        stack.push([v, 0]);
      } else if (v !== parent[u]) low[u] = Math.min(low[u], disc[v]);
    } else {
      stack.pop();
      const p = parent[u];
      if (p < 0) continue;
      low[p] = Math.min(low[p], low[u]);
      below[p] += below[u];
      size[p] += size[u];
      if (p === root) {
        if (heavy(u)) heavyRootKids++;
      } else if (low[u] >= disc[p] && heavy(u)) {
        // the subtree of u hangs on p alone; the other side holds the root, which is a start
        isCut[p] = 1;
      }
    }
  }
  // without the root (a start) its subtrees fall apart: bad if two of them matter
  if (heavyRootKids > 1) isCut[root] = 1;
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (isCut[i]) out.push(i);
  return out;
}
