/**
 * Scenarios: hand-designed situations (unusual maps and preset forces) instead of an ordinary start.
 * A scenario fixes the map, the number of seats and the modes; the map of the day plays it with the
 * recommended bots, the battle setup lets the player choose who sits in each seat. Each scenario is a
 * parametric builder, so every seed produces a new variation. Layouts are built in axial hex
 * coordinates and converted to the engine's odd-r grid.
 */
import { Rng, randomSeed } from './rng';
import { buildAdjacency, geometricPairs } from './field';
import { createMatch, defaultOrderComp } from './engine';
import { articulationPoints, chokePoints } from './connectivity';
import { NEUTRAL, type Cell, type Field, type FieldSize, type MatchSettings, type MatchState, type OrderComp, type PlayerType } from './types';

type Ax = [number, number]; // q, r

interface Slot {
  q: number;
  r: number;
  max: number;
  owner: number;
  power: number;
  objective?: boolean;
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
    this.cells.set(key(q, r), { q, r, max: 8, owner: NEUTRAL, power: 0, ...o });
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

  /** Only carve out terrain when the remaining board has a way around every cell. */
  carve(c: Slot): boolean {
    this.remove(c.q, c.r);
    if (this.solid()) return true;
    this.add(c.q, c.r, c);
    return false;
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

  toField(size: FieldSize): { field: Field; objectives: number[] } {
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
    const field = { size, w, h, cells, adj, walls: walls.filter(([a, b]) => geometricPairs(w, [cells[a], cells[b]]).length > 0), starts };
    // The engine addresses cells by their index AFTER sorting, not by Cell.id or axial insertion order.
    return { field, objectives: off.flatMap(({ c }, i) => c.objective ? [i] : []) };
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

// ---------------------------------------------------------------- the night drop

type LandingSize = 'L' | 'XL' | 'XXL';

/** The night drop's land for each size: a disk of this radius, drops at least `spacing` apart. */
const LANDING_SIZES: Record<LandingSize, { radius: number; spacing: number }> = {
  L: { radius: 7, spacing: 4 },
  XL: { radius: 8, spacing: 5 },
  XXL: { radius: 10, spacing: 6 },
};

/**
 * Drop spots: random, at least `spacing` apart and two steps clear of the rim (so that the open
 * ground around every drop is whole). Tries a few random orders before settling for less spacing.
 */
function landingDrops(rng: Rng, radius: number, spacing: number, seats: number): Ax[] {
  const inland: Ax[] = [];
  for (let q = -radius; q <= radius; q++) for (let r = -radius; r <= radius; r++) if (hexDist([q, r], [0, 0]) <= radius - 2) inland.push([q, r]);
  for (let gap = spacing; gap > 1; gap--)
    for (let attempt = 0; attempt < 40; attempt++) {
      const drops: Ax[] = [];
      for (let p = 0; p < seats; p++) {
        const far = inland.filter((c) => drops.every((o) => hexDist(c, o) >= gap));
        if (!far.length) break;
        drops.push(rng.pick(far));
      }
      if (drops.length === seats) return drops;
    }
  throw new Error('night drop: no room for the drops');
}

/** Extra cells and grey guards of the order compensation around the night drop's squads (no randomness). */
function landingComp(b: Board, squads: Ax[][], comp: OrderComp) {
  const ring = (squad: Ax[]) => {
    const out: Slot[] = [];
    const seen = new Set<string>();
    for (const [q, r] of squad)
      for (const [dq, dr] of DIRS) {
        const c = b.get(q + dq, r + dr);
        if (c && !seen.has(key(c.q, c.r))) {
          seen.add(key(c.q, c.r));
          out.push(c);
        }
      }
    return out.filter((c) => c.owner === NEUTRAL).sort((x, y) => x.q - y.q || x.r - y.r);
  };
  squads.forEach((squad, p) => {
    const free = ring(squad).filter((c) => c.power === 0);
    for (const c of free.slice(0, comp.extra?.[p] ?? 0)) Object.assign(c, { owner: p, power: Math.max(1, Math.min(c.max, comp.extraPower ?? 1)) });
  });
  squads.forEach((squad, p) => {
    const g = comp.grey?.[p] ?? 0;
    if (g > 0) for (const c of ring(squad)) c.power = Math.max(c.power, Math.min(c.max, g));
  });
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

/** Later scenarios: battles for three to six players, and the raid (a duel). */
export const BATTLE_SCENARIOS = ['landing', 'laststand', 'olympus', 'titans', 'hollow', 'raid'] as const;

export const NEW_SCENARIOS = ['moonvale', 'fireflies', 'crossroads', 'highlands', 'colonies', 'farshore', 'sparks', 'pinwheel'] as const;

export type ScenarioId = (typeof CLASSIC_SCENARIOS)[number] | (typeof BATTLE_SCENARIOS)[number] | (typeof NEW_SCENARIOS)[number];

/** Scenarios retired from both the gallery and all new dailies. Old daily builders remain available. */
export const RETIRED_SCENARIOS: ScenarioId[] = ['hill', 'ringmap', 'bridges', 'treasury', 'hourglass'];

/** Removed only from the gallery: already-published daily rotations still include Thermopylae. */
export const GALLERY_ONLY_RETIRED_SCENARIOS: ScenarioId[] = ['thermopylae'];

/** The scenarios in play, in the order of the setup gallery. */
export const SCENARIOS: ScenarioId[] = [BATTLE_SCENARIOS[0], ...NEW_SCENARIOS, ...BATTLE_SCENARIOS.slice(1), ...CLASSIC_SCENARIOS]
  .filter((id) => !RETIRED_SCENARIOS.includes(id) && !GALLERY_ONLY_RETIRED_SCENARIOS.includes(id));

/** A scenario that can be picked (retired ones are not). */
export function isScenarioId(id: unknown): id is ScenarioId {
  return typeof id === 'string' && (SCENARIOS as string[]).includes(id);
}

/** A known scenario, including retired ones referenced by existing games. */
export function isKnownScenarioId(id: unknown): id is ScenarioId {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(SCENARIO_META, id);
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
  /** each launch builds a genuinely different map (the setup offers "another map") */
  varied?: boolean;
  /** marked control points decide the match (hold 2 of 3 until your next turn) */
  objectives?: boolean;
  /**
   * What the player may change besides the seat types: the map size (one of `sizes`), the number of
   * seats (`seats` = [fewest, most], you included) and the listed modes. The rest stays fixed. The map
   * of the day always plays the defaults (`size`, `players`, the modes above).
   */
  configurable?: { sizes: FieldSize[]; seats: [number, number]; modes: ScenarioMode[] };
}

/** A mode a configurable scenario lets the player switch. */
export type ScenarioMode = 'unions';

function scoutRadius(id: 'moonvale' | 'fireflies', size: FieldSize, seats: number): number {
  const base = id === 'moonvale' ? { L: 6, XL: 8, XXL: 10 } : { L: 6, XL: 7, XXL: 9 };
  return (base as Partial<Record<FieldSize, number>>)[size]! + (seats === 2 ? -1 : seats >= 6 ? 2 : seats >= 4 ? 1 : 0);
}

/** The player's choices for a configurable scenario (missing: the scenario's default). */
export interface ScenarioConfig {
  size?: FieldSize;
  unions?: boolean;
  /**
   * Turn-order compensation of the night drop and the equal-seat scenarios (missing: their default;
   * 'off': none, as past maps of the day were built). Scenarios with their own seats ignore it.
   */
  orderComp?: OrderComp | 'off';
  /** night drop: your squad is like the others (no knob), for measuring the turn order alone */
  even?: boolean;
}

/** What a builder gets besides the knob, the seats and the size. */
interface BuildExtras {
  comp: OrderComp | null;
  even: boolean;
}

export const SCENARIO_META: Record<ScenarioId, ScenarioMeta> = {
  siege: { players: ['human', 'master'], level: 4, size: 'L' },
  cauldron: { players: ['human', 'master'], level: 3, size: 'L' },
  bastion: { players: ['human', 'master'], level: 4, size: 'L' },
  archipelago: { players: ['human', 'god', 'master'], level: 4, size: 'L', configurable: { sizes: ['L'], seats: [3, 6], modes: [] } },
  labyrinth: { players: ['human', 'master'], level: 4, size: 'L' },
  spiral: { players: ['human', 'master'], level: 4, size: 'L' },
  twofronts: { players: ['human', 'god', 'master'], level: 4, size: 'L' },
  greysea: { players: ['human', 'master'], level: 3, size: 'L' },
  checker: { players: ['human', 'master'], level: 4, size: 'M' },
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
  landing: {
    varied: true,
    players: ['human', 'god', 'master', 'hunter', 'master', 'hunter'],
    level: 3,
    size: 'XL',
    darkness: true,
    blind: true,
    configurable: { sizes: ['L', 'XL', 'XXL'], seats: [3, 6], modes: ['unions'] },
  },
  laststand: { players: ['human', 'master', 'hunter', 'god', 'hunter', 'master'], level: 4, size: 'L' },
  titans: { players: ['human', 'master', 'master'], level: 3, size: 'L', unions: true },
  olympus: { objectives: true, players: ['human', 'master', 'hunter', 'god', 'hunter', 'master'], level: 3, size: 'L', configurable: { sizes: ['L'], seats: [3, 6], modes: [] } },
  hollow: { players: ['human', 'master', 'god', 'master'], level: 2, size: 'L' },
  raid: { players: ['human', 'master'], level: 4, size: 'L' },
  farshore: { players: ['human', 'master'], level: 3, size: 'L' },
  moonvale: { varied: true, players: ['human', 'master', 'hunter'], level: 3, size: 'L', darkness: true, blind: true, configurable: { sizes: ['L', 'XL', 'XXL'], seats: [2, 6], modes: [] } },
  sparks: { varied: true, objectives: true, players: ['human', 'master', 'hunter'], level: 3, size: 'M', crowded: true },
  fireflies: { varied: true, players: ['human', 'hunter', 'hunter'], level: 2, size: 'XL', darkness: true, blind: true, configurable: { sizes: ['L', 'XL', 'XXL'], seats: [2, 6], modes: [] } },
  crossroads: { varied: true, objectives: true, players: ['human', 'master'], level: 3, size: 'L' },
  highlands: { varied: true, objectives: true, players: ['human', 'master', 'hunter'], level: 3, size: 'L', configurable: { sizes: ['L'], seats: [2, 6], modes: [] } },
  colonies: { varied: true, players: ['human', 'master'], level: 3, size: 'L' },
  pinwheel: { players: ['human', 'master', 'hunter'], level: 3, size: 'M' },
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
  checker: 2.2,
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
  landing: 6.25,
  laststand: 6,
  olympus: 4.5,
  titans: 6,
  hollow: 0,
  raid: 3.45,
  // Design defaults (not simulation-calibrated). Sparks deals the same hand to every seat.
  farshore: 5,
  moonvale: 7,
  sparks: 7,
  fireflies: 2,
  crossroads: 5,
  highlands: 6,
  colonies: 4,
  pinwheel: 8,
};

/** Knobs of a configurable scenario on its other sizes (TUNING holds the one of the default size). */
export const SIZE_TUNING: Partial<Record<ScenarioId, Partial<Record<FieldSize, number>>>> = {
  // newer scenarios aim at Master in your seat winning about 55–65%; on XXL the drops are farther apart.
  // Recalibrated with the turn-order compensation of the bots' squads (Master in your seat against the
  // recommended line-up, 480 games per size: L 6.75 → 64%, XL 6.25 → 58%, XXL 7 → 61%)
  landing: { L: 6.75, XXL: 7 },
};

/** Knobs the maps of the day were published with, where the gallery's have since been recalibrated. */
const DAILY_KNOB: Partial<Record<ScenarioId, number>> = { crossroads: 6, colonies: 7 };

/** The knob for a scenario on a map size. */
export function scenarioKnob(id: ScenarioId, size: FieldSize = SCENARIO_META[id].size): number {
  return SIZE_TUNING[id]?.[size] ?? TUNING[id];
}

/** Whether a configurable scenario can be played with this many seats (others: exactly the recommended). */
export function seatsFit(id: ScenarioId, n: number): boolean {
  const m = SCENARIO_META[id];
  return m.configurable ? n >= m.configurable.seats[0] && n <= m.configurable.seats[1] : n === m.players.length;
}

/** The size and modes a scenario is played with: the player's choices where it allows them, else its own. */
export function scenarioSetup(id: ScenarioId, config: ScenarioConfig = {}): { size: FieldSize; unions: boolean } {
  const m = SCENARIO_META[id];
  const c = m.configurable;
  return {
    size: c && config.size && c.sizes.includes(config.size) ? config.size : m.size,
    unions: c?.modes.includes('unions') && config.unions !== undefined ? config.unions : !!m.unions,
  };
}

/**
 * Scenarios whose map of the day differs in rules or layout from the gallery version: the day keeps
 * the old description (puzzleDescDaily_<id>) next to its frozen map.
 */
export const DAILY_LEGACY_DESC: ReadonlySet<ScenarioId> = new Set<ScenarioId>(['sparks', 'olympus', 'highlands', 'moonvale']);

type LegacyBuilder = (rng: Rng, k: number, seats: number) => Board;

/**
 * Frozen map builders for published dailies: gallery terrain can evolve without altering a date. Every
 * map of the day of a scenario listed here is built by its frozen copy (with the day's default seats).
 */
const LEGACY_BUILDERS: Partial<Record<ScenarioId, LegacyBuilder>> = {
  crossroads(rng: Rng, k: number) {
    const b = new Board();
    const reach = 4 + rng.int(2);
    const halfWidth = 7 + rng.int(2);
    const gap = 2 + rng.int(2);
    for (let r = -reach - 1; r <= reach + 1; r++) {
      for (let x = -halfWidth; x <= halfWidth; x++) {
        if (Math.abs(r) === 2 && Math.abs(x) <= gap) continue;
        b.add(x - Math.floor(r / 2), r, { max: rollMax(rng) });
      }
    }
    for (const r of [-reach, 0, reach]) {
      const x = rng.range(-1, Math.abs(r) % 2 ? 1 : 2);
      b.set(x - Math.floor(r / 2), r, { objective: true, max: 12 });
    }
    for (const p of [0, 1]) for (const inset of [0, 1]) {
      b.set((p ? 1 : -1) * (halfWidth - inset), 0, { owner: p, power: p ? 5 : kp(rng, k) });
    }
    return b;
  },
  highlands(rng: Rng, k: number, seats: number) {
    const b = new Board();
    const reach = 4 + rng.int(2);
    const lake = 1 + rng.int(2);
    const turn = rng.int(6);
    b.disk(reach + 2);
    for (const c of b.all()) {
      if (hexDist([c.q, c.r], [0, 0]) <= lake) b.remove(c.q, c.r);
      else c.max = rollMax(rng);
    }
    for (let p = 0; p < seats; p++) {
      const side = turn + 2 * p;
      const peak = rot([reach, 0], side);
      for (const c of b.all()) if (hexDist([c.q, c.r], peak) <= 1) Object.assign(c, { max: 12, power: 2 });
      b.set(...peak, { objective: true, power: 3 });
      for (const at of [[reach, 0], [reach + 1, 0]] as Ax[]) b.set(...rot(at, side + 1), { owner: p, power: p ? 5 : kp(rng, k) });
    }
    return b;
  },
  moonvale(rng: Rng, k: number, seats: number) {
    const b = new Board();
    b.disk(6);
    for (const c of b.all()) c.max = rollMax(rng);
    const turn = rng.int(6);
    const scout: Ax = [2, -3 - rng.int(2)];
    for (let p = 0; p < seats; p++) {
      const side = turn + 2 * p;
      for (const at of [[5, 0], [4, 0], [4, 1]] as Ax[]) b.set(...rot(at, side), { owner: p, power: p ? 6 : kp(rng, k) });
      b.set(...rot(scout, side), { owner: p, power: 2 });
    }
    return b;
  },
  sparks(rng: Rng, k: number) {
    const b = new Board();
    b.disk(4);
    b.remove(0, 0);
    const triples: Ax[][] = [];
    for (const c of b.all()) {
      const triple = [0, 2, 4].map(turn => rot([c.q, c.r], turn));
      if (triple.every(([q, r]) => q > c.q || (q === c.q && r >= c.r))) triples.push(triple);
    }
    rng.shuffle(triples).forEach((triple, n) => {
      const first = rng.int(3);
      const power = n % 4 === 0 ? kp(rng, k) : 1 + rng.int(2);
      const max = rollMax(rng);
      triple.forEach((at, i) => b.set(...at, { owner: (first + i) % 3, power, max }));
    });
    return b;
  },
  fireflies(rng: Rng, k: number, seats: number) {
    const b = new Board();
    b.disk(7);
    for (const c of b.all()) c.max = rollMax(rng);
    rng.shuffle(landingDrops(rng, 7, 3, 3 * seats)).forEach((at, i) => {
      const owner = i % seats;
      b.set(...at, { owner, power: owner ? 2 : kp(rng, k) });
    });
    return b;
  },
  colonies(rng: Rng, k: number) {
    const b = new Board();
    b.disk(8);
    for (const c of b.all()) c.max = rollMax(rng);
    const turn = rng.int(6);
    for (const p of [0, 1]) {
      const home = rot([p ? 3 : -3, -2], turn);
      for (const c of b.all()) if (hexDist([c.q, c.r], home) <= 2)
        Object.assign(c, { owner: p, power: p ? 7 : kp(rng, k) });
    }
    for (const r of [4, 6]) for (const q of [-5, -2, 1]) {
      b.set(...rot([q, r], turn), { owner: 0, power: 2 });
      b.set(...rot([q + 1, r], turn), { owner: 1, power: 2 });
    }
    return b;
  },
  /** Six climbers around a mountain; its slopes are rich and walled, with one path up from each side. */
  olympus(rng, k, seats) {
    const b = new Board();
    b.disk(6);
    for (const c of b.all()) {
      const d = hexDist([c.q, c.r], [0, 0]);
      c.max = d <= 2 ? 12 : rollMax(rng, 0.2);
    }
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
};

/**
 * The sides (k × 60°) of `seats` evenly spread seats: three and six are fully symmetric, four sit in
 * two facing pairs (0 1 · 3 4), five leave one side empty.
 */
function seatSides(seats: number, turn: number): number[] {
  return Array.from({ length: seats }, (_, p) => turn + Math.floor((p * 6) / seats));
}

// ---------------------------------------------------------------- symmetric layouts

type Sym = (a: Ax) => Ax;

/** Mirror an axial vector in the line at k × 30° through the middle. */
function mirror(a: Ax, k: number): Ax {
  return rot([a[0] + a[1], -a[1]], k);
}

/**
 * Symmetries that carry every seat on the sides seatSides(seats, 0) onto every other: three seats
 * turn, four are swapped pairwise across the two lines between them, two mirror each other, five and
 * six use the six-seat group (rotations by 120° and the mirrors between neighbours).
 */
function seatSymmetries(seats: number): Sym[] {
  const r = (k: number): Sym => (a) => rot(a, k);
  const m = (k: number): Sym => (a) => mirror(a, k);
  if (seats === 2) return [r(0), m(3)];
  if (seats === 3) return [r(0), r(2), r(4)];
  if (seats === 4) return [r(0), r(3), m(1), m(4)];
  return [r(0), r(2), r(4), m(1), m(3), m(5)];
}

function orbit(a: Ax, syms: Sym[]): Ax[] {
  const out = new Map<string, Ax>();
  for (const f of syms) {
    const b = f(a);
    out.set(key(...b), b);
  }
  return [...out.values()];
}

/** Breadth-first distances on the board graph (walls respected), by key. */
function boardDistances(b: Board, from: Ax[]): Map<string, number> {
  const { keys, index, adj } = b.graph();
  const d = new Map<string, number>();
  const queue = from.map((a) => index.get(key(...a))).filter((i): i is number => i !== undefined);
  for (const i of queue) d.set(keys[i], 0);
  for (let n = 0; n < queue.length; n++)
    for (const j of adj[queue[n]])
      if (!d.has(keys[j])) {
        d.set(keys[j], d.get(keys[queue[n]])! + 1);
        queue.push(j);
      }
  return d;
}

/** Roll every cell's capacity once per symmetric set of cells. */
function symmetricMaxes(b: Board, rng: Rng, syms: Sym[], big = 0.3) {
  const rolled = new Set<string>();
  for (const c of b.all()) {
    if (rolled.has(key(c.q, c.r))) continue;
    const max = rollMax(rng, big);
    for (const at of orbit([c.q, c.r], syms)) {
      rolled.add(key(...at));
      b.set(...at, { max });
    }
  }
}

/** Apply a change to a cell and all its symmetric copies. */
function symmetricSet(b: Board, syms: Sym[], c: Ax, f: (s: Slot) => void) {
  for (const at of orbit(c, syms)) {
    const s = b.get(...at);
    if (s) f(s);
  }
}

/** Remove a cell and its copies, unless one is kept or that leaves a cell holding the land together. */
function symmetricDig(b: Board, syms: Sym[], c: Ax, keep: (s: Slot) => boolean): boolean {
  const cells = orbit(c, syms).map((a) => b.get(...a)).filter((s): s is Slot => !!s);
  if (!cells.length || cells.some(keep)) return false;
  cells.forEach((s) => b.remove(s.q, s.r));
  if (b.solid()) return true;
  cells.forEach((s) => b.add(s.q, s.r, s));
  return false;
}

/**
 * Up to `ridges` straight walls three to five cells long, each with a pass, copied by the symmetries;
 * a ridge that would leave a cell holding the land together is dropped. No wall touches a `clear` cell.
 */
function symmetricRidges(b: Board, rng: Rng, syms: Sym[], keep: (s: Slot) => boolean, ridges: number, clear?: (s: Slot) => boolean) {
  for (let n = 0; n < ridges * 4; n++) {
    const start = rng.pick(b.all().filter((c) => !keep(c)));
    const d = rng.int(6);
    const length = 3 + rng.int(3);
    const edges: [Ax, Ax][] = [];
    for (let i = 0; i < length; i++) {
      const at: Ax = [start.q + DIRS[d][0] * i, start.r + DIRS[d][1] * i];
      if (i === 1 + rng.int(length - 1)) continue; // a pass
      for (const e of [DIRS[(d + 1) % 6], DIRS[(d + 2) % 6]]) {
        const to: Ax = [at[0] + e[0], at[1] + e[1]];
        const [x, y] = [b.get(...at), b.get(...to)];
        if (!x || !y || (clear && (clear(x) || clear(y)))) continue;
        for (const f of syms) edges.push([f(at), f(to)]);
      }
    }
    // no stray stubs: a ridge runs at least three cells along
    if (edges.length < 4 * syms.length) continue;
    const before = b.walls.length;
    for (const [x, y] of edges) b.wall(x, y);
    if (!b.solid()) b.walls.length = before;
    else if (--ridges <= 0) break;
  }
}

/**
 * One try at a highlands board in the seats' own frame (null: rejected, roll again). `plain`: the last
 * resort, no terrain and the simplest summits, which always pass.
 */
function highlandsAttempt(rng: Rng, k: number, seats: number, radius: number, syms: Sym[], plain: boolean): Board | null {
  const b = new Board();
  b.disk(radius);
  // capacities are rolled once per symmetric set of cells: every camp has the same land around it
  symmetricMaxes(b, rng, syms);
  const sides = seatSides(seats, 0);
  const camps = sides.map((side) => [rot([radius - 2, 0], side), rot([radius - 1, 0], side)]);
  // the summits: a set of three that the seats' symmetries keep
  const t = 2 + rng.int(2);
  let summits: Ax[];
  if (plain) summits = seats === 2 ? [[0, 0], [-2, 4], [2, -4]] : seats === 4 ? [[0, 0], [2, 2], [-2, -2]] : [0, 2, 4].map((i) => rot([2, 2], i));
  else if (seats === 3) {
    // anywhere: a central triangle, peaks between the camps or right above them
    const spots = b.all().filter((c) => { const d = hexDist([c.q, c.r], [0, 0]); return d >= 2 && d <= radius - 3; });
    const at = rng.pick(spots);
    summits = [0, 2, 4].map((i) => rot([at.q, at.r], i));
  } else if (seats === 2) {
    // a ridge across the valley between the camps, or one summit on it and a pair of flanks
    const line: Ax = [-t, 2 * t];
    if (rng.bool()) summits = [[0, 0], line, [-line[0], -line[1]]];
    else {
      const crest: Ax = rng.bool() ? [0, 0] : [-1, 2];
      const flank = rng.pick(b.all().filter((c) => hexDist([c.q, c.r], [0, 0]) >= 3 && hexDist([c.q, c.r], [0, 0]) <= radius - 2 && orbit([c.q, c.r], syms).length === 2));
      summits = [crest, ...orbit([flank.q, flank.r], syms)];
    }
  } else if (seats === 4) {
    // the heart and two summits in the narrow or in the wide gaps between the camps
    const v: Ax = rng.bool() ? [t, t] : [-(t + 2), t + 2];
    summits = [[0, 0], v, [-v[0], -v[1]]];
  } else {
    // a central triangle or shrines on the passes between neighbouring camps
    summits = [0, 2, 4].map((i) => rot([t, t], i));
  }
  if (summits.some((a) => !b.get(...a)) || new Set(summits.map((a) => key(...a))).size !== 3) return null;
  const near = (c: Slot, list: Ax[], d: number) => list.some((a) => hexDist([c.q, c.r], a) <= d);
  const campCells = camps.flat();
  const keep = (c: Slot) => near(c, campCells, 2) || near(c, summits, 1);
  // every summit is a roomy peak among roomy slopes with a small garrison
  for (const c of b.all()) if (near(c, summits, 1)) Object.assign(c, { max: 12, power: 2 });
  for (const a of summits) b.set(...a, { objective: true, power: 3 });
  const everywhere = (c: Ax, f: (s: Slot) => void) => symmetricSet(b, syms, c, f);
  const dig = (c: Ax) => symmetricDig(b, syms, c, keep);
  if (!plain) {
    const centre = summits.some((a) => hexDist(a, [0, 0]) <= 2);
    const terrain = rng.int(3);
    if (terrain === 0 && !centre) {
      // a lake in the middle, with coves
      const lake = 1 + rng.int(2);
      for (const c of b.all()) if (hexDist([c.q, c.r], [0, 0]) <= lake && !keep(c)) b.remove(c.q, c.r);
      for (const c of rng.shuffle(b.all().filter((c) => hexDist([c.q, c.r], [0, 0]) === lake + 1)).slice(0, rng.int(3))) dig([c.q, c.r]);
    } else if (terrain === 1) {
      // a broad plateau, garrisoned
      const plateau = centre ? 1 : 1 + rng.int(2);
      for (const c of b.all()) if (hexDist([c.q, c.r], [0, 0]) <= plateau && !c.objective) Object.assign(c, { max: 12, power: Math.max(c.power, 3) });
    } else {
      // ridges: walls with passes, and a few sinkholes
      symmetricRidges(b, rng, syms, keep, 1 + rng.int(3));
      let holes = rng.int(3);
      for (const c of rng.shuffle(b.all()).slice(0, 12)) {
        if (holes <= 0) break;
        if (dig([c.q, c.r])) holes--;
      }
    }
    // garrisons on some approaches, a ragged rim
    for (const c of rng.shuffle(b.all().filter((c) => !keep(c) && c.power === 0 && near(c, summits, 3))).slice(0, 1 + rng.int(2))) {
      const power = 2 + rng.int(3);
      everywhere([c.q, c.r], (s) => { s.power = Math.min(s.max, power); });
    }
    for (const c of rng.shuffle(b.all().filter((c) => hexDist([c.q, c.r], [0, 0]) === radius)).slice(0, rng.int(4))) dig([c.q, c.r]);
  }
  // the camps: two cells on the axis, below the slopes
  camps.forEach((camp, p) => camp.forEach((at) => b.set(...at, { owner: p, power: p ? 5 : kp(rng, k), max: 8 })));
  // the walls stop at the summits: each keeps four ways in
  const { index, adj } = b.graph();
  if (summits.some((a) => adj[index.get(key(...a))!].length < 4) || !b.solid()) return null;
  const from = summits.map((a) => boardDistances(b, [a]));
  if (from.some((d, i) => summits.some((a, j) => i !== j && (d.get(key(...a)) ?? 0) < 4))) return null;
  // climb[camp][summit]: steps from the camp up to the summit
  const climb = camps.map((camp) => from.map((d) => Math.min(...camp.map((c) => d.get(key(...c)) ?? Infinity))));
  const sorted = climb.map((c) => [...c].sort((x, y) => x - y));
  if (sorted.some((c) => c[0] < 3 || !Number.isFinite(c[2]))) return null;
  // with three or more camps each summit lies between at least two of them (five: one gap is empty)
  if (seats >= 3 && seats !== 5 && summits.some((_, i) => { const reach = climb.map((c) => c[i]).sort((x, y) => x - y); return reach[1] - reach[0] > 2; })) return null;
  if (seats !== 5 && new Set(sorted.map(String)).size !== 1) return null;
  return b;
}

/** The symmetry that carries side 0 onto this side. */
function symToSide(syms: Sym[], side: number): Sym {
  return syms.find((f) => key(...f([1, 0])) === key(...rot([1, 0], side)))!;
}

/** One try at a moonless valley in the seats' own frame (null: rejected, roll again). */
function moonvaleAttempt(rng: Rng, k: number, seats: number, radius: number, syms: Sym[]): Board | null {
  const b = new Board();
  b.disk(radius);
  // the valley is mostly poor ground, so that the clearings stand out
  symmetricMaxes(b, rng, syms, 0.12);
  const sides = seatSides(seats, 0);
  const camp0: Ax[] = [[radius - 1, 0], [radius - 2, 0], [radius - 2, 1]];
  // every place a camp could be (five seats: the sixth stays empty, but nothing is built there)
  const anyCamp = syms.flatMap((f) => camp0.map(f));
  const camps = sides.map((side) => camp0.map(symToSide(syms, side)));
  const ax = (c: Slot): Ax => [c.q, c.r];
  const apart = (list: Ax[], d: number) => list.every((a, i) => list.every((o, j) => i === j || hexDist(a, o) >= d));
  // the clearing: seven roomy cells (sometimes a ruin in the middle), not too close to any camp; one
  // on a line of symmetry is shared by the two seats it lies between
  const glades = b.all().filter((c) => {
    const spots = orbit(ax(c), syms);
    return spots.length * 2 >= syms.length && apart(spots, 3) && spots.every((g) => anyCamp.every((a) => hexDist(g, a) >= 4)) &&
      hexDist(ax(c), [0, 0]) >= 2 && hexDist(ax(c), [0, 0]) <= radius - 1;
  });
  if (!glades.length) return null;
  const glade = ax(rng.pick(glades));
  const glades0 = orbit(glade, syms);
  // the scout: one step from its clearing, off the rim, three clear of every camp and every other scout
  const scouts = b.all().filter((c) => {
    const spots = orbit(ax(c), syms);
    return hexDist(ax(c), glade) === 2 && hexDist(ax(c), [0, 0]) <= radius - 2 && spots.length === syms.length && apart(spots, 3) &&
      spots.every((s) => anyCamp.every((a) => hexDist(s, a) >= 3) && glades0.every((g) => hexDist(s, g) >= 2));
  });
  if (!scouts.length) return null;
  const scout = ax(rng.pick(scouts));
  const scouts0 = orbit(scout, syms);
  const near = (c: Slot, list: Ax[], d: number) => list.some((a) => hexDist(ax(c), a) <= d);
  const keep = (c: Slot) => near(c, anyCamp, 2) || near(c, scouts0, 2) || near(c, glades0, 1);
  const ruin = rng.int(3) === 0 ? 3 : 0;
  for (const c of b.all()) if (near(c, glades0, 1)) Object.assign(c, { max: 12, power: 0 });
  for (const g of glades0) b.set(...g, { power: ruin });
  // the middle: a lake, a rich meadow or a ruin
  const middle = rng.int(3);
  const core = b.all().filter((c) => hexDist(ax(c), [0, 0]) <= 1 && !keep(c));
  if (middle === 0) core.forEach((c) => b.remove(c.q, c.r));
  else if (middle === 1) core.forEach((c) => Object.assign(c, { max: 12, power: 0 }));
  else core.forEach((c) => Object.assign(c, { max: 12, power: hexDist(ax(c), [0, 0]) ? 3 : 5 }));
  if (!b.solid()) return null;
  // ridges with passes and small lakes make corridors, ruins guard some of them
  symmetricRidges(b, rng, syms, keep, 1 + rng.int(3), (c) => near(c, anyCamp, 1) || near(c, scouts0, 1) || near(c, glades0, 1));
  const land = b.cells.size;
  for (let i = 0; i < Math.round(land / 10 / syms.length); i++) {
    const c = rng.pick(b.all());
    symmetricDig(b, syms, ax(c), keep);
  }
  for (const c of rng.shuffle(b.all().filter((c) => !keep(c) && c.power === 0 && hexDist(ax(c), [0, 0]) > 1)).slice(0, Math.round((b.cells.size * 0.06) / syms.length))) {
    const power = 2 + rng.int(3);
    symmetricSet(b, syms, ax(c), (s) => { if (!keep(s)) s.power = Math.min(s.max, power); });
  }
  camps.forEach((camp, p) => camp.forEach((at) => b.set(...at, { owner: p, power: p ? 6 : kp(rng, k) })));
  sides.forEach((side, p) => b.set(...symToSide(syms, side)(scout), { owner: p, power: 2 }));
  return b.solid() ? b : null;
}

const BUILDERS: Record<ScenarioId, (rng: Rng, k: number, seats: number, size: FieldSize, extras: BuildExtras) => Board> = {
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

  /**
   * Islands joined by thin bridges, one per seat; a rich neutral island in the middle. Three islands
   * keep the classic map; four to six lie farther out (four: two facing pairs, five: one place empty).
   */
  archipelago(rng, k, seats) {
    const b = new Board();
    const turn = rng.int(6);
    const centres: Ax[] = seatSides(seats, turn).map((side) => rot(seats === 3 ? [5, -2] : [7, -3], side));
    b.disk(1, [0, 0], { max: 12 });
    centres.forEach((c, i) => {
      b.disk(2, c);
      for (const s of b.all()) if (hexDist([s.q, s.r], c) <= 2) s.max = s.max === 12 ? 12 : rollMax(rng, 0.25);
      b.line([0, 0], c);
      b.line(c, centres[(i + 1) % seats]);
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

  /** Two secure inland bases, but both players already have a stake on both distant shores. */
  farshore(rng, k) {
    const b = new Board();
    b.disk(6);
    const coast = 4 + rng.int(2);
    const turn = rng.int(6);
    for (const c of b.all()) c.max = rollMax(rng);
    for (const p of [0, 1]) {
      const home = rot([5, 0], turn + 3 * p);
      for (const c of b.all()) if (hexDist([c.q, c.r], home) <= 1) Object.assign(c, { owner: p, power: p ? 4 : kp(rng, k) });
      // Four alternating flags on each shore; a garrison faces a weak neighbour at either end.
      for (let j = 0; j < 4; j++) {
        const at = rot([j - 4, coast], turn + 3 * p);
        b.set(...at, { owner: (p + j) % 2, power: j === 0 || j === 3 ? 6 : 2 });
      }
    }
    return b;
  },

  /**
   * Each seat has a fighting squad on the rim and a lone pair of eyes out in the valley, a few steps
   * from a rich clearing of its own. Ridges, lakes and ruins cut the dark valley into corridors; the
   * middle holds a lake, a meadow or a ruin. Laid out once and copied by the seats' symmetries.
   */
  moonvale(rng, k, seats, size) {
    // five seats get the six-seat valley (the sixth camp's place stays empty)
    const radius = scoutRadius('moonvale', size, seats === 5 ? 6 : seats);
    const turn = rng.int(6);
    const syms = seatSymmetries(seats);
    for (let attempt = 0; attempt < 30; attempt++) {
      const b = moonvaleAttempt(rng, k, seats, radius, syms);
      if (b) {
        b.rotate(turn);
        return b;
      }
    }
    throw new Error(`moonvale: no layout for ${seats} seats`);
  },

  /** Three rotationally balanced realms, with different broad landforms and clustered flashpoints. */
  sparks(rng, k) {
    const b = new Board();
    const shape = rng.int(3);
    b.disk(shape === 2 ? 3 : 4);
    // (every shape keeps the middle empty: the three-way deal needs no cell on the rotation's fixed point)
    if (shape === 0) for (const c of b.all()) if (hexDist([c.q, c.r], [0, 0]) <= 1) b.remove(c.q, c.r); // a ring road
    if (shape === 1) {
      // a trefoil: three headlands between three deep bays
      b.remove(0, 0);
      for (const turn of [0, 2, 4]) b.disk(1, rot([4, 0], turn));
      for (const turn of [1, 3, 5]) for (const c of b.all()) if (hexDist([c.q, c.r], rot([4, 0], turn)) <= 1) b.remove(c.q, c.r);
    }
    if (shape === 2) {
      // three rival lobes around a common hub
      b.remove(0, 0);
      for (const turn of [0, 2, 4]) b.disk(2, rot([4, 0], turn));
    }
    const triples: Ax[][] = [];
    for (const c of b.all()) {
      const triple = [0, 2, 4].map(turn => rot([c.q, c.r], turn));
      if (triple.every(([q, r]) => q > c.q || (q === c.q && r >= c.r))) triples.push(triple);
    }
    const first = rng.int(3);
    // Two compact hotspots (an inner flashpoint and an outer stronghold) of three strong roomy cells,
    // and a weak but roomy pocket of 1s worth growing into; the rest of the deal is light (1–2).
    // a triangle of three touching cells around a random cell at this distance from the middle
    const spot = (distance: number): string[] => {
      const shapes = triples.filter(triple => hexDist(triple[0], [0, 0]) === distance).flatMap(([at]) =>
        [0, 1, 2, 3, 4, 5].map(t => [at, ...[t, t + 1].map(i => DIRS[i % 6]).map(([dq, dr]) => [at[0] + dq, at[1] + dr] as Ax)]))
        .filter(cells => cells.every(c => b.get(...c)));
      return rng.pick(shapes).map(c => key(...c));
    };
    const hotSpots = [...spot(2), ...spot(shape === 2 ? 5 : 4)];
    const weakSpot = spot(3);
    for (const triple of triples) {
      const hot = triple.some(c => hotSpots.includes(key(...c)));
      const weak = !hot && triple.some(c => weakSpot.includes(key(...c)));
      const power = hot ? kp(rng, k) : weak ? 1 : 1 + rng.int(2);
      const max = hot || weak ? 12 : rollMax(rng);
      triple.forEach((at, i) => b.set(...at, { owner: (first + i) % 3, power, max }));
    }
    // Each realm keeps one spark deep in its own land (the same spot turned for every seat): win by
    // holding your spark and a rival's until your next turn. Never on a cell that holds the map together.
    const { keys, adj } = b.graph();
    const cuts = new Set(articulationPoints(adj).map(i => keys[i]));
    const buried = triples.filter(triple => triple.every(([q, r]) => {
      const owner = b.get(q, r)!.owner;
      return !cuts.has(key(q, r)) && DIRS.every(([dq, dr]) => b.get(q + dq, r + dr)?.owner === owner);
    }));
    const sparks = rng.pick(buried);
    const garrison = 3 + rng.int(3);
    for (const at of sparks) b.set(...at, { objective: true, power: garrison, max: 12 });
    return b;
  },

  /** No squads and no stronghold: only little pools of light, each with an open escape route. */
  fireflies(rng, k, seats, size) {
    const radius = scoutRadius('fireflies', size, seats);
    const b = new Board();
    b.disk(radius);
    for (const c of b.all()) c.max = rollMax(rng);
    rng.shuffle(landingDrops(rng, radius, 3, 3 * seats)).forEach((at, i) => {
      const owner = i % seats;
      b.set(...at, { owner, power: owner ? 2 : kp(rng, k) });
    });
    return b;
  },

  /** Three broad approaches through straight, staggered, or double bands of rough terrain. */
  crossroads(rng, k) {
    const b = new Board();
    const reach = 4 + rng.int(2);
    const halfWidth = 7 + rng.int(2);
    const gap = 2 + rng.int(2);
    const banks = [[-2, 2], [-3, 2], [-3, -2, 2, 3]][rng.int(3)];
    for (let r = -reach - 1; r <= reach + 1; r++) {
      for (let x = -halfWidth; x <= halfWidth; x++) {
        if (banks.includes(r) && Math.abs(x) <= gap) continue;
        b.add(x - Math.floor(r / 2), r, { max: rollMax(rng) });
      }
    }
    for (const r of [-reach, 0, reach]) {
      // Odd rows sit half a hex to the right: keep every crossing within one hex of the midline.
      const x = rng.range(-1, Math.abs(r) % 2 ? 1 : 2);
      b.set(x - Math.floor(r / 2), r, { objective: true, max: 12 });
    }
    for (const p of [0, 1]) for (const inset of [0, 1]) {
      b.set((p ? 1 : -1) * (halfWidth - inset), 0, { owner: p, power: p ? 5 : kp(rng, k) });
    }
    // Uneven outer banks and clearings distinguish the three broad approaches between games.
    const edges = rng.shuffle(b.all().filter(c =>
      Math.abs(c.r) >= 3 && Math.abs(c.q + Math.floor(c.r / 2)) >= halfWidth - 1));
    for (const c of edges.slice(0, 3 + rng.int(9))) b.carve(c);
    return b;
  },

  /**
   * Camps at the foot of the mountains, three marked summits in a new arrangement every launch, and a
   * central lake, a garrisoned plateau or ridges with passes between them. Everything (summits,
   * terrain, capacities, garrisons) is laid out once and copied by the symmetries that carry every camp
   * onto every other, so each seat faces the same climb (five seats: the six-seat layout, one camp empty).
   */
  highlands(rng, k, seats) {
    const radius = (seats === 2 ? 5 : seats === 3 ? 6 : 7) + rng.int(2);
    const turn = rng.int(6);
    const syms = seatSymmetries(seats);
    for (let attempt = 0; attempt <= 40; attempt++) {
      const b = highlandsAttempt(rng, k, seats, radius, syms, attempt === 40);
      if (b) {
        b.rotate(turn);
        return b;
      }
    }
    throw new Error(`highlands: no layout for ${seats} seats`);
  },

  /** Two neighboring strongholds face each other; many small rival colonies share the southern flank. */
  colonies(rng, k) {
    const b = new Board();
    b.disk(8);
    for (const c of b.all()) c.max = rollMax(rng);
    const turn = rng.int(6);
    for (const p of [0, 1]) {
      const home = rot([p ? 3 : -3, -2], turn);
      for (const c of b.all()) if (hexDist([c.q, c.r], home) <= 2)
        Object.assign(c, { owner: p, power: p ? 7 : kp(rng, k) });
    }
    // A solid off-axis patch dealt like crowded land: both sides get as many colonies and the same
    // powers. Of a few balanced shuffles, the one with the most, smallest same-side colonies is kept, so the
    // flank is thoroughly mixed rather than a second front or a row of isolated flags.
    const patch: Ax[] = [];
    for (let r = 4; r <= 7; r++) for (let q = -5; q <= 1; q++) patch.push(rot([q, r], turn));
    const clumping = (owner: Map<string, number>) => {
      let score = 0;
      const colonies = [0, 0];
      const seen = new Set<string>();
      for (const at of patch) {
        if (seen.has(key(...at))) continue;
        seen.add(key(...at));
        const stack = [at];
        let size = 0;
        while (stack.length) {
          const [q, r] = stack.pop()!;
          size++;
          for (const [dq, dr] of DIRS) {
            const n = key(q + dq, r + dr);
            if (owner.get(n) === owner.get(key(q, r)) && !seen.has(n)) {
              seen.add(n);
              stack.push([q + dq, r + dr]);
            }
          }
        }
        score += size * size;
        colonies[owner.get(key(...at))!]++;
      }
      // every side should own several separate colonies, not one sprawling second front
      return score + (Math.min(...colonies) < 3 ? 1e6 : 0);
    };
    let deal = new Map<string, number>();
    let best = Infinity;
    for (let attempt = 0; attempt < 48; attempt++) {
      const owner = new Map(rng.shuffle([...patch]).map((at, i) => [key(...at), i % 2]));
      const score = clumping(owner);
      if (score < best) [best, deal] = [score, owner];
    }
    const powers = Array.from({ length: patch.length / 2 }, () => 1 + rng.int(3));
    const hands = [rng.shuffle([...powers]), rng.shuffle([...powers])];
    for (const at of patch) {
      const p = deal.get(key(...at))!;
      b.set(...at, { owner: p, power: hands[p].pop()! });
    }
    return b;
  },

  /** Three columns chase each other along the rim. The neutral inner lane is a shortcut home. */
  pinwheel(rng, k, seats) {
    const b = new Board();
    const rim = 4 + rng.int(2);
    const turn = rng.int(6);
    b.disk(rim);
    for (const c of b.all()) {
      if (hexDist([c.q, c.r], [0, 0]) < rim - 2) b.remove(c.q, c.r);
      else c.max = rollMax(rng);
    }
    for (let p = 0; p < seats; p++) for (let arc = 0; arc < 2; arc++) {
      for (let i = 0; i < rim; i++) {
        const head = arc === 1 && i >= rim - 2;
        b.set(...rot([rim - i, i], turn + 2 * p + arc), { owner: p, power: head ? (p ? 6 : kp(rng, k)) : 1 });
      }
    }
    return b;
  },

  // ------------------------------------------------------------ battles for three to six players

  /**
   * A big land in darkness; everybody is dropped at a random spot and nobody knows where the others
   * are. The drops are picked first, on the bare land, and each gets the same patch of open ground: no
   * lake, wall or armed ruin within two steps of it, so every squad can spread on its first turn.
   */
  landing(rng, _k, seats, size, { comp }) {
    const { radius, spacing } = LANDING_SIZES[size as LandingSize] ?? LANDING_SIZES.XL;
    const b = new Board();
    b.disk(radius);
    for (const c of b.all()) c.max = rollMax(rng, 0.3);
    const picked = landingDrops(rng, radius, spacing, seats);
    // the spots are picked one after another, so the last ones tend to be squeezed in between the
    // others: with the order compensation the seats draw their spots in a random order (from a copy of
    // the generator, so the rest of the map stays as it was)
    const drops = comp ? new Rng(rng.state()).shuffle([...picked]) : picked;
    const open = (c: Ax, d: number) => drops.every((o) => hexDist(c, o) > d);
    // as many landmarks per cell on every size and seat count, all of them out in the wild: lakes and
    // walls (never leaving a cell that holds the land together) and ruins, armed grey cells seen only up close
    const land = b.cells.size;
    const wild = () => b.all().filter((c) => open([c.q, c.r], 2));
    for (let i = 0; i < Math.round(land / 6) && b.cells.size > land * 0.86; i++) {
      const at = rng.pick(wild());
      const lake = b.all().filter((c) => hexDist([c.q, c.r], [at.q, at.r]) <= (rng.float() < 0.5 ? 1 : 0) && open([c.q, c.r], 2));
      lake.forEach((c) => b.remove(c.q, c.r));
      if (!b.solid()) lake.forEach((c) => b.add(c.q, c.r, c));
    }
    for (let i = 0; i < land / 2 && b.walls.length < land / 7; i++) {
      const c = rng.pick(wild());
      const [dq, dr] = rng.pick(DIRS);
      if (!b.get(c.q + dq, c.r + dr) || !open([c.q + dq, c.r + dr], 2)) continue;
      b.wall([c.q, c.r], [c.q + dq, c.r + dr]);
      if (!b.solid()) b.walls.pop();
    }
    for (const c of rng.shuffle(wild()).slice(0, Math.round(b.cells.size * 0.075))) c.power = Math.min(c.max, 2 + rng.int(3));
    // every squad is the same little triangle, turned at random
    const squads: Ax[][] = [];
    drops.forEach((d, p) => {
      const turn = rng.int(6);
      const squad: Ax[] = [];
      for (const [dq, dr] of [[0, 0], DIRS[turn], DIRS[(turn + 1) % 6]]) {
        const c = b.get(d[0] + dq, d[1] + dr)!;
        // every squad starts the same, yours too: a party map, the later movers get the order compensation
        const own = comp?.power?.[p] ?? 3;
        Object.assign(c, { owner: p, power: Math.max(1, Math.min(c.max, own)) });
        squad.push([c.q, c.r]);
      }
      squads.push(squad);
    });
    if (comp) landingComp(b, squads, comp);
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

  /**
   * Climbers around a walled mountain with a path up on every side; its slopes are rich (roomy, empty
   * cells). Three marked shrines on the summit decide the match: hold two until your next turn. Three
   * and six seats get the crown (between the paths) or, for three, the inner ring (by the summit cell);
   * four get the heart and two crown shrines on the line between the facing pairs; five the crown.
   */
  olympus(rng, k, seats) {
    const b = new Board();
    const radius = seats <= 3 ? 5 : 6;
    b.disk(radius);
    for (const c of b.all()) {
      const d = hexDist([c.q, c.r], [0, 0]);
      c.max = d <= 2 ? 12 : rollMax(rng, 0.2);
    }
    // the mountain wall: a path up in each of the six directions
    for (const c of b.all()) {
      if (hexDist([c.q, c.r], [0, 0]) !== 2 || (c.q === 0 || c.r === 0 || c.q + c.r === 0)) continue;
      for (const [dq, dr] of DIRS) if (hexDist([c.q + dq, c.r + dr], [0, 0]) === 3) b.wall([c.q, c.r], [c.q + dq, c.r + dr]);
    }
    const turn = rng.int(6);
    const sides = seatSides(seats, turn);
    sides.forEach((side, p) => {
      const at = rot([radius - 1, 0], side);
      for (const c of b.all())
        if (hexDist([c.q, c.r], at) <= 1 && hexDist([c.q, c.r], [0, 0]) >= radius - 1) Object.assign(c, { owner: p, power: p === 0 ? kp(rng, k) : 3 });
    });
    // the shrines, turned with the seats: the crown sits behind the wall between two paths, the inner
    // ring by the summit cell on the paths' axes, the heart line runs between the facing pairs of four
    const crown: Ax[] = [0, 2, 4].map(i => rot([1, 1], turn + i));
    const shrines = seats === 4 ? [[0, 0] as Ax, rot([1, 1], turn), rot([-1, -1], turn)]
      : seats === 3 && rng.bool() ? [0, 2, 4].map(i => rot([1, 0], turn + 1 + i))
        : crown;
    for (const at of shrines) b.set(...at, { objective: true, power: 2 });
    // a ragged edge, never leaving a rim cell hanging by another one
    for (const c of b.all()) if (hexDist([c.q, c.r], [0, 0]) === radius && c.owner === NEUTRAL && rng.float() < 0.3) b.carve(c);
    return b;
  },

  /**
   * Hollow lands: the whole map is split into four equal realms, mirror images of each other. Each is
   * almost all power 0, with a front row of 1s along the borders: huge income, nothing to fight with
   * yet. A quick race of greed rather than a skill test (calibration: the greedy Hunter does as well
   * as Master or GOD, and every one of them wins far more than a fair quarter from the first seat), so
   * it stays out of the map of the day. Knob: more than 0 turns that many of your empty cells into 1s,
   * less than 0 empties your front.
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
 * The night drop's turn-order compensation (given: that one): the seats draw their drop spots in a
 * random order, and a later seat gets extra power with its first reinforcement, as in an ordinary
 * battle but per squad cell. Your own squad's power stays the knob.
 */
export function landingOrderComp(seats: number, _size: FieldSize, given?: OrderComp | 'off'): OrderComp | null {
  if (given === 'off') return null;
  if (given) return given;
  return defaultOrderComp(seats, 3) ?? {};
}

/**
 * Turn-order compensation of the equal-seat scenarios by seat count. Olympus and the highlands give
 * later seats the ordinary battle's extra first income (engine.seatBonus per start cell); in the dark
 * valleys the first move decides the race to the clearings, so extra income barely helps there. Measured
 * with Master in every seat, 40–80 games per line (scripts/scenario-sim.ts): without a compensation the
 * first mover won 40 of 40 two-seat valleys and 22–33 of 40 three-seat ones.
 */
const SEAT_COMP: Partial<Record<ScenarioId, (seats: number) => OrderComp | null>> = {
  olympus: (n) => defaultOrderComp(n, 1),
  highlands: (n) => defaultOrderComp(n, 1),
  // two seats: the first mover sits out its first attack, with 4 more income (46 : 34 of 80);
  // more seats: a snake order (three seats: 30 / 26 / 24 of 80)
  moonvale: (n) => n === 2 ? { skip: 1, bonus: [4, 0] } : { order: 'snake' },
  // two seats: the first mover sits out its first attack (without: 40 of 40 for it; with: 51 : 69 of 120);
  // three or four: a snake order (26 / 23 / 31 of 80; 18 / 21 / 18 / 23); five or six, where a snake
  // hands the game to the last seats (6: 4 / 8 / 11 / 16 / 20 / 21 of 80), the first two sit out their
  // first attack (5: 21 / 15 / 21 / 15 / 8 of 80; 6: 33 / 16 / 26 / 14 / 11 / 20 of 120)
  fireflies: (n) => n === 2 ? { skip: 1, bonus: [0, 1] } : n <= 4 ? { order: 'snake' } : { skip: 2 },
  // three seats: 3 extra cells' worth per later seat (without: 16 / 15 / 9 of 40; with: 12 / 11 / 17)
  archipelago: (n) => defaultOrderComp(n, n === 3 ? 3 : 1),
};

/** The turn-order compensation of an equal-seat scenario (given: that one; 'off': none), or null. */
export function scenarioOrderComp(id: ScenarioId, seats: number, given?: OrderComp | 'off'): OrderComp | null {
  const comp = SEAT_COMP[id];
  if (comp === undefined || given === 'off') return null;
  return given ?? comp(seats);
}

/**
 * Build the starting position of a scenario (deterministic for a seed). `players` replaces the
 * recommended seat types (seat 0 is you; as many seats as recommended, or any number the scenario
 * allows when it is configurable); `config` picks the size and modes of a configurable scenario.
 */
function buildScenarioInternal(id: ScenarioId, seed: number, knob?: number, players?: PlayerType[], config?: ScenarioConfig, historical = false, order?: number[]): MatchState {
  const meta = SCENARIO_META[id];
  const seats = players ?? meta.players;
  if (!seatsFit(id, seats.length)) throw new Error(`${id}: ${meta.players.length} seats, got ${seats.length}`);
  const { size, unions } = scenarioSetup(id, config);
  const rng = new Rng(seed);
  const comp = id === 'landing' ? landingOrderComp(seats.length, size, config?.orderComp)
    : historical ? null : scenarioOrderComp(id, seats.length, config?.orderComp);
  const legacyBuilder = historical ? LEGACY_BUILDERS[id] : undefined;
  const board = legacyBuilder ? legacyBuilder(rng, knob ?? DAILY_KNOB[id] ?? scenarioKnob(id, size), seats.length) :
    BUILDERS[id](rng, knob ?? scenarioKnob(id, size), seats.length, size, { comp, even: !!config?.even });
  board.unchoke();
  const { field, objectives } = board.toField(size);
  if (order) {
    // the map is built for the given seats (your stronger start included); only the turn order moves
    const seatOf = new Map(order.map((from, to) => [from, to]));
    for (const c of field.cells) if (c.owner >= 0) c.owner = seatOf.get(c.owner)!;
  }
  const state = createMatch(
    {
      kind: 'single',
      size,
      players: order ? order.map((i) => seats[i]) : [...seats],
      darkness: !!meta.darkness,
      symmetry: false,
      crowded: !!meta.crowded,
      unions,
      shuffle: false,
      duelRules: false,
      puzzle: id,
      ...(meta.blind && !(historical && (id === 'moonvale' || id === 'fireflies')) ? { blind: true } : {}),
      ...(comp ? { orderComp: comp } : {}),
    },
    { field, keepPlacement: true, seed: seed ^ 0x5bd1e995 },
  );
  if (objectives.length) state.objectives = objectives;
  return state;
}

/** Gallery and battle setup: the current designs and exploration rules. */
export function buildScenario(id: ScenarioId, seed: number, knob?: number, players?: PlayerType[], config?: ScenarioConfig): MatchState {
  return buildScenarioInternal(id, seed, knob, players, config);
}

/** All previously scheduled dates keep their original maps and rules, including future dates. */
export function buildDailyScenario(id: ScenarioId, seed: number): MatchState {
  return buildScenarioInternal(id, seed, undefined, undefined, undefined, true);
}

/**
 * A new match for these settings: the scenario named in `settings.puzzle` (with the given seats, kind
 * of match and, when the scenario is configurable, size and unions), or an ordinary generated map.
 */
export function startMatch(settings: MatchSettings, seed = randomSeed(), seatOrder?: number[]): MatchState {
  // a match of one never ends (nobody is left to beat): refuse it rather than start it
  if (!Array.isArray(settings.players) || settings.players.length < 2) throw new RangeError('a match needs at least 2 players');
  const id = settings.puzzle;
  if (!isScenarioId(id)) {
    return createMatch(seatOrder ? { ...settings, players: seatOrder.map((i) => settings.players[i]) } : settings, { seed });
  }
  // a configurable scenario has the same climb for every seat, so "shuffle players" may decide who moves first
  const shuffle = !!settings.shuffle && !!SCENARIO_META[id].configurable;
  const order = seatOrder ?? (shuffle ? new Rng((seed ^ 0x2545f491) >>> 0).shuffle([...settings.players.keys()]) : undefined);
  const config = { size: settings.size, unions: settings.unions };
  const st = !order ? buildScenario(id, seed, undefined, settings.players, config)
    // the night drop builds its turn-order compensation into the squads: its seats are dealt before the drop
    : id === 'landing' ? buildScenario(id, seed, undefined, order.map((i) => settings.players[i]), config)
    // elsewhere the design favours your seat (the difficulty knob): build it for you, then move the turn order
    : buildScenarioInternal(id, seed, undefined, settings.players, config, false, order);
  st.settings = { ...st.settings, kind: settings.kind, turnTime: settings.turnTime, ...(shuffle ? { shuffle: true } : {}) };
  return st;
}
