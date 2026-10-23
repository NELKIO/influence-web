/**
 * Scenarios: hand-designed situations (unusual maps and preset forces) instead of an ordinary start.
 * A scenario fixes the map, the number of seats and the modes; the map of the day plays it with the
 * recommended bots, the battle setup lets the player choose who sits in each seat. Each scenario is a
 * parametric builder, so every seed produces a new variation. Layouts are built in axial hex
 * coordinates and converted to the engine's odd-r grid.
 */
import { Rng, randomSeed } from './rng';
import { buildAdjacency, geometricPairs } from './field';
import { createMatch } from './engine';
import { articulationPoints, chokePoints } from './connectivity';
import { NEUTRAL, type Cell, type Field, type FieldSize, type MatchSettings, type MatchState, type PlayerType } from './types';

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

  /** Rotate the whole board by k × 60° (to fit tall phone screens better). */
  rotate(k: number) {
    const cells = new Map<string, Slot>();
    for (const c of this.cells.values()) {
      const [q, r] = rot([c.q, c.r], k);
      cells.set(key(q, r), { ...c, q, r });
    }
    this.cells = cells;
    this.walls = this.walls.map(([a, b]) => {
      const f = (x: string): string => {
        const [q, r] = x.split(',').map(Number);
        const [nq, nr] = rot([q, r], k);
        return key(nq, nr);
      };
      return [f(a), f(b)];
    });
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

  /** Cell graph (walls respected), cells in insertion order. */
  graph(): { keys: string[]; index: Map<string, number>; adj: number[][] } {
    const keys = [...this.cells.keys()];
    const index = new Map(keys.map((k, i) => [k, i]));
    const blocked = new Set(this.walls.flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]));
    const adj = keys.map((k) => {
      const c = this.cells.get(k)!;
      const out: number[] = [];
      for (const [dq, dr] of DIRS) {
        const n = index.get(key(c.q + dq, c.r + dr));
        if (n !== undefined && !blocked.has(`${k}|${keys[n]}`)) out.push(n);
      }
      return out;
    });
    return { keys, index, adj };
  }

  /** Connected, and no single cell (or wall gap) holds it together. */
  solid(): boolean {
    const { adj } = this.graph();
    if (!adj.length) return false;
    const seen = new Uint8Array(adj.length);
    const stack = [0];
    seen[0] = 1;
    let count = 1;
    while (stack.length)
      for (const v of adj[stack.pop()!])
        if (!seen[v]) {
          seen[v] = 1;
          count++;
          stack.push(v);
        }
    return count === adj.length && articulationPoints(adj).length === 0;
  }

  /**
   * No single cell may cut owned cells apart (the two sides would retake it forever). While one does,
   * open the nearest wall across the cut, or else add a neutral cell that leads around it.
   */
  unchoke(limit = 80) {
    for (let step = 0; step < limit; step++) {
      const { keys, index, adj } = this.graph();
      const owned = keys.flatMap((k, i) => (this.cells.get(k)!.owner >= 0 ? [i] : []));
      const cuts = chokePoints(adj, owned);
      if (!cuts.length) return;
      const cut = cuts[0];
      const c = this.cells.get(keys[cut])!;
      const at: Ax = [c.q, c.r];
      // the sides of the cut
      const side = new Int32Array(keys.length).fill(-1);
      side[cut] = -2;
      let sides = 0;
      for (let i = 0; i < keys.length; i++) {
        if (side[i] !== -1) continue;
        side[i] = sides;
        const stack = [i];
        while (stack.length)
          for (const v of adj[stack.pop()!])
            if (side[v] === -1) {
              side[v] = sides;
              stack.push(v);
            }
        sides++;
      }
      const ax = (k: string): Ax => {
        const s = this.cells.get(k)!;
        return [s.q, s.r];
      };
      let wall: [string, string] | null = null;
      let best = Infinity;
      for (const [a, b] of this.walls) {
        const sa = side[index.get(a) ?? cut];
        const sb = side[index.get(b) ?? cut];
        if (sa < 0 || sb < 0 || sa === sb) continue;
        const d = hexDist(ax(a), at) + hexDist(ax(b), at);
        if (d < best) [best, wall] = [d, [a, b]];
      }
      if (wall) {
        const [a, b] = wall;
        this.walls = this.walls.filter(([x, y]) => !((x === a && y === b) || (x === b && y === a)));
        continue;
      }
      let spot: Ax | null = null;
      best = Infinity;
      for (const s of this.cells.values())
        for (const [dq, dr] of DIRS) {
          const p: Ax = [s.q + dq, s.r + dr];
          if (this.get(p[0], p[1])) continue;
          const touch = new Set<number>();
          for (const [eq, er] of DIRS) {
            const n = index.get(key(p[0] + eq, p[1] + er));
            if (n !== undefined && side[n] >= 0) touch.add(side[n]);
          }
          const d = hexDist(p, at);
          if (touch.size >= 2 && d < best) [best, spot] = [d, p];
        }
      if (!spot) return;
      this.add(spot[0], spot[1], { max: c.max, power: c.owner < 0 ? c.power : 0 });
    }
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

/** The first scenarios: duels and three-player fights. */
export const CLASSIC_SCENARIOS = [
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
  'hydra',
  'trojan',
  'thermopylae',
  'minefield',
  'hourglass',
  'pincer',
  'hive',
  'overload',
  'treasury',
  'bridges',
  'spear',
] as const;

/** Battles for three to six players. */
export const BATTLE_SCENARIOS = ['landing', 'laststand', 'olympus', 'titans', 'hollow', 'raid'] as const;

export type ScenarioId = (typeof CLASSIC_SCENARIOS)[number] | (typeof BATTLE_SCENARIOS)[number];

/** Every scenario, in the order of the setup gallery. The map of the day rotates through all of them. */
export const SCENARIOS: ScenarioId[] = [...BATTLE_SCENARIOS, ...CLASSIC_SCENARIOS];

export function isScenarioId(id: unknown): id is ScenarioId {
  return typeof id === 'string' && (SCENARIOS as string[]).includes(id);
}

/** What a scenario fixes besides the map: the seats and the modes. */
export interface ScenarioMeta {
  /** recommended seat types; seat 0 is you (the map of the day plays exactly these) */
  players: PlayerType[];
  /** difficulty 1..5 with these opponents (shown on the map of the day), from the calibration */
  level: number;
  size: FieldSize;
  darkness?: boolean;
  unions?: boolean;
  /** the whole map starts taken (shown as the "crowded" mode) */
  crowded?: boolean;
  /** exploration fog: the map itself is unknown until seen (with darkness) */
  blind?: boolean;
}

export const SCENARIO_META: Record<ScenarioId, ScenarioMeta> = {
  siege: { players: ['human', 'master'], level: 4, size: 'L' },
  cauldron: { players: ['human', 'master'], level: 3, size: 'L' },
  bastion: { players: ['human', 'master'], level: 4, size: 'L' },
  archipelago: { players: ['human', 'god', 'master'], level: 4, size: 'L' },
  labyrinth: { players: ['human', 'master'], level: 4, size: 'L' },
  spiral: { players: ['human', 'master'], level: 4, size: 'L' },
  twofronts: { players: ['human', 'god', 'master'], level: 4, size: 'L' },
  greysea: { players: ['human', 'master'], level: 3, size: 'L' },
  checker: { players: ['human', 'master'], level: 2, size: 'M' },
  dam: { players: ['human', 'master'], level: 4, size: 'L' },
  ringmap: { players: ['human', 'god', 'master'], level: 3, size: 'L' },
  hill: { players: ['human', 'master', 'god'], level: 3, size: 'L' },
  awakening: { players: ['human', 'master'], level: 2, size: 'L' },
  hydra: { players: ['human', 'master'], level: 4, size: 'L' },
  trojan: { players: ['human', 'hunter'], level: 4, size: 'L' },
  thermopylae: { players: ['human', 'master'], level: 4, size: 'L' },
  minefield: { players: ['human', 'master'], level: 2, size: 'L' },
  hourglass: { players: ['human', 'master'], level: 4, size: 'L' },
  pincer: { players: ['human', 'master'], level: 4, size: 'L' },
  hive: { players: ['human', 'master'], level: 4, size: 'M' },
  overload: { players: ['human', 'master'], level: 4, size: 'L' },
  treasury: { players: ['human', 'master'], level: 4, size: 'L' },
  bridges: { players: ['human', 'master'], level: 3, size: 'L' },
  spear: { players: ['human', 'master'], level: 4, size: 'L' },
  landing: { players: ['human', 'god', 'master', 'hunter', 'master', 'hunter'], level: 3, size: 'XL', darkness: true, blind: true },
  laststand: { players: ['human', 'master', 'hunter', 'god', 'hunter', 'master'], level: 4, size: 'L' },
  titans: { players: ['human', 'master', 'master'], level: 3, size: 'L', unions: true },
  olympus: { players: ['human', 'master', 'hunter', 'god', 'hunter', 'master'], level: 3, size: 'L' },
  hollow: { players: ['human', 'master', 'god', 'master'], level: 3, size: 'L' },
  raid: { players: ['human', 'master'], level: 3, size: 'L' },
};

/**
 * Difficulty knobs for the recommended opponents, tuned with scripts/calibrate-puzzles.ts so that a
 * strong player usually wins and an average one usually does not. (The map of the day has its own
 * frozen line-ups and knobs, see daily.ts.)
 */
export const TUNING: Record<ScenarioId, number> = {
  siege: 10,
  cauldron: 2,
  bastion: 8.5,
  archipelago: 5.5,
  labyrinth: 5.5,
  spiral: 7,
  twofronts: 3,
  greysea: 1.5,
  checker: 2.5,
  dam: 5,
  ringmap: 6,
  hill: 8,
  awakening: 5.5,
  hydra: 11.5,
  trojan: 5.5,
  thermopylae: 4.5,
  minefield: 5,
  hourglass: 4.5,
  pincer: 4,
  hive: 5,
  overload: 1.5,
  treasury: 4,
  bridges: 3,
  spear: 4.5,
  landing: 5,
  laststand: 6,
  olympus: 4.5,
  titans: 8,
  hollow: 0,
  raid: 6,
};

const BUILDERS: Record<ScenarioId, (rng: Rng, k: number, seats: number) => Board> = {
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
    return b;
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
    return b;
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
    return b;
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
    // the rich island: roomy cells (up to 12) that nobody holds yet, free for whoever gets there first
    for (const s of b.all()) if (hexDist([s.q, s.r], [0, 0]) <= 1) Object.assign(s, { max: 12, power: 0 });
    b.prune([0, 0]);
    return b;
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
    return b;
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
      // a second lane one cell further out: the road is two cells wide all the way
      const out = (rad + 1) / rad;
      const c2 = roundAx(q * out, r * out);
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
    return b;
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
    return b;
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
    return b;
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
    return b;
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
    return b;
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
    return b;
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
    return b;
  },

  /** The enemy is scattered over six small colonies; you are one block in the middle. Hunt them down. */
  hydra(rng, k) {
    const b = new Board();
    b.disk(5, [0, 0]);
    for (const c of b.all()) c.max = rollMax(rng, 0.25);
    for (const c of b.all()) if (hexDist([c.q, c.r], [0, 0]) <= 1) Object.assign(c, { owner: 0, power: kp(rng, k) });
    const turn = rng.int(6);
    for (let i = 0; i < 6; i++) {
      const at = rot([4, rng.int(2) - 1], i + turn);
      b.set(at[0], at[1], { owner: 1, power: 5 + rng.int(3) });
      for (const [dq, dr] of [DIRS[i % 6], DIRS[(i + 1) % 6]]) b.set(at[0] + dq, at[1] + dr, { owner: 1, power: 3 + rng.int(2) });
    }
    for (const c of b.all()) if (hexDist([c.q, c.r], [0, 0]) === 5 && c.owner < 0 && rng.float() < 0.35) b.remove(c.q, c.r);
    b.prune([0, 0]);
    return b;
  },

  /** One mighty cell hidden deep in enemy land, and a tiny base on the edge. */
  trojan(rng, k) {
    const b = new Board();
    b.disk(5, [0, 0]);
    const turn = rng.int(6);
    const base = rot([5, -1], turn);
    const horse = rot([-1, 1], turn);
    for (const c of b.all()) {
      c.max = rollMax(rng, 0.25);
      const d = hexDist([c.q, c.r], base);
      if (d <= 1) Object.assign(c, { owner: 0, power: kp(rng, k) });
      // the enemy realm surrounds the horse
      else if (hexDist([c.q, c.r], horse) <= 2) Object.assign(c, { owner: 1, power: 3 + rng.int(3) });
    }
    b.set(horse[0], horse[1], { owner: 0, max: 12, power: 12 });
    b.prune(base);
    return b;
  },

  /** You hold a narrow pass; a large army waits on the other side, empty land behind you. */
  thermopylae(rng, k) {
    const b = new Board();
    const west: Ax = [-5, 0];
    const east: Ax = [5, 0];
    b.disk(3, west);
    b.disk(3, east);
    // the pass: two rows wide
    for (let q = -2; q <= 2; q++) {
      b.add(q, 0, { max: 12 });
      b.add(q, -1, { max: 12 });
    }
    for (const c of b.all()) {
      if (c.q + c.r / 2 > 2.5) {
        c.max = rollMax(rng, 0.2);
        if (rng.float() < 0.85) Object.assign(c, { owner: 1, power: 2 + rng.int(3) });
      } else if (c.q + c.r / 2 < -2.5) c.max = rollMax(rng, 0.3);
      else Object.assign(c, { owner: 0, power: kp(rng, k) });
    }
    b.prune(west);
    b.rotate(rng.bool() ? 1 : 2);
    return b;
  },

  /** Strong neutral "mines" scattered over open land: choose your path. */
  minefield(rng, k) {
    const b = new Board();
    b.disk(5, [0, 0]);
    for (const c of b.all()) {
      c.max = rollMax(rng, 0.3);
      if (rng.float() < 0.33) c.power = Math.min(c.max, 6 + rng.int(3));
    }
    const turn = rng.int(6);
    const me = rot([5, 0], turn);
    const foe = rot([5, 0], turn + 3);
    for (const [who, at] of [
      [0, me],
      [1, foe],
    ] as const) {
      b.set(at[0], at[1], { owner: who, power: who === 0 ? kp(rng, k) : 5 });
      const n = rot([4, 0], turn + (who === 0 ? 0 : 3));
      b.set(n[0], n[1], { owner: who, power: who === 0 ? kp(rng, k) : 5 });
    }
    return b;
  },

  /** Two triangles meeting at a narrow waist guarded by neutral forces. */
  hourglass(rng, k) {
    const b = new Board();
    const a = 4;
    // upper triangle points down, lower triangle points up; they touch through a short neck
    for (let q = -8; q <= 8; q++)
      for (let r = -8; r <= 8; r++) {
        const s = -q - r;
        const up: [number, number, number] = [q, r + 5, s - 5];
        const down: [number, number, number] = [q, r - 5, s + 5];
        if (-up[0] <= a && -up[1] <= a && -up[2] <= a) b.add(q, r, { max: rollMax(rng, 0.25) });
        else if (down[0] <= a && down[1] <= a && down[2] <= a) b.add(q, r, { max: rollMax(rng, 0.25) });
      }
    b.line([0, -1], [0, 1], { max: 12 });
    for (const c of b.all()) if (Math.abs(c.r) <= 1 && Math.abs(c.q + c.r / 2) <= 1) c.power = 3;
    const top = b.all().reduce((m, c) => (c.r < m.r ? c : m));
    const bottom = b.all().reduce((m, c) => (c.r > m.r ? c : m));
    Object.assign(top, { owner: 0, power: kp(rng, k), max: 12 });
    Object.assign(bottom, { owner: 1, power: 7, max: 12 });
    b.prune([top.q, top.r]);
    return b;
  },

  /** Your army is split in two; the enemy stands between the halves. */
  pincer(rng, k) {
    const b = new Board();
    for (let r = -4; r <= 4; r++) for (let x = -6; x <= 6; x++) b.add(x - Math.floor(r / 2), r, { max: rollMax(rng, 0.25) });
    for (const c of b.all()) {
      const x = c.q + Math.floor(c.r / 2);
      if (Math.abs(x) <= 1) Object.assign(c, { owner: 1, power: 4 + rng.int(3) });
      else if (Math.abs(x) >= 5 && rng.float() < 0.7) Object.assign(c, { owner: 0, power: kp(rng, k) });
    }
    if (!b.all().some((c) => c.owner === 0)) b.all()[0].owner = 0;
    return b;
  },

  /** A perfect maze: walls everywhere except a tree of passages (plus a few loops). */
  hive(rng, k) {
    const b = new Board();
    b.disk(4, [0, 0]);
    for (const c of b.all()) c.max = rollMax(rng, 0.3);
    const cells = b.all();
    const id = (c: Slot) => key(c.q, c.r);
    const seen = new Set<string>([id(cells[0])]);
    const open = new Set<string>();
    const stack = [cells[0]];
    while (stack.length) {
      const c = stack[stack.length - 1];
      const next = rng.shuffle(DIRS.map(([dq, dr]) => b.get(c.q + dq, c.r + dr)).filter((n): n is Slot => !!n && !seen.has(id(n))));
      if (!next.length) {
        stack.pop();
        continue;
      }
      const n = next[0];
      seen.add(id(n));
      open.add(`${id(c)}|${id(n)}`);
      open.add(`${id(n)}|${id(c)}`);
      stack.push(n);
    }
    for (const c of cells)
      for (const [dq, dr] of DIRS.slice(0, 3)) {
        const n = b.get(c.q + dq, c.r + dr);
        if (!n || open.has(`${id(c)}|${id(n)}`)) continue;
        if (rng.float() < 0.18) continue; // a few loops
        b.wall([c.q, c.r], [n.q, n.r]);
      }
    const turn = rng.int(6);
    const me = rot([4, 0], turn);
    const foe = rot([4, 0], turn + 3);
    b.set(me[0], me[1], { owner: 0, power: kp(rng, k) });
    b.set(foe[0], foe[1], { owner: 1, power: 6 });
    return b;
  },

  /** Your cells are full — no power until you spend some. A swarm of weak cells around you. */
  overload(rng, k) {
    const b = new Board();
    b.disk(5, [0, 0]);
    const turn = rng.int(6);
    const home = rot([2, 0], turn);
    const size = Math.max(1, Math.round(k));
    for (const c of b.all()) {
      c.max = rollMax(rng, 0.3);
      const d = hexDist([c.q, c.r], home);
      if (d < size) Object.assign(c, { owner: 0, power: c.max });
      else if (d >= size + 1 && rng.float() < 0.6) Object.assign(c, { owner: 1, power: 1 + rng.int(3) });
    }
    b.prune(home);
    return b;
  },

  /** A walled vault full of power in the centre, with two entrances on opposite sides. */
  treasury(rng, k) {
    const b = new Board();
    b.disk(5, [0, 0]);
    for (const c of b.all()) {
      const d = hexDist([c.q, c.r], [0, 0]);
      c.max = d <= 1 ? 12 : rollMax(rng, 0.25);
      if (d <= 1) c.power = 10;
    }
    const ring = b.all().filter((c) => hexDist([c.q, c.r], [0, 0]) === 1);
    const door = ring[rng.int(ring.length)];
    // a single door would be a choke point: whoever holds the vault could only be reached through it
    const isDoor = (c: Slot) => (c.q === door.q && c.r === door.r) || (c.q === -door.q && c.r === -door.r);
    ring.forEach((c) => {
      for (const [dq, dr] of DIRS) {
        const n: Ax = [c.q + dq, c.r + dr];
        if (hexDist(n, [0, 0]) === 2 && b.get(n[0], n[1]) && !isDoor(c)) b.wall([c.q, c.r], n);
      }
    });
    const turn = rng.int(6);
    [0, 3].forEach((i, owner) => {
      for (const v of [rot([5, 0], i + turn), rot([5, -1], i + turn)]) b.set(v[0], v[1], { owner, power: owner === 0 ? kp(rng, k) : 5 });
    });
    return b;
  },

  /** Two shores joined by long bridges with neutral forts on them. */
  bridges(rng, k) {
    const b = new Board();
    const west: Ax = [-5, 0];
    const east: Ax = [5, 0];
    b.disk(3, west);
    b.disk(3, east);
    b.line([-2, -2], [3, -2]);
    b.line([-3, 2], [2, 2]);
    for (const c of b.all()) {
      c.max = rollMax(rng, 0.25);
      if (Math.abs(c.q + c.r / 2) <= 1.5 && Math.abs(c.r) === 2) Object.assign(c, { max: 12, power: 6 });
    }
    const me = rot([-8, 0], 0);
    const foe = rot([8, 0], 0);
    for (const [who, at] of [
      [0, me],
      [1, foe],
    ] as const) {
      for (const c of b.all()) if (hexDist([c.q, c.r], at) <= 1) Object.assign(c, { owner: who, power: who === 0 ? kp(rng, k) : 4 });
    }
    b.prune(west);
    b.rotate(rng.bool() ? 1 : 2);
    return b;
  },

  /** A long wedge of yours driven deep into enemy land. */
  spear(rng, k) {
    const b = new Board();
    for (let r = -5; r <= 5; r++) for (let x = -4; x <= 4; x++) b.add(x - Math.floor(r / 2), r, { max: rollMax(rng, 0.25) });
    const col = rng.int(3) - 1;
    for (const c of b.all()) {
      const x = c.q + Math.floor(c.r / 2);
      if (c.r >= 4) Object.assign(c, { owner: 0, power: 2 });
      else if (Math.abs(x - col) <= (c.r >= 0 ? 1 : 0) && c.r >= -3) Object.assign(c, { owner: 0, power: kp(rng, k) });
      else if (c.r <= 2 && rng.float() < 0.8) Object.assign(c, { owner: 1, power: 2 + rng.int(3) });
    }
    return b;
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
    return b;
  },

  // ------------------------------------------------------------ battles for three to six players

  /** A big land in darkness; everybody is dropped at a random spot and nobody knows where the others are. */
  landing(rng, k, seats) {
    const b = new Board();
    b.disk(8);
    for (const c of b.all()) c.max = rollMax(rng, 0.3);
    // lakes and walls as landmarks, never leaving a cell that holds the land together
    for (let i = 0; i < 10; i++) {
      const at = rng.pick(b.all());
      const lake = b.all().filter((c) => hexDist([c.q, c.r], [at.q, at.r]) <= (rng.float() < 0.5 ? 1 : 0));
      lake.forEach((c) => b.remove(c.q, c.r));
      if (!b.solid()) lake.forEach((c) => b.add(c.q, c.r, c));
    }
    for (let i = 0; i < 40; i++) {
      const c = rng.pick(b.all());
      const [dq, dr] = rng.pick(DIRS);
      if (!b.get(c.q + dq, c.r + dr)) continue;
      b.wall([c.q, c.r], [c.q + dq, c.r + dr]);
      if (!b.solid()) b.walls.pop();
    }
    // ruins: armed grey cells, seen only up close
    for (const c of b.all()) if (rng.float() < 0.08) c.power = Math.min(c.max, 2 + rng.int(3));
    // drops: a random free spot well away from the others (or the farthest one when the land is crowded)
    const drops: Slot[] = [];
    const away = (c: Slot) => Math.min(99, ...drops.map((o) => hexDist([c.q, c.r], [o.q, o.r])));
    for (let p = 0; p < seats; p++) {
      const free = b.all().filter((c) => c.owner === NEUTRAL && c.power === 0);
      const far = free.filter((c) => away(c) >= 5);
      const best = far.length ? rng.pick(far) : free.reduce((m, c) => (away(c) > away(m) ? c : m));
      drops.push(best);
      const squad = [best, ...rng.shuffle(DIRS.map(([dq, dr]) => b.get(best.q + dq, best.r + dr))).filter((n): n is Slot => !!n && n.owner === NEUTRAL).slice(0, 2)];
      for (const c of squad) Object.assign(c, { owner: p, power: p === 0 ? Math.min(c.max, kp(rng, k)) : Math.min(c.max, 3) });
    }
    return b;
  },

  /** You hold the citadel in the middle; warlords close in from every corner and fight each other too. */
  laststand(rng, k, seats) {
    const b = new Board();
    b.disk(6);
    for (const c of b.all()) {
      const d = hexDist([c.q, c.r], [0, 0]);
      c.max = d <= 1 ? 12 : rollMax(rng, 0.25);
      if (d <= 1) Object.assign(c, { owner: 0, power: d === 0 ? Math.min(12, kp(rng, k) + 3) : kp(rng, k) });
    }
    // the citadel wall with three gates, on every other side
    const turn = rng.int(6);
    const gates = [0, 2, 4].map((i) => key(...rot([1, 0], i + turn)));
    for (const c of b.all())
      if (hexDist([c.q, c.r], [0, 0]) === 1 && !gates.includes(key(c.q, c.r)))
        for (const [dq, dr] of DIRS) if (hexDist([c.q + dq, c.r + dr], [0, 0]) === 2) b.wall([c.q, c.r], [c.q + dq, c.r + dr]);
    // warlords in the corners: one corner stays empty
    const free = rng.int(6);
    const corners = [0, 1, 2, 3, 4, 5].filter((i) => i !== free).slice(0, seats - 1);
    corners.forEach((i, n) => {
      const at = rot([6, 0], i + turn);
      for (const c of b.all()) if (hexDist([c.q, c.r], at) <= 1) Object.assign(c, { owner: n + 1, power: 3 + rng.int(2) });
    });
    // a ragged edge
    for (const c of b.all()) if (hexDist([c.q, c.r], [0, 0]) === 6 && c.owner === NEUTRAL && rng.float() < 0.3) b.remove(c.q, c.r);
    return b;
  },

  /**
   * Colossi on feet of clay: two vast empires at war, strong only along their mutual front, empty
   * (power 0) everywhere behind it. Your realm below is small but full.
   */
  titans(rng, k) {
    const b = new Board();
    for (let r = -5; r <= 5; r++) for (let x = -6; x <= 6; x++) b.add(x - Math.floor(r / 2), r, { max: rollMax(rng, 0.25) });
    for (const c of b.all()) {
      const x = c.q + Math.floor(c.r / 2);
      if (c.r >= 4 && Math.abs(x) <= 1) Object.assign(c, { owner: 0, power: Math.min(c.max, kp(rng, k)) });
      else if (c.r <= 1 && x !== 0) Object.assign(c, { owner: x < 0 ? 1 : 2, power: Math.abs(x) <= 2 ? 4 + rng.int(3) : 0 });
    }
    return b;
  },

  /** Six climbers around a mountain; its slopes are rich and walled, with one path up from each side. */
  olympus(rng, k, seats) {
    const b = new Board();
    b.disk(6);
    for (const c of b.all()) {
      const d = hexDist([c.q, c.r], [0, 0]);
      // the mountain is rich: roomy cells (up to 12), empty and free for whoever climbs first
      c.max = d <= 2 ? 12 : rollMax(rng, 0.2);
    }
    // the mountain wall: a path up in each of the six directions
    for (const c of b.all()) {
      if (hexDist([c.q, c.r], [0, 0]) !== 2 || (c.q === 0 || c.r === 0 || c.q + c.r === 0)) continue;
      for (const [dq, dr] of DIRS) if (hexDist([c.q + dq, c.r + dr], [0, 0]) === 3) b.wall([c.q, c.r], [c.q + dq, c.r + dr]);
    }
    const turn = rng.int(6);
    for (let p = 0; p < seats; p++) {
      const at = rot([5, 0], p + turn);
      for (const c of b.all())
        if (hexDist([c.q, c.r], at) <= 1 && hexDist([c.q, c.r], [0, 0]) >= 5) Object.assign(c, { owner: p, power: p === 0 ? kp(rng, k) : 3 });
    }
    for (const c of b.all()) if (hexDist([c.q, c.r], [0, 0]) === 6 && c.owner === NEUTRAL && rng.float() < 0.3) b.remove(c.q, c.r);
    return b;
  },

  /**
   * Hollow lands: the whole map is split into four equal realms, mirror images of each other. Each is
   * almost all power 0, with a front row of 1s along the borders: huge income, nothing to fight with
   * yet. Knob: more than 0 turns that many of your empty cells into 1s, less than 0 empties your front.
   */
  hollow(rng, k) {
    const b = new Board();
    const W = 5; // even rows 2W+1 cells, odd rows 2W, centred: symmetric left/right and up/down
    for (let r = -6; r <= 6; r++)
      for (let x2 = -2 * W; x2 <= 2 * W; x2++) if ((x2 + r) % 2 === 0) b.add((x2 - r) / 2, r);
    // capacities the same in all four realms
    const caps = new Map<string, number>();
    for (const c of b.all()) {
      const id = `${Math.abs(2 * c.q + c.r)},${Math.abs(c.r)}`;
      if (!caps.has(id)) caps.set(id, rollMax(rng, 0.25));
      c.max = caps.get(id)!;
    }
    // realms by quadrant; the cells on the axes are dealt out so that every realm gets as many
    const realm = (x2: number, r: number): number => {
      if (x2 === 0 && r === 0) return NEUTRAL;
      let top: boolean;
      let left: boolean;
      if (r === 0) {
        left = x2 < 0;
        top = (Math.abs(x2) / 2) % 2 === 1 ? left : !left;
      } else if (x2 === 0) {
        top = r < 0;
        left = (Math.abs(r) / 2) % 2 === 1 ? !top : top;
      } else {
        top = r < 0;
        left = x2 < 0;
      }
      // seats around the table: 0 top-left, 1 top-right, 2 bottom-right, 3 bottom-left
      return top ? (left ? 0 : 1) : left ? 3 : 2;
    };
    for (const c of b.all()) c.owner = realm(2 * c.q + c.r, c.r);
    // a front row of 1s wherever a realm touches another one
    for (const c of b.all())
      if (c.owner >= 0 && DIRS.some(([dq, dr]) => {
        const n = b.get(c.q + dq, c.r + dr);
        return !!n && n.owner >= 0 && n.owner !== c.owner;
      }))
        c.power = 1;
    const mine = b.all().filter((c) => c.owner === 0);
    if (k > 0) for (const c of rng.shuffle(mine.filter((c) => c.power === 0)).slice(0, Math.round(k))) c.power = 1;
    if (k < 0) for (const c of rng.shuffle(mine.filter((c) => c.power === 1)).slice(0, Math.round(-k))) c.power = 0;
    b.rotate(rng.int(2) * 3);
    return b;
  },

  /**
   * A raid: a wide empire of two provinces joined by a narrow waist, all of it empty (power 0) but
   * for a rim of 1s. Your small army stands just below the waist, every cell full. Cut the empire in
   * two before its income fortifies it.
   */
  raid(rng, k) {
    const b = new Board();
    for (let r = -5; r <= 5; r++) for (let x = -6; x <= 6; x++) b.add(x - Math.floor(r / 2), r, { max: rollMax(rng, 0.25) });
    const px = (c: Slot) => c.q + c.r / 2;
    const py = (c: Slot) => (c.r * Math.sqrt(3)) / 2;
    const yc = -1.7;
    const lobe = (c: Slot, x: number) => Math.hypot(px(c) - x, py(c) - yc) <= 2.4;
    for (const c of b.all()) {
      if (lobe(c, -4) || lobe(c, 4) || (Math.abs(py(c) - yc) <= 0.9 && Math.abs(px(c)) <= 4)) Object.assign(c, { owner: 1, power: 0 });
      else if (Math.hypot(px(c), py(c) - 2.6) <= 1.6) Object.assign(c, { owner: 0, power: Math.min(c.max, kp(rng, k)) });
    }
    // a rim of 1s where the empire meets anything else
    for (const c of b.all())
      if (c.owner === 1 && DIRS.some(([dq, dr]) => (b.get(c.q + dq, c.r + dr)?.owner ?? 1) !== 1)) c.power = 1;
    b.rotate(rng.bool() ? 0 : 3);
    return b;
  },
};

