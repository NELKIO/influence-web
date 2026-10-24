import { Rng, randomSeed } from './rng';
import { generateField } from './field';
import {
  DIFFICULTY,
  NEUTRAL,
  SIZES,
  type AttackRefusal,
  type Field,
  type FightEvent,
  type MatchEnd,
  type MatchSettings,
  type MatchState,
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
  if (s.shuffle && s.players.length > 2) {
    const rest = rng.shuffle(s.players.slice(1));
    s.players = [s.players[0], ...rest];
  }
  const field = opts.field
    ? structuredClone(opts.field)
    : generateField({ size: s.size, symmetry: s.symmetry, players: s.players.length }, rng);
  if (!opts.keepPlacement) placeStarts(field, s, rng);

  const n = s.players.length;
  const firstHuman = s.players.findIndex(isHumanType);
  const state: MatchState = {
    v: 1,
    settings: s,
    field,
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
  chosen.forEach((ci, slot) => {
    const c = field.cells[ci];
    c.owner = slot;
    c.power = n !== 2 ? 2 : s.size !== 'S' ? (slot === 0 ? 5 : 7) : slot === 0 ? 2 : 3;
  });
  if (s.crowded && !s.duelRules) {
    const order = rng.shuffle(field.cells.map((_, i) => i));
    order.forEach((ci, i) => {
      field.cells[ci].owner = i % n;
      field.cells[ci].power = 2;
    });
  }
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
  if (state.phase !== 'attack') return 'wrongPhase';
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
  if (union) explore(state);
  state.phase = 'power';
  state.selected = -1;
  state.powerLeft = incomeFor(state, state.current);
  return union;
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
  if (isHuman(state, next)) state.viewer = next;
  const cap = state.settings.spectate;
  if (cap && state.turn >= cap) state.ended = { winner: -1, humanWon: false, reason: 'cap', turn: state.turn };
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
    return { type: 'union', absorber: cur, absorbed: cand };
  }
  return null;
}

// ---------------------------------------------------------------- end of match

export function checkEnd(state: MatchState): void {
  if (state.ended) return;
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
  enough: boolean;
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
  // with other people still in the match a fair share is not enough: only the leader can claim the win
  const leader = leaderOf(state);
  const others = humansAlive(state).length > 1;
  return { percent, enough: percent >= 100 / alive.length && (!others || leader === state.current) };
}

/** The alive seat with the most cells (-1 on a tie for first place). */
function leaderOf(state: MatchState): number {
  let best = -1;
  let bestN = -1;
  let tie = false;
  for (const p of alivePlayers(state)) {
    const n = cellCount(state, p);
    if (n > bestN) {
      best = p;
      bestN = n;
      tie = false;
    } else if (n === bestN) tie = true;
  }
  return tie ? -1 : best;
}

export function finishEarly(state: MatchState, offer: StuckOffer): void {
  // alone against bots giving up early is a defeat; with other people the leader takes the match
  const winner = offer.enough ? state.current : humansAlive(state).length > 1 ? leaderOf(state) : -1;
  state.ended = {
    winner,
    humanWon: winner >= 0 && isHuman(state, winner),
    reason: 'early',
    turn: state.turn,
  };
}

/**
 * `loser` gives up. Against a single opponent the match ends at once with the board as it is. With
 * more seats alive the seat leaves: its cells turn neutral and the others play on until the usual end
 * rules apply (one seat left wins; no person left means the bots won).
 */
export function concede(state: MatchState, loser: number): void {
  if (state.ended || !isAlive(state, loser)) return;
  const others = alivePlayers(state).filter((p) => p !== loser);
  if (others.length <= 1) {
    const winner = others[0] ?? -1;
    state.ended = { winner, humanWon: winner >= 0 && isHuman(state, winner), reason: 'concede', turn: state.turn };
    return;
  }
  for (const c of state.field.cells) {
    if (c.owner === loser) {
      c.owner = NEUTRAL;
      c.power = 0;
    }
  }
  state.outAt[loser] = state.turn;
  checkEnd(state);
  const end = state.ended as MatchEnd | null;
  if (end) {
    state.ended = { ...end, reason: 'concede' };
    return;
  }
  if (state.viewer === loser) state.viewer = humansAlive(state)[0] ?? state.viewer;
  if (state.current === loser) finishTurn(state);
  else if (state.selected >= 0 && state.field.cells[state.selected].owner !== state.current) state.selected = -1;
}

// ---------------------------------------------------------------- darkness

/** Cells visible to `viewer` under darkness (all cells when darkness is off). */
export function visibleCells(state: MatchState, viewer = state.viewer): Uint8Array {
  const { cells, adj } = state.field;
  const vis = new Uint8Array(cells.length);
  // the fog lifts when the match is over: everyone sees how the map really looked
  if (!state.settings.darkness || viewer < 0 || state.ended || (humansAlive(state).length === 0 && state.settings.kind !== 'duelOnline')) {
    vis.fill(1);
    return vis;
  }
  cells.forEach((c, i) => {
    if (c.owner === viewer) {
      vis[i] = 1;
      for (const n of adj[i]) vis[n] = 1;
    }
  });
  return vis;
}

// ---------------------------------------------------------------- exploration fog

/** Under exploration fog: add what every person sees now to the cells they have already seen. */
export function explore(state: MatchState): void {
  const s = state.settings;
  if (!s.blind || !s.darkness) return;
  const { cells, adj } = state.field;
  const explored = (state.explored ??= []);
  s.players.forEach((p, seat) => {
    if (!isPersonType(p)) return;
    const row = (explored[seat] ?? '').padEnd(cells.length, '0').split('');
    let grew = !explored[seat];
    cells.forEach((c, i) => {
      if (c.owner !== seat) return;
      for (const j of [i, ...adj[i]])
        if (row[j] !== '1') {
          row[j] = '1';
          grew = true;
        }
    });
    if (grew) explored[seat] = row.join('');
  });
}

/**
 * Cells shown to `viewer` under exploration fog: everything they have seen (null: no fog, show the
 * whole map; also once the match is over or nobody is left to explore).
 */
export function exploredCells(state: MatchState, viewer = state.viewer): Uint8Array | null {
  const row = state.explored?.[viewer];
  if (!state.settings.blind || !state.settings.darkness || state.ended || !row || humansAlive(state).length === 0) return null;
  const out = new Uint8Array(state.field.cells.length);
  for (let i = 0; i < out.length; i++) out[i] = row.charCodeAt(i) === 49 ? 1 : 0;
  return out;
}
