import { Rng, randomSeed } from './rng';
import { generateField, WIDE_ROTATIONAL_DAILY_FROM } from './field';
import { splitTerritories } from './splitTerritories';
import { chooseFrontierPoints, frontierConfig, frontierGenerated, interruptObjectiveHold, objectiveHandoff, objectiveHolders } from './objectives';
import {
  DIFFICULTY,
  NEUTRAL,
  SIZES,
  type AttackRefusal,
  type ConcedeChoice,
  type Field,
  type FightEvent,
  type MatchEnd,
  type MatchSettings,
  type MatchState,
  type OrderComp,
  type UnionEvent,
} from './types';

// ---------------------------------------------------------------- creation

export interface CreateOptions {
  seed?: number;
  /** use this field (topology + caps) instead of generating one */
  field?: Field;
  /** keep owners/powers of the given field as-is */
  keepPlacement?: boolean;
}

export function createMatch(settings: MatchSettings, opts: CreateOptions = {}): MatchState {
  const seed = opts.seed ?? randomSeed();
  const rng = new Rng(seed);
  const s: MatchSettings = { ...settings, players: [...settings.players] };
  if (s.duelRules) s.unions = false;
  // shuffle: every seat, the person's too (moving first is an advantage; who gets it is left to chance)
  if (s.shuffle && s.players.length >= 2) s.players = rng.shuffle(s.players);
  const comp = resolveOrderComp(s);
  if (comp) s.orderComp = comp;
  else if (s.orderComp !== 'off') delete s.orderComp;
  const field = opts.field
    ? structuredClone(opts.field)
    : generateField({
      size: s.size, symmetry: s.symmetry, players: s.players.length,
      // published maps of the day stay as they were
      legacy: s.kind === 'daily' && !!s.dailyId && s.dailyId < WIDE_ROTATIONAL_DAILY_FROM,
    }, rng);
  const objectives = !opts.keepPlacement ? placeStarts(field, s, rng) : undefined;

  const n = s.players.length;
  const firstHuman = s.players.findIndex(isHumanType);
  const state: MatchState = {
    v: 1,
    settings: s,
    field,
    ...(objectives ? { objectives } : {}),
    seed,
    rng: rng.state(),
    turn: 0,
    current: 0,
    phase: 'attack',
    powerLeft: 0,
    luck: [0, 0, 0],
    lastStuck: 0,
    viewer: firstHuman,
    selected: -1,
    chronicle: { damage: 0, damageTaken: 0, conquered: 0, lost: 0, attacks: 0, attacksWon: 0 },
    outAt: new Array(n).fill(-1),
    ended: null,
    startedAt: Date.now(),
  };
  explore(state);
  return state;
}

/**
 * New dice for a match about to be played again (restart, another attempt at the map of the day):
 * the map, the placement and the seed it was built from stay, only the fights are rolled anew.
 */
export function withFreshDice(state: MatchState, seed = randomSeed()): MatchState {
  state.rng = new Rng(seed).state();
  state.luck = [0, 0, 0];
  return state;
}

function placeStarts(field: Field, s: MatchSettings, rng: Rng) {
  for (const c of field.cells) {
    c.owner = NEUTRAL;
    c.power = 0;
  }
  const n = s.players.length;
  const P = field.starts;
  let chosen: number[];
  if (n === 2) chosen = rng.bool() ? [P[0], P[1]] : [P[2], P[3]];
  else if (n === 3) chosen = [...(rng.bool() ? [P[0], P[1]] : [P[2], P[3]]), P[4]];
  else if (n === 4) chosen = [P[0], P[1], P[2], P[3]];
  else if (n === 5) {
    // six-ray maps leave one ray free (chosen at random); other maps have exactly five starts
    if (P.length >= 6) {
      const free = rng.int(6);
      chosen = P.slice(0, 6).filter((_, i) => i !== free);
    } else chosen = P.slice(0, 5);
  } else chosen = P.slice(0, 6);
  rng.shuffle(chosen);
  const comp = s.orderComp && s.orderComp !== 'off' ? s.orderComp : null;
  chosen.forEach((ci, slot) => {
    const c = field.cells[ci];
    c.owner = slot;
    c.power = n !== 2 ? 2 : s.size !== 'S' ? (slot === 0 ? 5 : 7) : slot === 0 ? 2 : 3;
    const p = comp?.power?.[slot];
    if (p !== undefined) c.power = Math.max(1, Math.min(c.maxPower, p));
  });
  if (comp && !(s.crowded && !s.duelRules)) applyStartComp(field, chosen, comp);
  // (a scenario places its own: its starts are kept)
  const objectives = frontierGenerated(s) && !s.puzzle
    ? chooseFrontierPoints(field, frontierConfig(s).pointCount) : undefined;
  if (s.crowded && !s.duelRules) {
    const order = rng.shuffle(field.cells.map((_, i) => i));
    let dealt = 0;
    order.forEach((ci) => {
      if (objectives?.includes(ci)) {
        // a garrison stronger than any dealt cell: points are won after reinforcing, not grabbed in the first round
        field.cells[ci].power = CROWDED_POINT_GARRISON;
        return;
      }
      field.cells[ci].owner = dealt++ % n;
      field.cells[ci].power = 2;
    });
  }
  return objectives;
}

