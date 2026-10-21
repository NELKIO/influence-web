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
  for (let i = 0; i < 5; i++) {
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
}

/** Generate a connected map with 5 start positions. Deterministic for a given rng state. */
export function generateField(opts: GenerateOptions, rng: Rng): Field {
  if (opts.symmetry && opts.players === 3) return generateRotational(opts.size, 'triangle', rng);
  if (opts.symmetry && opts.players === 5) return generateRotational(opts.size, 'star', rng);
  const info = SIZES[opts.size];
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
    const field: Field = { size: opts.size, w: info.w, h: info.h, cells, adj, walls, starts };
    if (!isConnected(field)) continue;
    fallback ??= field;
    if (edgeCriteriaOk(cells, info.edgeK)) return field;
  }
  if (fallback) return fallback;
  throw new Error('map generation failed');
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

export type RotShape = 'triangle' | 'star';

function inShape(shape: RotShape, a: number, [q, r, s]: Cube): boolean {
  const tri = q <= a && r <= a && s <= a;
  if (shape === 'triangle') return tri;
  return tri || (-q <= a && -r <= a && -s <= a);
}

function shapeCells(shape: RotShape, a: number): Cube[] {
  const out: Cube[] = [];
  const R = a * 2 + 2;
  for (let q = -R; q <= R; q++) for (let r = -R; r <= R; r++) {
    const c: Cube = [q, r, -q - r];
    if (inShape(shape, a, c)) out.push(c);
  }
  return out;
}

function cubeDist([q, r, s]: Cube) {
  return Math.max(Math.abs(q), Math.abs(r), Math.abs(s));
}

/**
 * Map with exact rotational symmetry: a triangle (120°, three players) or a six-pointed star
 * (60°; five players take five of its rays). Built by carving random symmetric holes out of the
 * full shape while keeping it connected.
 */
export function generateRotational(size: FieldSize, shape: RotShape, rng: Rng): Field {
  const k: 3 | 6 = shape === 'triangle' ? 3 : 6;
  const target = SIZES[size].cells + 1;
  let a = 1;
  while (shapeCells(shape, a).length < target * 1.22) a++;
  const all = shapeCells(shape, a);
  const present = new Map<string, Cube>(all.map((c) => [cubeKey(c), c]));
  const cap = new Map<string, number>();
  const done = new Set<string>();
  for (const c of all) {
    const key = cubeKey(c);
    if (done.has(key)) continue;
    const mp = rollMaxPower(rng);
    for (const o of orbit(c, k)) {
      cap.set(cubeKey(o), mp);
      done.add(cubeKey(o));
    }
  }

  // start cells: far out on the rays/corners, pairwise apart
  const byDist = [...all].sort((x, y) => cubeDist(y) - cubeDist(x));
  const far = byDist.filter((c) => cubeDist(c) >= cubeDist(byDist[0]) - 1 - Math.floor(a / 4));
  const startOrbit = orbit(rng.pick(far.length ? far : byDist), k);
  const protectedKeys = new Set<string>();
  for (const c of startOrbit) {
    protectedKeys.add(cubeKey(c));
    for (const d of CUBE_DIRS) protectedKeys.add(cubeKey([c[0] + d[0], c[1] + d[1], c[2] + d[2]]));
  }
  protectedKeys.add('0,0');

  const connected = () => {
    const keys = [...present.keys()];
    if (!keys.length) return false;
    const seen = new Set<string>([keys[0]]);
    const stack = [present.get(keys[0])!];
    while (stack.length) {
      const c = stack.pop()!;
      for (const d of CUBE_DIRS) {
        const nk = cubeKey([c[0] + d[0], c[1] + d[1], c[2] + d[2]]);
        if (present.has(nk) && !seen.has(nk)) {
          seen.add(nk);
          stack.push(present.get(nk)!);
        }
      }
    }
    return seen.size === present.size;
  };

  // carve symmetric holes until the target size is reached
  const candidates = rng.shuffle(all.filter((c) => !protectedKeys.has(cubeKey(c))));
  for (const c of candidates) {
    if (present.size <= target) break;
    const orb = orbit(c, k);
    if (orb.some((o) => !present.has(cubeKey(o)))) continue;
    for (const o of orb) present.delete(cubeKey(o));
    if (!connected()) for (const o of orb) present.set(cubeKey(o), o);
  }

  // cube -> odd-r offset grid (row shift kept even so the half-cell offset of rows is preserved)
  const list = [...present.values()];
  const minR = Math.min(...list.map((c) => c[1]));
  const yShift = minR % 2 === 0 ? -minR : -minR + 1;
  const off = list.map((c) => {
    const y = c[1] + yShift;
    return { c, x: c[0] + Math.floor(c[1] / 2), y };
  });
  const minX = Math.min(...off.map((o) => o.x));
  for (const o of off) o.x -= minX;
  const w = Math.max(...off.map((o) => o.x)) + 2;
  const h = Math.max(...off.map((o) => o.y)) + 1;
  // generator order: by x, then y
  off.sort((p, q) => p.x - q.x || p.y - q.y);
  const cells: Cell[] = off.map((o) => ({ id: o.y * w + o.x, x: o.x, y: o.y, power: 0, maxPower: cap.get(cubeKey(o.c))!, owner: NEUTRAL }));
  const index = new Map(off.map((o, i) => [cubeKey(o.c), i]));
  const pairs = geometricPairs(w, cells);
  const adj = buildAdjacency(cells.length, pairs);
  const s = startOrbit.map((c) => index.get(cubeKey(c))!);
  // engine placement: 3 players use [P0,P1]|[P2,P3] + P4; 5 players use P0..P4
  let starts: number[];
  if (k === 3) starts = [s[0], s[1], s[0], s[1], s[2]];
  else {
    const free = rng.int(6);
    starts = s.filter((_, i) => i !== free);
  }
  return { size, w, h, cells, adj, walls: [], starts, layout: shape };
}
