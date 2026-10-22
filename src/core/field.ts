import { weakPoints } from './connectivity';
import { Rng } from './rng';
import { NEUTRAL, SIZES, type Cell, type Field, type FieldSize } from './types';

/** Odd-r offset hex grid: odd rows are shifted right by half a cell and have one column less. */
export function rowWidth(w: number, y: number): number {
  return y % 2 === 1 ? w - 1 : w;
}

export function inGrid(w: number, h: number, x: number, y: number): boolean {
  return y >= 0 && y < h && x >= 0 && x < rowWidth(w, y);
}

export function hexNeighbours(x: number, y: number): [number, number][] {
  return y % 2 === 0
    ? [[x - 1, y], [x + 1, y], [x - 1, y - 1], [x, y - 1], [x - 1, y + 1], [x, y + 1]]
    : [[x - 1, y], [x + 1, y], [x, y - 1], [x + 1, y - 1], [x, y + 1], [x + 1, y + 1]];
}

export function rollMaxPower(rng: Rng): number {
  return rng.float() < 0.3 ? 12 : 8;
}

/** Index lookup grid id -> cell index (or -1). */
export function idIndex(field: Field): Int32Array {
  const m = new Int32Array(field.w * field.h).fill(-1);
  field.cells.forEach((c, i) => (m[c.id] = i));
  return m;
}

interface Slots {
  w: number;
  h: number;
  /** 0 = empty, otherwise maxPower */
  cap: Int32Array;
}

function newSlots(w: number, h: number): Slots {
  return { w, h, cap: new Int32Array(w * h) };
}

function place(s: Slots, x: number, y: number, mp: number): boolean {
  if (!inGrid(s.w, s.h, x, y)) return false;
  const id = y * s.w + x;
  if (s.cap[id] !== 0) return false;
  s.cap[id] = mp;
  return true;
}

/** Empty in-grid slots adjacent to at least one placed cell. */
function frontier(s: Slots): number[] {
  const out: number[] = [];
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < rowWidth(s.w, y); x++) {
      const id = y * s.w + x;
      if (s.cap[id] !== 0) continue;
      for (const [nx, ny] of hexNeighbours(x, y)) {
        if (inGrid(s.w, s.h, nx, ny) && s.cap[ny * s.w + nx] !== 0) {
          out.push(id);
          break;
        }
      }
    }
  }
  return out;
}

function growRandom(s: Slots, target: number, rng: Rng) {
  place(s, Math.floor(s.w / 2), Math.floor(s.h / 2), rollMaxPower(rng));
  for (let i = 0; i < target; i++) {
    const f = frontier(s);
    if (!f.length) break;
    const id = rng.pick(f);
    place(s, id % s.w, Math.floor(id / s.w), rollMaxPower(rng));
  }
}

export function mirror(w: number, h: number, x: number, y: number): [number, number] {
  const my = h - 1 - y;
  return [w - 1 - x - (my % 2 === 1 ? 1 : 0), my];
}

function placeMirrored(s: Slots, x: number, y: number, mp: number) {
  const [mx, my] = mirror(s.w, s.h, x, y);
  place(s, x, y, mp);
  place(s, mx, my, mp);
  place(s, x, my, mp);
  // horizontal mirror within the same row
  place(s, rowWidth(s.w, y) - 1 - x, y, mp);
}

function growSymmetric(s: Slots, target: number, rng: Rng) {
  const { w, h } = s;
  const seeds: [number, number][] = [
    [Math.floor(w / 2) - 1, Math.floor(h / 2) - 1],
    [Math.floor(w / 2), Math.floor(h / 2)],
    [0, Math.floor(h / 2)],
    [Math.floor(w / 2), 1],
    [rng.int(Math.max(1, Math.floor(w / 2))), rng.int(Math.max(1, Math.floor(h / 2)))],
  ];
  const [sx, sy] = rng.pick(seeds);
  placeMirrored(s, sx, sy, rollMaxPower(rng));
  const groups = Math.floor(target / 4);
  for (let placed = 0; placed < groups; placed++) {
    const f = frontier(s);
    if (!f.length) break;
    const id = rng.pick(f);
    placeMirrored(s, id % w, Math.floor(id / w), rollMaxPower(rng));
  }
}

/** Reject thin, stringy maps: after dropping k outer rows/cols, every remaining row/col must have > k cells. */
function edgeCriteriaOk(cells: Cell[], k: number): boolean {
  const check = (vals: number[]) => {
    const count = new Map<number, number>();
    for (const v of vals) count.set(v, (count.get(v) ?? 0) + 1);
    const keys = [...count.keys()].sort((a, b) => a - b);
    const inner = keys.slice(k, keys.length - k);
    if (!inner.length) return true;
    return Math.min(...inner.map((key) => count.get(key)!)) > k;
  };
  return check(cells.map((c) => c.x)) && check(cells.map((c) => c.y));
}

function buildCells(s: Slots): Cell[] {
  const cells: Cell[] = [];
  for (let x = 0; x < s.w; x++) {
    for (let y = 0; y < s.h; y++) {
      const id = y * s.w + x;
      if (s.cap[id] > 0) cells.push({ id, x, y, power: 0, maxPower: s.cap[id], owner: NEUTRAL });
    }
  }
  return cells;
}

