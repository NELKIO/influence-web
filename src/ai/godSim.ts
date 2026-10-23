/**
 * GOD ("БОГ") simulator: a fast typed-array copy of the rules engine with per-player policy models.
 *
 * - Exact fight arithmetic (overflow back to the attacker, defender keeps max(1,|a−d|) on a loss), exact
 *   income (cells, or the biggest group under duel rules, capped by free capacity), duel greys-first.
 * - The hidden streak corrector is simulated with its counters: GOD's rollouts start from a belief over
 *   the counters (it never reads the real ones) and then play the corrector exactly as the engine does.
 * - Every seat is played by a model of its own type: Hunter / Duel Hunter / Dummy / Freak exactly as their
 *   bots, Master by its expert policy (forced continuation, no pass, threat minimums), people and other
 *   GODs by the "sage" heuristic below (GOD's own base policy).
 *
 * Nothing in here touches a MatchState: the brain builds a Sim from its (fog-respecting) belief.
 */
import type { MatchState, PlayerType } from '../core/types';

// ------------------------------------------------------------------ policy kinds

export const PK_FREAK = 0;
export const PK_DUMMY = 1;
export const PK_HUNTER = 2;
export const PK_MASTER = 3;
export const PK_SAGE = 4;

export function policyKind(t: PlayerType): number {
  switch (t) {
    case 'freak':
      return PK_FREAK;
    case 'dummy':
      return PK_DUMMY;
    case 'hunter':
    case 'duelHunter':
      return PK_HUNTER;
    case 'master':
      return PK_MASTER;
    default:
      return PK_SAGE; // human, remote, online, god
  }
}

export const isPerson = (t: PlayerType) => t === 'human' || t === 'remote' || t === 'online';

// ------------------------------------------------------------------ rng

