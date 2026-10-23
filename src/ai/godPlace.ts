/**
 * In-rollout placement models of GOD's own placement (round 7, docs/GOD.md).
 *
 * GOD's emulated rollouts (re-scored attacks, emuTail) must place GOD's own power the way GOD really
 * does after the move being judged. GOD's real duel placement is Master-anchored: most of the time it
 * plays Master's own placement (a real Master search), sometimes a best-response deviation. These
 * models reproduce that cheaply on the simulator board:
 *  - 'expert': Master's own rollout policy for placements (threat minimums, then canonical fills from
 *    the lowest-priority border cell upwards), no search;
 *  - 'search': a small real Master placement search (fixed playouts) on a light MatchState view of the
 *    simulator board.
 */
import type { MatchState } from '../core/types';
import { MasterBrain, __test as masterInternals } from './master';
import type { Sim } from './godSim';

/**
 * A minimal MatchState view of a simulator board for MasterBrain.decidePower (it only reads the field,
 * the phase, the player to move, the points to place and the duel-rules flag).
 */
export class SimStateView {
  readonly state: MatchState;
  constructor(base: MatchState) {
    const cells = base.field.cells.map((c) => ({ ...c }));
    this.state = {
      ...base,
      field: { ...base.field, cells },
      chronicle: base.chronicle,
      ended: null,
      phase: 'power',
    } as MatchState;
  }

  load(sim: Sim, me: number, left: number): MatchState {
    const cells = this.state.field.cells;
    for (let i = 0; i < cells.length; i++) {
      const o = sim.owner[i];
      cells[i].owner = o < 0 ? -1 : o;
      cells[i].power = o < 0 ? 0 : sim.power[i];
    }
    this.state.current = me;
    this.state.powerLeft = left;
    this.state.phase = 'power';
    this.state.ended = null;
    return this.state;
  }
}

/** Master's placement on a simulator board by its own search with `playouts` per placement step. */
export class MasterPlacer {
  private view: SimStateView;
  private brain: MasterBrain;
  constructor(base: MatchState, seed: number, playouts: number) {
    this.view = new SimStateView(base);
    this.brain = new MasterBrain(seed, { playouts });
  }

  /**
   * Place `left` points for `me` on the simulator board. `seed`: restart Master's own dice (its search
   * samples fights) so that a rollout's placement depends only on the rollout, not on earlier calls.
   */
  place(sim: Sim, me: number, left: number, seed?: number): number {
    if (left <= 0) return left;
    // MasterBrain keeps its generator in a private field; replacing it only changes the random stream
    if (seed !== undefined) (this.brain as unknown as { rng: unknown }).rng = new masterInternals.FastRng(seed >>> 0);
    const st = this.view.load(sim, me, left);
    const pl = this.brain.decidePower(st, { speedMs: 0 });
    const cap = sim.t.cap;
    for (const [c, v] of pl) {
      const k = Math.min(v, cap[c] - sim.power[c], left);
      if (k > 0 && sim.owner[c] === me) {
        sim.power[c] += k;
        left -= k;
      }
    }
    return left;
  }
}

/** Master's priority of an own cell: c/1000 + 0.5 per grey neighbour + the units of enemy neighbours */
function priority(sim: Sim, c: number): number {
  const { adjStart, adj } = sim.t;
  const me = sim.owner[c];
  let p = c / 1000;
  for (let k = adjStart[c]; k < adjStart[c + 1]; k++) {
    const nb = adj[k];
    const o = sim.owner[nb];
    if (o < 0 || sim.power[nb] === 0) p += 0.5;
    else if (o !== me) p += sim.power[nb];
  }
  return p;
}

/** depth of the grey pocket next to c (capped at cap), −1 if it touches another player (Master's dead ends) */
function grayDepth(sim: Sim, c: number): number {
  const t = sim.t;
  const { adjStart, adj, queue, qval, stamp } = t;
  const g = t.nextStamp();
  const cur = sim.owner[c];
  const cap = t.cap[c];
  let head = 0;
  let tail = 0;
  for (let k = adjStart[c]; k < adjStart[c + 1]; k++) {
    const nb = adj[k];
    if (sim.owner[nb] < 0 && stamp[nb] !== g) {
      stamp[nb] = g;
      queue[tail] = nb;
      qval[tail++] = 1;
    }
  }
  let maxDepth = 0;
  while (head < tail) {
    const x = queue[head];
    const dep = qval[head++];
    if (dep >= cap) return cap;
    if (dep > maxDepth) maxDepth = dep;
    for (let k = adjStart[x]; k < adjStart[x + 1]; k++) {
      const y = adj[k];
      const o = sim.owner[y];
      if (o >= 0 && o !== cur) return -1;
      if (o < 0 && stamp[y] !== g) {
        stamp[y] = g;
        queue[tail] = y;
        qval[tail++] = dep + 1;
      }
    }
  }
  return maxDepth;
}

/**
 * Master's rollout policy for the free part of a placement (after its threat minimums): fill the
 * lowest-priority border cell, then the next one of higher priority, ... (room capped in dead ends).
 * Returns the points left.
 */
export function masterExpertRest(sim: Sim, me: number, left: number): number {
  const { n, cap, adjStart, adj } = sim.t;
  let threshold = 0.49;
  let guard = 0;
  while (left > 0 && guard++ < n) {
    let best = -1;
    let bestP = Infinity;
    let bestRoom = 0;
    for (let i = 0; i < n; i++) {
      if (sim.owner[i] !== me || sim.power[i] >= cap[i]) continue;
      const p = priority(sim, i);
      if (p <= threshold || p >= bestP) continue;
      let room = cap[i] - sim.power[i];
      let other = false;
      let grey = false;
      for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
        const o = sim.owner[adj[k]];
        if (o < 0) grey = true;
        else if (o !== me) other = true;
      }
      if (!other && grey) {
        const d = grayDepth(sim, i);
        if (d !== -1) room = Math.min(room, Math.max(0, d + 1 - sim.power[i]));
      }
      if (room <= 0) continue;
      best = i;
      bestP = p;
      bestRoom = room;
    }
    if (best < 0) break;
    const v = Math.min(left, bestRoom);
    sim.power[best] += v;
    left -= v;
    threshold = bestP;
  }
  return left;
}
