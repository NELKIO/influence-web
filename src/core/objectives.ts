import type { MatchState } from './types';

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
export function validObjectiveFields(s: Record<string, unknown>, cells: unknown[], seats: number, puzzle: unknown): boolean {
  const ids = s.objectives, holder = s.objectiveHolder;
  const enabled = puzzle === 'crossroads' || puzzle === 'highlands';
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
