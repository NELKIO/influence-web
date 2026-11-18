import type { MatchState } from './types';

/** Shared snapshot boundary for saves and both wire formats (legacy saves have no sources). */
export function validSignalFireCells(value: unknown, seats: number, cells: number): boolean {
  return value === undefined || (Array.isArray(value) && value.length === seats &&
    value.every(i => Number.isInteger(i) && i >= -1 && i < cells));
}

/** Hash sources by seat, not by round or viewer. Preserve hashes of games without fires. */
export function mixSignalFires(s: MatchState, mix: (n: number) => void): void {
  if (!s.settings.darkness || !s.settings.signalFires) return;
  mix(0x5346);
  s.settings.players.forEach((_, seat) => {
    mix((s.signalFireCells?.[seat] ?? -1) + 1);
    if (s.settings.blind) {
      const row = s.explored?.[seat] ?? '';
      mix(row.length);
      for (let i = 0; i < row.length; i++) mix(row.charCodeAt(i));
    }
  });
}