/** All hex-adjacent pairs (i < j) by cell index. */
export function geometricPairs(w: number, cells: Cell[]): [number, number][] {
  const idx = new Map<number, number>();
  cells.forEach((c, i) => idx.set(c.id, i));
  const pairs: [number, number][] = [];
  cells.forEach((c, i) => {
    for (const [nx, ny] of hexNeighbours(c.x, c.y)) {
      if (nx < 0 || ny < 0 || nx >= w) continue;
      const j = idx.get(ny * w + nx);
      if (j !== undefined && j > i && cells[j].x === nx) pairs.push([i, j]);
    }
  });
  return pairs;
}

export function buildAdjacency(n: number, pairs: [number, number][]): number[][] {
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const [a, b] of pairs) {
    adj[a].push(b);
    adj[b].push(a);
  }
  for (const list of adj) list.sort((a, b) => a - b);
  return adj;
}

function pairKey(a: number, b: number) {
  return a < b ? a * 100000 + b : b * 100000 + a;
}

/** Random walls: ~20% of the links that are not needed for connectivity. */
function makeWalls(n: number, pairs: [number, number][], rng: Rng): [number, number][] {
  const adj = buildAdjacency(n, pairs);
  const tree = new Set<number>();
  const seen = new Uint8Array(n);
  const stack = [0];
  seen[0] = 1;
  while (stack.length) {
    const v = stack.pop()!;
    for (const u of adj[v]) {
      if (!seen[u]) {
        seen[u] = 1;
        tree.add(pairKey(v, u));
        stack.push(u);
      }
    }
  }
  return pairs.filter(([a, b]) => !tree.has(pairKey(a, b)) && rng.float() < 0.2);
}

function nonAdjacent(adj: number[][], chosen: number[], c: number): boolean {
  if (chosen.includes(c)) return false;
  return !adj[c].some((n) => chosen.includes(n));
}

function randomStarts(adj: number[][], n: number, rng: Rng): number[] | null {
  const out: number[] = [];
  for (let i = 0; i < 6; i++) {
    const options: number[] = [];
    for (let c = 0; c < n; c++) if (nonAdjacent(adj, out, c)) options.push(c);
    if (!options.length) return null;
    out.push(rng.pick(options));
  }
  return out;
}

function symmetricStarts(w: number, h: number, cells: Cell[], adj: number[][], rng: Rng): number[] | null {
  const idx = new Map<number, number>();
  cells.forEach((c, i) => idx.set(c.id, i));
  const at = (x: number, y: number) => idx.get(y * w + x);
  const quadrant = cells.filter((c) => c.x < Math.max(1, Math.floor(w / 2) - 1) && c.y < Math.max(1, Math.floor(h / 2) - 1));
  const candidates = quadrant.length ? quadrant : cells.filter((c) => c.x < w / 2 && c.y < h / 2);
  for (let attempt = 0; attempt < 30 && candidates.length; attempt++) {
    const c = rng.pick(candidates);
    const [mx, my] = mirror(w, h, c.x, c.y);
    const four = [at(c.x, c.y), at(mx, my), at(c.x, my), at(rowWidth(w, c.y) - 1 - c.x, c.y)];
    if (four.some((v) => v === undefined)) continue;
    const arr: number[] = [];
    let ok = true;
    for (const v of four as number[]) {
      if (!nonAdjacent(adj, arr, v)) {
        ok = false;
        break;
      }
      arr.push(v);
    }
    if (!ok) continue;
    const options: number[] = [];
    for (let i = 0; i < cells.length; i++) if (nonAdjacent(adj, arr, i)) options.push(i);
    if (!options.length) continue;
    // prefer a centre-ish fifth start
    options.sort((a, b) => centreDist(w, h, cells[a]) - centreDist(w, h, cells[b]));
    arr.push(options[rng.int(Math.min(3, options.length))]);
    return arr;
  }
  return null;
}

function centreDist(w: number, h: number, c: Cell) {
  const px = c.x + (c.y % 2 ? 0.5 : 0) - (w - 1) / 2;
  const py = c.y - (h - 1) / 2;
  return px * px + py * py;
}

export interface GenerateOptions {
  size: FieldSize;
  symmetry: boolean;
  /** number of players: symmetric maps for 3 and 5 players use rotational layouts */
  players?: number;
  /** force a rotational layout family */
  layout?: RotLayout;
}

/**
 * Generate a connected map with 5 (mirrored) or 6 (random, six-ray) start positions. Deterministic
 * for a given rng state. No single cell separates any of the starts from the others, and no dead end
 * bigger than MAX_POCKET hangs on a single cell (see connectivity.ts): such narrow links are widened
 * or doubled before the map is returned.
 */
export function generateField(opts: GenerateOptions, rng: Rng): Field {
  if (opts.symmetry && opts.players === 3) return generateRotational(opts.size, 3, rng, opts.layout);
  if (opts.symmetry && (opts.players === 5 || opts.players === 6)) return generateRotational(opts.size, 6, rng, opts.layout);
  const info = SIZES[opts.size];
  const lat = gridLattice(info.w, info.h, opts.symmetry);
  let fallback: Field | null = null;
  for (let attempt = 0; attempt < 60; attempt++) {
    const s = newSlots(info.w, info.h);
    if (opts.symmetry) growSymmetric(s, info.cells, rng);
    else growRandom(s, info.cells, rng);
    const cells = buildCells(s);
    const pairs = geometricPairs(info.w, cells);
    const walls = opts.symmetry ? [] : makeWalls(cells.length, pairs, rng);
    const wallKeys = new Set(walls.map(([a, b]) => pairKey(a, b)));
    const adj = buildAdjacency(cells.length, pairs.filter(([a, b]) => !wallKeys.has(pairKey(a, b))));
    const starts = opts.symmetry ? symmetricStarts(info.w, info.h, cells, adj, rng) : randomStarts(adj, cells.length, rng);
    if (!starts) continue;
    let field: Field | null = { size: opts.size, w: info.w, h: info.h, cells, adj, walls, starts };
    if (!isConnected(field)) continue;
    if (weakPoints(adj, starts, MAX_POCKET).length) {
      field = repairField(field, lat, rng);
      if (!field) continue;
    }
    fallback ??= field;
    if (edgeCriteriaOk(field.cells, info.edgeK)) return field;
  }
  if (fallback) return fallback;
  throw new Error('map generation failed');
}