/** Power of a neutral control point on a crowded map (dealt cells have 2). */
const CROWDED_POINT_GARRISON = 3;

/**
 * Turn-order compensation (measured with scripts/seat-bias.ts): who moves first in a round has an
 * edge, so a later seat gets extra power with its first reinforcement, after its first attacks. Seat k
 * (k seats moved before it) gets k points per start cell, scaled down with more than four seats so that
 * the last one never gets more than 3 per start cell (ordinary battles have one start cell, the night
 * drop's squads three): 0 1 2 | 0 1 2 3 | 0 1 2 2 3 | 0 1 1 2 2 3, and in the night drop
 * 0 3 6 | 0 3 6 9 | 0 2 5 7 9 | 0 2 4 5 7 9.
 */
export function seatBonus(seat: number, seats: number, startCells = 1): number {
  if (seats < 3) return 0;
  return Math.round(seat * startCells * Math.min(1, 3 / (seats - 1)));
}

/** The default compensation of an ordinary battle (none for two seats: they start with 5 and 7). */
export function defaultOrderComp(seats: number, startCells = 1): OrderComp | null {
  if (seats < 3) return null;
  return { bonus: Array.from({ length: seats }, (_, k) => seatBonus(k, seats, startCells)) };
}

/**
 * The turn-order compensation a match is played with: the one given in the settings, else the default
 * of an ordinary battle (scenarios have their own seats: only the night drop sets one, see
 * scenarios.ts), or null.
 */
export function resolveOrderComp(s: MatchSettings): OrderComp | null {
  if (s.orderComp === 'off') return null;
  if (s.orderComp) return s.orderComp;
  if (s.puzzle) return null;
  return defaultOrderComp(s.players.length);
}

/** Extra start cells and grey guards of the order compensation (`starts` = start cell per seat). */
function applyStartComp(field: Field, starts: number[], comp: OrderComp) {
  const { cells, adj } = field;
  starts.forEach((start, slot) => {
    const extra = comp.extra?.[slot] ?? 0;
    for (let k = 0; k < extra; k++) {
      // the nearest free cell (breadth first from the start, field order within a ring)
      const seen = new Set([start]);
      let ring = [start];
      let pick = -1;
      while (ring.length && pick < 0) {
        const next: number[] = [];
        for (const v of ring)
          for (const u of adj[v])
            if (!seen.has(u)) {
              seen.add(u);
              next.push(u);
            }
        next.sort((a, b) => a - b);
        pick = next.find((u) => cells[u].owner === NEUTRAL && cells[u].power === 0 && adj[u].some((w) => cells[w].owner === slot)) ?? -1;
        ring = next;
      }
      if (pick < 0) break;
      cells[pick].owner = slot;
      cells[pick].power = Math.max(1, Math.min(cells[pick].maxPower, comp.extraPower ?? 1));
    }
  });
  starts.forEach((start, slot) => {
    const g = comp.grey?.[slot] ?? 0;
    if (g <= 0) return;
    for (const u of adj[start]) if (cells[u].owner === NEUTRAL) cells[u].power = Math.max(cells[u].power, Math.min(cells[u].maxPower, g));
  });
}

/** Whether the current seat sits out its attack phase (order compensation: the first movers in round 0). */
export function attackBlocked(state: MatchState): boolean {
  const c = state.settings.orderComp;
  return !!c && c !== 'off' && !!c.skip && state.turn === 0 && state.current < c.skip;
}