export class FastRng {
  s: number;
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

// ------------------------------------------------------------------ parameters

/**
 * Tunable knobs. The sage weights drive GOD's base heuristic, used to model people and other GODs in
 * multi-player searches; the p.. / q.. weights are the phase-end evaluation (evalPhase), tuned by self-play
 * against Master (scripts/god-strength.ts): Master's own ratio 2·cells / enemy power turned out to be a
 * sharp optimum (own power, exposure, enemy cells and interior discounts all lost games).
 */
export interface GodParams {
  /** sage: value of a cell in power units */
  cellValue: number;
  /** sage: weight of enemy material changes vs own (1 = zero-sum) */
  enemyWeight: number;
  /** sage: how much of the exposure created by an attack counts (income placement fixes part of it) */
  exposure: number;
  /** sage attacks only when the score exceeds this */
  attackThreshold: number;
  /** sage: value (in cell values per chain step) of shrinking an enemy stack that could chain through weak cells */
  chain: number;
  /** evaluation: weight of cells outside the biggest group under duel rules (relative to pCell) */
  evalDuelStray: number;
  /** phase-end evaluation: weights of own cells, own border power, own interior power */
  pCell: number;
  pPow: number;
  pInt: number;
  /** phase-end evaluation: weights of enemy cells and enemy power */
  qCell: number;
  qPow: number;
  /** phase-end evaluation: weight of enemy power on interior cells */
  qInt: number;
  /** phase-end evaluation: penalty (in own-cell units) per own cell an adjacent enemy stack takes surely */
  pExposed: number;
  /** map the ratio like Master (clamp((x − 0.3) / 2.7)) instead of x / (1 + x) */
  clampMap?: boolean;
}

export const DEFAULT_PARAMS: GodParams = {
  cellValue: 3,
  enemyWeight: 1,
  exposure: 0.5,
  attackThreshold: 0,
  chain: 0.3,
  evalDuelStray: 0.4,
  pCell: 2,
  pPow: 0,
  pInt: 0,
  qCell: 0,
  qPow: 1,
  qInt: 1,
  pExposed: 0,
};

// ------------------------------------------------------------------ luck model

/**
 * Effective win chances of the 25/50/75% buckets for bot and person attackers under the streak
 * corrector, by simulating a long stream of fights in which a share `personShare` of the attackers are
 * people. Index: person * 3 + bucket.
 */
export function luckTable(personShare: number): Float64Array {
  const out = new Float64Array(6);
  const rng = new FastRng(12345);
  const ps = [0.25, 0.5, 0.75];
  for (let k = 0; k < 3; k++) {
    const limit = k === 0 ? 3 : 2;
    let c = 0;
    const wins = [0, 0];
    const tries = [0, 0];
    for (let i = 0; i < 40000; i++) {
      const human = rng.next() < personShare ? 1 : 0;
      let win = rng.next() < ps[k];
      if (win !== !!human) c++;
      else c = 0;
      if ((c === limit && rng.next() < 0.5) || c > limit) {
        c = 0;
        win = !!human;
      }
      tries[human]++;
      if (win) wins[human]++;
    }
    for (let h = 0; h < 2; h++) out[h * 3 + k] = tries[h] ? wins[h] / tries[h] : h ? 1 - (1 - ps[k]) * 0.8 : ps[k] * 0.8;
  }
  return out;
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

// ------------------------------------------------------------------ topology

export class Topo {
  readonly n: number;
  readonly adjStart: Int32Array;
  readonly adj: Int32Array;
  readonly cap: Int8Array;
  readonly slots: number;
  readonly kind: Uint8Array;
  readonly person: Uint8Array;
  readonly duel: boolean;
  /** effective chances per (person, bucket) */
  readonly luck: Float64Array;
  // scratch
  readonly stamp: Int32Array;
  gen = 0;
  readonly queue: Int32Array;
  readonly qval: Int32Array;
  readonly tmp: Int32Array;
  readonly need: Int16Array;

  constructor(state: MatchState, kinds?: (number | undefined)[]) {
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
    const players = state.settings.players;
    this.slots = players.length;
    this.kind = Uint8Array.from(players.map((p, i) => kinds?.[i] ?? policyKind(p)));
    this.person = Uint8Array.from(players.map((p) => (isPerson(p) ? 1 : 0)));
    this.duel = state.settings.duelRules;
    const persons = players.filter(isPerson).length;
    this.luck = luckTable(persons / players.length);
    this.stamp = new Int32Array(n);
    this.queue = new Int32Array(n * 2 + 8);
    this.qval = new Int32Array(n * 2 + 8);
    this.tmp = new Int32Array(n + 8);
    this.need = new Int16Array(n);
  }

  nextStamp(): number {
    if (++this.gen > 2_000_000_000) {
      this.stamp.fill(0);
      this.gen = 1;
    }
    return this.gen;
  }

  /** effective win probability of an attack a→d by `slot` */
  eff(a: number, d: number, slot: number): number {
    const p = winChance(a, d);
    if (p <= 0 || p >= 1) return p;
    const k = p < 0.4 ? 0 : p < 0.6 ? 1 : 2;
    return this.luck[this.person[slot] * 3 + k];
  }
}

// ------------------------------------------------------------------ board

export class Sim {
  readonly t: Topo;
  readonly owner: Int8Array;
  readonly power: Int8Array;
  readonly cnt: Int16Array;
  readonly luck: Int8Array;
  /** Dummy's remembered scan index per slot */
  readonly dummyIdx: Int16Array;
  rng: FastRng;
  /** nominal dice without the streak corrector (how Master believes fights work); not copied */
  nominal = false;

  constructor(t: Topo, rng: FastRng) {
    this.t = t;
    this.rng = rng;
    this.owner = new Int8Array(t.n);
    this.power = new Int8Array(t.n);
    this.cnt = new Int16Array(t.slots);
    this.luck = new Int8Array(3);
    this.dummyIdx = new Int16Array(t.slots);
  }

  copyFrom(o: Sim): void {
    this.owner.set(o.owner);
    this.power.set(o.power);
    this.cnt.set(o.cnt);
    this.luck.set(o.luck);
    this.dummyIdx.set(o.dummyIdx);
  }

  clone(): Sim {
    const s = new Sim(this.t, this.rng);
    s.copyFrom(this);
    return s;
  }

  recount(): void {
    this.cnt.fill(0);
    for (let i = 0; i < this.t.n; i++) if (this.owner[i] >= 0) this.cnt[this.owner[i]]++;
  }

  alive(slot: number): boolean {
    return this.cnt[slot] > 0;
  }

  aliveCount(): number {
    let k = 0;
    for (let p = 0; p < this.t.slots; p++) if (this.cnt[p] > 0) k++;
    return k;
  }

  hasNeutralNb(c: number): boolean {
    const { adjStart, adj } = this.t;
    for (let k = adjStart[c]; k < adjStart[c + 1]; k++) if (this.owner[adj[k]] < 0) return true;
    return false;
  }

  /** own cell with a non-own neighbour */
  isBorder(c: number): boolean {
    const { adjStart, adj } = this.t;
    const o = this.owner[c];
    for (let k = adjStart[c]; k < adjStart[c + 1]; k++) if (this.owner[adj[k]] !== o) return true;
    return false;
  }

  /** engine checkAttack for the slot owning `s` */
  legal(s: number, t: number): boolean {
    const o = this.owner[s];
    if (o < 0 || this.power[s] < 2) return false;
    const ot = this.owner[t];
    if (ot === o) return false;
    const { adjStart, adj } = this.t;
    let adjOk = false;
    for (let k = adjStart[s]; k < adjStart[s + 1]; k++) if (adj[k] === t) adjOk = true;
    if (!adjOk) return false;
    if (this.t.duel && ot >= 0 && this.hasNeutralNb(s)) return false;
    return true;
  }

  /** Resolve a fight with the engine's arithmetic and streak corrector. Returns win. */
  fight(s: number, t: number, forced?: boolean): boolean {
    const a = this.power[s];
    const att = this.owner[s];
    const d = this.power[t];
    const p = winChance(a, d);
    let win: boolean;
    if (forced !== undefined) win = forced;
    else if (p >= 1) win = true;
    else if (p <= 0) win = false;
    else if (this.nominal) win = this.rng.next() < p;
    else {
      win = this.rng.next() < p;
      const k = p < 0.4 ? 0 : p < 0.6 ? 1 : 2;
      const limit = k === 0 ? 3 : 2;
      const human = this.t.person[att] === 1;
      if (win !== human) this.luck[k]++;
      else this.luck[k] = 0;
      if ((this.luck[k] === limit && this.rng.next() < 0.5) || this.luck[k] > limit) {
        this.luck[k] = 0;
        win = human;
      }
    }
    this.apply(s, t, win);
    return win;
  }

  apply(s: number, t: number, win: boolean): void {
    const a = this.power[s];
    const att = this.owner[s];
    const prev = this.owner[t];
    const d = this.power[t];
    const capT = this.t.cap[t];
    let atkAfter = 1;
    let defAfter = d === 0 ? a - 1 : Math.abs(a - d);
    if (defAfter <= 0) defAfter = 1;
    if (win && defAfter > capT) {
      atkAfter += defAfter - capT;
      defAfter = capT;
      if (d > 0) atkAfter -= 1;
    } else if (!win && defAfter > capT) defAfter = capT;
    this.power[s] = atkAfter;
    this.power[t] = defAfter;
    if (win) {
      this.owner[t] = att;
      this.cnt[att]++;
      if (prev >= 0) this.cnt[prev]--;
    }
  }

  freeCap(slot: number): number {
    let f = 0;
    const cap = this.t.cap;
    for (let i = 0; i < this.t.n; i++) if (this.owner[i] === slot) f += cap[i] - this.power[i];
    return f;
  }

  /** size of the biggest connected group of `slot` */
  biggestGroup(slot: number): number {
    const t = this.t;
    const { n, adjStart, adj, stamp, queue } = t;
    const g = t.nextStamp();
    let best = 0;
    for (let i = 0; i < n; i++) {
      if (this.owner[i] !== slot || stamp[i] === g) continue;
      let head = 0;
      let tail = 0;
      stamp[i] = g;
      queue[tail++] = i;
      while (head < tail) {
        const x = queue[head++];
        for (let k = adjStart[x]; k < adjStart[x + 1]; k++) {
          const y = adj[k];
          if (this.owner[y] === slot && stamp[y] !== g) {
            stamp[y] = g;
            queue[tail++] = y;
          }
        }
      }
      if (tail > best) best = tail;
    }
    return best;
  }

  income(slot: number): number {
    const base = this.t.duel ? this.biggestGroup(slot) : this.cnt[slot];
    return Math.min(base, this.freeCap(slot));
  }

  /** strongest enemy neighbour that may attack `c` next turn (duel: not if it must take greys first) */
  threatOn(c: number, exclude = -1): number {
    const { adjStart, adj } = this.t;
    const o = this.owner[c];
    let best = 0;
    for (let k = adjStart[c]; k < adjStart[c + 1]; k++) {
      const e = adj[k];
      if (e === exclude) continue;
      const oe = this.owner[e];
      if (oe < 0 || oe === o) continue;
      const y = this.power[e];
      if (y > best) {
        if (this.t.duel && this.hasNeutralNb(e)) continue;
        best = y;
      }
    }
    return best;
  }
}

// ------------------------------------------------------------------ policies: attack

/** Policy-level per-turn memory (Master's forced continuation). */
export interface TurnMemo {
  lastTo: number;
}

/** Hunter: strongest border cell (random initial pick, first strictly stronger) → weakest neighbour. */
export function hunterAttack(sim: Sim, me: number): number {
  const { n, adjStart, adj } = sim.t;
  const owner = sim.owner;
  const power = sim.power;
  let borders = 0;
  for (let i = 0; i < n; i++) if (owner[i] === me && sim.isBorder(i)) borders++;
  if (borders === 0 || sim.cnt[me] === n) return -1;
  let pick = sim.rng.int(borders);
  let best = -1;
  for (let i = 0; i < n; i++) {
    if (owner[i] === me && sim.isBorder(i)) {
      if (pick-- === 0) {
        best = i;
        break;
      }
    }
  }
  let bestP = power[best];
  for (let i = 0; i < n; i++) {
    if (owner[i] === me && power[i] > bestP && sim.isBorder(i)) {
      best = i;
      bestP = power[i];
    }
  }
  if (bestP < 2) return -1;
  const greys = sim.t.duel && sim.hasNeutralNb(best);
  // lazy target
  let m = 99;
  let first = -1;
  let firstP = 0;
  let ties = 0;
  for (let k = adjStart[best]; k < adjStart[best + 1]; k++) {
    const t = adj[k];
    const o = owner[t];
    if (o === me || (greys && o >= 0)) continue;
    const p = o < 0 ? 0 : power[t];
    if (first < 0) {
      first = t;
      firstP = p;
    }
    if (p < m) {
      m = p;
      ties = 1;
    } else if (p === m) ties++;
  }
  if (first < 0) return -1;
  if (firstP === m && m > 0) return best * 1024 + first;
  let r = sim.rng.int(ties);
  for (let k = adjStart[best]; k < adjStart[best + 1]; k++) {
    const t = adj[k];
    const o = owner[t];
    if (o === me || (greys && o >= 0)) continue;
    const p = o < 0 ? 0 : power[t];
    if (p === m && r-- === 0) return best * 1024 + t;
  }
  return -1;
}

/** Dummy: cyclic scan from the remembered index, first usable cell → first non-own neighbour. */
export function dummyAttack(sim: Sim, me: number): number {
  const { n, adjStart, adj } = sim.t;
  const own = sim.t.tmp;
  let cntOwn = 0;
  for (let i = 0; i < n; i++) if (sim.owner[i] === me) own[cntOwn++] = i;
  if (cntOwn === 0 || cntOwn === n) return -1;
  let idx = sim.dummyIdx[me];
  if (idx >= cntOwn) idx = 0;
  for (let k = 0; k < cntOwn; k++) {
    const i = (idx + k) % cntOwn;
    const c = own[i];
    if (sim.power[c] < 2) continue;
    const greys = sim.t.duel && sim.hasNeutralNb(c);
    for (let q = adjStart[c]; q < adjStart[c + 1]; q++) {
      const t = adj[q];
      const o = sim.owner[t];
      if (o === me || (greys && o >= 0)) continue;
      sim.dummyIdx[me] = i;
      return c * 1024 + t;
    }
  }
  sim.dummyIdx[me] = idx;
  return -1;
}

/** Freak: random own cell (border-biased), random target; stops when the pick is too weak. */
export function freakAttack(sim: Sim, me: number): number {
  const { n, adjStart, adj } = sim.t;
  const own = sim.t.tmp;
  let cntOwn = 0;
  for (let i = 0; i < n; i++) if (sim.owner[i] === me) own[cntOwn++] = i;
  if (cntOwn === 0 || cntOwn === n) return -1;
  let c = own[sim.rng.int(cntOwn)];
  let tries = 1;
  while (!sim.isBorder(c) && tries <= cntOwn) {
    c = own[sim.rng.int(cntOwn)];
    tries++;
  }
  if (sim.power[c] < 2) return -1;
  const greys = sim.t.duel && sim.hasNeutralNb(c);
  let k = 0;
  for (let q = adjStart[c]; q < adjStart[c + 1]; q++) {
    const o = sim.owner[adj[q]];
    if (o !== me && !(greys && o >= 0)) k++;
  }
  if (!k) return -1;
  let r = sim.rng.int(k);
  for (let q = adjStart[c]; q < adjStart[c + 1]; q++) {
    const o = sim.owner[adj[q]];
    if (o !== me && !(greys && o >= 0) && r-- === 0) return c * 1024 + adj[q];
  }
  return -1;
}

export function masterReturn(a: number, d: number): number {
  if (d === 0) return a - 1.01;
  const diff = a - d;
  return diff >= 2 ? diff : diff === 1 ? 1.25 : diff === 0 ? 1.5 : diff === -1 ? 1.75 : 1.0;
}

/** Master's expert policy: no pass, forced continuation from the captured cell, best expected return. */
export function masterAttack(sim: Sim, me: number, memo: TurnMemo): number {
  const { n, adjStart, adj } = sim.t;
  const owner = sim.owner;
  const power = sim.power;
  let best = -1;
  let bestV = -Infinity;
  const scan = (s: number) => {
    const greys = sim.t.duel && sim.hasNeutralNb(s);
    const a = power[s];
    for (let k = adjStart[s]; k < adjStart[s + 1]; k++) {
      const t = adj[k];
      const o = owner[t];
      if (o === me || (greys && o >= 0)) continue;
      const v = masterReturn(a, o < 0 ? 0 : power[t]);
      if (v > bestV) {
        bestV = v;
        best = s * 1024 + t;
      }
    }
  };
  const r = memo.lastTo;
  if (r >= 0 && owner[r] === me && power[r] > 1) {
    scan(r);
    if (best >= 0) return best;
  }
  for (let i = 0; i < n; i++) if (owner[i] === me && power[i] > 1) scan(i);
  return best;
}


/** Sage scoring of one attack (GOD's base policy). Higher is better; −Infinity when impossible. */
export function sageScore(sim: Sim, s: number, t: number, P: GodParams): number {
  const T = sim.t;
  const me = sim.owner[s];
  const a = sim.power[s];
  const prev = sim.owner[t];
  const enemy = prev >= 0;
  const d = sim.power[t];
  const p = T.eff(a, d, me);
  const cap = T.cap[t];
  // outcomes (exact arithmetic)
  let atkW = 1;
  let defW = d === 0 ? a - 1 : Math.abs(a - d);
  if (defW <= 0) defW = 1;
  if (defW > cap) {
    atkW += defW - cap;
    defW = cap;
    if (d > 0) atkW -= 1;
  }
  let defL = Math.abs(a - d);
  if (defL <= 0) defL = 1;
  if (defL > cap) defL = cap;
  const cv = P.cellValue;
  const ew = P.enemyWeight;
  const matWin = cv + (atkW - a) + defW + (enemy ? ew * (cv + d) : 0);
  let matLoss = 1 - a + (enemy ? ew * (d - defL) : 0);
  let chainW = 0;
  if (enemy && P.chain > 0 && d > 2) {
    // a big enemy stack chains through weak cells next turn: shrinking it removes that threat
    chainW = P.chain * cv * (d - 2);
    matLoss += P.chain * cv * (d - 2 - Math.max(0, defL - 2));
  }
  const matWinC = matWin + chainW;
  // exposure: risk of losing s / t next turn
  const ex = P.exposure;
  let score: number;
  if (ex > 0) {
    const yS = sim.threatOn(s);
    const before = risk(T, a, yS, cv);
    // after a win, t is no longer an enemy of s
    const yS2 = enemy ? sim.threatOn(s, t) : yS;
    const winRisk = risk(T, atkW, yS2, cv) + risk(T, defW, threatAfterCapture(sim, t, me), cv);
    const lossRisk = risk(T, 1, yS, cv);
    // relief: my other cells next to t are no longer threatened by t (win) or less (loss: t drops to defL)
    let reliefW = 0;
    let reliefL = 0;
    if (enemy && d >= 3) {
      const { adjStart, adj } = T;
      for (let k = adjStart[t]; k < adjStart[t + 1]; k++) {
        const m = adj[k];
        if (m === s || sim.owner[m] !== me) continue;
        const x = sim.power[m];
        const y0 = sim.threatOn(m);
        if (y0 > d) continue;
        const y1 = sim.threatOn(m, t);
        const r0 = risk(T, x, y0, cv);
        reliefW += r0 - risk(T, x, y1, cv);
        reliefL += r0 - risk(T, x, Math.max(y1, defL), cv);
      }
    }
    score = p * (matWinC - ex * (winRisk - before) + ex * reliefW) + (1 - p) * (matLoss - ex * (lossRisk - before) + ex * reliefL);
  } else {
    score = p * matWinC + (1 - p) * matLoss;
  }
  return score;
}

function threatAfterCapture(sim: Sim, t: number, me: number): number {
  const { adjStart, adj } = sim.t;
  let best = 0;
  for (let k = adjStart[t]; k < adjStart[t + 1]; k++) {
    const e = adj[k];
    const oe = sim.owner[e];
    if (oe < 0 || oe === me) continue;
    const y = sim.power[e];
    if (y > best) best = y;
  }
  return best;
}

/** expected loss of a cell with power x facing an enemy stack y */
function risk(_T: Topo, x: number, y: number, cv: number): number {
  if (y < 2) return 0;
  const p = winChance(y, x);
  if (p <= 0) return 0;
  // a lost even fight still costs the stack; a captured cell costs the cell and its power
  return p * (cv + x) + (1 - p) * Math.max(0, x - Math.max(1, Math.abs(y - x)));
}

/** GOD base policy: best-scoring legal attack if its score beats the threshold, else −1 (stop). */
export function sageAttack(sim: Sim, me: number, P: GodParams): number {
  const { n, adjStart, adj } = sim.t;
  const owner = sim.owner;
  const power = sim.power;
  let best = -1;
  let bestV = P.attackThreshold;
  for (let s = 0; s < n; s++) {
    if (owner[s] !== me || power[s] < 2) continue;
    const greys = sim.t.duel && sim.hasNeutralNb(s);
    for (let k = adjStart[s]; k < adjStart[s + 1]; k++) {
      const t = adj[k];
      const o = owner[t];
      if (o === me || (greys && o >= 0)) continue;
      const v = sageScore(sim, s, t, P);
      if (v > bestV) {
        bestV = v;
        best = s * 1024 + t;
      }
    }
  }
  return best;
}

// ------------------------------------------------------------------ policies: power

/** round-robin +1 over the cells in `list[0..len)` */
function roundRobin(sim: Sim, list: Int32Array, len: number, left: number): number {
  const cap = sim.t.cap;
  while (left > 0) {
    let any = false;
    for (let i = 0; i < len && left > 0; i++) {
      const c = list[i];
      if (sim.power[c] < cap[c]) {
        sim.power[c]++;
        left--;
        any = true;
      }
    }
    if (!any) break;
  }
  return left;
}

export function smartyPlace(sim: Sim, me: number, left: number): number {
  const { n } = sim.t;
  const list = sim.t.tmp;
  let k = 0;
  for (let i = 0; i < n; i++) if (sim.owner[i] === me && sim.isBorder(i)) list[k++] = i;
  left = roundRobin(sim, list, k, left);
  if (left > 0) {
    k = 0;
    for (let i = 0; i < n; i++) if (sim.owner[i] === me) list[k++] = i;
    left = roundRobin(sim, list, k, left);
  }
  return left;
}

export function dummyPlace(sim: Sim, me: number, left: number): number {
  const list = sim.t.tmp;
  let k = 0;
  for (let i = 0; i < sim.t.n; i++) if (sim.owner[i] === me) list[k++] = i;
  return roundRobin(sim, list, k, left);
}

export function randomPlace(sim: Sim, me: number, left: number): number {
  const list = sim.t.tmp;
  const cap = sim.t.cap;
  let guard = 0;
  while (left > 0 && guard++ < 10000) {
    let k = 0;
    for (let i = 0; i < sim.t.n; i++) if (sim.owner[i] === me && sim.power[i] < cap[i]) list[k++] = i;
    if (!k) break;
    const c = list[sim.rng.int(k)];
    sim.power[c]++;
    left--;
  }
  return left;
}

/**
 * Reach search ("how far can enemy stacks get", Master §7.5) for one attacker X against `me`:
 * writes into T.need[c] = max(T.need[c], min(u−1, cap) − units) for my cells reachable by a stack u,
 * walking through grey cells (−1) and third-party cells (−units). Returns the sum of new needs.
 */
export function reachNeeds(sim: Sim, X: number, me: number, margin: number): void {
  const T = sim.t;
  const { n, adjStart, adj, cap, stamp, queue, qval } = T;
  const owner = sim.owner;
  const power = sim.power;
  const g = T.nextStamp();
  // simple max-priority processing: bucket queue by units (max 12)
  const buckets: number[][] = [];
  for (let u = 0; u <= 12; u++) buckets.push([]);
  for (let i = 0; i < n; i++) {
    if (owner[i] === X) {
      stamp[i] = g;
      if (power[i] > 1) buckets[power[i]].push(i);
    }
  }
  void queue;
  void qval;
  for (let u = 12; u >= 2; u--) {
    const b = buckets[u];
    for (let q = 0; q < b.length; q++) {
      const node = b[q];
      for (let k = adjStart[node]; k < adjStart[node + 1]; k++) {
        const nb = adj[k];
        if (stamp[nb] === g) continue;
        const o = owner[nb];
        if (o === X) continue;
        stamp[nb] = g;
        if (o === me) {
          const v = Math.min(u - 1 + margin, cap[nb]) - power[nb];
          if (v > T.need[nb]) T.need[nb] = v;
        } else {
          const rem = u - (o < 0 ? 1 : power[nb]);
          if (rem > 1) buckets[rem].push(nb);
        }
      }
    }
  }
}

/** Master's power model: threat minimums against all others (water-level cut), then SmartyPower. */
export function masterPlace(sim: Sim, me: number, left: number): number {
  left = threatMinimums(sim, me, left, 0);
  // Master's search mostly fills one attack cell to capacity after the other
  left = stackPlace(sim, me, left, left);
  return smartyPlace(sim, me, left);
}

/**
 * Threat minimums (Master §7.5, per opponent): every own cell an enemy stack u can reach is raised to
 * min(u − 1 + margin, cap); when the income is short, a uniform "water level" cut. Returns points left.
 */
export function threatMinimums(sim: Sim, me: number, left: number, margin: number): number {
  const T = sim.t;
  const n = T.n;
  T.need.fill(0);
  for (let x = 0; x < T.slots; x++) if (x !== me && sim.cnt[x] > 0) reachNeeds(sim, x, me, margin);
  let total = 0;
  for (let i = 0; i < n; i++) if (T.need[i] > 0) total += T.need[i];
  if (total > 0) {
    const excess = total - left;
    if (excess > 0) {
      let level = 0;
      let removed = 0;
      for (;;) {
        let count = 0;
        for (let i = 0; i < n; i++) if (T.need[i] > level) count++;
        if (count === 0 || removed + count > excess) break;
        removed += count;
        level++;
      }
      let rRem = excess - removed;
      let cellsRem = 0;
      for (let i = 0; i < n; i++) if (T.need[i] > level) cellsRem++;
      for (let i = 0; i < n; i++) {
        let v = T.need[i] - level;
        if (v > 0) {
          if (sim.rng.int(cellsRem) < rRem) {
            v--;
            rRem--;
          }
          cellsRem--;
        }
        T.need[i] = v > 0 ? v : 0;
      }
    }
    for (let i = 0; i < n && left > 0; i++) {
      const v = Math.min(T.need[i], left, T.cap[i] - sim.power[i]);
      if (v > 0) {
        sim.power[i] += v;
        left -= v;
      }
    }
  }
  return left;
}

/** weights of the attack-stack key (which border cell gets filled) */
export interface StackWeights {
  pow: number;
  grey: number;
  greyN: number;
  weak: number;
  cap12: number;
  enemyN: number;
  enemyPow: number;
  /** weak (≤ 2) or grey cells within two steps: room for a chain */
  chain: number;
}

/** the original key (also the model of Master's fills) */
export const BASE_STACK: StackWeights = { pow: 1, grey: 1.5, greyN: 0, weak: 0.5, cap12: 0.2, enemyN: 0, enemyPow: 0, chain: 0 };

/** GOD's own key (tuned vs Master, see scripts/god-tune.py) */
export const GOD_STACK: StackWeights = { ...BASE_STACK, chain: 0.5 };

/** attack-stack key of a border cell (−1 for cells without a non-own neighbour) */
function stackKey(sim: Sim, me: number, c: number, w: StackWeights): number {
  const { adjStart, adj, cap } = sim.t;
  const owner = sim.owner;
  const power = sim.power;
  let weak = 99;
  let greys = 0;
  let enemies = 0;
  let enemyPow = 0;
  let any = false;
  for (let e = adjStart[c]; e < adjStart[c + 1]; e++) {
    const o = owner[adj[e]];
    if (o === me) continue;
    any = true;
    if (o < 0) greys++;
    else {
      enemies++;
      enemyPow += power[adj[e]];
      if (power[adj[e]] < weak) weak = power[adj[e]];
    }
  }
  if (!any) return -1;
  if (sim.t.duel && greys > 0) weak = 99;
  let k = w.pow * power[c] + (greys ? w.grey : 0) + w.greyN * greys + (weak < 99 ? Math.max(0, 4 - weak) * w.weak : 0);
  k += cap[c] > 8 ? w.cap12 : 0;
  k += w.enemyN * enemies + w.enemyPow * enemyPow * 0.1;
  if (w.chain) {
    const T = sim.t;
    const g = T.nextStamp();
    T.stamp[c] = g;
    let room = 0;
    for (let e = adjStart[c]; e < adjStart[c + 1]; e++) {
      const a = adj[e];
      if (T.stamp[a] === g) continue;
      T.stamp[a] = g;
      if (owner[a] === me || (owner[a] >= 0 && power[a] > 2)) continue;
      room++;
      for (let f = adjStart[a]; f < adjStart[a + 1]; f++) {
        const b = adj[f];
        if (T.stamp[b] === g) continue;
        T.stamp[b] = g;
        if (owner[b] !== me && (owner[b] < 0 || power[b] <= 2)) room++;
      }
    }
    k += w.chain * room;
  }
  return k;
}

/** Border cells with room, best attack-stack key first (candidate generation). */
export function stackOrder(sim: Sim, me: number, w: StackWeights = BASE_STACK): number[] {
  const { n, cap } = sim.t;
  const list: number[] = [];
  const key = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (sim.owner[i] !== me || sim.power[i] >= cap[i]) continue;
    const k = stackKey(sim, me, i, w);
    if (k < 0) continue;
    key[i] = k;
    list.push(i);
  }
  return list.sort((x, y) => key[y] - key[x] || x - y);
}

/** Fill attack stacks (best key first) to capacity with up to `budget` points. Returns points left. */
export function stackPlace(sim: Sim, me: number, left: number, budget: number, skip = 0, w: StackWeights = BASE_STACK): number {
  const { n, cap } = sim.t;
  const list: number[] = [];
  const key = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (sim.owner[i] !== me || sim.power[i] >= cap[i]) continue;
    const k = stackKey(sim, me, i, w);
    if (k < 0) continue;
    key[i] = k;
    list.push(i);
  }
  list.sort((x, y) => key[y] - key[x] || x - y);
  for (let q = skip; q < list.length && budget > 0 && left > 0; q++) {
    const c = list[q];
    const v = Math.min(budget, left, cap[c] - sim.power[c]);
    sim.power[c] += v;
    budget -= v;
    left -= v;
  }
  return left;
}