// ---------------------------------------------------------------- choke point repair
//
// A choke point is a cell whose loss cuts some start regions off from the others; whoever holds it
// can be thrown out and come back forever. The same goes for a big dead end behind a single cell.
// The repair works on hex slots (cells and empty places around them): for such a cell it finds the
// cheapest detour around it, from the part on one side to a part that matters (with a start, or a
// big pocket) on the other, adds the empty slots on the detour (and opens walls on it), and repeats
// until no such cell is left. Along a one-cell chain this lays a second chain next to the first, i.e.
// widens the link. Additions are whole symmetry orbits, so symmetric maps stay exactly symmetric.
// Mirrored and random maps are then trimmed back to their size at the rim; rotational maps carve
// their holes afterwards, never creating a choke point again.

/**
 * Biggest dead end that may hang on a single cell. Income is one point per cell, so a smaller pocket
 * cannot keep refilling its entrance against an attacker; a bigger one can, and the fight for the
 * entrance never ends (in crowded matches anybody may own such a pocket from the start).
 */
const MAX_POCKET = 5;

interface Lattice {
  /** geometric neighbours of every slot that lie inside the lattice */
  nbrs: number[][];
  /** slots the map's symmetry maps onto each other (the slot itself included) */
  orbit(slot: number): number[];
}

interface Work {
  lat: Lattice;
  /** per slot: 0 = empty, otherwise maxPower */
  cap: Int32Array;
  /** walls as pairKey of two slots */
  walls: Set<number>;
  /** start slots */
  starts: number[];
  /** biggest dead end (cells without a start) that may hang on a single cell */
  pocket: number;
  /** when set: no slot outside this (ascending) list is present, which speeds up the checks */
  universe?: number[];
  /** reusable arrays for workSound */
  scratch?: Record<'disc' | 'low' | 'parent' | 'below' | 'size' | 'stack' | 'iter', Int32Array>;
}

interface SlotGraph {
  /** cell index -> slot */
  slots: number[];
  /** slot -> cell index or -1 */
  index: Int32Array;
  adj: number[][];
}

function gridLattice(w: number, h: number, mirrored: boolean): Lattice {
  const nbrs: number[][] = Array.from({ length: w * h }, () => []);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < rowWidth(w, y); x++)
      for (const [nx, ny] of hexNeighbours(x, y)) if (inGrid(w, h, nx, ny)) nbrs[y * w + x].push(ny * w + nx);
  const orbit = (slot: number) => {
    if (!mirrored) return [slot];
    const x = slot % w;
    const y = Math.floor(slot / w);
    const [mx, my] = mirror(w, h, x, y);
    const out = [slot];
    for (const [ox, oy] of [[mx, my], [x, my], [rowWidth(w, y) - 1 - x, y]]) {
      const o = oy * w + ox;
      if (!out.includes(o)) out.push(o);
    }
    return out;
  };
  return { nbrs, orbit };
}

function slotGraph(work: Work): SlotGraph {
  const { cap, walls, lat } = work;
  const slots: number[] = [];
  const index = new Int32Array(cap.length).fill(-1);
  const add = (s: number) => {
    if (cap[s] > 0) {
      index[s] = slots.length;
      slots.push(s);
    }
  };
  if (work.universe) for (const s of work.universe) add(s);
  else for (let s = 0; s < cap.length; s++) add(s);
  const noWalls = walls.size === 0;
  const adj = slots.map((s) => {
    const out: number[] = [];
    for (const t of lat.nbrs[s]) if (index[t] >= 0 && (noWalls || !walls.has(pairKey(s, t)))) out.push(index[t]);
    return out.sort((a, b) => a - b);
  });
  return { slots, index, adj };
}

/** Restrict the checks to the slots present now (valid while cells are only removed). */
function freezeUniverse(work: Work) {
  work.universe = [];
  for (let s = 0; s < work.cap.length; s++) if (work.cap[s]) work.universe.push(s);
}

function weakOf(work: Work, g: SlotGraph): number[] {
  return weakPoints(g.adj, work.starts.map((s) => g.index[s]), work.pocket);
}

/**
 * Connected, no cell separates the starts and no big dead end hangs on a single cell: `weakPoints`
 * run straight on the slots (no graph is built), as carving and trimming call it for every orbit.
 */