/** The seats in the order they move in a round (always 0..n-1 unless the order compensation changes it). */
export function roundOrder(s: MatchSettings, round: number): number[] {
  const n = s.players.length;
  const base = Array.from({ length: n }, (_, i) => i);
  const o = s.orderComp && s.orderComp !== 'off' ? s.orderComp.order : undefined;
  if (o === 'rotate') return base.map((i) => (i + round) % n);
  if (o === 'snake') return round % 2 ? base.reverse() : base;
  return base;
}

// ---------------------------------------------------------------- queries

export const isHumanType = (t: string) => t === 'human';
/** A seat played by a person on any device (this one, a duel opponent or a battle-room guest). */
export const isPersonType = (t: string) => t === 'human' || t === 'remote' || t === 'online';

export function isHuman(state: MatchState, slot: number): boolean {
  return isHumanType(state.settings.players[slot]);
}

export function cellsOf(state: MatchState, slot: number): number[] {
  const out: number[] = [];
  state.field.cells.forEach((c, i) => c.owner === slot && out.push(i));
  return out;
}

export function scoreOf(state: MatchState, slot: number): number {
  let s = 0;
  for (const c of state.field.cells) if (c.owner === slot) s += c.power;
  return s;
}

export function cellCount(state: MatchState, slot: number): number {
  let n = 0;
  for (const c of state.field.cells) if (c.owner === slot) n++;
  return n;
}

export function isAlive(state: MatchState, slot: number): boolean {
  return state.field.cells.some((c) => c.owner === slot);
}

export function alivePlayers(state: MatchState): number[] {
  const alive = new Set<number>();
  for (const c of state.field.cells) if (c.owner >= 0) alive.add(c.owner);
  return [...alive].sort((a, b) => a - b);
}

export function humansAlive(state: MatchState): number[] {
  return alivePlayers(state).filter((p) => isHuman(state, p));
}

/** The next alive person at this device after `seat` in seat order (wrapping round), or -1. */
export function nextHumanAfter(state: MatchState, seat: number): number {
  const n = state.settings.players.length;
  for (let k = 1; k <= n; k++) {
    const p = (seat + k + n) % n;
    if (isHuman(state, p) && isAlive(state, p)) return p;
  }
  return -1;
}

export function freeCapacity(state: MatchState, slot: number): number {
  let cap = 0;
  for (const c of state.field.cells) if (c.owner === slot) cap += c.maxPower - c.power;
  return cap;
}

/** Connected groups of a player's cells, biggest first (stable by discovery). */
export function groupsOf(state: MatchState, slot: number): number[][] {
  const { cells, adj } = state.field;
  const seen = new Uint8Array(cells.length);
  const groups: number[][] = [];
  cells.forEach((c, i) => {
    if (c.owner !== slot || seen[i]) return;
    const g: number[] = [];
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const v = stack.pop()!;
      g.push(v);
      for (const u of adj[v]) {
        if (!seen[u] && cells[u].owner === slot) {
          seen[u] = 1;
          stack.push(u);
        }
      }
    }
    groups.push(g);
  });
  return groups.sort((a, b) => b.length - a.length);
}

/** Cells that bring power under duel rules (the biggest group); all own cells otherwise. */
export function incomeCells(state: MatchState, slot: number): Set<number> {
  if (!state.settings.duelRules) return new Set(cellsOf(state, slot));
  const g = groupsOf(state, slot);
  return new Set(g[0] ?? []);
}

export function incomeFor(state: MatchState, slot: number): number {
  const base = state.settings.duelRules ? (groupsOf(state, slot)[0]?.length ?? 0) : cellCount(state, slot);
  return Math.min(base, freeCapacity(state, slot));
}

export function winChance(a: number, d: number): number {
  if (a <= 1) return 0;
  if (d === 0) return 1;
  const delta = a - d;
  if (delta <= -2) return 0;
  if (delta === -1) return 0.25;
  if (delta === 0) return 0.5;
  if (delta === 1) return 0.75;
  return 1;
}

export function hasNeutralNeighbour(state: MatchState, cell: number): boolean {
  return state.field.adj[cell].some((n) => state.field.cells[n].owner === NEUTRAL);
}

