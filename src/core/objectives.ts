import { articulationPoints } from './connectivity';
import { FRONTIER_SCENARIOS, objectivePuzzle, objectivesOptional } from './objectivePuzzles';
import { NEUTRAL, type Field, type MatchSettings, type MatchState } from './types';

export const FRONTIER_MIN_POINTS = 2;
export const FRONTIER_MAX_POINTS = 9;
/** The longest hold one can ask for, in own turns. */
export const FRONTIER_MAX_HOLD = 5;

/**
 * Normalize untrusted preferences; missing win count follows the majority of the selected points, a
 * missing hold is one turn (until the start of your next turn).
 */
export function frontierConfig(settings: Partial<{ frontierPointCount: unknown; frontierWinCount: unknown; frontierHoldTurns: unknown }>): { pointCount: number; winCount: number; holdTurns: number } {
  const clamp = (value: unknown, fallback: number, min: number, max: number) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
  const pointCount = clamp(settings.frontierPointCount, 3, FRONTIER_MIN_POINTS, FRONTIER_MAX_POINTS);
  const winCount = clamp(settings.frontierWinCount, Math.floor(pointCount / 2) + 1, 1, pointCount);
  const holdTurns = clamp(settings.frontierHoldTurns, 1, 1, FRONTIER_MAX_HOLD);
  return { pointCount, winCount, holdTurns };
}

/** The match settings of a frontier battle (a one-turn hold, the default, is left out as before). */
export function frontierSettings(f: { pointCount: number; winCount: number; holdTurns: number }): Pick<MatchSettings, 'frontierMode' | 'frontierPointCount' | 'frontierWinCount' | 'frontierHoldTurns'> {
  return { frontierMode: true, frontierPointCount: f.pointCount, frontierWinCount: f.winCount, ...(f.holdTurns > 1 ? { frontierHoldTurns: f.holdTurns } : {}) };
}

/**
 * Whether these settings play for generated frontier points: an ordinary battle (alone or online) with
 * the frontier mode, or one of the scenarios that let you switch it on (never a map of the day).
 */
export function frontierGenerated(s: Partial<Record<'frontierMode' | 'puzzle' | 'duelRules' | 'kind', unknown>>): boolean {
  return s.frontierMode === true && !s.duelRules && (s.kind === 'single' || s.kind === 'battleOnline') &&
    (!s.puzzle || (typeof s.puzzle === 'string' && FRONTIER_SCENARIOS.has(s.puzzle)));
}

/** Named puzzles always retain their published three targets and two-point victory. */
export function objectiveWinCount(s: MatchState): number {
  return s.settings.puzzle && !s.settings.frontierMode ? 2 : frontierConfig(s.settings).winCount;
}

/** How many of its own turns a holder must reach still holding (named puzzles: one, the next). */
export function objectiveHoldTurns(s: MatchState): number {
  return s.settings.puzzle && !s.settings.frontierMode ? 1 : frontierConfig(s.settings).holdTurns;
}

/** How many of its own turns this seat has already reached while holding (0: none yet, or no hold). */
export function objectiveHeldTurns(s: MatchState, seat: number): number {
  return s.objectiveHeld?.[seat] ?? 0;
}

/** Pending holders in arming order (including holders from legacy single-holder saves). */
export function objectiveHolders(s: MatchState): readonly number[] {
  return s.objectiveHolder === undefined ? [] : [s.objectiveHolder, ...(s.objectiveHoldersExtra ?? [])];
}

/** Deterministic graph distances; map generation and combat dice never depend on point selection. */
function distances(adj: number[][], start: number): number[] {
  const result = Array<number>(adj.length).fill(Infinity);
  result[start] = 0;
  const queue = [start];
  for (const i of queue) for (const j of adj[i]) if (result[j] === Infinity) {
    result[j] = result[i] + 1;
    queue.push(j);
  }
  return result;
}

/**
 * The symmetries of a map as it stands: permutations of the cell indices (the identity first) that
 * turn the map into itself, geometrically (rotations and reflections of the hex grid) and in play
 * (links, cell sizes, neutral garrisons, and the seats' cells onto the cells of one other seat each).
 */