function workSound(work: Work): boolean {
  const { cap, lat, walls, pocket } = work;
  const n = cap.length;
  const sc = (work.scratch ??= {
    disc: new Int32Array(n),
    low: new Int32Array(n),
    parent: new Int32Array(n),
    below: new Int32Array(n),
    size: new Int32Array(n),
    stack: new Int32Array(n),
    iter: new Int32Array(n),
  });
  const { disc, low, parent, below, size, stack, iter } = sc;
  disc.fill(-1);
  below.fill(0);
  for (const s of work.starts) below[s] = 1;
  const root = work.starts[0];
  if (!cap[root]) return false;
  const noWalls = walls.size === 0;
  let sp = 0;
  stack[sp++] = root;
  disc[root] = low[root] = 0;
  parent[root] = -1;
  size[root] = 1;
  iter[root] = 0;
  let time = 1;
  let heavyRootKids = 0;
  while (sp > 0) {
    const u = stack[sp - 1];
    const nb = lat.nbrs[u];
    if (iter[u] < nb.length) {
      const v = nb[iter[u]++];
      if (!cap[v] || (!noWalls && walls.has(pairKey(u, v)))) continue;
      if (disc[v] < 0) {
        parent[v] = u;
        disc[v] = low[v] = time++;
        size[v] = 1;
        iter[v] = 0;
        stack[sp++] = v;
      } else if (v !== parent[u] && disc[v] < low[u]) low[u] = disc[v];
    } else {
      sp--;
      const p = parent[u];
      if (p < 0) continue;
      if (low[u] < low[p]) low[p] = low[u];
      below[p] += below[u];
      size[p] += size[u];
      const heavy = below[u] > 0 || size[u] > pocket;
      if (p === root) {
        if (heavy) heavyRootKids++;
      } else if (heavy && low[u] >= disc[p]) return false;
    }
  }
  if (heavyRootKids > 1) return false;
  // connected: the search reached every cell
  let present = 0;
  if (work.universe) for (const s of work.universe) present += cap[s] ? 1 : 0;
  else for (let s = 0; s < n; s++) present += cap[s] ? 1 : 0;
  return present === time;
}

/** Minimal binary heap of [priority, value] for the detour search. */
class Heap {
  private p: number[] = [];
  private v: number[] = [];
  get size() {
    return this.p.length;
  }
  push(pr: number, val: number) {
    const { p, v } = this;
    let i = p.length;
    p.push(pr);
    v.push(val);
    while (i > 0) {
      const j = (i - 1) >> 1;
      if (p[j] <= pr) break;
      p[i] = p[j];
      v[i] = v[j];
      i = j;
    }
    p[i] = pr;
    v[i] = val;
  }
  pop(): [number, number] {
    const { p, v } = this;
    const top: [number, number] = [p[0], v[0]];
    const lp = p.pop()!;
    const lv = v.pop()!;
    if (p.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= p.length) break;
        if (c + 1 < p.length && p[c + 1] < p[c]) c++;
        if (p[c] >= lp) break;
        p[i] = p[c];
        v[i] = v[c];
        i = c;
      }
      p[i] = lp;
      v[i] = lv;
    }
    return top;
  }
}

/**
 * Detour around choke cell `c`: from the smallest start region left when `c` is gone to any other
 * start region, through existing cells (free), empty slots (cost ~1 each) and walls (cost 1 each).
 * Adds the detour's slots (as orbits) and opens its walls. False if there is no detour.
 */
function bypass(work: Work, g: SlotGraph, c: number, rng: Rng): boolean {
  const { lat, cap, walls } = work;
  const n = g.slots.length;
  const comp = new Int32Array(n).fill(-1);
  comp[c] = -2;
  const compSize: number[] = [];
  for (let s = 0; s < n; s++) {
    if (comp[s] !== -1) continue;
    const id = compSize.length;
    let size = 0;
    const stack = [s];
    comp[s] = id;
    while (stack.length) {
      const u = stack.pop()!;
      size++;
      for (const v of g.adj[u]) if (comp[v] === -1) (comp[v] = id), stack.push(v);
    }
    compSize.push(size);
  }
  // parts that matter: those with a start and dead ends too big to hang on one cell
  const heavy = compSize.map((size) => size > work.pocket);
  const isStart = new Uint8Array(cap.length);
  for (const s of work.starts) {
    isStart[s] = 1;
    const i = g.index[s];
    if (i !== c) heavy[comp[i]] = true;
  }
  let from = -1;
  for (let id = 0; id < compSize.length; id++) if (heavy[id] && (from < 0 || compSize[id] < compSize[from])) from = id;
  if (from < 0) return false;

  const cSlot = g.slots[c];
  const dist = new Float64Array(cap.length).fill(Infinity);
  const prev = new Int32Array(cap.length).fill(-1);
  const heap = new Heap();
  for (let i = 0; i < n; i++) {
    if (comp[i] === from) {
      dist[g.slots[i]] = 0;
      heap.push(0, g.slots[i]);
    }
  }
  // a little noise so detours do not always bend the same way
  const noise = new Float64Array(cap.length);
  for (let s = 0; s < cap.length; s++) noise[s] = rng.float() * 0.3;
  let goal = -1;
  while (heap.size) {
    const [d, u] = heap.pop();
    if (d > dist[u]) continue;
    const ui = g.index[u];
    if (ui >= 0 && comp[ui] >= 0 && comp[ui] !== from && heavy[comp[ui]]) {
      goal = u;
      break;
    }
    for (const v of lat.nbrs[u]) {
      if (v === cSlot) continue;
      let cost = cap[v] ? 0 : 1 + noise[v];
      if (cap[u] && cap[v] && walls.has(pairKey(u, v))) {
        // never open a wall between two start cells: they must not touch
        if (isStart[u] && isStart[v]) continue;
        cost += 1;
      }
      if (d + cost < dist[v]) {
        dist[v] = d + cost;
        prev[v] = u;
        heap.push(d + cost, v);
      }
    }
  }
  if (goal < 0) return false;
  for (let v = goal; prev[v] >= 0; v = prev[v]) {
    const u = prev[v];
    if (!cap[u]) {
      const mp = rollMaxPower(rng);
      for (const o of lat.orbit(u)) if (!cap[o]) cap[o] = mp;
    }
    walls.delete(pairKey(u, v));
  }
  return true;
}