/**
 * Build the starting position of a scenario (deterministic for a seed). `players` replaces the
 * recommended seat types (same number of seats; seat 0 is you).
 */
export function buildScenario(id: ScenarioId, seed: number, knob = TUNING[id], players?: PlayerType[]): MatchState {
  const meta = SCENARIO_META[id];
  const seats = players ?? meta.players;
  if (seats.length !== meta.players.length) throw new Error(`${id}: ${meta.players.length} seats, got ${seats.length}`);
  const rng = new Rng(seed);
  const board = BUILDERS[id](rng, knob, seats.length);
  board.unchoke();
  const field = board.toField(meta.size);
  return createMatch(
    {
      kind: 'single',
      size: meta.size,
      players: [...seats],
      darkness: !!meta.darkness,
      symmetry: false,
      crowded: !!meta.crowded,
      unions: !!meta.unions,
      shuffle: false,
      duelRules: false,
      puzzle: id,
      ...(meta.blind ? { blind: true } : {}),
    },
    { field, keepPlacement: true, seed: seed ^ 0x5bd1e995 },
  );
}

/**
 * A new match for these settings: the scenario named in `settings.puzzle` (with the given seats and
 * kind of match), or an ordinary generated map.
 */
export function startMatch(settings: MatchSettings, seed = randomSeed()): MatchState {
  if (!isScenarioId(settings.puzzle)) return createMatch(settings, { seed });
  const st = buildScenario(settings.puzzle, seed, undefined, settings.players);
  st.settings = { ...st.settings, kind: settings.kind, turnTime: settings.turnTime };
  return st;
}
