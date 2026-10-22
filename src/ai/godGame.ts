/**
 * GOD whole-turn search: UCT with chance edges over GOD's turn, the opponents' replies and GOD's next
 * attack phase, on the luck-exact simulator.
 *
 *  - GOD's attack moves: every legal attack (optional forced continuation from the cell just captured)
 *    and optionally STOP. GOD's power moves: threat minimums are applied first (forced), then a canonical
 *    sequence of "fill cell j" / "+3 on cell j" choices over the best attack-stack cells (strictly
 *    increasing j, so permutations are not searched twice) and "spread the rest".
 *  - Opponents: in a duel their attacks are minimising tree nodes (adversarial reply); with more players
 *    each plays its own type's model (Hunter, Master, ...), so who-fights-whom is simulated, not assumed.
 *    Their power phases use their type's placement model.
 *  - Horizon: the end of GOD's next attack phase (attack root) or the end of GOD's attack phase after the
 *    replies (power root). Leaves are valued with evalPhase.
 */
import {
  FastRng,
  Sim,
  evalPhase,
  masterAttack,
  playAttacks,
  playPower,
  smartyPlace,
  stackOrder,
  threatMinimums,
  type GodParams,
  type StackWeights,
  type Topo,
} from './godSim';

const MAX_NODES = 200_000;
const ATTACK = 0;
const POWER = 1;
/** move codes in the power phase: cell*16 + kind; kind 0 = fill, 1 = +3; END = −2; STOP = −1 */
const END = -2;
const STOP = -1;

interface Edge {
  n: number;
  wins: number;
  win: GNode | null;
  loss: GNode | null;
}

interface GNode {
  count: number;
  value: number;
  moves: Int32Array | null;
  edges: (Edge | undefined)[] | null;
}

export interface GameOptions {
  /** GOD may end its attack phase voluntarily */
  stop: boolean;
  /** forced continuation from a freshly captured cell (GOD's own attacks) */
  forced: boolean;
  c: number;
  /** canonical power cells considered */
  powerCells: number;
  /** adversarial opponents (minimising nodes); otherwise opponents follow their models */
  adversarial: boolean;
  /** attack-stack weights ordering GOD's canonical placement cells */
  stack: StackWeights;
}

/** Search state on top of a Sim. */
export class GState {
  sim: Sim;
  phase = ATTACK;
  cur = 0;
  reinf = 0;
  lastTo = -1;
  /** power phase: canonical candidate cells and the cursor into them */
  order: number[] = [];
  cursor = 0;
  /** number of GOD's power phases started since the root */
  myPowers = 0;
  done = false;

  constructor(sim: Sim) {
    this.sim = sim;
  }

  copyFrom(o: GState) {
    this.sim.copyFrom(o.sim);
    this.phase = o.phase;
    this.cur = o.cur;
    this.reinf = o.reinf;
    this.lastTo = o.lastTo;
    this.order = o.order;
    this.cursor = o.cursor;
    this.myPowers = o.myPowers;
    this.done = o.done;
  }
}

export class GameTree {
  private table = new Map<number, GNode>();
  private z1: Uint32Array;
  private z2: Uint32Array;
  private scratch: GState;
  /** GOD's power phases after which the search stops (attack root: 2, power root: 1) */
  horizon = 2;
  /** enemy power hidden by the fog (added to the evaluation) */
  hidden = 0;
  static readonly END = END;
  private memo = { lastTo: -1 };

