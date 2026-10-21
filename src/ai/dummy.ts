import { cellsOf, targetsFrom } from '../core/engine';
import type { MatchState } from '../core/types';
import { dummyPower, isMyAttackPhase, legalOrNull } from './common';
import type { AttackMove, Bot, BotContext } from './types';

/**
 * Dummy ("Тупица"): scans own cells cyclically in field order from a remembered index (never reset,
 * kept across turns) and attacks from the first cell with power >= 2 into its first non-own neighbour,
 * regardless of odds. Never stops voluntarily. Power: even round-robin over all own cells.
 * Fully deterministic.
 */
export class DummyBot implements Bot {
  readonly type = 'dummy' as const;
  private index = 0;

  pickAttack(state: MatchState): AttackMove | null {
    if (!isMyAttackPhase(state)) return null;
    const own = cellsOf(state, state.current);
    const n = own.length;
    if (n === 0 || n === state.field.cells.length) return null;
    if (this.index >= n) this.index = 0;
    const start = this.index;
    for (let k = 0; k < n; k++) {
      const i = (start + k) % n;
      const c = own[i];
      if (state.field.cells[c].power < 2) continue;
      const targets = targetsFrom(state, c);
      if (!targets.length) continue;
      this.index = i;
      return legalOrNull(state, c, targets[0]);
    }
    this.index = start;
    return null;
  }

  async nextAttack(state: MatchState, _ctx: BotContext): Promise<AttackMove | null> {
    return this.pickAttack(state);
  }

  async placePower(state: MatchState, _ctx: BotContext): Promise<Map<number, number>> {
    return dummyPower(state);
  }
}
