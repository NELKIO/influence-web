/**
 * Engine-level helpers for battle rooms (pure functions on MatchState; src/core is not modified).
 *
 * Concede rule (battles with 3+ seats, also used with 2): the conceding seat leaves the match. All its
 * cells become neutral (owner -1, power 0 — the engine's invariant for neutral cells), it is marked out
 * at the current round, and if it was that seat's turn the turn passes to the next alive seat. The match
 * then ends by the normal rules: one seat left → it wins; no person left → bots won (winner -1).
 * An ending caused by a concession has reason 'concede'.
 */
import * as E from '../core/engine';
import { Rng } from '../core/rng';
import type { FightEvent, MatchEnd, MatchSettings, MatchState, PlayerType, UnionEvent } from '../core/types';
import type { BattleAction } from './battleProtocol';

/** Remove `seat` from the match (see the module doc). Returns false if nothing changed. */
export function concedeSeat(state: MatchState, seat: number): boolean {
  if (state.ended || seat < 0 || seat >= state.settings.players.length || !E.isAlive(state, seat)) return false;
  for (const c of state.field.cells) {
    if (c.owner === seat) {
      c.owner = -1;
      c.power = 0;
    }
  }
  state.outAt[seat] = state.turn;
  const wasCurrent = state.current === seat;
  E.checkEnd(state);
  const end = state.ended as MatchEnd | null;
  if (end) {
    state.ended = { ...end, reason: 'concede' };
    return true;
  }
  if (wasCurrent) E.finishTurn(state);
  else if (state.selected >= 0 && state.field.cells[state.selected]?.owner !== state.current) state.selected = -1;
  return true;
}

/** Player kinds as seen by the guest in `seat`: own seat 'human', other persons 'remote', bots unchanged. */
export function localizePlayers(players: PlayerType[], seat: number): PlayerType[] {
  return players.map((p, i) => (i === seat ? 'human' : E.isPersonType(p) ? 'remote' : p));
}

function localEnd(end: MatchEnd, players: PlayerType[]): MatchEnd {
  return { ...end, humanWon: end.winner >= 0 && players[end.winner] === 'human' };
}

/** Copy of a host-perspective state for the guest in `seat`. */
export function localizeBattleState(state: MatchState, seat: number): MatchState {
  const s = structuredClone(state);
  s.settings.players = localizePlayers(s.settings.players, seat);
  s.viewer = seat;
  s.selected = -1;
  if (s.ended) s.ended = localEnd(s.ended, s.settings.players);
  return s;
}

/**
 * Seat order of a battle with `shuffle` on: every seat is shuffled, the host's too (like the engine),
 * deterministically for the seed. Scenario rooms keep their seats (the map is built around them).
 * Returns `order` where match seat i is lobby seat order[i].
 */
export function shuffledSeatOrder(settings: MatchSettings, seed: number): number[] {
  const n = settings.players.length;
  const order = [...Array(n).keys()];
  if (!settings.shuffle || n < 2 || settings.puzzle) return order;
  const rng = new Rng((seed ^ 0x5bd1e995) >>> 0);
  return rng.shuffle(order);
}

export type ApplyOutcome =
  | { ok: true; fight?: FightEvent; union?: UnionEvent | null; power?: { cell: number; amount: number } }
  | { ok: false; reason: string };

/**
 * Apply an already resolved action (host shadow copy and guests). Validates it first: game actions
 * must come from the seat whose turn it is, attacks must be legal and their outcome possible, power
 * must fit exactly. `localSeat` >= 0 localises 'settings' / 'end' for that guest; -1 keeps the host view.
 */
export function applyBattleAction(state: MatchState, seat: number, a: BattleAction, localSeat = -1): ApplyOutcome {
  const bad = (reason: string): ApplyOutcome => ({ ok: false, reason });
  if (a.t === 'settings') {
    if (a.players.length !== state.settings.players.length) return bad('settings: wrong seat count');
    state.settings.players = localSeat >= 0 ? localizePlayers(a.players, localSeat) : [...a.players];
    return { ok: true };
  }
  if (a.t === 'end') {
    if (!state.ended) state.ended = localEnd(a.end, state.settings.players);
    return { ok: true };
  }
  if (state.ended) return bad('match ended');
  if (a.t === 'concede') return concedeSeat(state, seat) ? { ok: true } : bad('concede: seat not alive');
  if (seat !== state.current) return bad(`${a.t} by seat ${seat}, current is ${state.current}`);
  switch (a.t) {
    case 'attack': {
      const refusal = E.checkAttack(state, a.from, a.to);
      if (refusal) return bad(`illegal attack ${a.from}->${a.to}: ${refusal}`);
      const p = E.winChance(state.field.cells[a.from].power, state.field.cells[a.to].power);
      if ((a.win && p === 0) || (!a.win && p === 1)) return bad(`impossible outcome ${a.from}->${a.to}`);
      return { ok: true, fight: E.attack(state, a.from, a.to, { win: a.win }) as FightEvent };
    }
    case 'endAttack':
      if (state.phase !== 'attack') return bad('endAttack in power phase');
      return { ok: true, union: E.endAttack(state) };
    case 'power': {
      if (state.phase !== 'power') return bad('power in attack phase');
      const c = state.field.cells[a.cell];
      if (!c || c.owner !== seat) return bad(`power to foreign cell ${a.cell}`);
      if (Math.min(a.amount, state.powerLeft, c.maxPower - c.power) !== a.amount) return bad('power overflow');
      E.addPower(state, a.cell, a.amount);
      return { ok: true, power: { cell: a.cell, amount: a.amount } };
    }
    case 'endTurn':
      E.finishTurn(state);
      return { ok: true };
  }
}

/** Battle action of a fight event (for `BattleHost.publish`). */
export function actionOfFight(ev: FightEvent): BattleAction {
  return { t: 'attack', from: ev.from, to: ev.to, win: ev.win };
}
