/**
 * Master ("Мастер"): Monte-Carlo tree search (UCT) against a merged opponent.
 *
 * Model (see docs/re/02-bots.md §7):
 *  - Master keeps its id (0), every other alive player is merged into one opponent id (1) that plays
 *    one turn per opponent slot, in seat order.
 *  - No "pass" in the attack phase; forced continuation from a freshly captured cell.
 *  - Power: threat-based minimum placements first, then canonical priority-ordered placements on
 *    border cells (fill, or +min(3, spare) on threatened cells), capped in dead ends.
 *  - Evaluation clamp((myScore / oppUnits - 0.3) / 2.7, 0, 1), myScore = reinforcement + #cells at
 *    the start of Master's own power phase.
 *  - Horizon: attack decisions look to the end of Master's attack phase, power decisions to the start
 *    of Master's next power phase. Expert rollouts, UCB (+C) in search, LCB (-C) for the final choice.
 *
 * Everything here is pure computation over its own typed-array board; the real MatchState is never
 * mutated. The same MasterBrain runs inside the Web Worker or synchronously (tests / no Worker).
 */
import { alivePlayers, checkAttack } from '../core/engine';
import { NEUTRAL, type MatchState } from '../core/types';
import type { AttackMove, BotContext } from './types';
import { PowerPlan, botSeed, firstLegalAttack, smartyPower } from './common';

// ------------------------------------------------------------------ constants

const ME = 0;
const OPP = 1;
const GREY = -1;
const ATTACK = 0;
const POWER = 1;
const SHIFT = 1024; // move = left * SHIFT + right
/** transposition table cap (nodes) */
const MAX_NODES = 120_000;
/** stop pondering after this much background search (game paused, slow UI...) */
const PONDER_LIMIT_MS = 4000;

// ------------------------------------------------------------------ options

export interface MasterOptions {
  /**
   * Fixed number of playouts per decision. When set, time budgets are ignored and the bot is fully
   * deterministic for a given seed (used by tests and headless simulations).
   */
  playouts?: number;
  /** first attack decision of a turn: minimum thinking time (ms) */
  firstAttackMs?: number;
  /** first attack decision of a turn: minimum playouts */
  firstAttackRuns?: number;
  /** later attack decisions think for attackSpeedFactor × ctx.speedMs ... */
  attackSpeedFactor?: number;
  /** ... but run at least this many playouts */
  attackRuns?: number;
  /** first power decision: min(powerMsPerSource × sources, powerMaxMs) */
  powerMsPerSource?: number;
  powerMaxMs?: number;
  /** minimum playouts per power decision */
  powerRuns?: number;
  /** hard cap for one nextAttack() / placePower() call (ms) */
  maxDecisionMs?: number;
  /** stop a decision early once this many playouts ran (and the minimum playouts are done) */
  maxRuns?: number;
  /** UCT exploration constant (search uses +C, final choice −C) */
  exploration?: number;
  limitPowerInDeadEnds?: boolean;
}

export const DEFAULT_MASTER_OPTIONS: Required<Omit<MasterOptions, 'playouts'>> = {
  firstAttackMs: 350,
  firstAttackRuns: 150,
  attackSpeedFactor: 1.2,
  attackRuns: 60,
  powerMsPerSource: 50,
  powerMaxMs: 350,
  powerRuns: 40,
  maxDecisionMs: 1500,
  maxRuns: 40_000,
  exploration: 0.25,
  limitPowerInDeadEnds: true,
};

// ------------------------------------------------------------------ fast rng

class FastRng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }
  /** mulberry32 */
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  u32(): number {
    return Math.floor(this.next() * 4294967296) >>> 0;
  }
}

const now = (): number =>
  typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();

// ------------------------------------------------------------------ topology

const ZK = 27; // zobrist codes per cell: grey, me 0..12, opp 0..12

class Topo {
  readonly n: number;
  readonly adjStart: Int32Array;
  readonly adj: Int32Array;
  readonly cap: Int8Array;
  /** mapped id per alive seat, in seat order */
  readonly players: Int8Array;
  readonly greysFirst: boolean;
  readonly duelIncome: boolean;
  readonly limitDeadEnds: boolean;
  readonly z1: Uint32Array;
  readonly z2: Uint32Array;
  /** scratch for BFS */
  readonly stamp: Int32Array;
  stampGen = 0;
  readonly queue: Int32Array;
  readonly qdepth: Int32Array;