export function canAttackFrom(state: MatchState, cell: number): boolean {
  const c = state.field.cells[cell];
  if (c.power < 2 || c.owner < 0) return false;
  if (c.owner === state.current && attackBlocked(state)) return false;
  return state.field.adj[cell].some((n) => state.field.cells[n].owner !== c.owner);
}

/** Legal targets for an attack from `cell` (respects the duel greys-first rule). */
export function targetsFrom(state: MatchState, cell: number): number[] {
  if (!canAttackFrom(state, cell)) return [];
  const c = state.field.cells[cell];
  const greysFirst = state.settings.duelRules && hasNeutralNeighbour(state, cell);
  return state.field.adj[cell].filter((n) => {
    const t = state.field.cells[n];
    if (t.owner === c.owner) return false;
    if (greysFirst && t.owner !== NEUTRAL) return false;
    return true;
  });
}

export function anyAttackLeft(state: MatchState, slot = state.current): boolean {
  return cellsOf(state, slot).some((i) => targetsFrom(state, i).length > 0);
}

export function checkAttack(state: MatchState, from: number, to: number): AttackRefusal | null {
  if (state.ended) return 'ended';
  if (state.phase !== 'attack' || attackBlocked(state)) return 'wrongPhase';
  const { cells, adj } = state.field;
  const a = cells[from];
  const d = cells[to];
  if (!a || !d || a.owner !== state.current) return 'notOwn';
  if (!adj[from].includes(to)) return 'notAdjacent';
  if (d.owner === a.owner) return 'ownTarget';
  if (a.power < 2) return 'weak';
  if (state.settings.duelRules && d.owner !== NEUTRAL && hasNeutralNeighbour(state, from)) return 'greysFirst';
  return null;
}

// ---------------------------------------------------------------- actions

/**
 * Resolve an attack. When `forced` is given (online duel replay) the outcome is taken from it
 * instead of being rolled.
 */
export function attack(state: MatchState, from: number, to: number, forced?: { win: boolean }): FightEvent | AttackRefusal {
  const refusal = checkAttack(state, from, to);
  if (refusal) return refusal;
  const { cells } = state.field;
  const A = cells[from];
  const D = cells[to];
  const a = A.power;
  const d = D.power;
  const p = winChance(a, d);
  const rng = new Rng(state.rng);
  let win: boolean;
  if (forced) {
    win = forced.win;
  } else {
    win = rng.float() < p;
    const bucket = Math.round(p * 100);
    if (bucket === 25 || bucket === 50 || bucket === 75) {
      const k = bucket === 25 ? 0 : bucket === 50 ? 1 : 2;
      const limit = bucket === 25 ? 3 : 2;
      const humanAttacker = isPersonType(state.settings.players[A.owner]);
      if (win !== humanAttacker) state.luck[k]++;
      else state.luck[k] = 0;
      if ((state.luck[k] === limit && rng.bool()) || state.luck[k] > limit) {
        state.luck[k] = 0;
        win = humanAttacker;
      }
    }
  }
  state.rng = rng.state();

  let atkAfter = 1;
  let defAfter = d === 0 ? a - 1 : Math.abs(a - d);
  if (defAfter <= 0) defAfter = 1;
  if (win && defAfter > D.maxPower) {
    atkAfter += defAfter - D.maxPower;
    defAfter = D.maxPower;
    if (d > 0) atkAfter -= 1;
  } else if (!win && defAfter > D.maxPower) {
    defAfter = D.maxPower;
  }
  const defOwnerBefore = D.owner;
  A.power = atkAfter;
  D.power = defAfter;
  if (win) D.owner = A.owner;

  // chronicle (single human perspective)
  const humans = state.settings.players.filter(isHumanType).length;
  if (humans === 1) {
    const ch = state.chronicle;
    if (isHuman(state, A.owner)) {
      ch.attacks++;
      if (win) {
        ch.attacksWon++;
        ch.conquered++;
      }
      if (defOwnerBefore !== NEUTRAL) ch.damage += a;
    } else if (defOwnerBefore >= 0 && isHuman(state, defOwnerBefore)) {
      ch.damageTaken += a;
      if (win) ch.lost++;
    }
  }

  let eliminated: number | null = null;
  if (win && defOwnerBefore >= 0 && !isAlive(state, defOwnerBefore)) {
    eliminated = defOwnerBefore;
    state.outAt[defOwnerBefore] = state.turn;
    clearSignalFire(state, defOwnerBefore);
  }
  state.selected = win ? to : from;
  if (win) explore(state);
  const ev: FightEvent = {
    type: 'fight',
    player: A.owner,
    from,
    to,
    atkBefore: a,
    defBefore: d,
    atkAfter,
    defAfter,
    defOwnerBefore,
    chance: p,
    win,
    eliminated,
  };
  checkEnd(state);
  return ev;
}

