/**
 * Puzzle scenarios for the map of the day: hand-designed situations (unusual maps and preset forces)
 * instead of an ordinary start. Each scenario is a parametric builder, so every day it produces a new
 * variation. Layouts are built in axial hex coordinates and converted to the engine's odd-r grid.
 */
import { Rng } from './rng';
import { buildAdjacency, geometricPairs } from './field';
import { createMatch } from './engine';
import { NEUTRAL, type Cell, type Field, type FieldSize, type MatchState, type PlayerType } from './types';

type Ax = [number, number]; // q, r

interface Slot {
  q: number;
  r: number;
  max: number;
  owner: number;
  power: number;
}

const DIRS: Ax[] = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
];

export function hexDist(a: Ax, b: Ax): number {
  const dq = a[0] - b[0];
  const dr = a[1] - b[1];
  return Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr));
}

/** Pixel-ish position (cell spacing 1) for angles and distances. */
function pos([q, r]: Ax): [number, number] {
  return [q + r / 2, (r * Math.sqrt(3)) / 2];
}

function key(q: number, r: number) {
  return `${q},${r}`;
}

/** Mutable board in axial coordinates. */
class Board {
  cells = new Map<string, Slot>();
  walls: [string, string][] = [];

  add(q: number, r: number, o: Partial<Omit<Slot, 'q' | 'r'>> = {}) {
    this.cells.set(key(q, r), { q, r, max: o.max ?? 8, owner: o.owner ?? NEUTRAL, power: o.power ?? 0 });
  }

  get(q: number, r: number) {
    return this.cells.get(key(q, r));
  }

  set(q: number, r: number, o: Partial<Omit<Slot, 'q' | 'r'>>) {
    const c = this.get(q, r);
    if (c) Object.assign(c, o);
  }

  remove(q: number, r: number) {
    this.cells.delete(key(q, r));
  }

  disk(radius: number, center: Ax = [0, 0], o: Partial<Omit<Slot, 'q' | 'r'>> = {}) {
    for (let q = -radius; q <= radius; q++)
      for (let r = -radius; r <= radius; r++) {
        const c: Ax = [center[0] + q, center[1] + r];
        if (hexDist(c, center) <= radius && !this.get(c[0], c[1])) this.add(c[0], c[1], o);
      }
  }

  /** Straight line of cells (hex line drawing). */
  line(a: Ax, b: Ax, o: Partial<Omit<Slot, 'q' | 'r'>> = {}) {
    const n = hexDist(a, b);
    for (let i = 0; i <= n; i++) {
      const t = n ? i / n : 0;
      const q = a[0] + (b[0] - a[0]) * t;
      const r = a[1] + (b[1] - a[1]) * t;
      const c = roundAx(q, r);
      if (!this.get(c[0], c[1])) this.add(c[0], c[1], o);
    }
  }

  wall(a: Ax, b: Ax) {
    this.walls.push([key(a[0], a[1]), key(b[0], b[1])]);
  }

  all(): Slot[] {
    return [...this.cells.values()];
  }