export function fieldSymmetries(field: Field): number[][] {
  const cells = field.cells;
  const n = cells.length;
  const identity = cells.map((_, i) => i);
  if (!n) return [identity];
  const H = Math.sqrt(3) / 2;
  const px = (x: number, y: number) => x + (y % 2 ? 0.5 : 0);
  let cx = 0, cy = 0;
  for (const c of cells) { cx += px(c.x, c.y); cy += c.y * H; }
  cx /= n; cy /= n;
  const at = new Map<number, number>();
  cells.forEach((c, i) => at.set(c.y * 100000 + c.x, i));
  const linked = field.adj.map(list => new Set(list));
  const out: number[][] = [identity];
  for (let turn = 0; turn < 6; turn++) for (const flip of [false, true]) {
    if (turn === 0 && !flip) continue;
    const a = (turn * Math.PI) / 3, cos = Math.cos(a), sin = Math.sin(a);
    const perm: number[] = [];
    for (const c of cells) {
      const dx = px(c.x, c.y) - cx, dy = c.y * H - cy;
      const fx = flip ? -dx : dx;
      const rx = cx + fx * cos - dy * sin, ry = cy + fx * sin + dy * cos;
      const y = Math.round(ry / H), x = Math.round(rx - (y % 2 ? 0.5 : 0));
      if (Math.abs(ry - y * H) > 1e-6 || Math.abs(rx - px(x, y)) > 1e-6) break;
      const j = at.get(y * 100000 + x);
      if (j === undefined) break;
      perm.push(j);
    }
    if (perm.length !== n || !playsTheSame(field, perm, linked)) continue;
    if (!out.some(p => p.every((j, i) => perm[i] === j))) out.push(perm);
  }
  return out;
}

function playsTheSame(field: Field, perm: number[], linked: Set<number>[]): boolean {
  const seat = new Map<number, number>();
  const taken = new Set<number>();
  for (let i = 0; i < perm.length; i++) {
    const a = field.cells[i], b = field.cells[perm[i]];
    if (a.maxPower !== b.maxPower || (a.owner === NEUTRAL) !== (b.owner === NEUTRAL)) return false;
    if (a.owner === NEUTRAL) {
      if (a.power !== b.power) return false;
    } else if (seat.has(a.owner)) {
      if (seat.get(a.owner) !== b.owner) return false;
    } else {
      if (taken.has(b.owner)) return false;
      seat.set(a.owner, b.owner);
      taken.add(b.owner);
    }
    if (field.adj[i].length !== field.adj[perm[i]].length) return false;
    for (const j of field.adj[i]) if (!linked[perm[i]].has(perm[j])) return false;
  }
  return true;
}

/**
 * Prefer contested interior cells reachable from every base, then spread the points apart. On a
 * symmetric map the points come in whole symmetry orbits (one point per seat when as many points as
 * seats are asked for), so every seat has the same way to them; a remainder no orbit fits goes to the
 * cells equally far from every seat.
 */
