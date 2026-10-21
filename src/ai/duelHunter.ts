import { targetsFrom } from '../core/engine';
import { NEUTRAL, type MatchState } from '../core/types';
import { HunterBot } from './hunter';

/**
 * Hunter used in duel training: GreyFirstLazyEnemy target choice — if any candidate is neutral,
 * only neutral cells are considered (required by the duel "greys first" rule; the engine's
 * targetsFrom() already applies it under duel rules, the explicit filter keeps the behaviour in any mode).
 */
export class DuelHunterBot extends HunterBot {
  override readonly type = 'duelHunter' as const;

  protected override targets(state: MatchState, src: number): number[] {
    const all = targetsFrom(state, src);
    const greys = all.filter((t) => state.field.cells[t].owner === NEUTRAL);
    return greys.length ? greys : all;
  }
}
