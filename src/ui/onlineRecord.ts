/**
 * Stats records of online matches written by the online glue itself (not by the game screen): a
 * person whose seat is out of a battle (conceded / knocked out), or who removed a running duel, gets
 * a loss at that moment, even if they are on another screen or leave right after. Each result is
 * recorded once: the keys of recorded results are remembered, and the game screen asks
 * (`OnlineBinding.ownsResult`) before it records the end of the match itself.
 */
import { alivePlayers } from '../core/engine';
import type { MatchState } from '../core/types';
import { addRecord } from '../storage';
import { countGame } from '../sitestats';

const KEY = 'infweb.onlineRecorded';
const KEEP = 200;

function recorded(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function wasRecorded(key: string): boolean {
  return recorded().includes(key);
}

function remember(key: string) {
  try {
    localStorage.setItem(KEY, JSON.stringify([...recorded(), key].slice(-KEEP)));
  } catch {
    /* ignore */
  }
}

/**
 * Record a result of the person playing `seats` in `state` (once per `key`). `place`: 1 = winner; for a
 * loss by default the seats still alive + 1 (the place the person went out on). Returns true if written now.
 */
export function recordOnlineResult(key: string, state: MatchState, seats: number[], win: boolean, place?: number): boolean {
  if (!seats.length || wasRecorded(key)) return false;
  remember(key);
  countGame();
  const others = alivePlayers(state).filter((p) => !seats.includes(p));
  addRecord({
    at: Date.now(),
    kind: state.settings.kind,
    size: state.settings.size,
    opponents: state.settings.players.filter((_, i) => !seats.includes(i)),
    humans: seats.length,
    win,
    rounds: (state.ended?.turn ?? state.turn) + 1,
    captured: state.chronicle?.conquered ?? 0,
    ms: Date.now() - state.startedAt,
    place: place ?? (win ? 1 : others.length + 1),
  });
  return true;
}

export function recordOnlineLoss(key: string, state: MatchState, seats: number[], place?: number): boolean {
  return recordOnlineResult(key, state, seats, false, place);
}