/** Options of GOD's heuristic placement (candidate generator and base policy). */
export interface PlaceStyle {
  /** defend reachable cells up to threat − 1 + margin (−9 = no defence) */
  margin: number;
  /** remainder: 0 = concentrate on attack stacks, 1 = spread over the border, 2 = mixed */
  rest: number;
  /** extra defence weight for big stacks / connectivity */
  guardStacks: boolean;
  /** skip this many best attack stacks (candidate diversity) */
  skip?: number;
}

export const SAGE_STYLE: PlaceStyle = { margin: 0, rest: 2, guardStacks: true };

/**
 * GOD's heuristic placement: threat minimums against each opponent separately (most valuable cells first
 * when the income cannot cover all), then attack stacks next to weak targets, then the border.
 */
export function sagePlace(sim: Sim, me: number, left: number, st: PlaceStyle): number {
  const T = sim.t;
  const n = T.n;
  const { adjStart, adj, cap } = T;
  const owner = sim.owner;
  const power = sim.power;
  if (left <= 0) return 0;
  if (st.margin > -5) {
    T.need.fill(0);
    for (let x = 0; x < T.slots; x++) if (x !== me && sim.cnt[x] > 0) reachNeeds(sim, x, me, st.margin);
    // cover needs: cheapest-first by value at risk per point
    const list = T.tmp;
    let k = 0;
    for (let i = 0; i < n; i++) if (T.need[i] > 0) list[k++] = i;
    if (k) {
      const score = new Float64Array(k);
      for (let q = 0; q < k; q++) {
        const c = list[q];
        let v = 3 + power[c];
        if (st.guardStacks) {
          // own neighbours that would be exposed when c falls
          for (let e = adjStart[c]; e < adjStart[c + 1]; e++) if (owner[adj[e]] === me) v += 0.5 + power[adj[e]] * 0.15;
        }
        score[q] = v / Math.max(1, T.need[c]);
      }
      const order = Array.from({ length: k }, (_, q) => q).sort((x, y) => score[y] - score[x] || list[x] - list[y]);
      for (const q of order) {
        if (left <= 0) break;
        const c = list[q];
        const v = Math.min(T.need[c], left, cap[c] - power[c]);
        if (v > 0) {
          power[c] += v;
          left -= v;
        }
      }
    }
  }
  if (left <= 0) return 0;
  if (st.rest === 0 || st.rest === 2) left = stackPlace(sim, me, left, st.rest === 0 ? left : Math.ceil(left / 2), st.skip ?? 0);
  if (left > 0) left = smartyPlace(sim, me, left);
  return left;
}

