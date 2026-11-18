import { articulationPoints } from './connectivity';
import { objectivePuzzle, objectivesOptional } from './objectivePuzzles';
import { NEUTRAL, type Field, type MatchState } from './types';

export const FRONTIER_MIN_POINTS = 3;
export const FRONTIER_MAX_POINTS = 9;

/** Normalize untrusted preferences; missing win count follows the majority of the selected points. */
export function frontierConfig(settings: Partial<{ frontierPointCount: unknown; frontierWinCount: unknown }>): { pointCount: number; winCount: number } {
  const clamp = (value: unknown, fallback: number, min: number, max: number) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
  const pointCount = clamp(settings.frontierPointCount, 3, FRONTIER_MIN_POINTS, FRONTIER_MAX_POINTS);
  const winCount = clamp(settings.frontierWinCount, Math.floor(pointCount / 2) + 1, 1, pointCount);
  return { pointCount, winCount };
}

/** Named puzzles always retain their published three targets and two-point victory. */
export function objectiveWinCount(s: MatchState): number {
  return s.settings.puzzle ? 2 : frontierConfig(s.settings).winCount;
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

/** Prefer contested interior cells reachable from every base, then spread the points apart. */
export function chooseFrontierPoints(field: Field, pointCount = 3): number[] {
  const bases = field.cells.flatMap((cell, i) => cell.owner >= 0 ? [i] : []);
  const fromBases = bases.map(i => distances(field.adj, i));
  const walkable = field.cells.flatMap((cell, i) =>
    cell.owner === NEUTRAL && field.adj[i].length >= 2 && !field.starts.includes(i) && fromBases.every(d => Number.isFinite(d[i])) ? [i] : []);
  const cuts = new Set(articulationPoints(field.adj));
  const open = walkable.filter(i => !cuts.has(i));
  // Prefer points with a way around them, so a fortified tile cannot lock down access to a pocket.
  // Larger sets exhaust open cells before using cuts; three-point maps keep their published selection.
  const tiers = open.length >= pointCount ? [open] : pointCount === 3 ? [walkable] : [open, walkable];
  const points: number[] = [];
  const spacing: number[][] = [];
  while (points.length < pointCount) {
    let available: number[] = [];
    for (const tier of tiers) {
      available = tier.filter(i => !points.includes(i) && spacing.every(d => d[i] >= 2));
      if (!available.length) available = tier.filter(i => !points.includes(i));
      if (available.length) break;
    }
    if (!available.length) throw new RangeError(`Not enough non-start cells for ${pointCount} frontiers`);
    const score = (i: number) => {
      const access = fromBases.map(d => d[i]).sort((a, b) => a - b);
      const spread = spacing.length ? Math.min(...spacing.map(d => d[i])) : 0;
      return spread * 6 - access[1] * 2 - access[0] - (access[access.length - 1] - access[0]);
    };
    const best = available.reduce((best, i) => score(i) > score(best) ? i : best);
    points.push(best);
    spacing.push(distances(field.adj, best));
  }
  return points;
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
}

/** The actual handoff, not the round number, is the clock. Consecutive snake turns offer no defence. */
export function objectiveHandoff(s: MatchState, previous: number): void {
  if (!s.objectives || previous === s.current || s.ended) return;
  interruptObjectiveHold(s);
  if (objectiveHolders(s).includes(s.current)) {
    s.ended = { reason: 'objective', winner: s.current, humanWon: s.settings.players[s.current] === 'human', turn: s.turn };
  } else if (objectiveCount(s, previous) >= objectiveWinCount(s) && !objectiveHolders(s).includes(previous)) {
    if (s.objectiveHolder === undefined) s.objectiveHolder = previous;
    else (s.objectiveHoldersExtra ??= []).push(previous);
  }
}

/** The hold cannot be reconstructed from current owners; save and snapshot validators need both. */
export function validObjectiveFields(s: Record<string, unknown>, cells: unknown[], seats: number, settings: Record<string, unknown>): boolean {
  const ids = s.objectives, holder = s.objectiveHolder, extra = s.objectiveHoldersExtra;
  const generated = settings.frontierMode === true && !settings.puzzle && !settings.duelRules && (settings.kind === 'single' || settings.kind === 'battleOnline');
  const named = objectivePuzzle(settings.puzzle, settings.kind);
  const enabled = named || generated;
  if (settings.frontierMode !== undefined && typeof settings.frontierMode !== 'boolean') return false;
  if (settings.frontierMode === true && !generated) return false;
  if (settings.frontierPointCount !== undefined && (!Number.isInteger(settings.frontierPointCount) || (settings.frontierPointCount as number) < FRONTIER_MIN_POINTS || (settings.frontierPointCount as number) > FRONTIER_MAX_POINTS)) return false;
  const { pointCount, winCount } = frontierConfig(settings);
  if (settings.frontierWinCount !== undefined && (!Number.isInteger(settings.frontierWinCount) || (settings.frontierWinCount as number) < 1 || (settings.frontierWinCount as number) > pointCount)) return false;
  const none = ids === undefined && holder === undefined && extra === undefined;
  if (!enabled) return none;
  // a scenario that gained control points later: games saved before that have none
  if (none && objectivesOptional(settings.puzzle, settings.kind)) return true;
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
  if (s.objectiveHoldersExtra) {
    mix(0x484f);
    for (const seat of s.objectiveHoldersExtra) mix(seat + 1);
  }
}