/** Apply an already resolved fight (online replay). */
export function applyFight(state: MatchState, ev: FightEvent): FightEvent | AttackRefusal {
  return attack(state, ev.from, ev.to, { win: ev.win });
}

/** End the attack phase: unions check, then compute income. */
export function endAttack(state: MatchState): UnionEvent | null {
  if (state.ended || state.phase !== 'attack') return null;
  const union = state.settings.unions ? maybeUnite(state) : null;
  if (union) {
    interruptObjectiveHold(state);
    explore(state);
  }
  state.phase = 'power';
  state.selected = -1;
  state.powerLeft = incomeFor(state, state.current);
  const comp = state.settings.orderComp;
  const bonus = state.turn === 0 && comp && comp !== 'off' ? (comp.bonus?.[state.current] ?? 0) : 0;
  if (bonus) state.powerLeft = Math.max(0, Math.min(state.powerLeft + bonus, freeCapacity(state, state.current)));
  return union;
}

/**
 * The turn-order bonus a seat would get if it reinforced now: its first-round bonus, as far as its
 * cells have room for it beyond the income (the rest is lost, as `endAttack` does). 0 after round 0.
 */
export function orderBonusNow(state: MatchState, slot: number): number {
  const comp = state.settings.orderComp;
  const bonus = state.turn === 0 && comp && comp !== 'off' ? (comp.bonus?.[slot] ?? 0) : 0;
  if (!bonus) return 0;
  return Math.max(0, Math.min(bonus, freeCapacity(state, slot) - incomeFor(state, slot)));
}

/** Add up to `amount` power to an own cell, capped by capacity and points left. Returns points added. */
export function addPower(state: MatchState, cell: number, amount = 1): number {
  if (state.ended || state.phase !== 'power') return 0;
  const c = state.field.cells[cell];
  if (!c || c.owner !== state.current) return 0;
  const add = Math.max(0, Math.min(amount, state.powerLeft, c.maxPower - c.power));
  c.power += add;
  state.powerLeft -= add;
  return add;
}

/** Round-robin +1 over own cells in field order until no points remain. Returns per-cell additions. */
export function autoPower(state: MatchState): Map<number, number> {
  const added = new Map<number, number>();
  const own = cellsOf(state, state.current);
  let guard = 0;
  while (state.powerLeft > 0 && guard++ < 1000) {
    let any = false;
    for (const i of own) {
      if (state.powerLeft <= 0) break;
      if (addPower(state, i, 1)) {
        added.set(i, (added.get(i) ?? 0) + 1);
        any = true;
      }
    }
    if (!any) {
      state.powerLeft = 0;
      break;
    }
  }
  return added;
}

/** Finish the power phase and pass the turn to the next alive player. */
export function finishTurn(state: MatchState): void {
  if (state.ended) return;
  state.powerLeft = 0;
  state.phase = 'attack';
  state.selected = -1;
  const n = state.settings.players.length;
  const previous = state.current;
  const comp = state.settings.orderComp;
  if (comp && comp !== 'off' && comp.order) {
    // a changed order within the round: the next seat alive in this round's order, else the first of the next round's
    const ord = roundOrder(state.settings, state.turn);
    const after = ord.slice(ord.indexOf(state.current) + 1).find((p) => isAlive(state, p));
    if (after === undefined) {
      state.turn++;
      state.current = roundOrder(state.settings, state.turn).find((p) => isAlive(state, p)) ?? state.current;
    } else state.current = after;
  } else {
    let next = state.current;
    for (let k = 1; k <= n; k++) {
      const cand = (state.current + k) % n;
      if (isAlive(state, cand)) {
        next = cand;
        break;
      }
    }
    if (next <= state.current) state.turn++;
    state.current = next;
  }
  const next = state.current;
  clearSignalFire(state, next);
  if (isHuman(state, next)) state.viewer = next;
  const cap = state.settings.spectate;
  if (cap && state.turn >= cap) state.ended = { winner: -1, humanWon: false, reason: 'cap', turn: state.turn };
  else objectiveHandoff(state, previous);
}