// ------------------------------------------------------------------ turn driver

const memo: TurnMemo = { lastTo: -1 };

/** Play the attack phase of `slot` with its model. Returns the number of attacks made. */
export function playAttacks(sim: Sim, slot: number, P: GodParams, kind = sim.t.kind[slot], maxAttacks = 400): number {
  memo.lastTo = -1;
  let k = 0;
  while (k < maxAttacks && sim.cnt[slot] > 0) {
    let mv: number;
    switch (kind) {
      case PK_HUNTER:
        mv = hunterAttack(sim, slot);
        break;
      case PK_DUMMY:
        mv = dummyAttack(sim, slot);
        break;
      case PK_FREAK:
        mv = freakAttack(sim, slot);
        break;
      case PK_MASTER:
        mv = masterAttack(sim, slot, memo);
        break;
      default:
        mv = sageAttack(sim, slot, P);
    }
    if (mv < 0) break;
    const s = mv >> 10;
    const t = mv & 1023;
    sim.fight(s, t);
    memo.lastTo = t;
    k++;
    if (sim.aliveCount() <= 1) break;
  }
  return k;
}

export function playPower(sim: Sim, slot: number, kind = sim.t.kind[slot], style = SAGE_STYLE): void {
  if (sim.cnt[slot] <= 0) return;
  const left = sim.income(slot);
  switch (kind) {
    case PK_HUNTER:
      smartyPlace(sim, slot, left);
      break;
    case PK_DUMMY:
      dummyPlace(sim, slot, left);
      break;
    case PK_FREAK:
      randomPlace(sim, slot, left);
      break;
    case PK_MASTER:
      masterPlace(sim, slot, left);
      break;
    default:
      sagePlace(sim, slot, left, style);
  }
}