/** Widen or double every link that a single cell holds; false if that is not possible. */
function repairChokes(work: Work, rng: Rng, maxSteps = 80): boolean {
  work.universe = undefined;
  for (let step = 0; step < maxSteps; step++) {
    const g = slotGraph(work);
    const chokes = weakOf(work, g);
    if (!chokes.length) return true;
    if (!bypass(work, g, chokes[rng.int(chokes.length)], rng)) return false;
  }
  return false;
}

/**
 * Remove rim orbits (cells with at most 3 neighbours) until the map has `count` cells, never
 * touching starts or `keep` slots, never cutting the map apart or creating a choke point.
 */
function trimRim(work: Work, count: number, keep: Uint8Array, rng: Rng) {
  const { cap, lat } = work;
  const isStart = new Uint8Array(cap.length);
  for (const s of work.starts) isStart[s] = 1;
  let present = 0;
  for (let s = 0; s < cap.length; s++) if (cap[s]) present++;
  freezeUniverse(work);
  while (present > count) {
    const cands: number[][] = [];
    for (let s = 0; s < cap.length; s++) {
      if (!cap[s] || keep[s] || isStart[s]) continue;
      const orb = lat.orbit(s);
      if (Math.min(...orb) !== s || present - orb.length < count) continue;
      if (orb.some((o) => isStart[o] || keep[o] || lat.nbrs[o].filter((t) => cap[t]).length > 3)) continue;
      cands.push(orb);
    }
    let removed = false;
    for (const orb of rng.shuffle(cands)) {
      const saved = orb.map((o) => cap[o]);
      for (const o of orb) cap[o] = 0;
      if (workSound(work)) {
        present -= orb.length;
        removed = true;
        break;
      }
      orb.forEach((o, i) => (cap[o] = saved[i]));
    }
    if (!removed) break;
  }
}

/** Repair a mirrored or random field (see above); null if it cannot be repaired. */
function repairField(field: Field, lat: Lattice, rng: Rng): Field | null {
  const { w } = field;
  const cap = new Int32Array(w * field.h);
  for (const c of field.cells) cap[c.id] = c.maxPower;
  const work: Work = {
    lat,
    cap,
    walls: new Set(field.walls.map(([a, b]) => pairKey(field.cells[a].id, field.cells[b].id))),
    starts: field.starts.map((i) => field.cells[i].id),
    pocket: MAX_POCKET,
  };
  const before = new Uint8Array(cap.length);
  for (const c of field.cells) before[c.id] = 1;
  if (!repairChokes(work, rng)) return null;
  // give the added cells back at the rim, keeping the detours (they are what fixed the map)
  const keep = new Uint8Array(cap.length);
  for (let s = 0; s < cap.length; s++) if (cap[s] && !before[s]) keep[s] = 1;
  trimRim(work, field.cells.length, keep, rng);

  const cells: Cell[] = [];
  for (let x = 0; x < w; x++)
    for (let y = 0; y < field.h; y++) {
      const id = y * w + x;
      if (cap[id]) cells.push({ id, x, y, power: 0, maxPower: cap[id], owner: NEUTRAL });
    }
  const idx = new Map(cells.map((c, i) => [c.id, i]));
  const pairs = geometricPairs(w, cells);
  const walls = pairs.filter(([a, b]) => work.walls.has(pairKey(cells[a].id, cells[b].id)));
  const wallKeys = new Set(walls.map(([a, b]) => pairKey(a, b)));
  const adj = buildAdjacency(cells.length, pairs.filter(([a, b]) => !wallKeys.has(pairKey(a, b))));
  const starts = work.starts.map((s) => idx.get(s)!);
  const out: Field = { ...field, cells, adj, walls, starts };
  return isConnected(out) && !weakPoints(adj, starts, MAX_POCKET).length ? out : null;
}

export function isConnected(field: Field): boolean {
  const n = field.cells.length;
  if (!n) return false;
  const seen = new Uint8Array(n);
  const stack = [0];
  seen[0] = 1;
  let count = 1;
  while (stack.length) {
    const v = stack.pop()!;
    for (const u of field.adj[v]) {
      if (!seen[u]) {
        seen[u] = 1;
        count++;
        stack.push(u);
      }
    }
  }
  return count === n;
}

export function cloneField(f: Field): Field {
  return {
    ...f,
    cells: f.cells.map((c) => ({ ...c })),
    adj: f.adj.map((a) => [...a]),
    walls: f.walls.map(([a, b]) => [a, b] as [number, number]),
    starts: [...f.starts],
  };
}

// ---------------------------------------------------------------- rotational maps (3 and 5 players)
//
// Exact rotational symmetry (120° for three players, 60° for five players on a six-fold map with one
// free ray). A layout family is a shape function of polar coordinates around the centre cell with
// random parameters. Decisions are made once per rotation orbit, so the result is exactly symmetric.

type Cube = [number, number, number];

/** 60° rotation of cube coordinates around the origin. */
function rot60([q, r, s]: Cube): Cube {
  return [-r, -s, -q];
}

function cubeKey([q, r]: Cube) {
  return `${q},${r}`;
}

function orbit(c: Cube, k: 3 | 6): Cube[] {
  const out: Cube[] = [];
  let cur = c;
  const step = k === 6 ? 1 : 2; // 3-fold symmetry = rotation by 120°
  for (let i = 0; i < 6; i += step) {
    if (!out.some((o) => o[0] === cur[0] && o[1] === cur[1])) out.push(cur);
    for (let j = 0; j < step; j++) cur = rot60(cur);
  }
  return out;
}

