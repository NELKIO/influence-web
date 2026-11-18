import { articulationPoints } from './connectivity';
import { NEUTRAL, type Field, type MatchState } from './types';

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

/** Prefer contested interior cells reachable from every base, then spread the three points apart. */
export function chooseFrontierPoints(field: Field): number[] {
  const bases = field.cells.flatMap((cell, i) => cell.owner >= 0 ? [i] : []);
  const fromBases = bases.map(i => distances(field.adj, i));
  const walkable = field.cells.flatMap((cell, i) =>
    cell.owner === NEUTRAL && field.adj[i].length >= 2 && !field.starts.includes(i) && fromBases.every(d => Number.isFinite(d[i])) ? [i] : []);
  const cuts = new Set(articulationPoints(field.adj));
  const open = walkable.filter(i => !cuts.has(i));
  // Prefer points with a way around them, so a fortified tile cannot lock down access to a pocket.
  const candidates = open.length >= 3 ? open : walkable;
  const points: number[] = [];
  const spacing: number[][] = [];
  while (points.length < 3) {
    let available = candidates.filter(i => !points.includes(i) && spacing.every(d => d[i] >= 2));
    if (!available.length) available = candidates.filter(i => !points.includes(i));
    if (!available.length) throw new RangeError('Not enough non-start cells for three frontiers');
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
  if (s.objectiveHolder !== undefined && objectiveCount(s, s.objectiveHolder) < 2) delete s.objectiveHolder;
}

/** The actual handoff, not the round number, is the clock. Consecutive snake turns offer no defence. */
export function objectiveHandoff(s: MatchState, previous: number): void {
  if (!s.objectives || previous === s.current || s.ended) return;
  interruptObjectiveHold(s);
  if (s.objectiveHolder === s.current) {
    s.ended = { reason: 'objective', winner: s.current, humanWon: s.settings.players[s.current] === 'human', turn: s.turn };
  } else if (objectiveCount(s, previous) >= 2) s.objectiveHolder = previous;
}

/** The hold cannot be reconstructed from current owners; save and snapshot validators need both. */
export function validObjectiveFields(s: Record<string, unknown>, cells: unknown[], seats: number, settings: Record<string, unknown>): boolean {
  const ids = s.objectives, holder = s.objectiveHolder;
  const enabled = settings.puzzle === 'crossroads' || settings.puzzle === 'highlands' ||
    (settings.frontierMode === true && !settings.puzzle && !settings.duelRules && (settings.kind === 'single' || settings.kind === 'battleOnline'));
  if (settings.frontierMode !== undefined && typeof settings.frontierMode !== 'boolean') return false;
  if (settings.frontierMode === true && (settings.puzzle || settings.duelRules || (settings.kind !== 'single' && settings.kind !== 'battleOnline'))) return false;
  if (!enabled) return ids === undefined && holder === undefined;
  if (!Array.isArray(ids) || ids.length !== 3 || new Set(ids).size !== 3 || !ids.every(i => Number.isInteger(i) && i >= 0 && i < cells.length)) return false;
  return holder === undefined || (typeof holder === 'number' && Number.isInteger(holder) && holder >= 0 && holder < seats &&
    ids.filter(i => (cells[i] as { owner?: unknown } | null)?.owner === holder).length >= 2);
}

export function mixObjectives(s: MatchState, mix: (n: number) => void): void {
  if (!s.objectives) return;
  mix(0x4f42); // domain separator; leave hashes of ordinary maps unchanged
  for (const i of s.objectives) mix(i);
  mix((s.objectiveHolder ?? -1) + 1);
  mix(s.ended?.reason === 'objective' ? s.ended.winner + 1 : 0);
}