export function playTurn(sim: Sim, slot: number, P: GodParams): void {
  if (sim.cnt[slot] <= 0) return;
  playAttacks(sim, slot, P);
  playPower(sim, slot);
}

// ------------------------------------------------------------------ evaluation


/**
 * Phase-end evaluation (end of an attack phase of `me`, before its power phase), a generalisation of
 * Master's (2·cells / enemy units): (pCell·cells + pPow·border power + pInt·interior power − exposure)
 * / (qCell·enemy cells + qPow·enemy power), mapped to [0, 1] by x / (1 + x).
 */
/** `penalty`: subtracted from the own side of the ratio (own-cell units × pCell, e.g. chain exposure) */
export function evalPhase(sim: Sim, me: number, P: GodParams, hidden = 0, penalty = 0): number {
  const T = sim.t;
  const { n, adjStart, adj } = T;
  const owner = sim.owner;
  const power = sim.power;
  let num = 0;
  let den = 0;
  let exposed = 0;
  for (let i = 0; i < n; i++) {
    const o = owner[i];
    if (o < 0) continue;
    if (o === me) {
      num += P.pCell;
      if (P.pPow || P.pInt || P.pExposed) {
        let border = false;
        let threat = 0;
        for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
          const e = adj[k];
          const oe = owner[e];
          if (oe !== me) {
            border = true;
            if (oe >= 0 && power[e] > threat) threat = power[e];
          }
        }
        num += border ? P.pPow * power[i] : P.pInt * power[i];
        if (threat >= power[i] + 2) exposed++;
      }
    } else {
      let w = P.qPow;
      if (P.qInt !== P.qPow) {
        let border = false;
        for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
          if (owner[adj[k]] !== o) {
            border = true;
            break;
          }
        }
        if (!border) w = P.qInt;
      }
      den += P.qCell + w * power[i];
    }
  }
  if (T.duel && P.pCell) {
    const g = sim.biggestGroup(me);
    num -= P.pCell * (1 - P.evalDuelStray) * (sim.cnt[me] - g);
  }
  num -= P.pExposed * P.pCell * exposed;
  num -= penalty;
  den += P.qPow * hidden;
  if (sim.cnt[me] === 0) return 0;
  if (den <= 0) return 1;
  const x = Math.max(0, num) / den;
  if (P.clampMap) {
    const v = (x - 0.3) / 2.7;
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }
  return x / (1 + x);
}

