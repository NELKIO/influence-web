import type { BotType, MatchState } from '../core/types';

export interface AttackMove {
  from: number;
  to: number;
}

export interface BotContext {
  /** delay between bot actions in ms (game speed); Master scales its thinking time with it */
  speedMs: number;
}

/**
 * A computer player. One instance per slot per match.
 * The game loop calls nextAttack() repeatedly during the bot's attack phase (one fight per call,
 * applying it with engine.attack in between) until it returns null, then calls placePower() once.
 */
export interface Bot {
  readonly type: BotType;
  /** next attack for state.current, or null to end the attack phase. Must be a legal attack. */
  nextAttack(state: MatchState, ctx: BotContext): Promise<AttackMove | null>;
  /** full power placement for state.current: cell index -> amount; sum must equal state.powerLeft and respect capacities */
  placePower(state: MatchState, ctx: BotContext): Promise<Map<number, number>>;
  dispose?(): void;
}