const CUBE_DIRS: Cube[] = [
  [1, -1, 0],
  [1, 0, -1],
  [0, 1, -1],
  [-1, 1, 0],
  [-1, 0, 1],
  [0, -1, 1],
];

function cubeDist([q, r, s]: Cube) {
  return Math.max(Math.abs(q), Math.abs(r), Math.abs(s));
}

/** Polar coordinates of a cell centre, radius in cell spacings. */
function polar([q, r]: Cube): [number, number] {
  const px = q + r / 2;
  const py = (r * Math.sqrt(3)) / 2;
  return [Math.hypot(px, py), Math.atan2(py, px)];
}

/** Smallest angular distance between two angles. */
function angDiff(a: number, b: number) {
  let d = (a - b) % (Math.PI * 2);
  if (d < 0) d += Math.PI * 2;
  return Math.min(d, Math.PI * 2 - d);
}

export type RotLayout = 'triangle' | 'star' | 'ring' | 'flower' | 'pinwheel' | 'islands' | 'honeycomb';

export const ROT_LAYOUTS: Record<3 | 6, RotLayout[]> = {
  3: ['triangle', 'ring', 'flower', 'pinwheel', 'islands', 'honeycomb'],
  6: ['star', 'ring', 'flower', 'islands', 'honeycomb'],
};

/** Shape test for one layout family at scale R (outer radius in cell spacings). */
type Shape = ((c: Cube, R: number) => boolean) & {
  /** cells that random holes must never remove (rims that give alternative routes) */
  keep?: (c: Cube, R: number) => boolean;
};

function withKeep(shape: (c: Cube, R: number) => boolean, keep: (c: Cube, R: number) => boolean): Shape {
  const s = shape as Shape;
  s.keep = keep;
  return s;
}

export function makeShape(layout: RotLayout, k: 3 | 6, rng: Rng): Shape {
  const sector = (Math.PI * 2) / k;
  const phase = rng.float() * sector;
  switch (layout) {
    case 'triangle': {
      return ([q, r, s], R) => {
        const a = Math.round(R * 0.55);
        return q <= a && r <= a && s <= a;
      };
    }
    case 'star': {
      return ([q, r, s], R) => {
        const a = Math.round(R * 0.5);
        return (q <= a && r <= a && s <= a) || (-q <= a && -r <= a && -s <= a);
      };
    }
    case 'honeycomb': {
      // a hexagon (optionally a hexagonal donut with a central island)
      const donut = rng.bool();
      const lake = 0.3 + rng.float() * 0.15;
      return (c, R) => {
        const d = cubeDist(c);
        if (d > Math.round(R * 0.9)) return false;
        if (donut && d > 1 && d < Math.round(R * 0.9 * lake) + 1) {
          // bridges across the lake
          const [rho, th] = polar(c);
          for (let j = 0; j < k; j++) if (angDiff(th, phase + j * sector) * rho <= 0.95) return true;
          return false;
        }
        return true;
      };
    }
    case 'ring': {
      // outer rim + central core + spokes: several routes between every pair of players
      const spokes = k === 3 ? rng.pick([1, 2]) : 1;
      const band = 1.1 + rng.float() * 1.1;
      const core = 0.22 + rng.float() * 0.12;
      const spokeW = 0.9 + rng.float() * 0.5;
      return withKeep((c, R) => {
        const [rho, th] = polar(c);
        if (rho > R) return false;
        if (rho <= Math.max(1.01, R * core)) return true;
        if (rho >= R - band) return true;
        for (let j = 0; j < k * spokes; j++) {
          const a = phase + (j * sector) / spokes;
          if (angDiff(th, a) * rho <= spokeW) return true;
        }
        return false;
      }, (c, R) => {
        const rho = polar(c)[0];
        return rho >= R - band && rho <= R;
      });
    }
    case 'flower': {
      const lobes = k === 3 ? rng.pick([3, 6]) : 6;
      const depth = 0.26 + rng.float() * 0.16;
      const lake = rng.float() < 0.5 ? 0.25 + rng.float() * 0.15 : 0;
      return (c, R) => {
        const [rho, th] = polar(c);
        const edge = R * (1 - depth + depth * Math.cos(lobes * (th - phase)));
        if (rho > edge) return false;
        if (lake && rho > 1.2 && rho < R * lake) {
          for (let j = 0; j < lobes; j++) if (angDiff(th, phase + (j * Math.PI * 2) / lobes) * rho <= 0.95) return true;
          return false;
        }
        return true;
      };
    }
    case 'pinwheel': {
      // curved arms from a core; an outer rim joins the arm tips
      const twist = (0.12 + rng.float() * 0.18) * (rng.bool() ? 1 : -1);
      const armW = 1.0 + rng.float() * 0.8;
      const core = 0.25 + rng.float() * 0.1;
      const rim = rng.float() < 0.65;
      return withKeep((c, R) => {
        const [rho, th] = polar(c);
        if (rho > R) return false;
        if (rho <= Math.max(1.01, R * core)) return true;
        if (rim && rho >= R - 1.2) return true;
        for (let j = 0; j < k; j++) {
          const a = phase + j * sector + twist * (rho - R * core);
          if (angDiff(th, a) * rho <= armW) return true;
        }
        return false;
      }, (c, R) => rim && polar(c)[0] >= R - 1.2 && polar(c)[0] <= R);
    }
    case 'islands': {
      // a central island, one island per ray, joined by bridges to the centre and/or along the rim
      const mode = rng.pick(['rim', 'both'] as const);
      const isl = 0.24 + rng.float() * 0.08;
      return withKeep((c, R) => {
        const [rho, th] = polar(c);
        if (rho > R) return false;
        const D = R * 0.66;
        const ri = R * isl;
        if (rho <= ri * 0.85) return true;
        for (let j = 0; j < k; j++) {
          const a = phase + j * sector;
          const x = rho * Math.cos(th) - D * Math.cos(a);
          const y = rho * Math.sin(th) - D * Math.sin(a);
          if (Math.hypot(x, y) <= ri) return true;
          if (mode === 'both' && rho < D && angDiff(th, a) * rho <= 0.9) return true;
        }
        if ((mode === 'rim' || mode === 'both') && Math.abs(rho - D) <= 0.9) return true;
        return false;
      }, (c, R) => (mode === 'rim' || mode === 'both') && Math.abs(polar(c)[0] - R * 0.66) <= 0.9);
    }
  }
}