/** Whether the bots left on the board can fight on without people (at least two, no person). */
export function canSpectate(state: MatchState): boolean {
  const alive = alivePlayers(state);
  return alive.length >= 2 && !alive.some((p) => isPersonType(state.settings.players[p]));
}

/**
 * A copy of a match the people have lost, in which the remaining bots fight on (see
 * MatchSettings.spectate). Null if fewer than two bots are left or a person is still on the board.
 */
export function spectateCopy(state: MatchState, rounds = 80): MatchState | null {
  if (!canSpectate(state)) return null;
  const s = structuredClone(state);
  s.ended = null;
  s.selected = -1;
  s.settings = { ...s.settings, spectate: s.turn + rounds };
  if (!isAlive(s, s.current)) finishTurn(s);
  return s;
}

// ---------------------------------------------------------------- unions

function maybeUnite(state: MatchState): UnionEvent | null {
  const s = state.settings;
  const humans = s.players.filter(isPersonType).length;
  if (s.duelRules || humans !== 1 || state.turn < 3) return null;
  const cur = state.current;
  const alive = alivePlayers(state);
  const raw = new Map<number, number>();
  for (const p of alive) raw.set(p, p < cur ? scoreOf(state, p) : scoreOf(state, p) + cellCount(state, p));
  const total = [...raw.values()].reduce((a, b) => a + b, 0);
  if (!total) return null;
  const share = (p: number) => (raw.get(p) ?? 0) / total;
  let leader = alive[0];
  for (const p of alive) if (share(p) > share(leader)) leader = p;
  const candidates = [...alive].sort((a, b) => DIFFICULTY[s.players[a]] - DIFFICULTY[s.players[b]]);
  for (const cand of candidates) {
    if (cand === cur || isPersonType(s.players[cand])) continue;
    if (leader === cur || leader === cand) continue;
    if (share(leader) < 0.25) continue;
    if (!(share(cand) < share(leader))) continue;
    if (!(share(cur) >= share(cand) || DIFFICULTY[s.players[cur]] <= DIFFICULTY[s.players[cand]])) continue;
    if (share(cur) + share(cand) > 1.3 * share(leader)) continue;
    for (const c of state.field.cells) if (c.owner === cand) c.owner = cur;
    state.outAt[cand] = state.turn;
    clearSignalFire(state, cand);
    return { type: 'union', absorber: cur, absorbed: cand };
  }
  return null;
}

// ---------------------------------------------------------------- end of match

export function checkEnd(state: MatchState): void {
  if (state.ended) return;
  // Fights and both local/online concession paths call this after changing owners.
  interruptObjectiveHold(state);
  const alive = alivePlayers(state);
  const humans = alive.filter((p) => isPersonType(state.settings.players[p]));
  if (alive.length <= 1) {
    const w = alive[0] ?? -1;
    state.ended = { winner: w, humanWon: w >= 0 && isHuman(state, w), reason: 'elimination', turn: state.turn };
  } else if (humans.length === 0 && !state.settings.spectate) {
    state.ended = { winner: -1, humanWon: false, reason: 'elimination', turn: state.turn };
  }
}

export interface StuckOffer {
  percent: number;
  /** finishing now wins the match for the current seat */
  enough: boolean;
  /** with other people in the match the first place is shared by a person: finishing now is a draw */
  draw?: boolean;
}

/** Called at the start of a human's turn. Returns an early-finish offer when the board is saturated. */
export function checkStuck(state: MatchState): StuckOffer | null {
  const s = state.settings;
  if (state.ended || s.kind === 'duelOnline' || s.kind === 'battleOnline') return null;
  if (state.turn <= SIZES[s.size].stuckAfter || state.turn - state.lastStuck < 5) return null;
  state.lastStuck = state.turn;
  const alive = alivePlayers(state);
  if (!isHuman(state, state.current) || alive.length <= 1) return null;
  let total = 0;
  let max = 0;
  for (const c of state.field.cells) {
    max += c.maxPower;
    if (c.owner >= 0) total += c.power;
  }
  if (total <= 0.8 * max) return null;
  const mine = cellCount(state, state.current);
  const percent = (mine / state.field.cells.length) * 100;
  if (state.objectives) return objectiveHolders(state).length === 0 ? { percent, enough: false, draw: true } : null;
  // alone against bots (the original rule): a fair share of the field wins, less loses
  if (humansAlive(state).length <= 1) return { percent, enough: percent >= 100 / alive.length };
  // with other people still in the match the leader takes it; a first place shared by a person is a draw
  const top = leadersOf(state);
  if (top.length === 1) return { percent, enough: top[0] === state.current };
  return { percent, enough: false, draw: top.some((p) => isPersonType(s.players[p])) };
}

