/**
 * GOD attack-phase tree search: UCT with chance edges over GOD's own attack phase, on the luck-exact
 * simulator (the streak corrector is part of the simulated dice; its counters are sampled from GOD's
 * belief at every iteration, so edge outcome frequencies are the effective, not the nominal, odds).
 *
 * Moves: every legal attack, plus STOP when enabled. Optional forced continuation from a freshly
 * captured cell (as Master). Leaves: end of the attack phase, valued by a pluggable evaluation.
 */
import { FastRng, Sim, type Topo } from './godSim';

const MAX_NODES = 150_000;

interface Edge {
  /** visits through this edge */
  n: number;
  /** outcomes seen */
  wins: number;
  win: TNode | null;
  loss: TNode | null;
}

interface TNode {
  count: number;
  value: number;
  /** move list: s*1024+t, −1 = STOP */
  moves: Int32Array | null;
  edges: (Edge | undefined)[] | null;
}

export interface TreeOptions {
  /** allow ending the attack phase voluntarily */
  stop: boolean;
  /** forced continuation from the cell just captured (Master's rule) */
  forced: boolean;
  /** UCT exploration constant */
  c: number;
}

export type LeafEval = (sim: Sim) => number;
/** rollout policy: next attack (s*1024+t) or −1 to stop */
export type Rollout = (sim: Sim, lastTo: number) => number;