  constructor(
    readonly t: Topo,
    readonly me: number,
    readonly P: GodParams,
    readonly opts: GameOptions,
    seed: number,
  ) {
    const r = new FastRng(seed ^ 0x7f4a7c15);
    const size = t.n * 32 + 64;
    this.z1 = new Uint32Array(size);
    this.z2 = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      this.z1[i] = r.u32();
      this.z2[i] = r.u32();
    }
    this.scratch = new GState(new Sim(t, new FastRng(1)));
  }

  get size(): number {
    return this.table.size;
  }

  hash(g: GState): number {
    const { n } = this.t;
    let h1 = 0;
    let h2 = 0;
    const owner = g.sim.owner;
    const power = g.sim.power;
    for (let i = 0; i < n; i++) {
      const o = owner[i];
      if (o < 0) {
        // armed grey cells (puzzles) lose power when attacked
        if (power[i] > 0) h2 = (h2 + Math.imul(power[i] * 977 + i, 0x85ebca6b)) | 0;
        continue;
      }
      const code = i * 32 + (o === this.me ? 0 : 16) + power[i];
      h1 ^= this.z1[code];
      h2 ^= this.z2[code];
      if (o !== this.me && o > 0) {
        // different opponents on the same cell must not collide
        h1 = (h1 + Math.imul(o * 131 + i, 0x9e3779b1)) | 0;
      }
    }
    const extra = (((g.phase * 7 + g.cur) * 1031 + g.reinf) * 1031 + g.lastTo + 2) * 64 + g.cursor * 4 + g.myPowers;
    h1 = (h1 ^ Math.imul(extra | 0, 0x27d4eb2d)) >>> 0;
    h2 = (h2 ^ Math.imul((extra + 0x165667b1) | 0, 0x9e3779b1)) >>> 0;
    return h1 * 2097152 + (h2 >>> 11);
  }

  private node(key: number): GNode {
    let nd = this.table.get(key);
    if (!nd) {
      nd = { count: 0, value: 0, moves: null, edges: null };
      this.table.set(key, nd);
    }
    return nd;
  }

  /** Is the player to move a branching (tree) player? */
  private branching(g: GState): boolean {
    if (g.cur === this.me) return true;
    return this.opts.adversarial && g.phase === ATTACK;
  }

  attackMoves(g: GState, slot: number, out: number[]): void {
    const sim = g.sim;
    const { n, adjStart, adj } = this.t;
    const owner = sim.owner;
    const power = sim.power;
    const from = (s: number) => {
      const greys = this.t.duel && sim.hasNeutralNb(s);
      for (let k = adjStart[s]; k < adjStart[s + 1]; k++) {
        const t = adj[k];
        const o = owner[t];
        if (o === slot || (greys && o >= 0)) continue;
        out.push(s * 1024 + t);
      }
    };
    const forced = slot === this.me ? this.opts.forced : true;
    if (forced && g.lastTo >= 0 && owner[g.lastTo] === slot && power[g.lastTo] > 1) {
      from(g.lastTo);
      if (out.length) return;
    }
    for (let s = 0; s < n; s++) if (owner[s] === slot && power[s] > 1) from(s);
  }

  moves(g: GState): Int32Array {
    const out: number[] = [];
    if (g.phase === ATTACK) {
      this.attackMoves(g, g.cur, out);
      if (out.length && g.cur === this.me && this.opts.stop) out.push(STOP);
      return Int32Array.from(out);
    }
    // my power phase
    if (g.reinf <= 0) return Int32Array.from(out);
    const cap = this.t.cap;
    const power = g.sim.power;
    for (let j = g.cursor; j < g.order.length; j++) {
      const c = g.order[j];
      const room = cap[c] - power[c];
      if (room <= 0) continue;
      out.push(c * 16);
      if (room > 3 && g.reinf > 3) out.push(c * 16 + 1);
    }
    out.push(END);
    return Int32Array.from(out);
  }

  /** start of a power phase for g.cur */
  private beginPower(g: GState) {
    const sim = g.sim;
    g.phase = POWER;
    g.lastTo = -1;
    if (g.cur === this.me) {
      g.myPowers++;
      if (g.myPowers >= this.horizon) {
        g.done = true;
        return;
      }
      let left = sim.income(this.me);
      left = threatMinimums(sim, this.me, left, 0);
      g.reinf = left;
      g.order = stackOrder(sim, this.me, this.opts.stack).slice(0, this.opts.powerCells);
      g.cursor = 0;
      if (left <= 0) this.endTurn(g);
    } else {
      playPower(sim, g.cur);
      this.endTurn(g);
    }
  }

  private endTurn(g: GState) {
    const sim = g.sim;
    if (g.cur === this.me && g.reinf > 0) {
      smartyPlace(sim, this.me, g.reinf);
    }
    g.reinf = 0;
    g.phase = ATTACK;
    g.lastTo = -1;
    g.order = [];
    g.cursor = 0;
    const slots = this.t.slots;
    for (let k = 1; k <= slots; k++) {
      const q = (g.cur + k) % slots;
      if (sim.cnt[q] > 0) {
        g.cur = q;
        break;
      }
    }
    this.advanceModels(g);
  }

  /** play non-branching players with their models until a branching decision (or the horizon) */
  advanceModels(g: GState) {
    let guard = 0;
    while (!g.done && guard++ < 64) {
      if (g.sim.cnt[this.me] === 0 || g.sim.aliveCount() <= 1) {
        g.done = true;
        return;
      }
      if (g.sim.cnt[g.cur] === 0) {
        this.endTurn(g);
        return;
      }
      if (this.branching(g)) {
        // a branching player with no attack left moves on to its power phase
        if (g.phase === ATTACK) {
          const tmp: number[] = [];
          this.attackMoves(g, g.cur, tmp);
          if (tmp.length) return;
          this.beginPower(g);
          continue;
        }
        return;
      }
      // model player: whole attack phase, then power
      playAttacks(g.sim, g.cur, this.P);
      this.beginPower(g);
      return;
    }
  }

  /** apply a move; returns the fight outcome (true for non-fights) */
  doMove(g: GState, mv: number): boolean {
    if (g.phase === ATTACK) {
      if (mv === STOP) {
        this.beginPower(g);
        return true;
      }
      const s = mv >> 10;
      const t = mv & 1023;
      const won = g.sim.fight(s, t);
      g.lastTo = t;
      if (g.sim.cnt[this.me] === 0 || g.sim.aliveCount() <= 1) {
        g.done = true;
        return won;
      }
      const tmp: number[] = [];
      this.attackMoves(g, g.cur, tmp);
      if (!tmp.length) this.beginPower(g);
      return won;
    }
    if (mv === END) {
      this.endTurn(g);
      return true;
    }
    this.applyPlacement(g, mv);
    if (g.reinf <= 0) this.endTurn(g);
    return true;
  }

  /** apply a placement move (fill / +3 on a canonical cell) without ending the phase */
  applyPlacement(g: GState, mv: number): void {
    const c = mv >> 4;
    const kind = mv & 15;
    const room = this.t.cap[c] - g.sim.power[c];
    const amt = Math.min(g.reinf, kind === 0 ? room : 3, room);
    g.sim.power[c] += amt;
    g.reinf -= amt;
    g.cursor = g.order.indexOf(c) + 1;
  }

  /** rollout policy for branching players */
  private rolloutMove(g: GState): number {
    if (g.phase === ATTACK) {
      this.memo.lastTo = g.lastTo;
      const mv = masterAttack(g.sim, g.cur, this.memo);
      return mv < 0 ? STOP : mv;
    }
    // my power: fill the best stack cell left, else spread
    const cap = this.t.cap;
    for (let j = g.cursor; j < g.order.length; j++) {
      const c = g.order[j];
      if (cap[c] > g.sim.power[c]) return c * 16;
    }
    return END;
  }

  private edgeVal(nd: GNode, i: number, c: number, maximize: boolean): number {
    const e = nd.edges![i];
    if (!e || e.n === 0) return c >= 0 ? Infinity : -Infinity;
    const lg = Math.log(Math.max(1, nd.count));
    const u = (ch: GNode) => {
      if (ch.count === 0) return c >= 0 ? Infinity : -Infinity;
      const mean = ch.value / ch.count;
      return (maximize ? mean : 1 - mean) + c * Math.sqrt(lg / ch.count);
    };
    if (e.win && e.loss) {
      const pw = e.wins / e.n;
      return pw * u(e.win) + (1 - pw) * u(e.loss);
    }
    const ch = e.win ?? e.loss;
    if (!ch) return c >= 0 ? Infinity : -Infinity;
    let v = u(ch);
    if (c >= 0 && e.n < 3 && e.wins > 0 && e.wins < e.n) v += c;
    return v;
  }

  iterate(root: GState, rng: FastRng): void {
    const g = this.scratch;
    g.copyFrom(root);
    g.sim.rng = rng;
    let nd = this.node(this.hash(g));
    const path: GNode[] = [nd];
    let guard = 0;
    while (!g.done && guard++ < 3000) {
      if (!nd.moves) {
        nd.moves = this.moves(g);
        nd.edges = new Array(nd.moves.length);
      }
      const moves = nd.moves;
      if (moves.length === 0) break;
      if (nd.count === 0 || this.table.size > MAX_NODES) {
        this.rollout(g);
        break;
      }
      const maximize = g.cur === this.me;
      let bi = 0;
      let bv = -Infinity;
      for (let i = 0; i < moves.length; i++) {
        const v = this.edgeVal(nd, i, this.opts.c, maximize);
        if (v > bv) {
          bv = v;
          bi = i;
        }
      }
      let e = nd.edges![bi];
      if (!e) {
        e = { n: 0, wins: 0, win: null, loss: null };
        nd.edges![bi] = e;
      }
      const won = this.doMove(g, moves[bi]);
      e.n++;
      if (won) e.wins++;
      if (!g.done) this.advanceModels(g);
      const child = this.node(this.hash(g));
      if (won) e.win = child;
      else e.loss = child;
      path.push(child);
      nd = child;
    }
    const value = this.leaf(g);
    for (const p of path) {
      p.count++;
      p.value += value;
    }
  }

  private rollout(g: GState) {
    let k = 0;
    while (!g.done && k++ < 3000) {
      if (!this.branching(g)) {
        this.advanceModels(g);
        continue;
      }
      const mv = this.rolloutMove(g);
      this.doMove(g, mv);
      if (!g.done) this.advanceModels(g);
    }
  }

  private leaf(g: GState): number {
    return evalPhase(g.sim, this.me, this.P, this.hidden);
  }

  /** final choice at the root (lower confidence bound) */
  best(root: GState): number {
    const nd = this.table.get(this.hash(root));
    if (!nd?.moves?.length) return STOP;
    let bi = -1;
    let bv = -Infinity;
    for (let i = 0; i < nd.moves.length; i++) {
      const v = this.edgeVal(nd, i, -this.opts.c, true);
      if (v > bv) {
        bv = v;
        bi = i;
      }
    }
    if (bi < 0) {
      let bc = -1;
      for (let i = 0; i < nd.moves.length; i++) {
        const c = nd.edges?.[i]?.n ?? 0;
        if (c > bc) {
          bc = c;
          bi = i;
        }
      }
    }
    return nd.moves[Math.max(0, bi)];
  }
}