/** The alive seats with the most cells (several on a tie for first place). */
function leadersOf(state: MatchState): number[] {
  let best: number[] = [];
  let bestN = -1;
  for (const p of alivePlayers(state)) {
    const n = cellCount(state, p);
    if (n > bestN) {
      best = [p];
      bestN = n;
    } else if (n === bestN) best.push(p);
  }
  return best;
}

export function finishEarly(state: MatchState, offer: StuckOffer): void {
  if (state.ended) return;
  const end = { reason: 'early' as const, turn: state.turn };
  if (state.objectives) {
    if (objectiveHolders(state).length === 0) state.ended = { ...end, winner: -1, humanWon: false, draw: true };
    return;
  }
  if (offer.enough) {
    state.ended = { ...end, winner: state.current, humanWon: true };
  } else if (offer.draw) {
    // the people at the top are level: nobody won, nobody lost
    state.ended = { ...end, winner: -1, humanWon: false, draw: true };
  } else {
    // alone against bots giving up early is a defeat; with other people the single leader takes the match
    const top = humansAlive(state).length > 1 ? leadersOf(state) : [];
    const winner = top.length === 1 ? top[0] : -1;
    state.ended = { ...end, winner, humanWon: winner >= 0 && isHuman(state, winner) };
  }
}

/**
 * Leave the match: give away cells at full strength, hand the seat to a GOD, or concede as before.
 * The split is a shuffled deal like crowded starts; peers replay it without using their battle dice.
 */
export function concede(state: MatchState, loser: number, recipient?: ConcedeChoice): boolean {
  const alive = alivePlayers(state);
  if (state.ended || !alive.includes(loser)) return false;
  const others = alive.filter((p) => p !== loser);
  if (recipient === 'god') {
    const { settings } = state;
    if (settings.kind === 'duelOnline' || !isPersonType(settings.players[loser]) || !others.length) return false;
    state.settings = { ...settings, players: settings.players.map((p, i) => i === loser ? 'god' : p) };
    clearSignalFire(state, loser);
    state.godTakeovers = [...(state.godTakeovers ?? []), loser];
    if (canSpectate(state)) state.settings.spectate = state.turn + 80;
    if (state.viewer === loser) state.viewer = nextHumanAfter(state, loser);
    if (state.current === loser) state.selected = -1;
    return true;
  }
  if (recipient === 'split' ? !others.length : recipient !== undefined && !others.includes(recipient)) return false;
  if (recipient === undefined && others.length <= 1) {
    clearSignalFire(state, loser);
    const winner = others[0] ?? -1;
    state.ended = { winner, humanWon: winner >= 0 && isHuman(state, winner), reason: 'concede', turn: state.turn };
    return true;
  }
  if (recipient === 'split') {
    const rng = new Rng((state.seed ^ Math.imul(state.turn + 1, 0x9e3779b9) ^ Math.imul(loser + 1, 0x85ebca6b)) >>> 0);
    const order = roundOrder(state.settings, state.turn);
    const upcoming = order.slice(order.indexOf(state.current)).concat(roundOrder(state.settings, state.turn + 1));
    const seats = [...new Set(upcoming.filter(p => others.includes(p)))];
    splitTerritories(state.field.cells, cellsOf(state, loser), seats, rng);
  } else {
    for (const c of state.field.cells) {
      if (c.owner !== loser) continue;
      c.owner = recipient ?? NEUTRAL;
      if (recipient === undefined) c.power = 0;
    }
  }
  state.outAt[loser] = state.turn;
  clearSignalFire(state, loser);
  if (recipient !== undefined) {
    explore(state);
    // Online spectators stay in the same room; the host runs the remaining bots.
    if (state.settings.kind === 'battleOnline' && canSpectate(state)) state.settings.spectate = state.turn + 80;
  }
  checkEnd(state);
  const end = state.ended as MatchEnd | null;
  if (end) {
    state.ended = { ...end, reason: 'concede' };
    state.selected = -1;
    return true;
  }
  if (state.viewer === loser) {
    const next = nextHumanAfter(state, loser);
    if (next >= 0) state.viewer = next;
  }
  if (state.current === loser) finishTurn(state);
  else if (state.selected >= 0 && state.field.cells[state.selected].owner !== state.current) state.selected = -1;
  return true;
}

