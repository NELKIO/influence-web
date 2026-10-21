import { cellsOf, checkAttack, targetsFrom } from '../core/engine';
import { Rng } from '../core/rng';
import type { MatchState } from '../core/types';
import type { AttackMove } from './types';

/** Non-own neighbours of an own cell (neutral or enemy), in field order. */
export function enemiesOf(state: MatchState, cell: number): number[] {
  const { cells, adj } = state.field;
  const owner = cells[cell].owner;
  return adj[cell].filter((n) => cells[n].owner !== owner);
}

export function hasEnemies(state: MatchState, cell: number): boolean {
  const { cells, adj } = state.field;
  const owner = cells[cell].owner;
  return adj[cell].some((n) => cells[n].owner !== owner);
}

/** True when it is `slot`'s attack phase in a running match. */
export function isMyAttackPhase(state: MatchState): boolean {
  return !state.ended && state.phase === 'attack' && state.current >= 0;
}

/** Returns the move if the engine accepts it, null otherwise. */
export function legalOrNull(state: MatchState, from: number, to: number): AttackMove | null {
  return checkAttack(state, from, to) === null ? { from, to } : null;
}

/** Any legal attack for the current player (field order), or null. Last-resort fallback. */
export function firstLegalAttack(state: MatchState): AttackMove | null {
  for (const i of cellsOf(state, state.current)) {
    for (const t of targetsFrom(state, i)) if (checkAttack(state, i, t) === null) return { from: i, to: t };
  }
  return null;
}

/**
 * Power planning helper mirroring the original BasicPowerStrategy: +1 at a time,
 * never above a cell's capacity, never more than the points left.
 */
export class PowerPlan {
  readonly planned = new Map<number, number>();
  left: number;

  constructor(
    readonly state: MatchState,
    readonly slot: number = state.current,
    left: number = state.powerLeft,
  ) {
    this.left = Math.max(0, left);
  }

  newPower(cell: number): number {
    return this.state.field.cells[cell].power + (this.planned.get(cell) ?? 0);
  }

  room(cell: number): number {
    const c = this.state.field.cells[cell];
    if (c.owner !== this.slot) return 0;
    return c.maxPower - this.newPower(cell);
  }

  /** Add up to `k` points to `cell`; returns how many were added. */
  add(cell: number, k = 1): number {
    const n = Math.max(0, Math.min(k, this.left, this.room(cell)));
    if (n > 0) {
      this.planned.set(cell, (this.planned.get(cell) ?? 0) + n);
      this.left -= n;
    }
    return n;
  }

  /** Round-robin +1 over the given cells until power runs out or nothing fits. */
  roundRobin(cells: number[]): void {
    while (this.left > 0) {
      let any = false;
      for (const c of cells) {
        if (this.left <= 0) break;
        if (this.add(c)) any = true;
      }
      if (!any) break;
    }
  }

  result(): Map<number, number> {
    const out = new Map<number, number>();
    for (const [k, v] of this.planned) if (v > 0) out.set(k, v);
    return out;
  }
}

/** Dummy power: round-robin over all own cells in field order (also the human "auto" power). */
export function dummyPower(state: MatchState, plan = new PowerPlan(state)): Map<number, number> {
  plan.roundRobin(cellsOf(state, plan.slot));
  return plan.result();
}

/**
 * SmartyPower (Hunter): +1 per pass to every border cell (own cell with a non-own neighbour)
 * while border room remains, then leftovers round-robin over all own cells.
 */
export function smartyPower(state: MatchState, plan = new PowerPlan(state)): Map<number, number> {
  const own = cellsOf(state, plan.slot);
  const border = own.filter((c) => hasEnemies(state, c));
  plan.roundRobin(border);
  plan.roundRobin(own);
  return plan.result();
}

/** Uniform random own cell with room, +1 at a time (Freak). */
export function randomPower(state: MatchState, rng: Rng, plan = new PowerPlan(state)): Map<number, number> {
  const own = cellsOf(state, plan.slot);
  while (plan.left > 0) {
    const open = own.filter((c) => plan.room(c) > 0);
    if (!open.length) break;
    // drawing among all own cells and rejecting full ones is the same as drawing among open ones
    let guard = 0;
    while (plan.left > 0 && guard++ < 64) {
      const c = open[rng.int(open.length)];
      if (!plan.add(c)) break;
    }
  }
  return plan.result();
}

export function botSeed(seed?: number): number {
  if (seed !== undefined) return seed >>> 0;
  return (Math.random() * 4294967296) >>> 0;
}