export function chooseFrontierPoints(field: Field, pointCount = 3): number[] {
  const bases = field.cells.flatMap((cell, i) => cell.owner >= 0 ? [i] : []);
  const fromBases = bases.map(i => distances(field.adj, i));
  // per seat: how far its nearest cell is
  const seats = [...new Set(bases.map(i => field.cells[i].owner))];
  const fromSeats = seats.map(seat => {
    const own = bases.flatMap((b, k) => field.cells[b].owner === seat ? [fromBases[k]] : []);
    return field.cells.map((_, i) => Math.min(...own.map(d => d[i])));
  });
  const walkable = field.cells.flatMap((cell, i) =>
    cell.owner === NEUTRAL && field.adj[i].length >= 2 && !field.starts.includes(i) && fromBases.every(d => Number.isFinite(d[i])) ? [i] : []);
  const cuts = new Set(articulationPoints(field.adj));
  const open = walkable.filter(i => !cuts.has(i));
  // Prefer points with a way around them, so a fortified tile cannot lock down access to a pocket.
  // Larger sets exhaust open cells before using cuts.
  const tiers = open.length >= pointCount ? [open] : [open, walkable];
  const symmetries = fieldSymmetries(field);
  const orbitOf = (i: number) => [...new Set(symmetries.map(g => g[i]))];
  const unfair = (i: number) => {
    const d = fromSeats.map(s => s[i]);
    return Math.max(...d) - Math.min(...d);
  };
  const points: number[] = [];
  const spacing: number[][] = [];
  const score = (orbit: number[]) => {
    const i = orbit[0];
    const access = fromBases.map(d => d[i]).sort((a, b) => a - b);
    const spread = spacing.length ? Math.min(...orbit.map(j => Math.min(...spacing.map(d => d[j])))) : 0;
    const inner = orbit.length > 1 ? Math.min(...orbit.flatMap((a, x) => orbit.slice(x + 1).map(b => distances(field.adj, a)[b]))) : 9;
    return Math.min(spread, inner < 2 ? 0 : 9) * 6 - access[1] * 2 - access[0] - (access[access.length - 1] - access[0]) - unfair(i) * 4;
  };
  while (points.length < pointCount) {
    const left = pointCount - points.length;
    let best: number[] | null = null;
    for (const tier of tiers) {
      const orbits = new Map<number, number[]>();
      for (const i of tier) {
        if (points.includes(i)) continue;
        const orbit = orbitOf(i);
        if (orbit.length > left || orbit.some(j => !tier.includes(j) || points.includes(j))) continue;
        orbits.set(Math.min(...orbit), orbit);
      }
      // whole orbits first, the biggest that fits (one point per seat), apart from the others
      const all = [...orbits.values()];
      const sizes = [...new Set(all.map(o => o.length))].sort((a, b) => b - a);
      for (const size of sizes) {
        const fits = all.filter(o => o.length === size && (size === left || canFill(all, o, left - size)));
        const apart = fits.filter(o => spacing.every(d => o.every(j => d[j] >= 2)));
        const pool = apart.length ? apart : fits;
        if (!pool.length) continue;
        best = pool.reduce((b, o) => score(o) > score(b) ? o : b);
        break;
      }
      if (best) break;
    }
    if (!best) {
      // the remainder no orbit fits: single cells, as far from every seat as possible
      for (const tier of tiers) {
        const free = tier.filter(i => !points.includes(i));
        const apart = free.filter(i => spacing.every(d => d[i] >= 2));
        const pool = apart.length ? apart : free;
        if (!pool.length) continue;
        const key = (i: number) => score([i]) - unfair(i) * 100;
        best = [pool.reduce((b, i) => key(i) > key(b) ? i : b)];
        break;
      }
    }
    if (!best) throw new RangeError(`Not enough non-start cells for ${pointCount} frontiers`);
    for (const i of best) {
      points.push(i);
      spacing.push(distances(field.adj, i));
    }
  }
  return points;
}

/** Whether other orbits than `taken` can make up exactly `need` cells (any remainder goes to single cells). */
function canFill(orbits: number[][], taken: number[], need: number): boolean {
  if (need === 0) return true;
  // a remainder of single cells is always possible; prefer leaving one only when no orbits make it up
  const sizes = orbits.filter(o => o !== taken && !o.some(j => taken.includes(j))).map(o => o.length);
  const can = new Uint8Array(need + 1);
  can[0] = 1;
  for (const s of sizes) for (let t = need; t >= s; t--) if (can[t - s]) can[t] = 1;
  return !!can[need];
}

export function objectiveCount(s: MatchState, seat: number): number {
  return s.objectives?.filter(i => s.field.cells[i].owner === seat).length ?? 0;
}

/** Run after ownership changes, including bulk transfers. Reacquisition cannot repair a broken hold. */
export function interruptObjectiveHold(s: MatchState): void {
  const holders = objectiveHolders(s).filter(seat => objectiveCount(s, seat) >= objectiveWinCount(s));
  if (holders.length) s.objectiveHolder = holders[0];
  else delete s.objectiveHolder;
  if (holders.length > 1) s.objectiveHoldersExtra = holders.slice(1);
  else delete s.objectiveHoldersExtra;
  // a broken hold starts from nothing when it is taken up again
  if (s.objectiveHeld) s.objectiveHeld = s.objectiveHeld.map((n, seat) => holders.includes(seat) ? n : 0);
}

/**
 * The actual handoff, not the round number, is the clock: a seat that ends its turn holding enough
 * points arms a hold, and wins when it reaches the start of its own turn still holding them as many
 * times as the hold asks (once by default: its next turn).
 */
export function objectiveHandoff(s: MatchState, previous: number): void {
  if (!s.objectives || previous === s.current || s.ended) return;
  interruptObjectiveHold(s);
  if (objectiveHolders(s).includes(s.current)) {
    const need = objectiveHoldTurns(s);
    let reached = 1;
    if (need > 1) {
      const held = (s.objectiveHeld ??= Array<number>(s.settings.players.length).fill(0));
      reached = ++held[s.current];
    }
    if (reached >= need) {
      s.ended = { reason: 'objective', winner: s.current, humanWon: s.settings.players[s.current] === 'human', turn: s.turn };
      return;
    }
  }
  if (objectiveCount(s, previous) >= objectiveWinCount(s) && !objectiveHolders(s).includes(previous)) {
    if (s.objectiveHolder === undefined) s.objectiveHolder = previous;
    else (s.objectiveHoldersExtra ??= []).push(previous);
  }
}