export class AttackTree {
  private table = new Map<number, TNode>();
  private z1: Uint32Array;
  private z2: Uint32Array;
  private scratch: Sim;
  constructor(
    readonly t: Topo,
    readonly me: number,
    readonly opts: TreeOptions,
    readonly leaf: LeafEval,
    readonly rollout: Rollout,
    seed: number,
  ) {
    const r = new FastRng(seed ^ 0x2545f491);
    const size = t.n * 48 + 64;
    this.z1 = new Uint32Array(size);
    this.z2 = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      this.z1[i] = r.u32();
      this.z2[i] = r.u32();
    }
    this.scratch = new Sim(t, new FastRng(1));
  }

  get size(): number {
    return this.table.size;
  }

  /** forget all nodes (reuse the object for another position) */
  reset(): void {
    this.table.clear();
  }

  /** Zobrist code index of a cell, or −1 for an unarmed grey cell */
  private code(i: number, o: number, p: number): number {
    if (o < 0) return p > 0 ? i * 48 + 32 + p : -1; // armed grey cells (puzzles) lose power when attacked
    return i * 48 + (o === this.me ? 0 : 16) + p;
  }

  /** board part of the hash (both halves), O(n) */
  private base(sim: Sim): void {
    const { n } = this.t;
    let h1 = 0;
    let h2 = 0;
    for (let i = 0; i < n; i++) {
      const c = this.code(i, sim.owner[i], sim.power[i]);
      if (c < 0) continue;
      h1 ^= this.z1[c];
      h2 ^= this.z2[c];
    }
    this.h1 = h1;
    this.h2 = h2;
  }

  /** XOR a cell's current code in or out of the running hash */
  private toggle(sim: Sim, i: number): void {
    const c = this.code(i, sim.owner[i], sim.power[i]);
    if (c < 0) return;
    this.h1 ^= this.z1[c];
    this.h2 ^= this.z2[c];
  }

  private key(lastTo: number): number {
    const extra = lastTo + 2;
    const h1 = (this.h1 ^ Math.imul(extra, 0x27d4eb2d)) >>> 0;
    const h2 = (this.h2 ^ Math.imul(extra + 0x165667b1, 0x9e3779b1)) >>> 0;
    return h1 * 2097152 + (h2 >>> 11);
  }

  private h1 = 0;
  private h2 = 0;

  hash(sim: Sim, lastTo: number): number {
    this.base(sim);
    return this.key(lastTo);
  }

  private node(key: number): TNode {
    let nd = this.table.get(key);
    if (!nd) {
      nd = { count: 0, value: 0, moves: null, edges: null };
      this.table.set(key, nd);
    }
    return nd;
  }

  /** legal moves of `me` (forced continuation first); STOP appended when allowed */
  moves(sim: Sim, lastTo: number): Int32Array {
    const out: number[] = [];
    const me = this.me;
    const { n, adjStart, adj } = this.t;
    const owner = sim.owner;
    const power = sim.power;
    const from = (s: number) => {
      const greys = this.t.duel && sim.hasNeutralNb(s);
      for (let k = adjStart[s]; k < adjStart[s + 1]; k++) {
        const t = adj[k];
        const o = owner[t];
        if (o === me || (greys && o >= 0)) continue;
        out.push(s * 1024 + t);
      }
    };
    if (this.opts.forced && lastTo >= 0 && owner[lastTo] === me && power[lastTo] > 1) {
      from(lastTo);
      if (out.length) {
        if (this.opts.stop) out.push(-1);
        return Int32Array.from(out);
      }
    }
    for (let s = 0; s < n; s++) if (owner[s] === me && power[s] > 1) from(s);
    if (out.length && this.opts.stop) out.push(-1);
    return Int32Array.from(out);
  }

  private edgeVal(nd: TNode, i: number, c: number): number {
    const e = nd.edges![i];
    if (!e || e.n === 0) return c >= 0 ? Infinity : -Infinity;
    const lg = Math.log(Math.max(1, nd.count));
    let v = 0;
    if (e.win && e.loss) {
      const pw = e.wins / e.n;
      v = pw * ucb(e.win, lg, c) + (1 - pw) * ucb(e.loss, lg, c);
    } else {
      const ch = e.win ?? e.loss;
      if (!ch || ch.count === 0) return c >= 0 ? Infinity : -Infinity;
      v = ucb(ch, lg, c);
      // only one outcome seen so far on a chance edge: keep some optimism for the other one
      if (c >= 0 && e.n < 3 && e.wins > 0 && e.wins < e.n) v += c;
    }
    return v;
  }

  /** board hash halves of a root, to pass to iterate() when the same position is searched repeatedly */
  rootHash(sim: Sim): [number, number] {
    this.base(sim);
    return [this.h1, this.h2];
  }

  /** one iteration from `root` (luck counters already sampled into `root`); `rh` = rootHash(root) */
  iterate(root: Sim, rootLast: number, rng: FastRng, rh?: [number, number]): void {
    const b = this.scratch;
    b.copyFrom(root);
    b.rng = rng;
    let lastTo = rootLast;
    if (rh) {
      this.h1 = rh[0];
      this.h2 = rh[1];
    } else this.base(b);
    let nd = this.node(this.key(lastTo));
    const path: TNode[] = [nd];
    let guard = 0;
    let value = -1;
    while (guard++ < 2000) {
      if (!nd.moves) {
        nd.moves = this.moves(b, lastTo);
        nd.edges = new Array(nd.moves.length);
      }
      const moves = nd.moves;
      if (moves.length === 0 || b.aliveCount() <= 1) {
        value = this.leaf(b);
        break;
      }
      if (nd.count === 0) {
        value = this.finishRollout(b, lastTo);
        break;
      }
      let bi = 0;
      let bv = -Infinity;
      for (let i = 0; i < moves.length; i++) {
        const v = this.edgeVal(nd, i, this.opts.c);
        if (v > bv) {
          bv = v;
          bi = i;
        }
      }
      const mv = moves[bi];
      let e = nd.edges![bi];
      if (!e) {
        e = { n: 0, wins: 0, win: null, loss: null };
        nd.edges![bi] = e;
      }
      if (mv < 0) {
        // STOP: terminal child
        const child = e.win ?? (e.win = { count: 0, value: 0, moves: new Int32Array(0), edges: [] });
        e.n++;
        e.wins++;
        path.push(child);
        value = this.leaf(b);
        break;
      }
      const s = mv >> 10;
      const t = mv & 1023;
      this.toggle(b, s);
      this.toggle(b, t);
      const won = b.fight(s, t);
      this.toggle(b, s);
      this.toggle(b, t);
      lastTo = t;
      e.n++;
      if (won) e.wins++;
      if (this.table.size > MAX_NODES) {
        value = this.finishRollout(b, lastTo);
        break;
      }
      const child = this.node(this.key(lastTo));
      if (won) e.win = child;
      else e.loss = child;
      path.push(child);
      nd = child;
    }
    if (value < 0) value = this.leaf(b);
    for (const p of path) {
      p.count++;
      p.value += value;
    }
  }

  private finishRollout(b: Sim, lastTo: number): number {
    let k = 0;
    while (k++ < 400 && b.aliveCount() > 1) {
      const mv = this.rollout(b, lastTo);
      if (mv < 0) break;
      const s = mv >> 10;
      const t = mv & 1023;
      b.fight(s, t);
      lastTo = t;
    }
    return this.leaf(b);
  }

  /** Final choice at the root: lower confidence bound; unexplored moves lose. */
  best(root: Sim, rootLast: number): { move: number; visits: number } {
    const nd = this.table.get(this.hash(root, rootLast));
    if (!nd || !nd.moves || !nd.moves.length) return { move: -1, visits: 0 };
    let bi = -1;
    let bv = -Infinity;
    for (let i = 0; i < nd.moves.length; i++) {
      const v = this.edgeVal(nd, i, -this.opts.c);
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
    return { move: nd.moves[Math.max(0, bi)], visits: nd.count };
  }

  /** root statistics for debugging: move, visits, mean */
  rootStats(root: Sim, rootLast: number): { move: number; n: number; mean: number }[] {
    const nd = this.table.get(this.hash(root, rootLast));
    if (!nd?.moves) return [];
    return Array.from(nd.moves, (m, i) => {
      const e = nd.edges?.[i];
      const n = e?.n ?? 0;
      const w = e?.win;
      const l = e?.loss;
      const tot = (w?.count ?? 0) + (l?.count ?? 0);
      const mean = tot ? ((w?.value ?? 0) + (l?.value ?? 0)) / tot : NaN;
      return { move: m, n, mean };
    });
  }
}

function ucb(ch: TNode, lg: number, c: number): number {
  if (ch.count === 0) return c >= 0 ? Infinity : -Infinity;
  return ch.value / ch.count + c * Math.sqrt(lg / ch.count);
}
