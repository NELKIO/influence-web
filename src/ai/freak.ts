import { cellsOf, targetsFrom } from '../core/engine';
import { Rng } from '../core/rng';
import type { MatchState } from '../core/types';
import { botSeed, hasEnemies, isMyAttackPhase, legalOrNull, randomPower } from './common';
import type { AttackMove, Bot, BotContext } from './types';

/**
 * Freak ("Псих" / Psycho): random source among own cells (biased to border cells by rejection),
 * random target regardless of odds, stops the attack phase the first time the picked cell is too weak.
 * Power goes one unit at a time to random own cells.
 */
export class FreakBot implements Bot {
  readonly type = 'freak' as const;
  private rng: Rng;

  constructor(seed?: number) {
    this.rng = new Rng(botSeed(seed));
  }

  pickAttack(state: MatchState): AttackMove | null {
    if (!isMyAttackPhase(state)) return null;
    const own = cellsOf(state, state.current);
    const n = own.length;
    if (n === 0 || n === state.field.cells.length) return null;
    let c = own[this.rng.int(n)];
    let tries = 1;
    while (!hasEnemies(state, c) && tries <= n) {
      c = own[this.rng.int(n)];
      tries++;
    }
    if (state.field.cells[c].power < 2) return null;
    const targets = targetsFrom(state, c);
    if (!targets.length) return null;
    return legalOrNull(state, c, targets[this.rng.int(targets.length)]);
  }

  async nextAttack(state: MatchState, _ctx: BotContext): Promise<AttackMove | null> {
    return this.pickAttack(state);
  }

  async placePower(state: MatchState, _ctx: BotContext): Promise<Map<number, number>> {
    return randomPower(state, this.rng);
  }
}