  constructor(state: MatchState, me: number, limitDeadEnds: boolean, rng: FastRng) {
    const { cells, adj } = state.field;
    const n = cells.length;
    this.n = n;
    this.adjStart = new Int32Array(n + 1);
    let total = 0;
    for (let i = 0; i < n; i++) total += adj[i].length;
    this.adj = new Int32Array(total);
    let k = 0;
    for (let i = 0; i < n; i++) {
      this.adjStart[i] = k;
      for (const j of adj[i]) this.adj[k++] = j;
    }
    this.adjStart[n] = k;
    this.cap = new Int8Array(n);
    for (let i = 0; i < n; i++) this.cap[i] = cells[i].maxPower;
    const alive = alivePlayers(state);
    if (!alive.includes(me)) alive.push(me);
    alive.sort((a, b) => a - b);
    this.players = Int8Array.from(alive.map((p) => (p === me ? ME : OPP)));
    this.greysFirst = state.settings.duelRules;
    this.duelIncome = state.settings.duelRules;
    this.limitDeadEnds = limitDeadEnds;
    this.z1 = new Uint32Array(n * ZK + 64);
    this.z2 = new Uint32Array(n * ZK + 64);
    for (let i = 0; i < this.z1.length; i++) {
      this.z1[i] = rng.u32();
      this.z2[i] = rng.u32();
    }
    this.stamp = new Int32Array(n);
    this.queue = new Int32Array(n);
    this.qdepth = new Int32Array(n);
  }

  nextStamp(): number {
    if (++this.stampGen > 2_000_000_000) {
      this.stamp.fill(0);
      this.stampGen = 1;
    }
    return this.stampGen;
  }
}

// ------------------------------------------------------------------ board