// ---------------------------------------------------------------- darkness

/** Fire range follows enabled passages, not hex distance through walls. */
export function canLightSignalFire(state: MatchState, cell?: number): boolean {
  return !!(state.settings.darkness && state.settings.signalFires && !state.ended &&
    (state.signalFireCells?.[state.current] ?? -1) < 0 &&
    (cell === undefined || (Number.isInteger(cell) && state.field.cells[cell]?.owner === state.current)));
}

export function lightSignalFire(state: MatchState, cell: number): boolean {
  if (!Number.isInteger(cell) || !canLightSignalFire(state, cell)) return false;
  const sources = state.signalFireCells ??= new Array<number>(state.settings.players.length).fill(-1);
  sources[state.current] = cell;
  explore(state);
  return true;
}

export function clearSignalFire(state: MatchState, seat: number): void {
  if (state.signalFireCells) state.signalFireCells[seat] = -1;
}

/** Actual live sight shared by both the renderer and exploration memory (no spectator overrides). */
function seatSight(state: MatchState, viewer: number): Uint8Array {
  const { cells, adj } = state.field;
  const vis = new Uint8Array(cells.length);
  cells.forEach((c, i) => {
    if (c.owner === viewer) {
      vis[i] = 1;
      for (const n of adj[i]) vis[n] = 1;
    }
  });
  if (state.settings.signalFires) state.signalFireCells?.forEach((source, seat) => {
    if (source < 0) return;
    vis[source] = 1;
    if (seat !== viewer) return;
    for (const near of adj[source]) {
      vis[near] = 1;
      for (const far of adj[near]) vis[far] = 1;
    }
  });
  return vis;
}

/** Cells visible to `viewer` under darkness (all cells when darkness is off). */
export function visibleCells(state: MatchState, viewer = state.viewer): Uint8Array {
  // the fog lifts when the match is over: everyone sees how the map really looked
  if (!state.settings.darkness || viewer < 0 || state.ended || (humansAlive(state).length === 0 && state.settings.kind !== 'duelOnline')) {
    return new Uint8Array(state.field.cells.length).fill(1);
  }
  return seatSight(state, viewer);
}

// ---------------------------------------------------------------- exploration fog

/** Under exploration fog: add what every person sees now to the cells they have already seen. */
export function explore(state: MatchState): void {
  const s = state.settings;
  if (!s.blind || !s.darkness) return;
  const { cells } = state.field;
  const explored = (state.explored ??= []);
  s.players.forEach((p, seat) => {
    if (!isPersonType(p)) return;
    const row = (explored[seat] ?? '').padEnd(cells.length, '0').split('');
    let grew = !explored[seat];
    seatSight(state, seat).forEach((visible, i) => {
      if (visible && row[i] !== '1') {
        row[i] = '1';
        grew = true;
      }
    });
    if (grew) explored[seat] = row.join('');
  });
}

/**
 * Cells shown to `viewer` under exploration fog: everything they have seen, and the control points,
 * whose places everyone knows from the start (the bots know them too) while who holds them stays in
 * the dark (null: no fog, show the whole map; also once the match is over or nobody is left to explore).
 */
export function exploredCells(state: MatchState, viewer = state.viewer): Uint8Array | null {
  const row = state.explored?.[viewer];
  if (!state.settings.blind || !state.settings.darkness || state.ended || !row || humansAlive(state).length === 0) return null;
  const out = new Uint8Array(state.field.cells.length);
  for (let i = 0; i < out.length; i++) out[i] = row.charCodeAt(i) === 49 ? 1 : 0;
  for (const i of state.objectives ?? []) out[i] = 1;
  return out;
}
