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

/** Generate a connected map with 5 start positions. Deterministic for a given rng state. */
export function generateField(opts: GenerateOptions, rng: Rng): Field {
  if (opts.symmetry && opts.players === 3) return generateRotational(opts.size, 3, rng, opts.layout);
  if (opts.symmetry && (opts.players === 5 || opts.players === 6)) return generateRotational(opts.size, 6, rng, opts.layout);
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

/** All cells of the shape at scale R that are connected to the centre cell, grouped by orbit. */
export function shapeOrbits(shape: Shape, R: number, k: 3 | 6): Cube[][] {
  const lim = Math.ceil(R) + 2;
  const seen = new Set<string>();
  const inside = new Map<string, Cube>();
  for (let q = -lim; q <= lim; q++)
    for (let r = -lim; r <= lim; r++) {
      const c: Cube = [q, r, -q - r];
      const key = cubeKey(c);
      if (seen.has(key)) continue;
      const orb = orbit(c, k);
      orb.forEach((o) => seen.add(cubeKey(o)));
      // one decision per orbit keeps the map exactly symmetric
      if (shape(c, R) || cubeDist(c) <= 1) orb.forEach((o) => inside.set(cubeKey(o), o));
    }
  // keep the part connected to the centre (it is mapped onto itself by the rotation)
  const keep = new Set<string>(['0,0']);
  const stack: Cube[] = [[0, 0, 0]];
  while (stack.length) {
    const c = stack.pop()!;
    for (const d of CUBE_DIRS) {
      const n: Cube = [c[0] + d[0], c[1] + d[1], c[2] + d[2]];
      const nk = cubeKey(n);
      if (inside.has(nk) && !keep.has(nk)) {
        keep.add(nk);
        stack.push(n);
      }
    }
  }
  const groups: Cube[][] = [];
  const done = new Set<string>();
  for (const key of keep) {
    if (done.has(key)) continue;
    const orb = orbit(inside.get(key)!, k);
    orb.forEach((o) => done.add(cubeKey(o)));
    groups.push(orb);
  }
  return groups;
}

/**
 * Map with exact rotational symmetry for three (k = 3) or five (k = 6, one ray stays free) players.
 * `layout` picks a family; otherwise a random one suitable for k.
 */
export function generateRotational(size: FieldSize, k: 3 | 6, rng: Rng, layout?: RotLayout): Field {
  const family = layout ?? rng.pick(ROT_LAYOUTS[k]);
  const shape = makeShape(family, k, rng);
  const target = SIZES[size].cells + 1;

  // grow the scale until the shape is a bit bigger than needed, holes are carved afterwards
  let R = 2;
  let groups = shapeOrbits(shape, R, k);
  const count = (g: Cube[][]) => g.reduce((a, o) => a + o.length, 0);
  // some orbit must hold k start cells that are not neighbours of each other
  const spread = (g: Cube[][]) =>
    g.some((orb) => orb.length === k && orb.every((a, i) => orb.every((b, j) => i === j || cubeDist([a[0] - b[0], a[1] - b[1], a[2] - b[2]]) > 1)));
  while ((count(groups) < target * 1.1 || !spread(groups)) && R < 60) {
    R += 0.25;
    groups = shapeOrbits(shape, R, k);
  }

  const present = new Map<string, Cube>();
  const cap = new Map<string, number>();
  for (const orb of groups) {
    const mp = rollMaxPower(rng);
    for (const o of orb) {
      present.set(cubeKey(o), o);
      cap.set(cubeKey(o), mp);
    }
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

  const connected = () => {
    const first = present.values().next().value as Cube | undefined;
    if (!first) return false;
    const seen = new Set<string>([cubeKey(first)]);
    const stack = [first];
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

  // carve random symmetric holes down to the target size (never cutting the map apart)
  for (const orb of rng.shuffle(groups.filter((g) => !g.some((c) => protectedKeys.has(cubeKey(c)))))) {
    if (present.size <= target) break;
    for (const o of orb) present.delete(cubeKey(o));
    if (!connected()) for (const o of orb) present.set(cubeKey(o), o);
  }

  // cube -> odd-r offset grid (row shift kept even so the half-cell offset of rows is preserved)
  const list = [...present.values()];
  const minR = Math.min(...list.map((c) => c[1]));
  const yShift = minR % 2 === 0 ? -minR : -minR + 1;
  const off = list.map((c) => ({ c, x: c[0] + Math.floor(c[1] / 2), y: c[1] + yShift }));
  const minX = Math.min(...off.map((o) => o.x));
  for (const o of off) o.x -= minX;
  const w = Math.max(...off.map((o) => o.x)) + 2;
  const h = Math.max(...off.map((o) => o.y)) + 1;
  off.sort((p, q) => p.x - q.x || p.y - q.y);
  const cells: Cell[] = off.map((o) => ({ id: o.y * w + o.x, x: o.x, y: o.y, power: 0, maxPower: cap.get(cubeKey(o.c))!, owner: NEUTRAL }));
  const index = new Map(off.map((o, i) => [cubeKey(o.c), i]));
  const adj = buildAdjacency(cells.length, geometricPairs(w, cells));
  const st = startOrbit.map((c) => index.get(cubeKey(c))!);
  // engine placement: 3 players use [P0,P1]|[P2,P3] + P4; 5 players use P0..P4
  let starts: number[];
  // 3 players use [P0,P1]|[P2,P3] + P4; on six-ray maps all six rays are starts (5 players leave one free)
  if (k === 3) starts = [st[0], st[1], st[0], st[1], st[2]];
  else starts = st;
  return { size, w, h, cells, adj, walls: [], starts, layout: family };
}