  /** Keep only the part connected to `from` (walls respected). */
  prune(from: Ax) {
    const blocked = new Set(this.walls.flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]));
    const seen = new Set([key(from[0], from[1])]);
    const stack = [from];
    while (stack.length) {
      const [q, r] = stack.pop()!;
      for (const [dq, dr] of DIRS) {
        const n: Ax = [q + dq, r + dr];
        const k = key(n[0], n[1]);
        if (this.cells.has(k) && !seen.has(k) && !blocked.has(`${key(q, r)}|${k}`)) {
          seen.add(k);
          stack.push(n);
        }
      }
    }
    for (const k of [...this.cells.keys()]) if (!seen.has(k)) this.cells.delete(k);
  }

  toField(size: FieldSize): Field {
    const list = this.all();
    const minR = Math.min(...list.map((c) => c.r));
    const yShift = minR % 2 === 0 ? -minR : -minR + 1;
    const off = list.map((c) => ({ c, x: c.q + Math.floor(c.r / 2), y: c.r + yShift }));
    const minX = Math.min(...off.map((o) => o.x));
    for (const o of off) o.x -= minX;
    const w = Math.max(...off.map((o) => o.x)) + 2;
    const h = Math.max(...off.map((o) => o.y)) + 1;
    off.sort((a, b) => a.x - b.x || a.y - b.y);
    const cells: Cell[] = off.map((o) => ({
      id: o.y * w + o.x,
      x: o.x,
      y: o.y,
      power: Math.min(o.c.power, o.c.max),
      maxPower: o.c.max,
      owner: o.c.owner,
    }));
    const index = new Map(off.map((o, i) => [key(o.c.q, o.c.r), i]));
    const wallSet = new Set<string>();
    const walls: [number, number][] = [];
    for (const [a, b] of this.walls) {
      const ia = index.get(a);
      const ib = index.get(b);
      if (ia === undefined || ib === undefined) continue;
      const lo = Math.min(ia, ib);
      const hi = Math.max(ia, ib);
      if (wallSet.has(`${lo},${hi}`)) continue;
      wallSet.add(`${lo},${hi}`);
      walls.push([lo, hi]);
    }
    const pairs = geometricPairs(w, cells).filter(([a, b]) => !wallSet.has(`${Math.min(a, b)},${Math.max(a, b)}`));
    const adj = buildAdjacency(cells.length, pairs);
    const starts = cells.slice(0, 5).map((_, i) => i);
    return { size, w, h, cells, adj, walls: walls.filter(([a, b]) => geometricPairs(w, [cells[a], cells[b]]).length > 0), starts };
  }
}

function roundAx(q: number, r: number): Ax {
  const s = -q - r;
  let rq = Math.round(q);
  let rr = Math.round(r);
  const rs = Math.round(s);
  const dq = Math.abs(rq - q);
  const dr = Math.abs(rr - r);
  const ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  return [rq, rr];
}

/** Your cell power for a (possibly fractional) knob: 2.5 = half the cells 2, half 3. */
function kp(rng: Rng, k: number) {
  return Math.max(1, Math.floor(k) + (rng.float() < k - Math.floor(k) ? 1 : 0));
}

function rollMax(rng: Rng, big = 0.3) {
  return rng.float() < big ? 12 : 8;
}

/** Rotate an axial vector by k × 60°. */
function rot(a: Ax, k: number): Ax {
  let [q, r] = a;
  for (let i = 0; i < ((k % 6) + 6) % 6; i++) [q, r] = [-r, q + r];
  return [q, r];
}

// ---------------------------------------------------------------- scenarios

export type ScenarioId =
  | 'siege'
  | 'cauldron'
  | 'bastion'
  | 'archipelago'
  | 'labyrinth'
  | 'spiral'
  | 'twofronts'
  | 'greysea'
  | 'checker'
  | 'dam'
  | 'ringmap'
  | 'hill'
  | 'awakening';

export const SCENARIOS: ScenarioId[] = [
  'siege',
  'cauldron',
  'bastion',
  'archipelago',
  'labyrinth',
  'spiral',
  'twofronts',
  'greysea',
  'checker',
  'dam',
  'ringmap',
  'hill',
  'awakening',
];

interface Built {
  board: Board;
  players: PlayerType[];
  size: FieldSize;
  darkness?: boolean;
}

/**
 * Difficulty knobs, tuned with scripts/calibrate-puzzles.ts so that a strong player usually wins and
 * an average one usually does not.
 */
export const TUNING: Record<ScenarioId, number> = {
  siege: 7,
  cauldron: 2,
  bastion: 6.5,
  archipelago: 4,
  labyrinth: 5.5,
  spiral: 4,
  twofronts: 2.5,
  greysea: 1.5,
  checker: 2.5,
  dam: 1.5,
  ringmap: 4,
  hill: 6.5,
  awakening: 3.5,
};

