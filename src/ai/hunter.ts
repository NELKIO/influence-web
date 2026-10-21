import { cellsOf, targetsFrom } from '../core/engine';
import { Rng } from '../core/rng';
import { NEUTRAL, type MatchState } from '../core/types';
import { botSeed, hasEnemies, isMyAttackPhase, legalOrNull, smartyPower } from './common';
import type { AttackMove, Bot, BotContext } from './types';

/** Strongest own border cell (random initial pick, then the first strictly stronger in field order). */
export function beefySource(state: MatchState, rng: Rng): number | null {
  const own = cellsOf(state, state.current);
  if (own.length === 0 || own.length === state.field.cells.length) return null;
  const border = own.filter((c) => hasEnemies(state, c));
  // guard: the original loops forever when there is no border cell (disconnected maps)
  if (!border.length) return null;
  const cells = state.field.cells;
  let best = border[rng.int(border.length)];
  let bestP = cells[best].power;
  for (const c of border) {
    if (cells[c].power > bestP) {
      best = c;
      bestP = cells[c].power;
    }
  }
  return best;
}

/** LazyEnemy: weakest neighbour (neutral cells first), with the original index-0 quirk. */
export function lazyTarget(state: MatchState, targets: number[], rng: Rng): number | null {
  if (!targets.length) return null;
  const cells = state.field.cells;
  const powers = targets.map((t) => (cells[t].owner === NEUTRAL ? 0 : cells[t].power));
  const m = Math.min(...powers);
  if (powers[0] === m && m > 0) return targets[0];
  const ties = targets.filter((_, i) => powers[i] === m);
  return ties[rng.int(ties.length)];
}

/**
 * Hunter ("Охотник"): attacks from its strongest border cell into the weakest neighbour until every
 * border cell is down to 1 (never declines a fight). Power: SmartyPower (border cells first).
 */
export class HunterBot implements Bot {
  readonly type: 'hunter' | 'duelHunter' = 'hunter';
  protected rng: Rng;

  constructor(seed?: number) {
    this.rng = new Rng(botSeed(seed));
  }

  /** Candidate targets from the chosen source. */
  protected targets(state: MatchState, src: number): number[] {
    return targetsFrom(state, src);
  }

  pickAttack(state: MatchState): AttackMove | null {
    if (!isMyAttackPhase(state)) return null;
    const src = beefySource(state, this.rng);
    if (src === null || state.field.cells[src].power < 2) return null;
    const tgt = lazyTarget(state, this.targets(state, src), this.rng);
    if (tgt === null) return null;
    return legalOrNull(state, src, tgt);
  }

  async nextAttack(state: MatchState, _ctx: BotContext): Promise<AttackMove | null> {
    return this.pickAttack(state);
  }

  async placePower(state: MatchState, _ctx: BotContext): Promise<Map<number, number>> {
    return smartyPower(state);
  }
}