/**
 * Exposure of `me` to sure enemy chains (round 7): the most own cells one enemy turn can take by sure
 * captures (attacker ≥ defender + 2) chained from a single stack, the stack first raised by the enemy's
 * income (`boost`, up to capacity). Greys on the way cost one unit, own cells their power; the chain
 * moves on with what is left. Every enemy cell is tried as the boosted start (the others count with their
 * current power). Duel boards only need one enemy, but every opponent is checked (maximum).
 */
export function chainExposure(sim: Sim, me: number, boost: (slot: number) => number): number {
  const T = sim.t;
  const { n, adjStart, adj, cap, stamp } = T;
  const owner = sim.owner;
  const power = sim.power;
  let worst = 0;
  for (let x = 0; x < T.slots; x++) {
    if (x === me || sim.cnt[x] <= 0) continue;
    const b = boost(x);
    for (let s = 0; s < n; s++) {
      if (owner[s] !== x) continue;
      // only cells touching a non-own cell can start a chain
      let border = false;
      for (let k = adjStart[s]; k < adjStart[s + 1]; k++) if (owner[adj[k]] !== x) border = true;
      if (!border) continue;
      const u0 = Math.min(cap[s], power[s] + b);
      if (u0 < 3) continue;
      const g = T.nextStamp();
      stamp[s] = g;
      let lost = 0;
      // greedy best-first walk: at each step capture the neighbour that keeps the biggest stack
      let cur = s;
      let u = u0;
      for (let step = 0; step < n; step++) {
        let best = -1;
        let bestRem = 0;
        let bestOwn = false;
        for (let k = adjStart[cur]; k < adjStart[cur + 1]; k++) {
          const y = adj[k];
          if (stamp[y] === g || owner[y] === x) continue;
          const d = owner[y] < 0 ? 0 : power[y];
          if (owner[y] >= 0 && owner[y] !== me) continue;
          if (d > 0 && u - d < 2) continue;
          const rem = d === 0 ? u - 1 : u - d;
          const isOwn = owner[y] === me;
          // prefer taking own cells (the loss we measure), then the bigger remaining stack
          if (rem >= 1 && (best < 0 || (isOwn && !bestOwn) || (isOwn === bestOwn && rem > bestRem))) {
            best = y;
            bestRem = Math.min(rem, cap[y]);
            bestOwn = isOwn;
          }
        }
        if (best < 0) break;
        stamp[best] = g;
        if (bestOwn) lost++;
        cur = best;
        u = bestRem;
        if (u < 2) break;
      }
      if (lost > worst) worst = lost;
    }
  }
  return worst;
}