const BUILDERS: Record<ScenarioId, (rng: Rng, k: number) => Built> = {
  /** You hold a small core in the middle; a ring of enemy cells surrounds you. Break out. */
  siege(rng, k) {
    const b = new Board();
    b.disk(5, [0, 0]);
    for (const c of b.all()) {
      const d = hexDist([c.q, c.r], [0, 0]);
      c.max = d === 0 ? 12 : rollMax(rng, d >= 4 ? 0.35 : 0.2);
      if (d <= 1) Object.assign(c, { owner: 0, power: d === 0 ? kp(rng, k) + 2 : kp(rng, k) });
      else if (d <= 3) Object.assign(c, { owner: 1, power: 2 + rng.int(3) });
    }
    // a few holes in the outer belt
    for (const c of b.all()) if (hexDist([c.q, c.r], [0, 0]) === 5 && rng.float() < 0.3) b.remove(c.q, c.r);
    b.prune([0, 0]);
    return { board: b, players: ['human', 'hunter'], size: 'L' };
  },

  /** Reverse siege: the enemy sits in a strong fortress, you hold a thin ring around it. */
  cauldron(rng, k) {
    const b = new Board();
    b.disk(5, [0, 0]);
    for (const c of b.all()) {
      const d = hexDist([c.q, c.r], [0, 0]);
      c.max = d <= 1 ? 12 : rollMax(rng, 0.2);
      if (d <= 1) Object.assign(c, { owner: 1, power: d === 0 ? 12 : 9 + rng.int(4) });
      else if (d === 2) Object.assign(c, { power: 0 });
      else if (d <= 4) Object.assign(c, { owner: 0, power: Math.max(1, kp(rng, k) - rng.int(2)) });
    }
    b.prune([0, 0]);
    return { board: b, players: ['human', 'master'], size: 'L' };
  },

  /** A corner fortress of full big cells against an empire of weak ones. */
  bastion(rng, k) {
    const b = new Board();
    b.disk(5, [0, 0]);
    const corner: Ax = rot([4, 0], rng.int(6));
    for (const c of b.all()) {
      const dc = hexDist([c.q, c.r], corner);
      c.max = rollMax(rng, 0.25);
      if (dc <= 1) Object.assign(c, { owner: 0, max: 12, power: dc === 0 ? 12 : Math.min(12, kp(rng, k)) });
      else if (dc >= 4 && rng.float() < 0.6) Object.assign(c, { owner: 1, power: 1 + rng.int(3) });
    }
    for (const c of b.all()) if (hexDist([c.q, c.r], [0, 0]) === 5 && rng.float() < 0.25 && hexDist([c.q, c.r], corner) > 2) b.remove(c.q, c.r);
    b.prune(corner);
    return { board: b, players: ['human', 'hunter'], size: 'L' };
  },

  /** Islands joined by thin bridges; a rich neutral island in the middle. */
  archipelago(rng, k) {
    const b = new Board();
    const turn = rng.int(6);
    const centres: Ax[] = [0, 2, 4].map((i) => rot([5, -2], i + turn));
    b.disk(1, [0, 0], { max: 12 });
    centres.forEach((c, i) => {
      b.disk(2, c);
      for (const s of b.all()) if (hexDist([s.q, s.r], c) <= 2) s.max = s.max === 12 ? 12 : rollMax(rng, 0.25);
      b.line([0, 0], c);
      b.line(c, centres[(i + 1) % 3]);
      // owner of the island
      const owner = i;
      for (const s of b.all())
        if (hexDist([s.q, s.r], c) <= 1) Object.assign(s, { owner, power: owner === 0 ? kp(rng, k) : 3 + rng.int(2) });
    });
    for (const s of b.all()) if (hexDist([s.q, s.r], [0, 0]) <= 1) Object.assign(s, { max: 12, power: 4 });
    b.prune([0, 0]);
    return { board: b, players: ['human', 'hunter', 'hunter'], size: 'L' };
  },

  /** Concentric walls with a few gaps: find the way. */
  labyrinth(rng, k) {
    const b = new Board();
    b.disk(5, [0, 0]);
    for (const c of b.all()) c.max = rollMax(rng, 0.3);
    for (const ring of [1, 3]) {
      const inner = b.all().filter((c) => hexDist([c.q, c.r], [0, 0]) === ring);
      const gaps = new Set<number>();
      while (gaps.size < 2 + (ring === 3 ? 1 : 0)) gaps.add(rng.int(inner.length));
      inner.forEach((c, i) => {
        if (gaps.has(i)) return;
        for (const [dq, dr] of DIRS) {
          const n: Ax = [c.q + dq, c.r + dr];
          if (hexDist(n, [0, 0]) === ring + 1 && b.get(n[0], n[1])) b.wall([c.q, c.r], n);
        }
      });
    }
    const side = rng.int(6);
    const me = rot([5, 0], side);
    const foe = rot([5, 0], side + 3);
    b.set(me[0], me[1], { owner: 0, power: kp(rng, k) });
    b.set(foe[0], foe[1], { owner: 1, power: 7 });
    b.prune(me);
    return { board: b, players: ['human', 'master'], size: 'L' };
  },

  /** A spiral road; you start in the heart, the enemy at the far end. */
  spiral(rng, k) {
    const b = new Board();
    const dir = rng.bool() ? 1 : -1;
    const twist = 0.55 + rng.float() * 0.2;
    for (let t = 0; t <= 4.6 * Math.PI; t += 0.05) {
      const rad = 0.8 + twist * t;
      const x = rad * Math.cos(dir * t);
      const y = rad * Math.sin(dir * t);
      const r = (y * 2) / Math.sqrt(3);
      const q = x - r / 2;
      const c = roundAx(q, r);
      if (!b.get(c[0], c[1])) b.add(c[0], c[1], { max: rollMax(rng, 0.3) });
      // widen the road
      const c2 = roundAx(q * 1.1, r * 1.1);
      if (!b.get(c2[0], c2[1])) b.add(c2[0], c2[1], { max: rollMax(rng, 0.3) });
    }
    const cells = b.all().sort((a, c) => Math.hypot(...pos([a.q, a.r])) - Math.hypot(...pos([c.q, c.r])));
    const heart = cells[0];
    const tail = cells[cells.length - 1];
    Object.assign(heart, { owner: 0, power: kp(rng, k) });
    Object.assign(tail, { owner: 1, power: 7 });
    // neutral checkpoints along the road
    cells.forEach((c, i) => {
      if (c.owner === NEUTRAL && i % 11 === 6) c.power = 3;
    });
    b.prune([heart.q, heart.r]);
    return { board: b, players: ['human', 'hunter'], size: 'L' };
  },

  /** You are the middle band, attacked from both sides. */
  twofronts(rng, k) {
    const b = new Board();
    for (let r = -4; r <= 4; r++)
      for (let x = -6; x <= 6; x++) {
        const q = x - Math.floor(r / 2);
        b.add(q, r, { max: rollMax(rng, 0.25) });
      }
    for (const c of b.all()) {
      if (Math.abs(c.r) <= 1) Object.assign(c, { owner: 0, power: kp(rng, k) });
      else if (c.r <= -3) Object.assign(c, { owner: 1, power: 3 + rng.int(2) });
      else if (c.r >= 3) Object.assign(c, { owner: 2, power: 3 + rng.int(2) });
    }
    return { board: b, players: ['human', 'hunter', 'hunter'], size: 'L' };
  },

  /** Every free cell is already held by neutral forces. */
  greysea(rng, k) {
    const b = new Board();
    b.disk(5, [0, 0]);
    for (const c of b.all()) {
      c.max = rollMax(rng, 0.3);
      c.power = 1 + rng.int(3);
    }
    const side = rng.int(6);
    const me = rot([4, 0], side);
    const foe = rot([4, 0], side + 3);
    for (const [who, at] of [
      [0, me],
      [1, foe],
    ] as const) {
      b.set(at[0], at[1], { owner: who, power: who === 0 ? Math.min(12, kp(rng, k) + 4) : 6, max: 12 });
      for (const [dq, dr] of DIRS.slice(0, 2)) b.set(at[0] + dq, at[1] + dr, { owner: who, power: 3 });
    }
    return { board: b, players: ['human', 'master'], size: 'L' };
  },

  /** Interleaved territories: no front line, every cell is a border. */
  checker(rng, k) {
    const b = new Board();
    b.disk(4, [0, 0]);
    for (const c of b.all()) {
      c.max = rollMax(rng, 0.25);
      const colour = (((c.q - c.r) % 3) + 3) % 3;
      if (colour === 0) Object.assign(c, { owner: 0, power: kp(rng, k) });
      else if (colour === 1) Object.assign(c, { owner: 1, power: 3 + rng.int(2) });
    }
    return { board: b, players: ['human', 'master'], size: 'M' };
  },

  /** A neutral dam with a few breaches separates you from a large weak army. */
  dam(rng, k) {
    const b = new Board();
    for (let r = -5; r <= 5; r++)
      for (let x = -4; x <= 4; x++) b.add(x - Math.floor(r / 2), r, { max: rollMax(rng, 0.2) });
    const row = b.all().filter((c) => c.r === 0);
    const breaches = new Set<number>();
    while (breaches.size < 2) breaches.add(rng.int(row.length));
    row.forEach((c, i) => Object.assign(c, breaches.has(i) ? { power: 0 } : { max: 12, power: 9 + rng.int(4) }));
    for (const c of b.all()) {
      if (c.r <= -2) Object.assign(c, { owner: 1, power: 2 + rng.int(2) });
      if (c.r >= 3 && rng.float() < 0.6) Object.assign(c, { owner: 0, power: kp(rng, k) });
    }
    if (!b.all().some((c) => c.owner === 0)) b.all().find((c) => c.r === 5)!.owner = 0;
    return { board: b, players: ['human', 'hunter'], size: 'L' };
  },

  /** A round track for three; no centre to hide in. */
  ringmap(rng, k) {
    const b = new Board();
    b.disk(5, [0, 0]);
    for (const c of b.all()) if (hexDist([c.q, c.r], [0, 0]) < 3) b.remove(c.q, c.r);
    for (const c of b.all()) c.max = rollMax(rng, 0.3);
    const turn = rng.int(6);
    [0, 2, 4].forEach((i, owner) => {
      const at = rot([4, 0], i + turn);
      b.set(at[0], at[1], { owner, power: owner === 0 ? kp(rng, k) : 5 });
      const n = rot([4, -1], i + turn);
      b.set(n[0], n[1], { owner, power: owner === 0 ? kp(rng, k) : 5 });
    });
    return { board: b, players: ['human', 'hunter', 'hunter'], size: 'L' };
  },

  /** A huge but sleeping territory (cells at 0) against a compact, battle-ready army. */
  awakening(rng, k) {
    const b = new Board();
    b.disk(5, [0, 0]);
    const turn = rng.int(6);
    const camp: Ax = rot([3, 0], turn + 3);
    for (const c of b.all()) {
      c.max = rollMax(rng, 0.25);
      const dCamp = hexDist([c.q, c.r], camp);
      // knob: the higher, the weaker the enemy camp
      if (dCamp <= 2) Object.assign(c, { owner: 1, power: Math.max(1, Math.min(c.max, 11 - kp(rng, k) + rng.int(3))) });
      else if (dCamp >= 4) Object.assign(c, { owner: 0, power: 0 });
    }
    // one of your cells is awake
    const mine = b.all().filter((c) => c.owner === 0);
    if (!mine.length) b.all().find((c) => hexDist([c.q, c.r], camp) >= 4)!.owner = 0;
    rng.pick(b.all().filter((c) => c.owner === 0)).power = 3;
    for (const c of b.all()) if (hexDist([c.q, c.r], [0, 0]) === 5 && c.owner !== 0 && rng.float() < 0.3) b.remove(c.q, c.r);
    b.prune(camp);
    return { board: b, players: ['human', 'hunter'], size: 'L' };
  },

  /** King of the hill: a strong neutral summit in the centre, three climbers around it. */
  hill(rng, k) {
    const b = new Board();
    b.disk(5, [0, 0]);
    for (const c of b.all()) {
      const d = hexDist([c.q, c.r], [0, 0]);
      c.max = d <= 1 ? 12 : rollMax(rng, 0.2);
      if (d <= 1) c.power = d === 0 ? 10 : 7;
    }
    const turn = rng.int(6);
    [0, 2, 4].forEach((i, owner) => {
      const at = rot([5, 0], i + turn);
      b.set(at[0], at[1], { owner, power: owner === 0 ? kp(rng, k) : 6 });
    });
    return { board: b, players: ['human', 'hunter', 'master'], size: 'L' };
  },
};

/** Build the starting position of a scenario (deterministic for a seed). */
export function buildScenario(id: ScenarioId, seed: number, knob = TUNING[id]): MatchState {
  const rng = new Rng(seed);
  const built = BUILDERS[id](rng, knob);
  const field = built.board.toField(built.size);
  return createMatch(
    {
      kind: 'single',
      size: built.size,
      players: built.players,
      darkness: !!built.darkness,
      symmetry: false,
      crowded: false,
      unions: false,
      shuffle: false,
      duelRules: false,
      puzzle: id,
    },
    { field, keepPlacement: true, seed: seed ^ 0x5bd1e995 },
  );
}