/** Binary max-heap on (units, -id) used by the threat search. */
class Heap {
  private keys: number[] = [];
  push(u: number, id: number) {
    const key = u * 4096 + (4095 - id);
    const a = this.keys;
    a.push(key);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p] >= a[i]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  get size() {
    return this.keys.length;
  }
  /** returns key; units = floor(key / 4096), id = 4095 - key % 4096 */
  pop(): number {
    const a = this.keys;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l] > a[m]) m = l;
        if (r < a.length && a[r] > a[m]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

export class Board {
  t: Topo;
  rng: FastRng;
  owner: Int8Array;
  units: Int8Array;
  cnt: [number, number] = [0, 0];
  idx = 0;
  phase = ATTACK;
  reinf = 0;
  lastL = -1;
  lastR = -1;
  minNeed: Int8Array;
  plusTwo: Int8Array;
  minCount = 0;
  winner = -1;
  myPowerStarts = 0;
  dead = false;
  moves: number[] = [];
  // info about the last attack (for chance edges)
  lastChance = false;
  lastWin = true;
  lastPWin = 1;

  constructor(t: Topo, rng: FastRng) {
    this.t = t;
    this.rng = rng;
    this.owner = new Int8Array(t.n);
    this.units = new Int8Array(t.n);
    this.minNeed = new Int8Array(t.n);
    this.plusTwo = new Int8Array(t.n);
  }

  clone(): Board {
    const b = new Board(this.t, this.rng);
    b.owner.set(this.owner);
    b.units.set(this.units);
    b.cnt = [this.cnt[0], this.cnt[1]];
    b.idx = this.idx;
    b.phase = this.phase;
    b.reinf = this.reinf;
    b.lastL = this.lastL;
    b.lastR = this.lastR;
    b.minNeed.set(this.minNeed);
    b.plusTwo.set(this.plusTwo);
    b.minCount = this.minCount;
    b.winner = this.winner;
    b.myPowerStarts = this.myPowerStarts;
    b.dead = this.dead;
    b.moves = this.moves.slice();
    return b;
  }

  get cur(): number {
    return this.t.players[this.idx];
  }

  get terminal(): boolean {
    return this.winner >= 0 || this.dead || this.myPowerStarts > 0;
  }

  static fromState(
    state: MatchState,
    t: Topo,
    rng: FastRng,
    me: number,
    lastMove: AttackMove | null,
  ): Board {
    const b = new Board(t, rng);
    state.field.cells.forEach((c, i) => {
      if (c.owner === NEUTRAL || c.power <= 0) {
        b.owner[i] = GREY;
        b.units[i] = 0;
      } else {
        const id = c.owner === me ? ME : OPP;
        b.owner[i] = id;
        b.units[i] = c.power;
        b.cnt[id]++;
      }
    });
    b.idx = t.players.indexOf(ME);
    if (state.phase === 'attack') {
      b.phase = ATTACK;
      if (lastMove) {
        b.lastL = lastMove.from;
        b.lastR = lastMove.to;
      }
    } else {
      b.phase = POWER;
      b.reinf = state.powerLeft;
      b.computeMinMap();
    }
    b.updateWinner();
    b.advance();
    return b;
  }

  updateWinner() {
    if (this.cnt[ME] === 0 && this.cnt[OPP] > 0) this.winner = OPP;
    else if (this.cnt[OPP] === 0 && this.cnt[ME] > 0) this.winner = ME;
  }

  // -------------------------------------------------------------- moves

  private targetsInto(s: number, cur: number, out: number[]) {
    const { adjStart, adj } = this.t;
    const owner = this.owner;
    let greyOnly = false;
    if (this.t.greysFirst) {
      for (let k = adjStart[s]; k < adjStart[s + 1]; k++) if (owner[adj[k]] === GREY) greyOnly = true;
    }
    const base = s * SHIFT;
    for (let k = adjStart[s]; k < adjStart[s + 1]; k++) {
      const nb = adj[k];
      const o = owner[nb];
      if (o === cur) continue;
      if (greyOnly && o !== GREY) continue;
      out.push(base + nb);
    }
  }

  priority(c: number): number {
    const { adjStart, adj } = this.t;
    const cur = this.owner[c];
    let p = c / 1000;
    for (let k = adjStart[c]; k < adjStart[c + 1]; k++) {
      const nb = adj[k];
      const o = this.owner[nb];
      if (o === GREY || this.units[nb] === 0) p += 0.5;
      else if (o !== cur) p += this.units[nb];
    }
    return p;
  }

  /** BFS depth of the grey pocket next to c; -1 if the pocket touches the other player. */
  grayDepth(c: number): number {
    const t = this.t;
    const { adjStart, adj, queue, qdepth, stamp } = t;
    const g = t.nextStamp();
    const cur = this.owner[c];
    const cap = t.cap[c];
    let head = 0;
    let tail = 0;
    for (let k = adjStart[c]; k < adjStart[c + 1]; k++) {
      const nb = adj[k];
      if (this.owner[nb] === GREY && stamp[nb] !== g) {
        stamp[nb] = g;
        queue[tail] = nb;
        qdepth[tail++] = 1;
      }
    }
    let maxDepth = 0;
    while (head < tail) {
      const x = queue[head];
      const dep = qdepth[head++];
      if (dep >= cap) return cap;
      if (dep > maxDepth) maxDepth = dep;
      for (let k = adjStart[x]; k < adjStart[x + 1]; k++) {
        const y = adj[k];
        const o = this.owner[y];
        if (o !== GREY && o !== cur) return -1;
        if (o === GREY && stamp[y] !== g) {
          stamp[y] = g;
          queue[tail] = y;
          qdepth[tail++] = dep + 1;
        }
      }
    }
    return maxDepth;
  }

  calculateMoves(): number[] {
    const out: number[] = [];
    if (this.winner >= 0) return out;
    const cur = this.cur;
    const { n, adjStart, adj, cap } = this.t;
    const owner = this.owner;
    const units = this.units;
    if (this.phase === ATTACK) {
      const r = this.lastR;
      if (this.lastL >= 0 && owner[r] === cur && units[r] > 1) {
        this.targetsInto(r, cur, out);
        if (out.length) return out;
      }
      for (let i = 0; i < n; i++) if (owner[i] === cur && units[i] > 1) this.targetsInto(i, cur, out);
      return out;
    }
    if (this.reinf <= 0) return out;
    if (this.minCount > 0) {
      for (let i = 0; i < n; i++) {
        if (this.minNeed[i] > 0) {
          const amt = Math.min(this.minNeed[i], this.reinf, cap[i] - units[i]);
          if (amt > 0) {
            out.push(i * SHIFT + amt);
            return out;
          }
          // nothing fits (should not happen): drop the entry
          this.minNeed[i] = 0;
          this.minCount--;
        }
      }
    }
    const threshold = this.lastL < 0 ? 0.49 : this.priority(this.lastL);
    for (let i = 0; i < n; i++) {
      if (owner[i] !== cur || units[i] >= cap[i]) continue;
      if (this.priority(i) <= threshold) continue;
      let room = cap[i] - units[i];
      if (this.t.limitDeadEnds) {
        let other = false;
        let grey = false;
        for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
          const o = owner[adj[k]];
          if (o === GREY) grey = true;
          else if (o !== cur) other = true;
        }
        if (!other && grey) {
          const d = this.grayDepth(i);
          if (d !== -1) room = Math.min(room, Math.max(0, d + 1 - units[i]));
        }
      }
      if (room <= 0) continue;
      const a1 = Math.min(this.reinf, room);
      out.push(i * SHIFT + a1);
      if (this.plusTwo[i] > 0) {
        const a2 = Math.min(this.plusTwo[i], room, this.reinf);
        if (a2 !== a1) out.push(i * SHIFT + a2);
      }
    }
    return out;
  }

  /** Recompute moves; switch phases while nobody can move. Stops at Master's next power phase. */
  advance() {
    this.moves = this.calculateMoves();
    let guard = 0;
    while (this.moves.length === 0 && this.winner < 0 && this.myPowerStarts === 0) {
      if (guard++ > 4 * this.t.players.length + 4) {
        this.dead = true;
        return;
      }
      this.switchPhase();
      if (this.myPowerStarts > 0) return;
      this.moves = this.calculateMoves();
    }
  }

  income(id: number): number {
    if (!this.t.duelIncome) return this.cnt[id];
    // biggest connected group
    const { n, adjStart, adj, stamp, queue } = this.t;
    const g = this.t.nextStamp();
    let best = 0;
    for (let i = 0; i < n; i++) {
      if (this.owner[i] !== id || stamp[i] === g) continue;
      let head = 0;
      let tail = 0;
      stamp[i] = g;
      queue[tail++] = i;
      while (head < tail) {
        const x = queue[head++];
        for (let k = adjStart[x]; k < adjStart[x + 1]; k++) {
          const y = adj[k];
          if (this.owner[y] === id && stamp[y] !== g) {
            stamp[y] = g;
            queue[tail++] = y;
          }
        }
      }
      if (tail > best) best = tail;
    }
    return best;
  }

  switchPhase() {
    if (this.phase === ATTACK) {
      this.phase = POWER;
      this.lastL = -1;
      this.lastR = -1;
      const cur = this.cur;
      this.reinf = this.income(cur);
      if (cur === ME) {
        this.myPowerStarts++;
        return; // horizon: no need for the minimum map
      }
      this.computeMinMap();
    } else {
      this.phase = ATTACK;
      this.idx = (this.idx + 1) % this.t.players.length;
      this.reinf = 0;
      this.lastL = -1;
      this.lastR = -1;
      if (this.minCount) {
        this.minNeed.fill(0);
        this.minCount = 0;
      }
      this.plusTwo.fill(0);
    }
  }

  /** Threat-based minimum power for the player to move (§7.5). */
  computeMinMap() {
    this.minNeed.fill(0);
    this.plusTwo.fill(0);
    this.minCount = 0;
    const me = this.cur;
    const x = me === ME ? OPP : ME;
    const { n, adjStart, adj, cap, stamp } = this.t;
    const owner = this.owner;
    const units = this.units;
    const g = this.t.nextStamp();
    const heap = new Heap();
    for (let i = 0; i < n; i++) {
      if (owner[i] === x) {
        stamp[i] = g;
        if (units[i] > 1) heap.push(units[i], i);
      }
    }
    const need = this.minNeed; // reuse as raw needs
    const cells: number[] = [];
    let total = 0;
    while (heap.size) {
      const key = heap.pop();
      const u = Math.floor(key / 4096);
      const node = 4095 - (key % 4096);
      for (let k = adjStart[node]; k < adjStart[node + 1]; k++) {
        const nb = adj[k];
        if (stamp[nb] === g || owner[nb] === x) continue;
        stamp[nb] = g;
        if (owner[nb] === GREY) {
          const rem = u - 1;
          if (rem > 1) heap.push(rem, nb);
        } else {
          const v = Math.min(u - 1, cap[nb]) - units[nb];
          if (v > 0) {
            need[nb] = v;
            cells.push(nb);
            total += v;
            const m = Math.min(3, cap[nb] - units[nb] - v);
            if (m > 0) this.plusTwo[nb] = m;
          }
        }
      }
    }
    if (!cells.length) return;
    cells.sort((a, b) => a - b);
    const excess = total - this.reinf;
    if (excess > 0) {
      // uniform "water level" cut, then the remainder by selection sampling
      let level = 0;
      let removed = 0;
      for (;;) {
        let count = 0;
        for (const c of cells) if (need[c] > level) count++;
        if (count === 0 || removed + count > excess) break;
        removed += count;
        level++;
      }
      let rRem = excess - removed;
      let cellsRem = 0;
      for (const c of cells) if (need[c] > level) cellsRem++;
      for (const c of cells) {
        let v = need[c] - level;
        if (v > 0) {
          if (this.rng.int(cellsRem) < rRem) {
            v--;
            rRem--;
          }
          cellsRem--;
        }
        need[c] = v > 0 ? v : 0;
      }
    }
    for (const c of cells) if (need[c] > 0) this.minCount++;
  }

  // -------------------------------------------------------------- transitions

  doMove(mv: number) {
    const l = Math.floor(mv / SHIFT);
    const r = mv % SHIFT;
    const cap = this.t.cap;
    if (this.phase === ATTACK) {
      const cur = this.cur;
      const a = this.units[l];
      const prev = this.owner[r];
      const d = prev === GREY ? 0 : this.units[r];
      let win: boolean;
      let p: number;
      if (d === 0) {
        p = 1;
        win = true;
      } else {
        p = Math.min(1, Math.max(0, (a - d + 2) / 4));
        win = p >= 1 ? true : p <= 0 ? false : this.rng.next() < p;
      }
      // same arithmetic as the real engine
      let atkAfter = 1;
      let defAfter = d === 0 ? a - 1 : Math.abs(a - d);
      if (defAfter <= 0) defAfter = 1;
      if (win && defAfter > cap[r]) {
        atkAfter += defAfter - cap[r];
        defAfter = cap[r];
        if (d > 0) atkAfter -= 1;
      } else if (!win && defAfter > cap[r]) {
        defAfter = cap[r];
      }
      this.units[l] = atkAfter;
      this.units[r] = defAfter;
      if (win) {
        this.owner[r] = cur;
        this.cnt[cur]++;
        if (prev !== GREY) this.cnt[prev]--;
        this.updateWinner();
      }
      this.lastL = l;
      this.lastR = r;
      this.lastChance = p > 0 && p < 1;
      this.lastPWin = p;
      this.lastWin = win;
    } else {
      const k = r;
      this.units[l] += k;
      this.reinf -= k;
      if (this.minNeed[l] > 0) {
        this.minNeed[l] = 0;
        this.minCount--;
        this.lastL = -1;
        this.lastR = -1;
      } else {
        this.lastL = l;
        this.lastR = k;
      }
      this.lastChance = false;
      this.lastPWin = 1;
      this.lastWin = true;
    }
    this.advance();
  }

  // -------------------------------------------------------------- evaluation

  result(): number {
    let me = 0;
    let opp = 0;
    const n = this.t.n;
    for (let i = 0; i < n; i++) {
      const o = this.owner[i];
      if (o === ME) me += this.units[i];
      else if (o === OPP) opp += this.units[i];
    }
    if (this.phase === POWER && this.cur === ME) me = this.reinf + this.cnt[ME];
    if (opp === 0) return 1;
    const v = (me / opp - 0.3) / 2.7;
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  hash(): number {
    const { z1, z2, n } = this.t;
    let h1 = 0;
    let h2 = 0;
    for (let i = 0; i < n; i++) {
      const o = this.owner[i];
      const code = i * ZK + (o === GREY ? 0 : 1 + o * 13 + this.units[i]);
      h1 ^= z1[code];
      h2 ^= z2[code];
      if (this.minNeed[i] || this.plusTwo[i]) {
        const m = Math.imul(this.minNeed[i] * 31 + this.plusTwo[i] + 7, 0x9e3779b1) ^ i;
        h1 = (h1 + Math.imul(m, 0x85ebca6b)) | 0;
        h2 = (h2 + Math.imul(m ^ 0x5bd1e995, 0xc2b2ae35)) | 0;
      }
    }
    const extra =
      ((this.phase * 31 + this.idx) * 1031 + this.reinf) * 2053 +
      (this.lastL + 1) * 17 +
      (this.lastR + 1) +
      this.myPowerStarts * 7919;
    h1 = (h1 ^ Math.imul(extra, 0x27d4eb2d)) >>> 0;
    h2 = (h2 ^ Math.imul(extra + 0x165667b1, 0x9e3779b1)) >>> 0;
    return h1 * 2097152 + (h2 >>> 11);
  }

  // -------------------------------------------------------------- rollout policy

  expertMove(): number {
    const moves = this.moves;
    if (moves.length === 1) return moves[0];
    if (this.phase === ATTACK) {
      let best = moves[0];
      let bestV = -Infinity;
      for (const mv of moves) {
        const s = Math.floor(mv / SHIFT);
        const t = mv % SHIFT;
        const a = this.units[s];
        const d = this.owner[t] === GREY ? 0 : this.units[t];
        let v: number;
        if (d === 0) v = a - 1.01;
        else {
          const diff = a - d;
          v = diff >= 2 ? diff : diff === 1 ? 1.25 : diff === 0 ? 1.5 : diff === -1 ? 1.75 : 1.0;
        }
        if (v > bestV) {
          bestV = v;
          best = mv;
        }
      }
      return best;
    }
    // power: the lowest-priority source, "fill" amount (first option)
    let best = moves[0];
    let bestP = Infinity;
    let lastSrc = -1;
    for (const mv of moves) {
      const s = Math.floor(mv / SHIFT);
      if (s === lastSrc) continue;
      lastSrc = s;
      const p = this.priority(s);
      if (p < bestP) {
        bestP = p;
        best = mv;
      }
    }
    return best;
  }

  rollout(): number {
    let guard = 0;
    while (!this.terminal && this.moves.length && guard++ < 20000) this.doMove(this.expertMove());
    return this.result();
  }
}

// ------------------------------------------------------------------ tree

interface Node {
  count: number;
  wins: number;
  /** filled lazily the first time the node is expanded (most leaves never are) */
  moves: number[] | null;
  edges: (Edge | undefined)[] | null;
}

interface Edge {
  chance: boolean;
  p: number;
  /** deterministic outcome or the "win" outcome of a chance move */
  a: Node | null;
  /** the "loss" outcome of a chance move */
  b: Node | null;
}

function newNode(): Node {
  return { count: 0, wins: 0, moves: null, edges: null };
}

function expand(node: Node, b: Board): number[] {
  if (!node.moves) {
    node.moves = b.moves.slice();
    node.edges = new Array(node.moves.length);
  }
  return node.moves;
}

function ucb(child: Node | null, parentCount: number, maximize: boolean, c: number): number {
  if (!child || child.count === 0) return c * Infinity;
  const mean = (maximize ? child.wins : child.count - child.wins) / child.count;
  return mean + c * Math.sqrt(Math.log(Math.max(1, parentCount)) / child.count);
}

function computeVal(node: Node, i: number, maximize: boolean, c: number): number {
  const e = node.edges?.[i];
  if (!e) return c * Infinity;
  if (e.chance) {
    if (!e.a || !e.b) return c * Infinity;
    return e.p * ucb(e.a, node.count, maximize, c) + (1 - e.p) * ucb(e.b, node.count, maximize, c);
  }
  return ucb(e.a, node.count, maximize, c);
}

export interface SearchStats {
  runs: number;
  ms: number;
}

class Search {
  table = new Map<number, Node>();
  constructor(readonly c: number) {}

  reset() {
    this.table.clear();
  }

  /** visits of the node for this board, if the table has it */
  visits(b: Board): number {
    return this.table.get(b.hash())?.count ?? 0;
  }

  private nodeFor(b: Board, key = b.hash()): Node {
    let n = this.table.get(key);
    if (!n) {
      n = newNode();
      this.table.set(key, n);
    }
    return n;
  }

  iterate(root: Board, rootNode: Node) {
    const b = root.clone();
    let node = rootNode;
    const path: Node[] = [node];
    let guard = 0;
    while (node.count > 0 && !b.terminal && b.moves.length && guard++ < 10000) {
      const moves = expand(node, b);
      const maximize = b.cur === ME;
      let bi = 0;
      let bv = -Infinity;
      for (let i = 0; i < moves.length; i++) {
        const v = computeVal(node, i, maximize, this.c);
        if (v > bv) {
          bv = v;
          bi = i;
        }
      }
      b.doMove(moves[bi]);
      const child = this.nodeFor(b);
      let e = node.edges![bi];
      if (!e) {
        e = { chance: b.lastChance, p: b.lastPWin, a: null, b: null };
        node.edges![bi] = e;
      }
      if (e.chance) {
        if (b.lastWin) e.a = child;
        else e.b = child;
      } else {
        e.a = child;
      }
      path.push(child);
      node = child;
    }
    const value = b.terminal || !b.moves.length ? b.result() : b.rollout();
    for (const n of path) {
      n.wins += value;
      n.count++;
    }
  }

  run(
    root: Board,
    minRuns: number,
    minMs: number,
    hardMs: number,
    maxRuns: number,
  ): { node: Node; stats: SearchStats } {
    const start = now();
    // keep the table bounded (nodes from earlier decisions are only an optimisation)
    if (this.table.size > MAX_NODES / 2) this.table.clear();
    const rootNode = this.nodeFor(root);
    expand(rootNode, root);
    let runs = 0;
    for (;;) {
      const t = (runs & 7) === 0 || runs < 16 ? now() - start : -1;
      if (t >= 0) {
        if (runs >= minRuns && t >= minMs) break;
        if (t >= hardMs && runs > 0) break;
      }
      if (runs >= maxRuns && runs >= minRuns) break;
      if (this.table.size > MAX_NODES && runs > 0) break;
      this.iterate(root, rootNode);
      runs++;
    }
    return { node: rootNode, stats: { runs, ms: now() - start } };
  }

  /** Final choice: lower confidence bound (−C); unexplored moves are −∞. */
  best(node: Node): number {
    const moves = node.moves!;
    let bi = -1;
    let bv = -Infinity;
    for (let i = 0; i < moves.length; i++) {
      const v = computeVal(node, i, true, -this.c);
      if (v > bv) {
        bv = v;
        bi = i;
      }
    }
    if (bi < 0) {
      // nothing fully explored: most visited outcome, else the first move
      let bc = -1;
      for (let i = 0; i < moves.length; i++) {
        const e = node.edges?.[i];
        const cnt = (e?.a?.count ?? 0) + (e?.b?.count ?? 0);
        if (cnt > bc) {
          bc = cnt;
          bi = i;
        }
      }
    }
    return moves[Math.max(0, bi)];
  }
}

// ------------------------------------------------------------------ brain

export interface MasterDecisionInfo {
  runs: number;
  ms: number;
}

/** Stateful Master decision maker (one per bot / worker). */
export class MasterBrain {
  readonly opts: Required<Omit<MasterOptions, 'playouts'>> & { playouts?: number };
  private rng: FastRng;
  private search: Search;
  private last: { turn: number; slot: number; from: number; to: number } | null = null;
  private attackKey = '';
  private topo: Topo | null = null;
  private topoKey = '';
  /** stats of the last decision (debug / tests) */
  lastInfo: MasterDecisionInfo = { runs: 0, ms: 0 };
  /** pondering: the last attack decision and the board it was made on */
  private ponderBase: { root: Board; mv: number } | null = null;
  private ponderRoot: Board | null = null;
  private ponderMs = 0;

  constructor(seed?: number, opts: MasterOptions = {}) {
    this.opts = { ...DEFAULT_MASTER_OPTIONS, ...opts };
    this.rng = new FastRng(botSeed(seed));
    this.search = new Search(this.opts.exploration);
  }

  private topoFor(state: MatchState, me: number): Topo {
    const key = [
      me,
      state.field.cells.length,
      state.field.adj.length,
      alivePlayers(state).join(','),
      state.settings.duelRules,
      state.field.cells.map((c) => c.maxPower).join(''),
    ].join('|');
    if (!this.topo || key !== this.topoKey) {
      this.topo = new Topo(state, me, this.opts.limitPowerInDeadEnds, this.rng);
      this.topoKey = key;
      this.search.reset();
    }
    return this.topo;
  }

  decideAttack(state: MatchState, ctx: BotContext): AttackMove | null {
    if (state.ended || state.phase !== 'attack') return null;
    const me = state.current;
    const t0 = now();
    const topo = this.topoFor(state, me);
    const key = `${state.turn}:${me}`;
    const first = key !== this.attackKey;
    if (first) {
      this.attackKey = key;
      this.search.reset();
    }
    const pondered = this.ponderMs;
    this.ponderMs = 0;
    this.ponderBase = null;
    this.ponderRoot = null;
    const last = this.last && !first && this.last.slot === me && this.last.turn === state.turn ? this.last : null;
    const root = Board.fromState(state, topo, this.rng, me, last ? { from: last.from, to: last.to } : null);
    if (root.phase !== ATTACK || root.cur !== ME || root.terminal || !root.moves.length) {
      this.last = null;
      this.lastInfo = { runs: 0, ms: now() - t0 };
      return null;
    }
    let mv: number;
    if (root.moves.length === 1) {
      mv = root.moves[0];
      this.lastInfo = { runs: 0, ms: now() - t0 };
    } else {
      const o = this.opts;
      let minRuns: number;
      let minMs: number;
      if (o.playouts !== undefined) {
        minRuns = o.playouts;
        minMs = 0;
      } else if (first) {
        minRuns = o.firstAttackRuns;
        minMs = Math.max(o.firstAttackMs, o.attackSpeedFactor * ctx.speedMs);
      } else {
        minRuns = o.attackRuns;
        // time spent pondering on this very position (the UI was animating the last move) counts
        const credit = this.search.visits(root) > 0 ? pondered : 0;
        minMs = Math.max(0, o.attackSpeedFactor * ctx.speedMs - credit);
      }
      const hard = o.playouts !== undefined ? Infinity : o.maxDecisionMs - (now() - t0);
      const { node, stats } = this.search.run(root, minRuns, Math.min(minMs, hard), hard, o.playouts ?? o.maxRuns);
      this.lastInfo = stats;
      mv = this.search.best(node);
    }
    const from = Math.floor(mv / SHIFT);
    const to = mv % SHIFT;
    let move: AttackMove | null = checkAttack(state, from, to) === null ? { from, to } : null;
    if (!move) {
      // the model and the engine disagree (should not happen): any legal model move, else any legal move
      for (const m of root.moves) {
        const f = Math.floor(m / SHIFT);
        const tt = m % SHIFT;
        if (checkAttack(state, f, tt) === null) {
          move = { from: f, to: tt };
          break;
        }
      }
      move ??= firstLegalAttack(state);
    }
    this.last = move ? { turn: state.turn, slot: me, from: move.from, to: move.to } : null;
    if (move && this.opts.playouts === undefined) this.ponderBase = { root, mv: move.from * SHIFT + move.to };
    return move;
  }

  /**
   * Think ahead between decisions (Web Worker only): search the position after the last chosen
   * attack with a sampled outcome, like the original's background runner. Nodes are found again
   * through the transposition table when the real dice agree. Returns false when there is nothing
   * (more) to do.
   */
  ponder(sliceMs: number): boolean {
    if (this.ponderBase) {
      const b = this.ponderBase.root.clone();
      b.doMove(this.ponderBase.mv);
      this.ponderBase = null;
      this.ponderRoot = b.terminal || !b.moves.length || b.phase !== ATTACK ? null : b;
    }
    if (!this.ponderRoot || this.ponderMs > PONDER_LIMIT_MS) return false;
    const t0 = now();
    this.search.run(this.ponderRoot, 1, sliceMs, sliceMs, Infinity);
    this.ponderMs += now() - t0;
    return true;
  }

  decidePower(state: MatchState, _ctx: BotContext): Map<number, number> {
    const me = state.current;
    const plan = new PowerPlan(state, me);
    if (state.ended || state.phase !== 'power' || plan.left <= 0) return plan.result();
    const t0 = now();
    const o = this.opts;
    const topo = this.topoFor(state, me);
    this.search.reset();
    this.last = null;
    this.attackKey = '';
    this.ponderBase = null;
    this.ponderRoot = null;
    this.ponderMs = 0;
    const b = Board.fromState(state, topo, this.rng, me, null);
    let decisions = 0;
    let totalRuns = 0;
    let guard = 0;
    while (
      b.phase === POWER &&
      b.cur === ME &&
      b.reinf > 0 &&
      !b.terminal &&
      b.moves.length > 0 &&
      plan.left > 0 &&
      guard++ < 1000
    ) {
      let mv: number;
      const forced = b.minCount > 0;
      if (forced || b.moves.length === 1) {
        mv = b.moves[0];
      } else {
        const sources = new Set(b.moves.map((m) => Math.floor(m / SHIFT))).size;
        let minRuns: number;
        let minMs: number;
        let hard: number;
        if (o.playouts !== undefined) {
          minRuns = o.playouts;
          minMs = 0;
          hard = Infinity;
        } else {
          minRuns = o.powerRuns;
          const elapsed = now() - t0;
          hard = Math.max(0, o.maxDecisionMs - elapsed);
          minMs =
            decisions === 0
              ? Math.min(o.powerMsPerSource * sources, o.powerMaxMs)
              : Math.min((o.powerMsPerSource / 2) * sources, o.powerMaxMs / 2);
          minMs = Math.min(minMs, hard);
        }
        const { node, stats } = this.search.run(b, minRuns, minMs, Math.max(hard, 1), o.playouts ?? o.maxRuns);
        totalRuns += stats.runs;
        mv = this.search.best(node);
        decisions++;
      }
      const cell = Math.floor(mv / SHIFT);
      const amt = mv % SHIFT;
      const added = plan.add(cell, amt);
      if (added !== amt) break; // model / state mismatch: stop and let the fallback place the rest
      b.doMove(mv);
    }
    // leftovers (interior cells, dead-end caps reached...): SmartyPower
    const out = smartyPower(state, plan);
    this.search.reset();
    this.lastInfo = { runs: totalRuns, ms: now() - t0 };
    return out;
  }
}

/** Internal access for tests. */
export const __test = { Board, Topo, FastRng, ME, OPP, ATTACK, POWER, SHIFT };