/** Cube radius that holds every cell of a shape at scale R (shapes stay within ~R of the centre). */
function shapeReach(R: number) {
  return Math.ceil(R * 1.16) + 2;
}

/** All cells of the shape at scale R that are connected to the centre cell, grouped by orbit. */
export function shapeOrbits(shape: Shape, R: number, k: 3 | 6): Cube[][] {
  const lim = shapeReach(R);
  const side = 2 * lim + 1;
  const id = (q: number, r: number) => (q + lim) * side + (r + lim);
  /** 0 = not decided, 1 = outside, 2 = inside, 3 = inside and connected to the centre */
  const state = new Uint8Array(side * side);
  for (let q = -lim; q <= lim; q++)
    for (let r = Math.max(-lim, -q - lim); r <= Math.min(lim, -q + lim); r++) {
      if (state[id(q, r)]) continue;
      const c: Cube = [q, r, -q - r];
      // one decision per orbit keeps the map exactly symmetric
      const mark = shape(c, R) || cubeDist(c) <= 1 ? 2 : 1;
      for (const o of orbit(c, k)) state[id(o[0], o[1])] = mark;
    }
  // keep the part connected to the centre (it is mapped onto itself by the rotation)
  state[id(0, 0)] = 3;
  const stack: Cube[] = [[0, 0, 0]];
  const groups: Cube[][] = [];
  const grouped = new Uint8Array(side * side);
  while (stack.length) {
    const c = stack.pop()!;
    if (!grouped[id(c[0], c[1])]) {
      const orb = orbit(c, k);
      for (const o of orb) grouped[id(o[0], o[1])] = 1;
      groups.push(orb);
    }
    for (const d of CUBE_DIRS) {
      const n: Cube = [c[0] + d[0], c[1] + d[1], c[2] + d[2]];
      if (cubeDist(n) > lim) continue;
      const ni = id(n[0], n[1]);
      if (state[ni] === 2) {
        state[ni] = 3;
        stack.push(n);
      }
    }
  }
  return groups;
}

/** Hexagon of cube slots of radius `L` around the centre, with k-fold rotation orbits. */
function cubeLattice(L: number, k: 3 | 6): Lattice & { slot(c: Cube): number; cube(slot: number): Cube } {
  const side = 2 * L + 1;
  const slot = ([q, r]: Cube) => (q + L) * side + (r + L);
  const cube = (sl: number): Cube => {
    const q = Math.floor(sl / side) - L;
    const r = (sl % side) - L;
    return [q, r, -q - r];
  };
  const nbrs: number[][] = Array.from({ length: side * side }, () => []);
  for (let sl = 0; sl < nbrs.length; sl++) {
    const c = cube(sl);
    if (cubeDist(c) > L) continue;
    for (const d of CUBE_DIRS) {
      const n: Cube = [c[0] + d[0], c[1] + d[1], c[2] + d[2]];
      if (cubeDist(n) <= L) nbrs[sl].push(slot(n));
    }
  }
  return { nbrs, slot, cube, orbit: (sl) => orbit(cube(sl), k).map(slot) };
}

/**
 * Map with exact rotational symmetry for three (k = 3) or five (k = 6, one ray stays free) players.
 * `layout` picks a family; otherwise a random one suitable for k.
 */
export function generateRotational(size: FieldSize, k: 3 | 6, rng: Rng, layout?: RotLayout): Field {
  const family = layout ?? rng.pick(ROT_LAYOUTS[k]);
  const target = SIZES[size].cells + 1;
  // a shape whose narrow parts needed a lot of widening can end up well over the size; then (and in
  // the rare case the widening fails) the same family is tried again from a derived seed
  let best: Field | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const f = attempt === 0 ? buildRotational(size, k, rng, family) : buildRotational(size, k, new Rng(rng.nextU32()), family);
    if (f && (!best || f.cells.length < best.cells.length)) best = f;
    if (best && best.cells.length <= target * 1.25 + 6) break;
  }
  if (!best) throw new Error('map generation failed');
  return best;
}