// ------------------------------------------------------------------ learned evaluation

/** number of features of phaseFeatures (index 0 is the bias) */
export const NF = 20;

/**
 * Features of a position at the end of `me`'s attack phase (before its power phase), `me` against all
 * opponents together. Used by the learned evaluation (weights fitted on self-play outcomes, see
 * scripts/god-learn.ts and docs/GOD.md).
 */
export function phaseFeatures(sim: Sim, me: number, f: Float64Array): void {
  const T = sim.t;
  const { n, adjStart, adj, cap } = T;
  const owner = sim.owner;
  const power = sim.power;
  let cm = 0, co = 0, um = 0, uo = 0, bm = 0, bo = 0, exposed = 0, chainO = 0, chainM = 0;
  let neutral = 0, nfm = 0, nfo = 0, room = 0, oppExposed = 0;
  const g = T.nextStamp();
  const stamp = T.stamp;
  for (let i = 0; i < n; i++) {
    const o = owner[i];
    if (o < 0) {
      neutral++;
      let tm = false;
      let to = false;
      for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
        const q = owner[adj[k]];
        if (q === me) tm = true;
        else if (q >= 0) to = true;
      }
      if (tm) nfm++;
      if (to) nfo++;
      continue;
    }
    const x = power[i];
    let border = false;
    let threat = 0;
    for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
      const e = adj[k];
      const oe = owner[e];
      if (oe === o) continue;
      border = true;
      if (oe >= 0 && oe !== me && o === me && power[e] > threat) threat = power[e];
      if (o !== me && oe === me && power[e] > threat) threat = power[e];
    }
    if (o === me) {
      cm++;
      um += x;
      room += cap[i] - x;
      if (border) {
        bm += x;
        if (x > 2) chainM += x - 2;
      }
      if (threat >= x + 2) exposed++;
    } else {
      co++;
      uo += x;
      if (border) {
        bo += x;
        // enemy stacks touching my cells: chain potential against me
        let touches = false;
        for (let k = adjStart[i]; k < adjStart[i + 1]; k++) if (owner[adj[k]] === me) touches = true;
        if (touches && x > 2 && stamp[i] !== g) {
          stamp[i] = g;
          chainO += x - 2;
        }
      }
      if (threat >= x + 2) oppExposed++;
    }
  }
  let alive = 0;
  let strongest = 0;
  for (let p = 0; p < T.slots; p++) {
    if (p === me || sim.cnt[p] <= 0) continue;
    alive++;
    if (sim.cnt[p] > strongest) strongest = sim.cnt[p];
  }
  let gm = cm;
  let go = co;
  if (T.duel) {
    gm = sim.biggestGroup(me);
    go = 0;
    for (let p = 0; p < T.slots; p++) if (p !== me && sim.cnt[p] > 0) go += sim.biggestGroup(p);
  }
  const u = n * 8;
  f[0] = 1;
  f[1] = Math.log((cm + 1) / (co + 1));
  f[2] = Math.log((um + 1) / (uo + 1));
  f[3] = cm / n;
  f[4] = co / n;
  f[5] = um / u;
  f[6] = uo / u;
  f[7] = bm / u;
  f[8] = bo / u;
  f[9] = exposed / n;
  f[10] = chainO / n;
  f[11] = chainM / n;
  f[12] = neutral / n;
  f[13] = nfm / n;
  f[14] = nfo / n;
  f[15] = room / u;
  f[16] = alive / 5;
  f[17] = strongest / n;
  f[18] = Math.log((gm + 1) / (go + 1));
  f[19] = oppExposed / n;
}
