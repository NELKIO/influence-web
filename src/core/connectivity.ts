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

/** Cells within `radius` steps of `from` (the cell itself included). */
export function around(adj: number[][], from: number, radius: number): number[] {
  const d = new Map<number, number>([[from, 0]]);
  const queue = [from];
  for (const i of queue) if (d.get(i)! < radius) for (const j of adj[i]) if (!d.has(j)) { d.set(j, d.get(i)! + 1); queue.push(j); }
  return queue;
}

/**
 * The narrowest place between two start regions (the cells within two steps of each start): how many
 * cells an owner must hold to shut the way between them. Below three, one side walls itself in with a
 * couple of strong cells and the match stalls. Counting stops at `cap`.
 */
export function startsWidth(adj: number[][], starts: number[], cap = Infinity): number {
  const zones = [...new Set(starts)].map((s) => around(adj, s, 2));
  let width = cap;
  for (let a = 0; a < zones.length; a++)
    for (let b = a + 1; b < zones.length; b++) width = Math.min(width, disjointPaths(adj, zones[a], zones[b], width));
  return width;
}

/**
 * How many paths with no cell in common lead from area `from` to area `to` (the cells of the areas
 * themselves may be shared): the width of the narrowest place between them (Menger). Counting stops
 * at `cap`.
 */
export function disjointPaths(adj: number[][], from: number[], to: number[], cap = Infinity): number {
  const n = adj.length;
  const S = 2 * n, T = 2 * n + 1;
  const wide = Math.max(1, from.length + to.length) * n;
  // every cell is split in two (in = 2i, out = 2i + 1) joined by an edge of capacity one (area cells:
  // unlimited); links go out -> in. Edges are stored in pairs: e and e ^ 1 is its reverse.
  const head: number[] = [], next: number[] = [], room: number[] = [];
  const first = new Int32Array(2 * n + 2).fill(-1);
  const edge = (a: number, b: number, c: number) => {
    for (const [u, v, w] of [[a, b, c], [b, a, 0]]) {
      head.push(v); room.push(w); next.push(first[u]); first[u] = head.length - 1;
    }
  };
  const inArea = new Uint8Array(n);
  for (const i of from) inArea[i] = 1;
  for (const i of to) inArea[i] = 1;
  for (let i = 0; i < n; i++) edge(2 * i, 2 * i + 1, inArea[i] ? wide : 1);
  for (let i = 0; i < n; i++) for (const j of adj[i]) edge(2 * i + 1, 2 * j, wide);
  for (const i of from) edge(S, 2 * i, wide);
  for (const i of to) edge(2 * i + 1, T, wide);
  let paths = 0;
  const via = new Int32Array(2 * n + 2);
  while (paths < cap) {
    via.fill(-1);
    via[S] = -2;
    const queue = [S];
    for (let h = 0; h < queue.length && via[T] === -1; h++)
      for (let e = first[queue[h]]; e !== -1; e = next[e])
        if (room[e] > 0 && via[head[e]] === -1) { via[head[e]] = e; queue.push(head[e]); }
    if (via[T] === -1) break;
    for (let v = T; v !== S; v = head[via[v] ^ 1]) { room[via[v]]--; room[via[v] ^ 1]++; }
    paths++;
    if (paths >= wide) return cap;
  }
  return paths;
}