function buildRotational(size: FieldSize, k: 3 | 6, rng: Rng, family: RotLayout): Field | null {
  const shape = makeShape(family, k, rng);
  const target = SIZES[size].cells + 1;

  // grow the scale until the shape is a bit bigger than needed, holes are carved afterwards
  const count = (g: Cube[][]) => g.reduce((a, o) => a + o.length, 0);
  // some orbit must hold k start cells that are not neighbours of each other
  const spread = (g: Cube[][]) =>
    g.some((orb) => orb.length === k && orb.every((a, i) => orb.every((b, j) => i === j || cubeDist([a[0] - b[0], a[1] - b[1], a[2] - b[2]]) > 1)));
  const enough = (g: Cube[][]) => count(g) >= target * 1.1 && spread(g);
  // smallest scale (on a quarter-cell grid) with enough cells: start below the disc that would just
  // hold them (shapes stay inside radius R), grow geometrically, then bisect
  const quarter = (x: number) => Math.round(x * 4) / 4;
  let lo = Math.max(1.75, quarter(Math.sqrt((target * 1.1) / (Math.PI * 1.16)) - 1));
  let R = lo;
  let groups = shapeOrbits(shape, R, k);
  while (!enough(groups) && R < 60) {
    lo = R;
    R = Math.min(60, quarter(R * 1.2 + 0.25));
    groups = shapeOrbits(shape, R, k);
  }
  if (R !== lo) {
    while (R - lo > 0.25) {
      const mid = quarter((lo + R) / 2);
      const g = shapeOrbits(shape, mid, k);
      if (enough(g)) {
        R = mid;
        groups = g;
      } else lo = mid;
    }
  }

  const L = shapeReach(R) + 6;
  const lat = cubeLattice(L, k);
  const cap = new Int32Array(lat.nbrs.length);
  for (const orb of groups) {
    const mp = rollMaxPower(rng);
    for (const o of orb) cap[lat.slot(o)] = mp;
  }

  // start cells: far from the centre, pairwise apart, chosen as one orbit
  const reps = groups.map((g) => g[0]).filter((c) => orbit(c, k).length === k);
  const maxD = Math.max(...reps.map((c) => polar(c)[0]));
  // far cells first (in random order), then the rest from the outside in
  const far = rng.shuffle(reps.filter((c) => polar(c)[0] >= maxD - 1.6));
  const rest = reps.filter((c) => polar(c)[0] < maxD - 1.6).sort((a, b) => polar(b)[0] - polar(a)[0]);
  let startOrbit: Cube[] = [];
  for (const cand of [...far, ...rest]) {
    const orb = orbit(cand, k);
    const apart = orb.every((a, i) => orb.every((b, j) => i === j || cubeDist([a[0] - b[0], a[1] - b[1], a[2] - b[2]]) > 1));
    if (apart) {
      startOrbit = orb;
      break;
    }
  }
  if (!startOrbit.length) startOrbit = orbit(reps[0] ?? [1, 0, -1], k);

  const protectedKeys = new Set<string>(['0,0']);
  if (shape.keep) for (const orb of groups) if (shape.keep(orb[0], R)) orb.forEach((c) => protectedKeys.add(cubeKey(c)));
  for (const c of startOrbit) {
    protectedKeys.add(cubeKey(c));
    for (const d of CUBE_DIRS) protectedKeys.add(cubeKey([c[0] + d[0], c[1] + d[1], c[2] + d[2]]));
  }

  const work: Work = { lat, cap, walls: new Set(), starts: startOrbit.map((c) => lat.slot(c)), pocket: MAX_POCKET };
  // the shape itself may have narrow necks between the start regions: widen them first
  if (!repairChokes(work, rng)) return null;
  let present = 0;
  for (let i = 0; i < cap.length; i++) if (cap[i]) present++;
  freezeUniverse(work);

  // carve random symmetric holes down to the target size (never cutting the map apart and never
  // leaving a single cell as the only link between start regions)
  for (const orb of rng.shuffle(groups.filter((g) => !g.some((c) => protectedKeys.has(cubeKey(c)))))) {
    if (present <= target) break;
    const slots = orb.map((o) => lat.slot(o));
    const saved = slots.map((sl) => cap[sl]);
    for (const sl of slots) cap[sl] = 0;
    if (workSound(work)) present -= slots.length;
    else slots.forEach((sl, i) => (cap[sl] = saved[i]));
  }

  // cube -> odd-r offset grid (row shift kept even so the half-cell offset of rows is preserved)
  const list: Cube[] = [];
  for (let sl = 0; sl < cap.length; sl++) if (cap[sl]) list.push(lat.cube(sl));
  const minR = Math.min(...list.map((c) => c[1]));
  const yShift = minR % 2 === 0 ? -minR : -minR + 1;
  const off = list.map((c) => ({ c, x: c[0] + Math.floor(c[1] / 2), y: c[1] + yShift }));
  const minX = Math.min(...off.map((o) => o.x));
  for (const o of off) o.x -= minX;
  const w = Math.max(...off.map((o) => o.x)) + 2;
  const h = Math.max(...off.map((o) => o.y)) + 1;
  off.sort((p, q) => p.x - q.x || p.y - q.y);
  const cells: Cell[] = off.map((o) => ({ id: o.y * w + o.x, x: o.x, y: o.y, power: 0, maxPower: cap[lat.slot(o.c)], owner: NEUTRAL }));
  const index = new Map(off.map((o, i) => [cubeKey(o.c), i]));
  const adj = buildAdjacency(cells.length, geometricPairs(w, cells));
  const st = startOrbit.map((c) => index.get(cubeKey(c))!);
  // engine placement: 3 players use [P0,P1]|[P2,P3] + P4; on six-ray maps all six rays are starts
  // (5 players leave one free)
  const starts = k === 3 ? [st[0], st[1], st[0], st[1], st[2]] : st;
  return { size, w, h, cells, adj, walls: [], starts, layout: family };
}
