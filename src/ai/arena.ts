/**
 * Headless match runner: plays a whole match through the engine with bots in every seat.
 * Used by the simulation tests and the strength script (scripts/strength.ts). No DOM.
 *
 * Seats typed 'human' are driven by `humanAs` bots (so union / stuck / luck code paths for humans are
 * exercised). When no seat is human the engine would end the match at the first fight ("no human
 * left"); the arena undoes that particular ending so bot-only matches play out to elimination.
 */
import {
  addPower,
  alivePlayers,
  attack,
  checkAttack,
  checkStuck,
  createMatch,
  endAttack,
  finishEarly,
  finishTurn,
  isAlive,
} from '../core/engine';
import type { BotType, MatchSettings, MatchState } from '../core/types';
import type { Bot, BotContext } from './types';

export interface ArenaOptions {
  seed: number;
  /** one bot per seat (seats typed 'human' are also driven by their bot) */
  bots: Bot[];
  /** stop after this many completed rounds (default 300) */
  maxRounds?: number;
  /** check invariants after every step (throws on violation) */
  checkInvariants?: boolean;
  ctx?: BotContext;
  /** accept early-finish offers of the stuck check for human seats (default true) */
  acceptStuck?: boolean;
}

export interface ArenaResult {
  state: MatchState;
  /** winner seat, -1 if none (round cap or no single winner) */
  winner: number;
  rounds: number;
  capped: boolean;
  attacks: number;
  unions: number;
}

export class InvariantError extends Error {}

function fail(msg: string): never {
  throw new InvariantError(msg);
}

export function totalPower(state: MatchState): number {
  let s = 0;
  for (const c of state.field.cells) if (c.owner >= 0) s += c.power;
  return s;
}

export function checkCells(state: MatchState): void {
  const n = state.settings.players.length;
  state.field.cells.forEach((c, i) => {
    if (c.owner < -1 || c.owner >= n || !Number.isInteger(c.owner)) fail(`cell ${i}: bad owner ${c.owner}`);
    if (c.owner === -1) {
      if (c.power !== 0) fail(`cell ${i}: neutral with power ${c.power}`);
    } else if (!(c.power >= 1 && c.power <= c.maxPower && Number.isInteger(c.power))) {
      fail(`cell ${i}: power ${c.power} out of 1..${c.maxPower}`);
    }
  });
}

/** Undo the engine's "no human left" ending in bot-only matches while several bots are alive. */
function reviveBotOnly(state: MatchState) {
  if (state.ended && state.ended.winner === -1 && state.ended.reason === 'elimination' && alivePlayers(state).length > 1) {
    state.ended = null;
  }
}

export async function runMatch(settings: MatchSettings, opts: ArenaOptions): Promise<ArenaResult> {
  const state = createMatch(settings, { seed: opts.seed });
  const maxRounds = opts.maxRounds ?? 300;
  const ctx = opts.ctx ?? { speedMs: 0 };
  const check = opts.checkInvariants ?? false;
  let attacks = 0;
  let unions = 0;
  if (check) checkCells(state);

  while (!state.ended && state.turn < maxRounds) {
    const me = state.current;
    const bot = opts.bots[me];
    if (check) {
      if (!isAlive(state, me)) fail(`current player ${me} is not alive`);
      if (state.phase !== 'attack') fail(`turn starts in phase ${state.phase}`);
    }
    if (settings.players[me] === 'human' || state.settings.players[me] === 'human') {
      const offer = checkStuck(state);
      if (offer && (opts.acceptStuck ?? true)) {
        finishEarly(state, offer);
        break;
      }
    }
    // attack phase
    let guard = 0;
    for (;;) {
      if (state.ended) break;
      const mv = await bot.nextAttack(state, ctx);
      if (!mv) break;
      if (++guard > 5000) fail(`seat ${me} (${bot.type}) attacks forever`);
      const refusal = checkAttack(state, mv.from, mv.to);
      if (refusal) fail(`seat ${me} (${bot.type}) illegal move ${mv.from}->${mv.to}: ${refusal}`);
      const before = check ? totalPower(state) : 0;
      const ev = attack(state, mv.from, mv.to);
      if (typeof ev === 'string') fail(`attack refused: ${ev}`);
      attacks++;
      reviveBotOnly(state);
      if (check) {
        checkCells(state);
        const after = totalPower(state);
        const delta = ev.atkAfter + ev.defAfter - ev.atkBefore - ev.defBefore;
        if (after - before !== delta) fail(`power changed by ${after - before}, fight says ${delta}`);
        if (delta > 0) fail(`fight created power (${delta})`);
        if (ev.defBefore === 0 && delta !== 0) fail('neutral capture changed total power');
      }
    }
    if (state.ended) break;
    // power phase
    const scoreBefore = check ? totalPower(state) : 0;
    const union = endAttack(state);
    if (union) unions++;
    if (state.ended) break;
    if (check) {
      if (state.phase !== 'power') fail('endAttack did not switch to power');
      if (state.current !== me) fail('current changed in endAttack');
      if (totalPower(state) !== scoreBefore) fail('union changed total power');
      checkCells(state);
    }
    const income = state.powerLeft;
    const placement = await bot.placePower(state, ctx);
    let sum = 0;
    for (const [cell, n] of placement) {
      const c = state.field.cells[cell];
      if (!c || c.owner !== me) fail(`seat ${me} (${bot.type}) places power on foreign cell ${cell}`);
      if (n < 0 || !Number.isInteger(n)) fail(`bad amount ${n}`);
      if (c.power + n > c.maxPower) fail(`seat ${me} (${bot.type}) overfills cell ${cell}`);
      sum += n;
    }
    if (sum !== income) fail(`seat ${me} (${bot.type}) placed ${sum} of ${income}`);
    for (const [cell, n] of placement) {
      if (addPower(state, cell, n) !== n) fail(`addPower rejected ${n} on ${cell}`);
    }
    if (check) {
      if (state.powerLeft !== 0) fail('power left after placement');
      if (totalPower(state) !== scoreBefore + income) fail('power phase changed total by a wrong amount');
      checkCells(state);
    }
    const turnBefore = state.turn;
    finishTurn(state);
    if (check && !state.ended) {
      if (state.turn < turnBefore || state.turn > turnBefore + 1) fail('turn counter jumped');
      if (!isAlive(state, state.current)) fail('next player is not alive');
      if (state.phase !== 'attack') fail('next turn not in attack phase');
    }
  }
  const alive = alivePlayers(state);
  const winner = state.ended ? state.ended.winner : alive.length === 1 ? alive[0] : -1;
  return { state, winner, rounds: state.turn, capped: !state.ended, attacks, unions };
}

export const ALL_BOTS: BotType[] = ['freak', 'dummy', 'hunter', 'duelHunter', 'master'];