/** The hold cannot be reconstructed from current owners; save and snapshot validators need both. */
export function validObjectiveFields(s: Record<string, unknown>, cells: unknown[], seats: number, settings: Record<string, unknown>): boolean {
  const ids = s.objectives, holder = s.objectiveHolder, extra = s.objectiveHoldersExtra;
  const generated = frontierGenerated(settings);
  const named = objectivePuzzle(settings.puzzle);
  const enabled = named || generated;
  if (settings.frontierMode !== undefined && typeof settings.frontierMode !== 'boolean') return false;
  if (settings.frontierMode === true && !generated) return false;
  if (settings.frontierPointCount !== undefined && (!Number.isInteger(settings.frontierPointCount) || (settings.frontierPointCount as number) < FRONTIER_MIN_POINTS || (settings.frontierPointCount as number) > FRONTIER_MAX_POINTS)) return false;
  const { pointCount, winCount } = frontierConfig(settings);
  if (settings.frontierWinCount !== undefined && (!Number.isInteger(settings.frontierWinCount) || (settings.frontierWinCount as number) < 1 || (settings.frontierWinCount as number) > pointCount)) return false;
  const hold = settings.frontierHoldTurns;
  if (hold !== undefined && (!generated || !Number.isInteger(hold) || (hold as number) < 1 || (hold as number) > FRONTIER_MAX_HOLD)) return false;
  const held = s.objectiveHeld;
  if (held !== undefined) {
    // counts below the hold asked for, and only for seats with a pending hold
    const pending = new Set([holder, ...(Array.isArray(extra) ? extra : [])]);
    if (!generated || !Array.isArray(held) || held.length !== seats ||
      !held.every((n, seat) => Number.isInteger(n) && n >= 0 && n < frontierConfig(settings).holdTurns && (n === 0 || pending.has(seat)))) return false;
  }
  const none = ids === undefined && holder === undefined && extra === undefined;
  if (!enabled) return none;
  // a scenario that gained control points later: games saved before that have none
  if (none && objectivesOptional(settings.puzzle)) return true;
  const required = generated ? winCount : 2;
  if (!Array.isArray(ids) || ids.length !== (generated ? pointCount : 3) || new Set(ids).size !== ids.length ||
    !ids.every(i => Number.isInteger(i) && i >= 0 && i < cells.length)) return false;
  if (extra !== undefined && (!Array.isArray(extra) || !extra.length || holder === undefined ||
    !extra.every(i => Number.isInteger(i) && i >= 0 && i < seats && i !== holder) || new Set(extra).size !== extra.length)) return false;
  if (!generated && extra !== undefined) return false;
  return (holder === undefined || (typeof holder === 'number' && Number.isInteger(holder) && holder >= 0 && holder < seats)) &&
    [holder, ...(extra ?? [])].every(seat => seat === undefined || ids.filter(i => (cells[i] as { owner?: unknown } | null)?.owner === seat).length >= required);
}

export function mixObjectives(s: MatchState, mix: (n: number) => void): void {
  if (!s.objectives) return;
  mix(0x4f42); // domain separator; leave hashes of ordinary maps unchanged
  for (const i of s.objectives) mix(i);
  mix((s.objectiveHolder ?? -1) + 1);
  mix(s.ended?.reason === 'objective' ? s.ended.winner + 1 : 0);
  if (s.settings.frontierMode && (s.settings.frontierPointCount !== undefined || s.settings.frontierWinCount !== undefined || s.objectiveHoldersExtra)) {
    mix(0x4652);
    mix(s.objectives.length);
    mix(objectiveWinCount(s));
  }
  if (s.objectiveHeld || s.settings.frontierHoldTurns !== undefined) {
    mix(0x484c);
    mix(objectiveHoldTurns(s));
    for (const n of s.objectiveHeld ?? []) mix(n);
  }
  if (s.objectiveHoldersExtra) {
    mix(0x484f);
    for (const seat of s.objectiveHoldersExtra) mix(seat + 1);
  }
}
