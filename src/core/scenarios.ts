/**
 * Scenarios: hand-designed situations (unusual maps and preset forces) instead of an ordinary start.
 * A scenario fixes the map, the number of seats and the modes; the map of the day plays it with the
 * recommended bots, the battle setup lets the player choose who sits in each seat. Each scenario is a
 * parametric builder, so every seed produces a new variation. Layouts are built in axial hex
 * coordinates and converted to the engine's odd-r grid.
 */
import { Rng, randomSeed } from './rng';
import { buildAdjacency, geometricPairs } from './field';
import { createMatch, defaultOrderComp, isPersonType } from './engine';
import { articulationPoints, chokePoints, disjointPaths } from './connectivity';
import { chooseFrontierPoints, frontierConfig, frontierSettings } from './objectives';
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

/** Drop spots on any land: cells with all six neighbours, at least `spacing` apart (null: they don't fit). */
function wildDrops(rng: Rng, b: Board, spacing: number, n: number): Ax[] | null {
  const inland = b.all().filter((c) => DIRS.every(([dq, dr]) => b.get(c.q + dq, c.r + dr))).map(axOf);
  for (let attempt = 0; attempt < 30; attempt++) {
    const drops: Ax[] = [];
    for (let p = 0; p < n; p++) {
      const far = inland.filter((c) => drops.every((o) => hexDist(c, o) >= spacing));
      if (!far.length) break;
      drops.push(rng.pick(far));
    }
    if (drops.length === n) return drops;
  }
  return null;
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

/** A mode a configurable scenario lets the player switch (frontier: generated control points, as in a battle). */
export type ScenarioMode = 'unions' | 'frontier' | 'signalFires';

function scoutRadius(id: 'moonvale' | 'fireflies', size: FieldSize, seats: number): number {
  const base = id === 'moonvale' ? { L: 6, XL: 8, XXL: 10 } : { L: 6, XL: 7, XXL: 9 };
  return (base as Partial<Record<FieldSize, number>>)[size]! + (seats === 2 ? -1 : seats >= 6 ? 2 : seats >= 4 ? 1 : 0);
}

/**
 * How many steps a scenario's land grows beyond its smallest size (0, 1, 2 for its three sizes): its
 * place in the scenario's own list of sizes.
 */
function growth(id: ScenarioId, size: FieldSize): number {
  return Math.max(0, SCENARIO_META[id].configurable?.sizes.indexOf(size) ?? 0);
}

/**
 * Whether a grown land of `cells` cells keeps to its size: within a fifth or so of a disc of the
 * `nominal` radius. The bands of neighbouring sizes do not meet, so the land's shape (lobes, ragged
 * coasts) never makes a "large" map smaller than a "medium" one. The smallest size is the scenario
 * as designed and is not filtered.
 */
function keepsSize(cells: number, nominal: number, grow: number): boolean {
  if (!grow) return true;
  const disc = 3 * nominal * (nominal + 1) + 1;
  return cells >= disc / 1.18 && (grow >= 2 || cells <= disc * 1.18);
}

/** The player's choices for a configurable scenario (missing: the scenario's default). */
export interface ScenarioConfig {
  size?: FieldSize;
  unions?: boolean;
  /** frontier victory: control points placed on the built map, how many and how many to hold */
  frontierMode?: boolean;
  frontierPoints?: number;
  /** null or missing: the majority of the points */
  frontierWin?: number | null;
  /** own turns to hold them (missing: one) */
  frontierHold?: number;
  signalFires?: boolean;
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
    configurable: { sizes: ['L', 'XL', 'XXL'], seats: [3, 6], modes: ['unions', 'frontier', 'signalFires'] },
  },
  laststand: { players: ['human', 'master', 'hunter', 'god', 'hunter', 'master'], level: 4, size: 'L' },
  titans: { players: ['human', 'master', 'master'], level: 3, size: 'L', unions: true },
  olympus: { varied: true, objectives: true, players: ['human', 'master', 'hunter', 'god', 'hunter', 'master'], level: 3, size: 'L', configurable: { sizes: ['L', 'XL', 'XXL'], seats: [3, 6], modes: [] } },
  hollow: { players: ['human', 'master', 'god', 'master'], level: 2, size: 'L' },
  raid: { players: ['human', 'master'], level: 4, size: 'L' },
  farshore: { players: ['human', 'master'], level: 3, size: 'L' },
  moonvale: { varied: true, players: ['human', 'master', 'hunter'], level: 3, size: 'L', darkness: true, blind: true, configurable: { sizes: ['L', 'XL', 'XXL'], seats: [2, 6], modes: ['frontier', 'signalFires'] } },
  sparks: { varied: true, objectives: true, players: ['human', 'master', 'hunter'], level: 3, size: 'M', configurable: { sizes: ['M', 'L', 'XL'], seats: [3, 3], modes: [] } },
  fireflies: { varied: true, players: ['human', 'hunter', 'hunter'], level: 2, size: 'XL', darkness: true, blind: true, configurable: { sizes: ['L', 'XL', 'XXL'], seats: [2, 6], modes: ['frontier', 'signalFires'] } },
  crossroads: { varied: true, objectives: true, players: ['human', 'master'], level: 3, size: 'L', configurable: { sizes: ['L', 'XL', 'XXL'], seats: [2, 2], modes: [] } },
  highlands: { varied: true, objectives: true, players: ['human', 'master', 'hunter'], level: 3, size: 'L', configurable: { sizes: ['L', 'XL', 'XXL'], seats: [2, 6], modes: [] } },
  colonies: { varied: true, players: ['human', 'master'], level: 3, size: 'L', configurable: { sizes: ['L', 'XL', 'XXL'], seats: [2, 2], modes: [] } },
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

/**
 * The knob of the equal-seat scenarios that gives your start exactly what every other seat gets: used
 * when several people play, so the seat of the one who set up the match has no edge (the knob is a
 * handicap against bots; the archipelago's islands roll theirs). Sparks deals the knob to every realm alike;
 * the night drop has none.
 */
const EVEN_KNOB: Partial<Record<ScenarioId, number>> = { olympus: 3, moonvale: 6, highlands: 5, crossroads: 5, colonies: 7, fireflies: 2, archipelago: 0 };

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

/** How a scenario is played: its size and modes, as chosen where it allows a choice, else its own. */
export interface ScenarioSetup {
  size: FieldSize;
  unions: boolean;
  /** generated frontier points (null: the scenario's own rules) */
  frontier: { pointCount: number; winCount: number; holdTurns: number } | null;
  signalFires: boolean;
}

/** The size and modes a scenario is played with: the player's choices where it allows them, else its own. */
export function scenarioSetup(id: ScenarioId, config: ScenarioConfig = {}): ScenarioSetup {
  const m = SCENARIO_META[id];
  const c = m.configurable;
  const offers = (mode: ScenarioMode) => !!c?.modes.includes(mode);
  return {
    size: c && config.size && c.sizes.includes(config.size) ? config.size : m.size,
    unions: offers('unions') && config.unions !== undefined ? config.unions : !!m.unions,
    frontier: offers('frontier') && config.frontierMode === true
      ? frontierConfig({ frontierPointCount: config.frontierPoints, frontierWinCount: config.frontierWin ?? undefined, frontierHoldTurns: config.frontierHold })
      : null,
    signalFires: offers('signalFires') && config.signalFires === true,
  };
}

/**
 * Scenarios whose map of the day differs in rules or layout from the gallery version: the day keeps
 * the old description (puzzleDescDaily_<id>) next to its frozen map.
 */
export const DAILY_LEGACY_DESC: ReadonlySet<ScenarioId> = new Set<ScenarioId>(['sparks', 'olympus', 'highlands', 'moonvale', 'crossroads', 'colonies', 'fireflies']);

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
  const pool = b.all().filter((c) => !keep(c));
  for (let n = 0; n < ridges * 4 && pool.length; n++) {
    const start = rng.pick(pool);
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
function highlandsAttempt(rng: Rng, k: number, seats: number, radius: number, syms: Sym[], plain: boolean, grow = 0): Board | null {
  const b = new Board();
  b.disk(radius);
  // capacities are rolled once per symmetric set of cells: every camp has the same land around it
  symmetricMaxes(b, rng, syms);
  const sides = seatSides(seats, 0);
  const camps = sides.map((side) => [rot([radius - 2, 0], side), rot([radius - 1, 0], side)]);
  // the summits: a set of three that the seats' symmetries keep
  // the summits spread out with the land
  const t = 2 + rng.int(2) + grow;
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
      symmetricRidges(b, rng, syms, keep, 1 + rng.int(3) + grow);
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

/**
 * The narrowest way between two camps: how many paths with no cell in common lead from the ground
 * around one camp (two steps) to the ground around another (seat 0 against each other seat: the
 * symmetries make every other pair one of these). A camp is a seat's group of cells (not a lone scout).
 */
function campWidth(b: Board, seats: number, cap: number): number {
  const { keys, adj } = b.graph();
  const zone = (seat: number) => {
    const camp = keys.flatMap((k, i) => {
      const c = b.cells.get(k)!;
      return c.owner === seat && adj[i].some((j) => b.cells.get(keys[j])!.owner === seat) ? [i] : [];
    });
    const d = new Map<number, number>(camp.map((i) => [i, 0]));
    const queue = [...camp];
    for (const i of queue) if (d.get(i)! < 2) for (const j of adj[i]) if (!d.has(j)) { d.set(j, d.get(i)! + 1); queue.push(j); }
    return queue;
  };
  const home = zone(0);
  let width = cap;
  for (let seat = 1; seat < seats; seat++) width = Math.min(width, disjointPaths(adj, home, zone(seat), cap));
  return width;
}

/** The symmetry that carries side 0 onto this side. */
function symToSide(syms: Sym[], side: number): Sym {
  return syms.find((f) => key(...f([1, 0])) === key(...rot([1, 0], side)))!;
}

/** One try at a moonless valley in the seats' own frame (null: rejected, roll again). */
function moonvaleAttempt(rng: Rng, k: number, seats: number, radius: number, syms: Sym[], plain: boolean): Board | null {
  // wild land of a new shape every time (the last resort: the plain disk), the camps out on its edge
  const camp0: Ax[] = plain ? [[radius - 1, 0], [radius - 2, 0], [radius - 2, 1]] : [[radius, 0], [radius - 1, 0], [radius - 1, 1]];
  let b: Board;
  if (plain) {
    b = new Board();
    b.disk(radius);
  } else {
    const wild = wildLand(rng, syms, radius, rng.pick(WILD_STYLES), camp0);
    if (!wild) return null;
    b = wild;
  }
  // the valley is mostly poor ground, so that the clearings stand out
  symmetricMaxes(b, rng, syms, 0.12);
  const sides = seatSides(seats, 0);
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
      hexDist(ax(c), [0, 0]) >= 2 && hexDist(ax(c), [0, 0]) <= radius - 1 &&
      spots.every((g) => diskCells(g, 1).every((a) => b.get(...a)));
  });
  if (!glades.length) return null;
  const glade = ax(rng.pick(glades));
  const glades0 = orbit(glade, syms);
  // the scout: one step from its clearing (over land, not across a bay), off the rim, three clear of
  // every camp and every other scout
  const toGlade = boardDistances(b, [glade]);
  const scouts = b.all().filter((c) => {
    const spots = orbit(ax(c), syms);
    return hexDist(ax(c), glade) === 2 && toGlade.get(key(c.q, c.r)) === 2 && hexDist(ax(c), [0, 0]) <= radius - 2 && spots.length === syms.length && apart(spots, 3) &&
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
  const clear = (c: Slot) => near(c, anyCamp, 1) || near(c, scouts0, 1) || near(c, glades0, 1);
  symmetricRidges(b, rng, syms, keep, 1 + rng.int(3), clear);
  const land = b.cells.size;
  if (!plain) symmetricWalls(b, rng, syms, Math.round(land / 16 / syms.length), clear);
  for (let i = 0; i < Math.round(land / (plain ? 10 : 16) / syms.length); i++) {
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

// ---------------------------------------------------------------- random symmetric land and terrain

const turnSym = (k: number): Sym => (a) => rot(a, k);
const mirrorSym = (k: number): Sym => (a) => mirror(a, k);

/** Two seats on the q axis face each other across a mirror line, or around the middle (a half turn). */
function duelSymmetries(rng: Rng): Sym[] {
  return rng.bool() ? [turnSym(0), mirrorSym(3)] : [turnSym(0), turnSym(3)];
}

const axOf = (s: Slot): Ax => [s.q, s.r];
const nearAny = (c: Ax, list: Ax[], d: number) => list.some((a) => hexDist(c, a) <= d);

function diskCells(center: Ax, radius: number): Ax[] {
  const out: Ax[] = [];
  for (let q = -radius; q <= radius; q++)
    for (let r = -radius; r <= radius; r++) if (hexDist([q, r], [0, 0]) <= radius) out.push([center[0] + q, center[1] + r]);
  return out;
}

/** Add a cell and every symmetric copy of it. */
function symmetricAdd(b: Board, syms: Sym[], a: Ax) {
  for (const at of orbit(a, syms)) if (!b.get(...at)) b.add(...at);
}

/** Silhouettes of random land; `capsule` stretches along the q axis (two seats only). */
type LandStyle = 'round' | 'lobed' | 'ring' | 'capsule' | 'jagged' | 'islands';

/**
 * Land of about this radius, kept by the symmetries: a round plain, a plain with headlands and bays,
 * a ring around a central lake, a long capsule, a jagged coast, or islands joined by broad causeways.
 * It may fall apart or hang on one cell: the caller checks `solid()`.
 */
function symmetricLand(rng: Rng, syms: Sym[], radius: number, style: LandStyle): Board {
  const b = new Board();
  const blob = (center: Ax, r: number) => diskCells(center, r).forEach((c) => symmetricAdd(b, syms, c));
  if (style === 'capsule') {
    const half = 3 + rng.int(2);
    const width = radius - 3 + rng.int(2);
    for (let t = -half; t <= half; t++) blob([t, 0], width);
  } else if (style === 'islands') {
    // a central island and a ring of others, each joined to the middle by a causeway two cells wide
    blob([0, 0], 1 + rng.int(2));
    const isles = 1 + rng.int(2);
    for (let i = 0; i < isles; i++) {
      const d = radius - 2 + rng.int(2);
      const at = rot([d, -rng.int(d + 1)], rng.int(6));
      blob(at, 2);
      const n = hexDist(at, [0, 0]);
      for (let s = 0; s <= n; s++) {
        const p = roundAx(at[0] * (1 - s / n), at[1] * (1 - s / n));
        symmetricAdd(b, syms, p);
        symmetricAdd(b, syms, [p[0] + 1, p[1]]);
        symmetricAdd(b, syms, [p[0], p[1] + 1]);
      }
    }
  } else {
    blob([0, 0], style === 'lobed' ? radius - 1 : radius);
    if (style === 'lobed') {
      for (let i = 1 + rng.int(3); i > 0; i--) {
        const rim = b.all().filter((c) => hexDist(axOf(c), [0, 0]) === radius - 1);
        blob(axOf(rng.pick(rim)), 1 + rng.int(2));
      }
    }
    if (style === 'ring') {
      const lake = 1 + rng.int(2);
      for (const c of b.all()) if (hexDist(axOf(c), [0, 0]) <= lake) b.remove(c.q, c.r);
    }
  }
  if (style === 'jagged' || style === 'lobed') {
    // bite bays out of the coast
    const outer = Math.max(...b.all().map((c) => hexDist(axOf(c), [0, 0])));
    for (const c of rng.shuffle(b.all().filter((c) => hexDist(axOf(c), [0, 0]) >= outer - 1))) {
      if (b.get(c.q, c.r) && rng.float() < (style === 'jagged' ? 0.35 : 0.15)) symmetricDig(b, syms, axOf(c), () => false);
    }
  }
  return b;
}

// ---------------------------------------------------------------- wild land of the dark scenarios

/**
 * Silhouettes of the lands in the dark: winding valleys (broad wandering trails), a ragged continent
 * with bays and inland lakes, or islands strung together by causeways.
 */
type WildStyle = 'valleys' | 'continent' | 'isles';
const WILD_STYLES: readonly WildStyle[] = ['valleys', 'continent', 'isles'];

const diskCount = (r: number) => 3 * r * (r + 1) + 1;
const stepAx = (a: Ax, d: number): Ax => [a[0] + DIRS[d][0], a[1] + DIRS[d][1]];

/**
 * A ragged land with about as many cells as a disk of this radius but spread wider, so that its shape
 * can't be guessed from a corner of it; kept by the symmetries (one symmetry: none at all). The
 * `anchors` and their neighbours are always land. Null when it came out in pieces or the wrong size.
 */
function wildLand(rng: Rng, syms: Sym[], radius: number, style: WildStyle, anchors: Ax[]): Board | null {
  const reach = radius + 2;
  const target = Math.round(diskCount(radius) * (1 + rng.float() * 0.12));
  const land = new Set<string>();
  const inside = (a: Ax) => hexDist(a, [0, 0]) <= reach;
  const put = (a: Ax) => { for (const o of orbit(a, syms)) if (inside(o)) land.add(key(...o)); };
  const has = (a: Ax) => land.has(key(...a));
  const fixed = anchors.flatMap((a) => diskCells(a, 1));
  fixed.forEach(put);
  const homeward = (a: Ax) => [0, 1, 2, 3, 4, 5].sort((x, y) => hexDist(stepAx(a, x), [0, 0]) - hexDist(stepAx(a, y), [0, 0]))[0];
  if (style === 'valleys') {
    // broad trails wander out from the anchors and the middle, turning now and then, until the land is big enough
    const starts: Ax[] = [[0, 0], ...anchors];
    for (let trail = 0; land.size < target && trail < 60; trail++) {
      let at: Ax = trail < starts.length ? starts[trail] : rng.pick([...land]).split(',').map(Number) as Ax;
      let dir = rng.int(6);
      for (let s = 0; s < 2 * radius && land.size < target; s++) {
        const turn = rng.float();
        dir = (dir + (turn < 0.2 ? 1 : turn < 0.4 ? 5 : 0)) % 6;
        if (hexDist(stepAx(at, dir), [0, 0]) > reach - 1) dir = homeward(at);
        at = stepAx(at, dir);
        put(at);
        for (let d = 0; d < 6; d++) if (rng.float() < 0.45) put(stepAx(at, d));
      }
    }
  } else if (style === 'continent') {
    // noise, denser in the middle, settled by a few rounds of "land where most neighbours are land"
    const rolled = new Set<string>();
    for (const a of diskCells([0, 0], reach)) {
      if (rolled.has(key(...a))) continue;
      const spots = orbit(a, syms);
      spots.forEach((o) => rolled.add(key(...o)));
      const d = hexDist(a, [0, 0]) / reach;
      if (rng.float() < 0.78 - 0.5 * d * d) spots.forEach((o) => land.add(key(...o)));
    }
    fixed.forEach(put);
    for (let round = 0; round < 3; round++) {
      const next = new Set<string>();
      for (const a of diskCells([0, 0], reach)) {
        const n = DIRS.filter(([dq, dr]) => has([a[0] + dq, a[1] + dr])).length;
        if (n >= 4 || (has(a) && n >= 3)) next.add(key(...a));
      }
      land.clear();
      next.forEach((k) => land.add(k));
      fixed.forEach(put);
    }
    // deep bays bitten out of the coast, so that it never settles into a round blob
    const fixedKeys = new Set(fixed.flatMap((a) => orbit(a, syms)).map((a) => key(...a)));
    for (let bay = 2 + rng.int(3) + Math.floor(radius / 4); bay > 0; bay--) {
      const coast = [...land].map((k) => k.split(',').map(Number) as Ax).filter((a) => hexDist(a, [0, 0]) >= radius - 1);
      if (!coast.length) break;
      let at = rng.pick(coast);
      for (let s = 0, depth = 1 + rng.int(3); s <= depth; s++) {
        for (const c of diskCells(at, 1)) for (const o of orbit(c, syms)) if (!fixedKeys.has(key(...o))) land.delete(key(...o));
        at = stepAx(at, homeward(at));
      }
    }
  } else {
    // round islands joined to their nearest neighbour by a causeway two cells wide
    const centres: Ax[] = [];
    const join = (from: Ax, to: Ax) => {
      const n = hexDist(from, to);
      for (let s = 0; s <= n; s++) {
        const p = roundAx(from[0] + ((to[0] - from[0]) * s) / n, from[1] + ((to[1] - from[1]) * s) / n);
        put(p);
        put(stepAx(p, 0));
        put(stepAx(p, 1));
      }
    };
    const isle = (c: Ax) => {
      diskCells(c, 1 + rng.int(2)).forEach(put);
      const near = centres.filter((o) => key(...o) !== key(...c)).sort((x, y) => hexDist(x, c) - hexDist(y, c))[0];
      if (near) join(c, near);
      for (const o of orbit(c, syms)) centres.push(o);
    };
    isle([0, 0]);
    anchors.forEach(isle);
    for (let n = 0; land.size < target && n < 40; n++) {
      const c = rng.pick(diskCells([0, 0], reach - 1));
      if (centres.some((o) => hexDist(o, c) < 4)) continue;
      isle(c);
    }
  }
  // keep the piece the anchors (or the middle) stand on, and only if the symmetries keep it whole
  const from = anchors.length ? anchors[0] : [...land].map((k) => k.split(',').map(Number) as Ax).sort((x, y) => hexDist(x, [0, 0]) - hexDist(y, [0, 0]))[0];
  if (!from || !has(from)) return null;
  const piece = new Set([key(...from)]);
  const queue: Ax[] = [from];
  while (queue.length) {
    const a = queue.pop()!;
    for (let d = 0; d < 6; d++) {
      const n = stepAx(a, d);
      if (has(n) && !piece.has(key(...n))) {
        piece.add(key(...n));
        queue.push(n);
      }
    }
  }
  const b = new Board();
  for (const k of piece) b.add(...(k.split(',').map(Number) as Ax));
  if (fixed.some((a) => !b.get(...a))) return null;
  if (b.all().some((c) => orbit(axOf(c), syms).some((o) => !b.get(...o)))) return null;
  // a cell that alone holds two parts together gets company, so the land never hangs on one cell
  for (let step = 0; step < 80; step++) {
    const { keys, adj } = b.graph();
    const cuts = articulationPoints(adj);
    if (!cuts.length) break;
    const [q, r] = keys[cuts[0]].split(',').map(Number);
    for (let d = 0; d < 6; d++) symmetricAdd(b, syms, stepAx([q, r], d));
  }
  const size = b.cells.size;
  return b.solid() && size >= target * 0.85 && size <= target * 1.4 ? b : null;
}

/**
 * Short walls of one or two edges scattered over the land, copied by the symmetries; none touches a
 * `clear` cell and none may leave a cell holding the land together.
 */
function symmetricWalls(b: Board, rng: Rng, syms: Sym[], count: number, clear: (s: Slot) => boolean) {
  const pool = b.all().filter((c) => !clear(c));
  for (let tries = 0, made = 0; made < count && tries < count * 4 && pool.length; tries++) {
    const c = rng.pick(pool);
    const d = rng.int(6);
    const sides: Ax[] = rng.bool() ? [stepAx(axOf(c), d)] : [stepAx(axOf(c), d), stepAx(axOf(c), (d + 1) % 6)];
    const edges: [Ax, Ax][] = [];
    for (const to of sides) {
      const s = b.get(...to);
      if (!s || clear(s)) continue;
      for (const f of syms) edges.push([f(axOf(c)), f(to)]);
    }
    if (!edges.length) continue;
    const before = b.walls.length;
    const seen = new Set(b.walls.map(([x, y]) => [x, y].sort().join('|')));
    for (const [x, y] of edges) {
      const id = [key(...x), key(...y)].sort().join('|');
      if (!seen.has(id)) {
        seen.add(id);
        b.wall(x, y);
      }
    }
    if (!b.solid()) b.walls.length = before;
    else made++;
  }
}

/**
 * Dress a dark land like the night drop's: rich ground here and there, inland pools, short walls,
 * sometimes a ridge with a pass, and armed ruins out in the wild. `keep` cells stay as they are, no
 * wall touches a `clear` one.
 */
function darkTerrain(b: Board, rng: Rng, syms: Sym[], keep: (s: Slot) => boolean, clear: (s: Slot) => boolean) {
  symmetricMaxes(b, rng, syms, 0.25);
  const land = b.cells.size;
  const free = () => b.all().filter((c) => !keep(c));
  for (let i = 1 + rng.int(2); i > 0; i--) {
    const spots = free();
    if (spots.length) for (const at of diskCells(axOf(rng.pick(spots)), 1)) symmetricSet(b, syms, at, (s) => { if (!keep(s)) s.max = 12; });
  }
  for (let i = 0; i < Math.round(land / 24 / syms.length); i++) {
    const spots = free();
    if (spots.length) for (const at of rng.shuffle(diskCells(axOf(rng.pick(spots)), rng.int(2)))) symmetricDig(b, syms, at, keep);
  }
  symmetricWalls(b, rng, syms, Math.round(land / 14 / syms.length), clear);
  if (rng.int(3) === 0) symmetricRidges(b, rng, syms, keep, 1, clear);
  for (const c of rng.shuffle(free().filter((c) => c.power === 0 && c.owner === NEUTRAL)).slice(0, Math.round((b.cells.size * 0.06) / syms.length))) {
    const power = 2 + rng.int(3);
    symmetricSet(b, syms, axOf(c), (s) => { if (!keep(s) && s.owner === NEUTRAL) s.power = Math.min(s.max, power); });
  }
}

/** How the land between the seats is dressed: one of five characters, so maps differ in how they play. */
interface TerrainPlan {
  /** share of roomy cells (up to 12) */
  rich: number;
  /** roomy meadows (a cell and its ring) */
  meadows: number;
  /** lakes dug out of the land, each a cell or a cell and its ring */
  lakes: number;
  lakeSize: number;
  /** ridges with passes */
  ridges: number;
  /** neutral strongholds of one to three cells */
  forts: number;
  fortPower: [number, number];
}

function terrainPlan(rng: Rng): TerrainPlan {
  switch (rng.int(5)) {
    case 0: // fertile plains with a couple of strongholds
      return { rich: 0.4, meadows: 2, lakes: rng.int(2), lakeSize: 1, ridges: 0, forts: 1 + rng.int(2), fortPower: [3, 5] };
    case 1: // a lake district
      return { rich: 0.25, meadows: 1, lakes: 3 + rng.int(3), lakeSize: 1, ridges: rng.int(2), forts: rng.int(2), fortPower: [2, 4] };
    case 2: // mountains: ridges with passes, garrisons on the approaches
      return { rich: 0.15, meadows: 1, lakes: rng.int(2), lakeSize: 0, ridges: 2 + rng.int(3), forts: 1 + rng.int(3), fortPower: [3, 6] };
    case 3: // a fortified borderland
      return { rich: 0.25, meadows: 0, lakes: 1, lakeSize: 0, ridges: 1, forts: 3 + rng.int(3), fortPower: [2, 6] };
    default: // marshes: many small pools on poor ground, a few rich meadows
      return { rich: 0.1, meadows: 2 + rng.int(2), lakes: 5 + rng.int(4), lakeSize: 0, ridges: 0, forts: rng.int(2), fortPower: [2, 3] };
  }
}

/**
 * Dress the land by the plan, every feature copied by the symmetries. Nothing is dug from or built on
 * a `keep` cell; no ridge touches a `clear` one.
 */
function symmetricTerrain(b: Board, rng: Rng, syms: Sym[], plan: TerrainPlan, keep: (s: Slot) => boolean, clear?: (s: Slot) => boolean) {
  symmetricMaxes(b, rng, syms, plan.rich);
  const free = () => b.all().filter((c) => !keep(c));
  for (let i = 0; i < plan.meadows; i++) {
    const spots = free();
    if (!spots.length) break;
    for (const at of diskCells(axOf(rng.pick(spots)), 1)) symmetricSet(b, syms, at, (s) => { s.max = 12; });
  }
  for (let i = 0, tries = 0; i < plan.lakes && tries < plan.lakes * 6; tries++) {
    const spots = free();
    if (!spots.length) break;
    let dug = false;
    for (const at of rng.shuffle(diskCells(axOf(rng.pick(spots)), plan.lakeSize))) dug = symmetricDig(b, syms, at, keep) || dug;
    if (dug) i++;
  }
  if (plan.ridges) symmetricRidges(b, rng, syms, keep, plan.ridges, clear);
  for (let i = 0; i < plan.forts; i++) {
    const spots = free().filter((c) => c.power === 0 && c.owner === NEUTRAL);
    if (!spots.length) break;
    const at = rng.pick(spots);
    const power = rng.range(plan.fortPower[0], plan.fortPower[1] + 1);
    const cluster = [axOf(at), ...rng.shuffle(DIRS.map(([dq, dr]) => [at.q + dq, at.r + dr] as Ax)).filter((a) => b.get(...a) && !keep(b.get(...a)!)).slice(0, rng.int(3))];
    for (const a of cluster) symmetricSet(b, syms, a, (s) => { if (!keep(s) && s.owner === NEUTRAL) s.power = Math.min(s.max, power); });
  }
}

/**
 * Three cells that the symmetries keep as a set (one orbit of three, a fixed cell and a pair, or three
 * fixed cells), at least `gap` apart; only cells passing `ok`. Null if no such set turned up.
 */
function symmetricTriple(rng: Rng, b: Board, syms: Sym[], ok: (a: Ax) => boolean, gap: number): Ax[] | null {
  const orbits = new Map<string, Ax[]>();
  for (const c of b.all()) {
    const o = orbit(axOf(c), syms);
    if (o.every((a) => b.get(...a) && ok(a))) orbits.set(o.map((a) => key(...a)).sort().join('|'), o);
  }
  const bySize = [1, 2, 3].map((n) => [...orbits.values()].filter((o) => o.length === n));
  const options: (() => Ax[])[] = [];
  if (bySize[2].length) options.push(() => rng.pick(bySize[2]));
  if (bySize[0].length && bySize[1].length) options.push(() => [...rng.pick(bySize[0]), ...rng.pick(bySize[1])]);
  if (bySize[0].length >= 3) options.push(() => rng.shuffle([...bySize[0]]).slice(0, 3).flat());
  if (!options.length) return null;
  for (let i = 0; i < 80; i++) {
    const set = rng.pick(options)();
    if (set.every((a, x) => set.every((o, y) => x === y || hexDist(a, o) >= gap))) return set;
  }
  return null;
}

/** Try a random design until one passes its checks; the plain variant always does. */
function firstDesign(build: (plain: boolean) => Board | null, what: string): Board {
  for (let attempt = 0; attempt < 80; attempt++) {
    const b = build(false);
    if (b) return b;
  }
  for (let attempt = 0; attempt < 40; attempt++) {
    const b = build(true);
    if (b) return b;
  }
  throw new Error(`${what}: no layout`);
}

/**
 * Crossroads: two camps at the ends of the land, three points between them on a new land every time
 * (a plain, lakes, mountains, strongholds, islands), mirrored or turned so both sides face the same.
 */
function crossroadsAttempt(rng: Rng, k: number, plain: boolean, grow: number): Board | null {
  const syms = duelSymmetries(rng);
  const radius = 6 + rng.int(2) + 2 * grow;
  // the least land for the size (the smallest: 110 cells, then 100 after the terrain)
  const least = (n: number) => Math.round(n * ((6.5 + 2 * grow) / 6.5) ** 2);
  const style: LandStyle = plain ? 'round' : rng.pick(['round', 'lobed', 'ring', 'capsule', 'jagged', 'islands'] as const);
  const b = symmetricLand(rng, syms, radius, style);
  if (!b.solid() || b.cells.size < least(110)) return null;
  const end = Math.max(...b.all().filter((c) => c.r === 0).map((c) => c.q));
  const camp0: Ax[] = [[end, 0], [end - 1, 0]];
  const camps = [camp0, camp0.map(syms[1])];
  const campCells = camps.flat();
  if (campCells.some((a) => !b.get(...a)) || hexDist(camp0[1], camps[1][1]) < 8 + 2 * grow) return null;
  const points = symmetricTriple(rng, b, syms, (a) => !nearAny(a, campCells, 3), 4);
  if (!points) return null;
  const keep = (s: Slot) => nearAny(axOf(s), campCells, 2) || nearAny(axOf(s), points, 1);
  if (plain) symmetricMaxes(b, rng, syms);
  else symmetricTerrain(b, rng, syms, terrainPlan(rng), keep, (s) => nearAny(axOf(s), campCells, 1) || nearAny(axOf(s), points, 0));
  const garrison = rng.int(3);
  for (const a of points) b.set(...a, { objective: true, max: 12, power: garrison });
  camps.forEach((camp, p) => camp.forEach((a) => b.set(...a, { owner: p, power: p ? 5 : kp(rng, k), max: 8 })));
  if (!b.solid() || b.cells.size < least(100) || !keepsSize(b.cells.size, 6.5 + 2 * grow, grow)) return null;
  const { index, adj } = b.graph();
  if (points.some((a) => adj[index.get(key(...a))!].length < 4)) return null;
  // the points lie at least four steps apart, each about as far from both camps
  const from = points.map((a) => boardDistances(b, [a]));
  for (const [i, d] of from.entries()) for (const [j, a] of points.entries()) if (i !== j && (d.get(key(...a)) ?? -1) < 4) return null;
  for (const d of from) {
    const reach = camps.map((camp) => Math.min(...camp.map((c) => d.get(key(...c)) ?? Infinity)));
    if (reach.some((n) => n < 3 || !Number.isFinite(n)) || Math.abs(reach[0] - reach[1]) > 2) return null;
  }
  // the camps stay at the sides of the screen
  b.rotate(3 * rng.int(2));
  return b;
}

/**
 * Sparks: three realms on a land turned by thirds, grown from rotated seeds (three sectors, swirls or
 * scattered provinces), power dealt by one of four plans, a spark buried in each realm.
 */
function sparksAttempt(rng: Rng, k: number, plain: boolean, grow: number): Board | null {
  const syms = [turnSym(0), turnSym(2), turnSym(4)];
  const radius = 4 + rng.int(2) + 2 * grow;
  const least = (n: number) => Math.round(n * ((4.5 + 2 * grow) / 4.5) ** 2);
  const style: LandStyle = plain ? 'round' : rng.pick(['round', 'lobed', 'ring', 'jagged', 'islands'] as const);
  const b = symmetricLand(rng, syms, radius, style);
  b.remove(0, 0);
  if (!b.solid() || b.cells.size < least(45)) return null;
  if (!plain) {
    for (let i = rng.int(3); i > 0; i--) symmetricDig(b, syms, axOf(rng.pick(b.all())), () => false);
    if (rng.int(3) === 0) symmetricRidges(b, rng, syms, () => false, 1 + rng.int(2));
  }
  if (b.cells.size < least(48) || !keepsSize(b.cells.size, 4.5 + 2 * grow, grow)) return null;
  // realms grow outwards from rotated seeds, a random step at a time
  const { keys, index, adj } = b.graph();
  const owner = new Map<string, number>();
  const frontier: string[] = [];
  const claim = (a: Ax, p: number) => syms.forEach((f, i) => {
    owner.set(key(...f(a)), (p + i) % 3);
    frontier.push(key(...f(a)));
  });
  for (let s = plain ? 1 : 1 + rng.int(3); s > 0; s--) {
    const open = b.all().filter((c) => !owner.has(key(c.q, c.r)));
    if (open.length) claim(axOf(rng.pick(open)), rng.int(3));
  }
  while (frontier.length) {
    const i = rng.int(frontier.length);
    const free = adj[index.get(frontier[i])!].map((j) => keys[j]).filter((n) => !owner.has(n));
    if (!free.length) {
      frontier.splice(i, 1);
      continue;
    }
    claim(axOf(b.cells.get(rng.pick(free))!), owner.get(frontier[i])!);
  }
  for (const c of b.all()) c.owner = owner.get(key(c.q, c.r))!;
  // the spark: deep in its realm, every neighbour its own
  const cuts = new Set(articulationPoints(adj).map((i) => keys[i]));
  const buried = b.all().filter((c) => adj[index.get(key(c.q, c.r))!].length === 6 && !cuts.has(key(c.q, c.r)) &&
    DIRS.every(([dq, dr]) => b.get(c.q + dq, c.r + dr)!.owner === c.owner));
  if (!buried.length) return null;
  const spark = axOf(rng.pick(buried));
  const sparks = orbit(spark, syms);
  // the deal, the same for every realm: compact strong hotspots, the rest mostly weak
  const hot = new Set<string>();
  const triangle = (ok: (c: Slot) => boolean) => {
    const shapes = b.all().filter(ok).flatMap((c) => [0, 1, 2, 3, 4, 5].map((t) => [axOf(c), ...[t, t + 1].map((i) => DIRS[i % 6]).map(([dq, dr]) => [c.q + dq, c.r + dr] as Ax)]))
      .filter((cells) => cells.every((a) => b.get(...a) && !sparks.some((s) => key(...s) === key(...a))));
    if (shapes.length) for (const a of rng.pick(shapes)) for (const at of orbit(a, syms)) hot.add(key(...at));
  };
  const border = (c: Slot) => DIRS.some(([dq, dr]) => { const n = b.get(c.q + dq, c.r + dr); return !!n && n.owner !== c.owner; });
  const deal = plain ? 0 : rng.int(4);
  if (deal === 1) {
    // a citadel: the spark is ringed by strength
    for (const a of diskCells(spark, 1)) if (key(...a) !== key(...spark)) for (const at of orbit(a, syms)) hot.add(key(...at));
  } else if (deal === 2) {
    // strong frontier posts where the realms meet
    triangle(border);
    triangle(border);
  } else if (deal === 3) {
    // one stronghold near the middle, one out on the rim
    const far = Math.max(...b.all().map((c) => hexDist(axOf(c), [0, 0])));
    triangle((c) => hexDist(axOf(c), [0, 0]) <= 2);
    triangle((c) => hexDist(axOf(c), [0, 0]) >= far - 1);
  } else {
    triangle(() => true);
    triangle(() => true);
  }
  // a bigger land: as many more hotspots, anywhere
  for (let i = 0; i < grow && deal !== 1; i++) triangle(() => true);
  const weak = new Set<string>();
  if (deal !== 1) {
    const pocket = rng.pick(b.all());
    for (const a of diskCells(axOf(pocket), 1)) for (const at of orbit(a, syms)) if (b.get(...at) && !hot.has(key(...at))) weak.add(key(...at));
  }
  const guard = deal === 2 ? 3 : 0;
  const done = new Set<string>();
  for (const c of b.all()) {
    if (done.has(key(c.q, c.r))) continue;
    const strongCell = hot.has(key(c.q, c.r));
    const weakCell = weak.has(key(c.q, c.r));
    const power = strongCell ? kp(rng, k) : weakCell ? 1 : guard && border(c) && rng.bool() ? guard : 1 + rng.int(2);
    const max = strongCell || weakCell ? 12 : rollMax(rng);
    for (const at of orbit(axOf(c), syms)) {
      done.add(key(...at));
      b.set(...at, { power, max });
    }
  }
  const garrison = 3 + rng.int(3);
  for (const a of sparks) b.set(...a, { objective: true, power: garrison, max: 12 });
  // checks: every realm has its hotspots and stays mostly weak
  const realm = b.all().filter((c) => c.owner === 0);
  const isHot = (c: Slot) => hot.has(key(c.q, c.r));
  const strong = realm.filter(isHot);
  const around = (c: Slot) => adj[index.get(key(c.q, c.r))!].map((j) => b.cells.get(keys[j])!);
  if (strong.length < 3 || strong.some((c) => !around(c).some(isHot))) return null;
  if (realm.filter((c) => (c.power <= 2 && !isHot(c)) || c.objective).length < 2 * strong.length) return null;
  // and a first move: a few cells strong enough to strike over the border
  const ready = realm.filter((c) => c.power >= 2 && around(c).some((n) => n.owner !== c.owner));
  if (ready.length < 3) return null;
  b.rotate(rng.int(6));
  return b;
}

/**
 * Colonies: two big bases close together, and a flank (or two, facing) of small colonies dealt in
 * mirrored pairs, so both sides get as many colonies and the same powers; random land and terrain.
 */
function coloniesAttempt(rng: Rng, k: number, plain: boolean, grow: number): Board | null {
  const syms = duelSymmetries(rng);
  const f = syms[1];
  const radius = 7 + rng.int(2) + 2 * grow;
  const least = (n: number) => Math.round(n * ((7.5 + 2 * grow) / 7.5) ** 2);
  // a bigger land has a bigger flank of colonies
  const spread = grow ? 1 : 0;
  const style: LandStyle = plain ? 'round' : rng.pick(['round', 'lobed', 'jagged', 'capsule'] as const);
  const b = symmetricLand(rng, syms, radius, style);
  if (!b.solid() || b.cells.size < least(140)) return null;
  const whole = (cells: Ax[]) => cells.every((a) => b.get(...a));
  const bases = b.all().map(axOf).filter((c) => { const d = hexDist(c, f(c)); return d >= 5 && d <= 7 && whole(diskCells(c, 2)); });
  if (!bases.length) return null;
  const base0 = rng.pick(bases);
  const baseCells = [...diskCells(base0, 2), ...diskCells(f(base0), 2)];
  // the flank: one patch on the mirror line, or (turned around the middle) two patches facing each other
  const mirrored = key(...f([1, -2])) === key(1, -2);
  const centres = b.all().map(axOf).filter((c) =>
    (mirrored ? key(...f(c)) === key(...c) : hexDist(c, f(c)) >= 5 + 2 * spread) && diskCells(c, (mirrored ? 3 : 2) + spread).every((a) => !nearAny(a, baseCells, 2)));
  if (!centres.length) return null;
  const centre = rng.pick(centres);
  const patch = [...new Map([...diskCells(centre, (mirrored ? 3 : 2) + spread), ...(mirrored ? [] : diskCells(f(centre), 2 + spread))]
    .filter((a) => b.get(...a)).map((a) => [key(...a), a] as const)).values()];
  const pairs: [Ax, Ax][] = [];
  const seen = new Set<string>();
  for (const a of patch) {
    if (seen.has(key(...a)) || key(...f(a)) === key(...a)) continue;
    seen.add(key(...a));
    seen.add(key(...f(a)));
    pairs.push([a, f(a)]);
  }
  if (pairs.length < 12) return null;
  const inPatch = new Set(patch.map((a) => key(...a)));
  const clumping = (owner: Map<string, number>) => {
    let score = 0;
    const count = [0, 0];
    const done = new Set<string>();
    for (const at of patch) {
      if (done.has(key(...at)) || !owner.has(key(...at))) continue;
      done.add(key(...at));
      const stack = [at];
      let size = 0;
      while (stack.length) {
        const [q, r] = stack.pop()!;
        size++;
        for (const [dq, dr] of DIRS) {
          const n = key(q + dq, r + dr);
          if (owner.get(n) === owner.get(key(q, r)) && !done.has(n)) {
            done.add(n);
            stack.push([q + dq, r + dr]);
          }
        }
      }
      score += size * size + (size > 8 + 4 * spread ? 1e5 : 0);
      count[owner.get(key(...at))!]++;
    }
    return score + (Math.min(...count) < 3 ? 1e6 : 0);
  };
  let deal = new Map<string, number>();
  let best = Infinity;
  for (let attempt = 0; attempt < 48; attempt++) {
    const owner = new Map<string, number>();
    for (const [a, c] of pairs) {
      const p = rng.int(2);
      owner.set(key(...a), p);
      owner.set(key(...c), 1 - p);
    }
    const score = clumping(owner);
    if (score < best) [best, deal] = [score, owner];
  }
  if (best >= 1e5) return null;
  // thoroughly mixed: most colony cells touch a rival one
  const mixed = [...deal.keys()].filter((at) => { const [q, r] = at.split(',').map(Number); return DIRS.some(([dq, dr]) => { const o = deal.get(key(q + dq, r + dr)); return o !== undefined && o !== deal.get(at); }); });
  if (mixed.length < 16 * (1 + spread)) return null;
  const keep = (s: Slot) => nearAny(axOf(s), baseCells, 1) || inPatch.has(key(s.q, s.r));
  if (plain) symmetricMaxes(b, rng, syms);
  else symmetricTerrain(b, rng, syms, terrainPlan(rng), keep, (s) => nearAny(axOf(s), baseCells, 1));
  for (const [a, c] of pairs) {
    const power = 1 + rng.int(3);
    b.set(...a, { owner: deal.get(key(...a))!, power });
    b.set(...c, { owner: deal.get(key(...c))!, power });
  }
  for (const a of patch) if (!deal.has(key(...a))) b.set(...a, { power: 1 });
  diskCells(base0, 2).forEach((a) => b.set(...a, { owner: 0, power: kp(rng, k) }));
  diskCells(f(base0), 2).forEach((a) => b.set(...a, { owner: 1, power: 7 }));
  if (!b.solid() || b.cells.size < least(130) || !keepsSize(b.cells.size, 7.5 + 2 * grow, grow)) return null;
  // the bases stay within three steps of each other; every colony at least three from its own base
  const near0 = boardDistances(b, diskCells(base0, 2));
  if (Math.min(...diskCells(f(base0), 2).map((a) => near0.get(key(...a)) ?? Infinity)) > 3) return null;
  const near1 = boardDistances(b, diskCells(f(base0), 2));
  for (const a of patch) {
    const p = deal.get(key(...a));
    if (p !== undefined && ((p ? near1 : near0).get(key(...a)) ?? Infinity) < 3) return null;
  }
  b.rotate(rng.int(6));
  return b;
}

/**
 * Olympus: camps around a walled mountain of rich slopes, three shrines on it. The mountain's height,
 * its gates (or a garrison instead of a wall, or an inner sanctum), the shrines, the camps and the
 * land around change every time; everything is copied by the symmetries that carry camp onto camp.
 */
function olympusAttempt(rng: Rng, k: number, seats: number, plain: boolean, grow: number): Board | null {
  const syms = seatSymmetries(seats);
  const sides = seatSides(seats, 0);
  const base = seats <= 3 ? 5 : seats === 4 ? 6 : 6 + (plain ? 0 : rng.int(2));
  const radius = base + 2 * grow;
  const style: LandStyle = plain ? 'round' : rng.pick(['round', 'lobed', 'jagged'] as const);
  const b = symmetricLand(rng, syms, radius, style);
  if (!b.solid() || b.cells.size < 20 * seats + 5) return null;
  // the mountain grows with the land
  const height = (plain ? 2 : 2 + rng.int(2)) + grow;
  const fortified = plain ? 0 : rng.int(3);
  const dist = (c: Ax) => hexDist(c, [0, 0]);
  const up = (c: Ax) => dist(c) <= height;
  // the camps: four cells on the rim, or three a step further in
  const outer = Math.max(...b.all().filter((c) => c.r === 0 && c.q > 0).map((c) => c.q));
  const camp0: Ax[] = rng.bool() || plain
    ? diskCells([outer - 1, 0], 1).filter((a) => b.get(...a) && dist(a) >= outer - 1)
    : [[outer - 1, 0], [outer - 2, 0], [outer - 2, 1]];
  if (camp0.length < 3 || camp0.some((a) => !b.get(...a)) || Math.min(...camp0.map(dist)) < height + 2) return null;
  const camps = sides.map((side) => camp0.map(symToSide(syms, side)));
  const campCells = camps.flat();
  const shrines = symmetricTriple(rng, b, syms, up, 2 + grow);
  if (!shrines) return null;
  const keep = (s: Slot) => dist(axOf(s)) <= height + 1 || nearAny(axOf(s), campCells, 2);
  if (plain) symmetricMaxes(b, rng, syms, 0.2);
  else symmetricTerrain(b, rng, syms, terrainPlan(rng), keep, (s) => dist(axOf(s)) <= height + 1 || nearAny(axOf(s), campCells, 1));
  // the slopes: rich and unclaimed
  for (const c of b.all()) if (up(axOf(c))) Object.assign(c, { max: 12, power: 0 });
  if (fortified === 2) {
    // no wall, but a garrison on every slope cell of the rim
    for (const c of b.all()) if (dist(axOf(c)) === height) c.power = 3;
  } else {
    // the wall with its gates (an orbit or two of rim cells); an inner sanctum has its own wall
    const rings = fortified === 1 && height >= 3 ? [height, 1] : [height];
    for (const ring of rings) {
      const rim = b.all().filter((c) => dist(axOf(c)) === ring).map(axOf);
      const gates = new Set<string>();
      for (let g = ring === 1 ? 1 : 1 + rng.int(2); g > 0; g--) for (const a of orbit(rng.pick(rim), syms)) gates.add(key(...a));
      for (const c of rim) {
        if (gates.has(key(...c))) continue;
        for (const [dq, dr] of DIRS) {
          const n: Ax = [c[0] + dq, c[1] + dr];
          if (dist(n) === ring + 1 && b.get(...n)) b.wall(c, n);
        }
      }
    }
  }
  for (const a of shrines) b.set(...a, { objective: true, power: 2 });
  camps.forEach((camp, p) => camp.forEach((a) => b.set(...a, { owner: p, power: p === 0 ? kp(rng, k) : 3 })));
  if (!b.solid() || b.cells.size < 20 * seats + 5) return null;
  if (!keepsSize(b.cells.size, (seats <= 3 ? 5 : seats === 4 ? 6 : 6.5) + 2 * grow, grow)) return null;
  // every shrine within reach, none next to a camp
  const climbs = shrines.map((a) => boardDistances(b, [a]));
  if (climbs.some((d) => campCells.some((c) => (d.get(key(...c)) ?? 0) < 3))) return null;
  b.rotate(rng.int(6));
  return b;
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
  archipelago(rng, k, seats, _size, { even }) {
    const b = new Board();
    // people at the table: every island gets the same garrison (rolled once, cell by cell from its centre)
    const garrison = new Map<string, number>();
    const roll = (c: Ax, s: Slot) => {
      if (!even) return 3 + rng.int(2);
      const at = key(s.q - c[0], s.r - c[1]);
      if (!garrison.has(at)) garrison.set(at, 3 + rng.int(2));
      return garrison.get(at)!;
    };
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
        if (hexDist([s.q, s.r], c) <= 1) Object.assign(s, { owner, power: owner === 0 && !even ? kp(rng, k) : roll(c, s) });
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
    // no thin isthmus between two camps: a narrow neck is held for ever and the game stalls
    const need = size === 'L' ? 4 : 5;
    let widest: { b: Board; width: number } | null = null;
    for (let attempt = 0; attempt < 90; attempt++) {
      const b = moonvaleAttempt(rng, k, seats, radius, syms, attempt >= 60);
      if (!b) continue;
      const width = campWidth(b, seats, need);
      if (!widest || width > widest.width) widest = { b, width };
      if (width >= need) break;
    }
    if (!widest) throw new Error(`moonvale: no layout for ${seats} seats`);
    widest.b.rotate(turn);
    return widest.b;
  },

  /** Three realms of a fully taken land, a spark buried in each; land, realms and deal change every time. */
  sparks(rng, k, _seats, size) {
    return firstDesign((plain) => sparksAttempt(rng, k, plain, growth('sparks', size)), 'sparks');
  },

  /**
   * No squads and no stronghold: only little pools of light scattered over a wild land of a new shape
   * every time (winding valleys, a ragged continent or islands), with pools, walls and armed ruins out
   * in the dark. Every scout lands on open ground with a way out in every direction.
   */
  fireflies(rng, k, seats, size, { even }) {
    const radius = scoutRadius('fireflies', size, seats);
    const syms = [turnSym(0)];
    for (let attempt = 0; attempt < 60; attempt++) {
      const b = wildLand(rng, syms, radius, rng.pick(WILD_STYLES), []);
      if (!b) continue;
      const drops = wildDrops(rng, b, 3, 3 * seats);
      if (!drops) continue;
      darkTerrain(b, rng, syms, (c) => nearAny(axOf(c), drops, 2), (c) => nearAny(axOf(c), drops, 1));
      // the rugged land takes away much of a strong player's edge: one of your scouts is a little
      // stronger (bot matches: Master as you wins about as often as on the old open disk)
      rng.shuffle(drops).forEach((at, i) => {
        const owner = i % seats;
        b.set(...at, { owner, power: owner ? 2 : kp(rng, k) + (i === 0 && !even ? 1 : 0), max: 8 });
      });
      return b;
    }
    // the last resort: the plain disk
    const b = new Board();
    b.disk(radius);
    for (const c of b.all()) c.max = rollMax(rng);
    rng.shuffle(landingDrops(rng, radius, 3, 3 * seats)).forEach((at, i) => {
      const owner = i % seats;
      b.set(...at, { owner, power: owner ? 2 : kp(rng, k) });
    });
    return b;
  },

  /** Two camps, three points between them, on new symmetric land every time. */
  crossroads(rng, k, _seats, size) {
    return firstDesign((plain) => crossroadsAttempt(rng, k, plain, growth('crossroads', size)), 'crossroads');
  },

  /**
   * Camps at the foot of the mountains, three marked summits in a new arrangement every launch, and a
   * central lake, a garrisoned plateau or ridges with passes between them. Everything (summits,
   * terrain, capacities, garrisons) is laid out once and copied by the symmetries that carry every camp
   * onto every other, so each seat faces the same climb (five seats: the six-seat layout, one camp empty).
   */
  highlands(rng, k, seats, size) {
    const grow = growth('highlands', size);
    const radius = (seats === 2 ? 5 : seats === 3 ? 6 : 7) + rng.int(2) + 2 * grow;
    const turn = rng.int(6);
    const syms = seatSymmetries(seats);
    for (let attempt = 0; attempt <= 40; attempt++) {
      const b = highlandsAttempt(rng, k, seats, radius, syms, attempt === 40, attempt === 40 ? 0 : grow);
      if (b) {
        b.rotate(turn);
        return b;
      }
    }
    throw new Error(`highlands: no layout for ${seats} seats`);
  },

  /** Two neighbouring strongholds and a flank (or two) of intermingled small colonies, on new land every time. */
  colonies(rng, k, _seats, size) {
    return firstDesign((plain) => coloniesAttempt(rng, k, plain, growth('colonies', size)), 'colonies');
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

  /** Camps around a walled mountain with three shrines; the mountain, its gates and the land change every time. */
  olympus(rng, k, seats, size) {
    return firstDesign((plain) => olympusAttempt(rng, k, seats, plain, growth('olympus', size)), 'olympus');
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
 * Turn-order compensation of the equal-seat scenarios by seat count, against bots (you start stronger,
 * by the scenario's knob; with people at the table see PEOPLE_SEAT_COMP). Olympus and the highlands give
 * later seats the ordinary battle's extra first income (engine.seatBonus per start cell). Measured
 * with Master in every seat, 40–80 games per line (scripts/scenario-sim.ts): without a compensation the
 * first mover won 40 of 40 two-seat valleys and 22–33 of 40 three-seat ones.
 */
const SEAT_COMP: Partial<Record<ScenarioId, (seats: number) => OrderComp | null>> = {
  olympus: (n) => defaultOrderComp(n, 1),
  highlands: (n) => defaultOrderComp(n, 1),
  // The turn passes round the table in seat order, always: a changed order (a snake, every other round
  // backwards) gave a seat two whole turns in a row, which players read as a broken turn order.
  // two seats: the first mover sits out its first attack, with 4 more income (46 : 34 of 80)
  moonvale: (n) => n === 2 ? { skip: 1, bonus: [4, 0] } : null,
  // two seats: the first mover sits out its first attack (without: 40 of 40 for it; with: 51 : 69 of 120);
  // five or six: the first two sit out their first attack (5: 21 / 15 / 21 / 15 / 8 of 80; 6: 33 / 16 / 26 / 14 / 11 / 20 of 120)
  fireflies: (n) => n === 2 ? { skip: 1, bonus: [0, 1] } : n <= 4 ? null : { skip: 2 },
  // three seats: 3 extra cells' worth per later seat (without: 16 / 15 / 9 of 40; with: 12 / 11 / 17)
  archipelago: (n) => defaultOrderComp(n, n === 3 ? 3 : 1),
};

/**
 * When people share the table every seat starts alike, and the turn order is the only difference left:
 * later seats get more first income (engine.seatBonus with the given per-cell step), or, where the
 * first blow decides the match, the first mover sits out its first attack. Measured with Master in every
 * seat and equal starts, 160 games per line (scripts/scenario-sim.ts even=1), wins by turn position:
 * - valley, 3 seats: none 71 / 18 / 11 %, step 14: 44 / 34 / 22, step 20: 41 / 26 / 33; 4: none
 *   54 / 20 / 18 / 8, step 6: 31 / 25 / 23 / 21; 5, step 6: 24 / 23 / 20 / 15 / 18; 6: none
 *   36 / 20 / 15 / 9 / 11 / 8, step 6: 21 / 18 / 15 / 8 / 16 / 21 (the bonus is capped by the room on
 *   the camp's cells, so the later seats of three get about the same)
 * - fireflies, step 3: 3 seats 36 / 39 / 25 (none: 75 / 16 / 8), 4: 28 / 24 / 23 / 25, 6: 13 to 21 each
 * - highlands: 2 seats none 62 / 38, +4 49 / 51; 3 seats step 3: 32 / 32 / 35 (step 1: 48 / 24 / 28)
 * - crossroads, 2 seats: none 74 / 26, +6 for the second: 49 / 51
 * - colonies, 2 seats: the first mover won 160 of 160 even with +4 for the second; sitting out its first
 *   attack: 48 / 52
 * - sparks, 3 seats: none 55 / 24 / 21, step 10: 39 / 34 / 28, step 14: 29 / 34 / 37 (12: between)
 * Olympus, the archipelago and the night drop were already even (within a few points of a fair share).
 */
const PEOPLE_SEAT_COMP: Partial<Record<ScenarioId, (seats: number) => OrderComp | null>> = {
  moonvale: (n) => n === 2 ? { skip: 1, bonus: [4, 0] } : defaultOrderComp(n, n === 3 ? 20 : 6),
  fireflies: (n) => n === 2 ? { skip: 1, bonus: [0, 1] } : defaultOrderComp(n, 3),
  highlands: (n) => n === 2 ? { bonus: [0, 4] } : defaultOrderComp(n, n === 3 ? 3 : 1),
  crossroads: () => ({ bonus: [0, 6] }),
  colonies: () => ({ skip: 1 }),
  sparks: (n) => defaultOrderComp(n, 12),
};

/**
 * The turn-order compensation of an equal-seat scenario (given: that one; 'off': none), or null.
 * `people`: people share the table, so every seat starts alike (against bots your start is the knob).
 */
export function scenarioOrderComp(id: ScenarioId, seats: number, given?: OrderComp | 'off', people = false): OrderComp | null {
  const comp = (people && PEOPLE_SEAT_COMP[id]) || SEAT_COMP[id];
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
  const { size, unions, frontier, signalFires } = scenarioSetup(id, config);
  const rng = new Rng(seed);
  // people at the table: everyone starts alike (the stronger start of yours is a handicap against bots)
  const people = !historical && (!!config?.even || seats.filter(isPersonType).length >= 2);
  const even = people && EVEN_KNOB[id] !== undefined;
  const comp = id === 'landing' ? landingOrderComp(seats.length, size, config?.orderComp)
    : historical ? null : scenarioOrderComp(id, seats.length, config?.orderComp, people);
  const legacyBuilder = historical ? LEGACY_BUILDERS[id] : undefined;
  const board = legacyBuilder ? legacyBuilder(rng, knob ?? DAILY_KNOB[id] ?? scenarioKnob(id, size), seats.length) :
    BUILDERS[id](rng, even ? EVEN_KNOB[id]! : knob ?? scenarioKnob(id, size), seats.length, size, { comp, even });
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
      ...(signalFires && meta.darkness ? { signalFires: true } : {}),
      ...(frontier ? frontierSettings(frontier) : {}),
    },
    { field, keepPlacement: true, seed: seed ^ 0x5bd1e995 },
  );
  if (objectives.length) state.objectives = objectives;
  // frontier victory on the built map: contested cells every start can reach, spread apart (the map
  // and the dice are the same as without it)
  if (frontier) state.objectives = chooseFrontierPoints(state.field, frontier.pointCount);
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
  const config: ScenarioConfig = {
    size: settings.size,
    unions: settings.unions,
    frontierMode: settings.frontierMode,
    frontierPoints: settings.frontierPointCount,
    frontierWin: settings.frontierWinCount,
    frontierHold: settings.frontierHoldTurns,
    signalFires: settings.signalFires,
  };
  const st = !order ? buildScenario(id, seed, undefined, settings.players, config)
    // the night drop builds its turn-order compensation into the squads: its seats are dealt before the drop
    : id === 'landing' ? buildScenario(id, seed, undefined, order.map((i) => settings.players[i]), config)
    // elsewhere the design favours your seat (the difficulty knob): build it for you, then move the turn order
    : buildScenarioInternal(id, seed, undefined, settings.players, config, false, order);
  st.settings = { ...st.settings, kind: settings.kind, turnTime: settings.turnTime, ...(shuffle ? { shuffle: true } : {}) };
  return st;
}
