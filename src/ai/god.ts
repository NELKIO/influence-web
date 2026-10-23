/**
 * GOD ("БОГ") — the strongest computer player.
 *
 * Duels are anchored on Master: every duel decision starts from Master's own choice (a real Master search
 * on the true position, inside GOD's time budget) and GOD plays something else only when its analysis
 * below shows a clear gain (paired emulated rollouts, or the attack tree's values). Its own analysis has
 * rare systematic misjudgements (e.g. over-extended opening chains towards the enemy) that the anchor
 * filters out; see docs/GOD.md, round 5.
 *
 * Search (all on GOD's own luck-exact simulator, src/ai/godSim.ts):
 *  - Duel (two players alive): every attack is chosen by UCT over GOD's own attack phase with chance
 *    edges (src/ai/godTree.ts). The dice include the engine's streak corrector, its counters sampled from
 *    GOD's belief at every iteration, so a "75%" fight is valued at its real ~53% between bots (Master
 *    believes 75%). Leaves: evalPhase (generalised Master ratio 2·cells / enemy power). The tree is kept
 *    for the whole turn, reused after each real outcome and searched further while the UI animates.
 *    Best response to the opponent: Master-like play is emulated by small UCT searches with Master's
 *    own objective (one per opponent move) plus threat-minimum placements. The placement is chosen among
 *    "threat minimums (Master §7.5, per opponent) + fill cell X + rest" candidates for the best
 *    attack-stack cells (key tuned against Master: own power, grey / weak neighbours, room for a chain
 *    within two steps) by rollouts through the emulated reply and GOD's next attack phase. Attacks are
 *    re-scored the same way among the tree's four favourite moves: every attack of the opening
 *    (rounds 0–3, which decide most matches) and the first attack of later turns. Candidates are
 *    compared with common random numbers and successive halving. The opening gets the big time budgets.
 *  - Three or more players alive: attacks and placements are chosen by a whole-turn search
 *    (src/ai/godGame.ts): GOD's attacks and canonical placements are tree nodes; every opponent plays its
 *    turn with a model of its own type (Hunter / Duel Hunter / Dummy / Freak exactly, Master by its
 *    expert policy and threat minimums, people and other GODs by GOD's base heuristics), so who attacks
 *    whom, being left alone while others fight, and the leader being attacked are simulated rather than
 *    assumed; the horizon is the end of GOD's next attack phase.
 *
 * Darkness: like every other bot, GOD sees the whole map (also under exploration fog). The fair-fog brain
 * (`fairFog`, experiments only) reads only its own cells and their neighbours, remembers what it saw
 * before (enemy cells keep their last seen owner and grow by one per round up to capacity), and puts the
 * enemy cells the public HUD counts but it cannot see on the most likely unseen cells (phantoms).
 * GOD never reads the streak-corrector counters: it keeps a belief over them
 * (stationary prior for the line-up, updated from the outcomes of its own fights within the turn).
 *
 * Budgets: `rollouts` = fixed iterations per decision (deterministic per seed, for tests and
 * simulations); otherwise wall-clock budgets scaled by ctx.speedMs with a hard cap per decision.
 * Tuning procedure and measurements: scripts/god-strength.ts, scripts/god-tune.py, scripts/god-learn.ts.
 */
import { cellCount, checkAttack, scoreOf, winChance as engineChance } from '../core/engine';
import { NEUTRAL, type MatchState } from '../core/types';
import { botSeed, firstLegalAttack, smartyPower } from './common';
import { GState, GameTree } from './godGame';
import {
  DEFAULT_PARAMS,
  FastRng,
  GOD_STACK,
  PK_MASTER,
  Sim,
  Topo,
  chainExposure,
  evalPhase,
  masterAttack,
  smartyPlace,
  stackOrder,
  stackPlace,
  threatMinimums,
  type GodParams,
  type StackWeights,
} from './godSim';
import { MasterPlacer, masterExpertRest } from './godPlace';
import { AttackTree } from './godTree';
import { MasterBrain } from './master';
import type { AttackMove, BotContext } from './types';

export interface GodOptions {
  /** fixed iterations per decision (deterministic for a seed; time budgets are ignored) */
  rollouts?: number;
  /** first attack decision of a turn: think this long (ms) */
  firstAttackMs?: number;
  /** later attack decisions: max(attackMs, attackSpeedFactor × ctx.speedMs) */
  attackMs?: number;
  attackSpeedFactor?: number;
  /** power placement budget (ms) */
  powerMs?: number;
  /** total budget of the first attack of a turn including its emulated re-scoring (ms) */
  rescoreMs?: number;
  /** rounds 0 .. openingRounds−1 use the opening budgets below */
  openingRounds?: number;
  openingFirstMs?: number;
  openingRescoreMs?: number;
  openingAttackMs?: number;
  openingPowerMs?: number;
  openingRescoreOtherMs?: number;
  /** hard cap of an opening decision (ms) */
  openingMaxMs?: number;
  /** hard cap per decision (ms) */
  maxDecisionMs?: number;
  /** evaluation weights */
  params?: Partial<GodParams>;
  /** attack-stack weights of GOD's own placements */
  stack?: Partial<StackWeights>;
  /** search mode: 'auto' (duel tree / whole-turn with 3+ players), or force one */
  mode?: 'auto' | 'duel' | 'multi';
  /** UCT exploration constant */
  c?: number;
  /** canonical placement cells in the whole-turn search */
  powerCells?: number;
  /** duel placement: 'heuristic' (tuned threat minimums + attack stack) or 'emulate' (best response) */
  duelPower?: 'heuristic' | 'emulate';
  emuCands?: number;
  /** emulator: UCT iterations per emulated move (default 128 in real time, 32 with fixed rollouts) */
  emuIters?: number;
  /** fixed-budget mode: emulated rollouts per duel placement (default 0.4 × rollouts) */
  emuRollouts?: number;
  /** first attack of a duel turn: re-score this many top tree moves by emulation (0 = off) */
  attackEmu?: number;
  /** fixed-budget mode: emulated rollouts for that (default 0.16 × rollouts) */
  emuAttackRollouts?: number;
  emuDepth?: number;
  rescoreAllOpening?: boolean;
  /** re-score every attack decision of the match */
  rescoreAll?: boolean;
  emuExtra?: boolean;
  /**
   * emulated Master opponents search like Master: nominal dice (Master does not know the streak
   * corrector) and its clamped ratio
   */
  emuNominal?: boolean;
  /** darkness: place the enemy cells counted by the HUD but not seen on the most likely unseen cells */
  phantoms?: boolean;
  duelLateScale?: number;
  multiScale?: number;
  /**
   * Master-anchored duels: every duel decision starts from Master's own choice (a real Master search on the
   * true position) and GOD deviates only when its own analysis shows a better move by a clear margin
   * (re-scored decisions: paired emulated rollouts, mean gain > anchorZ standard errors; other attacks:
   * the attack tree's values).
   */
  anchor?: boolean;
  anchorZ?: number;
  anchorMin?: number;
  /** the anchor threshold of placements (default anchorZ) */
  anchorZPow?: number;
  /**
   * 'all': GOD may deviate from any Master choice; 'chance': Master's sure captures always stand;
   * 'chanceP': and Master's placements too
   */
  anchorMode?: 'all' | 'chance' | 'chanceP';
  /**
   * share of an anchored comparison's rollouts kept to confirm the halving's winner against Master's choice
   * on fresh dice (the winner of several noisy means is biased upwards); 0 = judge on the same rollouts
   */
  anchorConfirm?: number;
  /**
   * GOD's own placement inside emulated rollouts: 'model' (threat minimums + GOD's attack-stack key, the
   * round-2 model), 'mstack' (the same with Master's key), 'expert' (Master's rollout policy) or
   * 'search:N' (a real Master placement search with N playouts per step: GOD's anchored placement is
   * mostly Master's)
   */
  ownPlace?: string;
  /** the opponents' (Master seats') placement inside emulated rollouts, same choices */
  oppPlace?: string;
  /**
   * leaf term of emulated rollouts: own cells a single sure enemy chain could take next turn (after GOD's
   * modelled placement, the enemy's income on the chain's start) count this much against GOD (0 = off)
   */
  chainLeaf?: number;
  /** emulated rollouts end after the opponents' next attacks instead of GOD's next attack phase */
  emuTail?: 'off' | 'opening' | 'all';
  /** Master's search time (ms) for: the first attack of an opening turn, other opening attacks, the first
   * attack of a later turn, other later attacks, opening placements, later placements */
  anchorMs?: [number, number, number, number, number, number];
  /** fixed-budget mode: Master's playouts per anchor decision (default: rollouts) */
  anchorPlayouts?: number;
  /** duel placement: also consider Master's own placement found by a Master search of this many ms (0 = off) */
  masterCand?: number;
  /** re-scored attacks: also consider Master's own choice found by a Master search of this many ms (0 = off) */
  masterAtk?: number;
  /** GOD's own attack tree may switch to another source after a capture (Master's rule is to go on from it) */
  unforced?: boolean;
  /**
   * Respect darkness (and exploration fog): read only own cells and their neighbours plus the public HUD
   * totals. Off by default: like every other bot, GOD sees the whole map. Experiments only.
   */
  fairFog?: boolean;
  /**
   * with fairFog: ignore the fog anyway, only in rounds 0..3 ('open'), only for attack ('attack') or
   * placement ('power') decisions (experiments). Partial cheats never enter GOD's memory.
   */
  cheat?: boolean | 'open' | 'attack' | 'power';
}

export const DEFAULT_GOD_OPTIONS = {
  firstAttackMs: 450,
  /** total budget of a first attack including the emulated re-scoring */
  rescoreMs: 900,
  /** rounds 0 .. openingRounds−1 get the opening budgets */
  openingRounds: 4,
  openingFirstMs: 500,
  openingRescoreMs: 1300,
  openingAttackMs: 200,
  /** total budget of a later attack of an opening turn including its re-scoring */
  openingRescoreOtherMs: 500,
  openingPowerMs: 1200,
  /** hard cap of an opening decision (ms) */
  openingMaxMs: 1420,
  attackMs: 150,
  attackSpeedFactor: 0.8,
  /** duels after the opening: scale of the time budgets */
  duelLateScale: 1,
  /** three or more players: scale of the time budgets of the whole-turn search */
  multiScale: 1,
  /** Master-anchored duels (see GodOptions.anchor) */
  anchor: true as boolean,
  anchorZ: 1.5,
  /** minimum mean gain (evaluation units, 0..1) of a deviation from Master's choice */
  anchorMin: 0,
  anchorMs: [300, 150, 250, 100, 300, 200] as [number, number, number, number, number, number],
  maxDecisionMs: 2000,
  mode: 'auto' as 'auto' | 'duel' | 'multi',
  c: 0.25,
  powerCells: 30,
  powerMs: 600,
  duelPower: 'emulate' as 'heuristic' | 'emulate',
  emuCands: 10,
  /** first attack of a turn: re-score this many top moves by emulation (0 = off) */
  attackEmu: 4,
  /** extra full rounds in emulated rollouts */
  emuDepth: 0,
  /** re-score every attack of the opening (not only the first of a turn) */
  rescoreAllOpening: true,
  /** more placement candidates (all-in without minimums, safer margin, split stacks) */
  emuExtra: false as boolean,
  /** darkness: the enemy cells the HUD counts but GOD cannot see are put on the most likely unseen cells */
  phantoms: true as boolean,
};

const now = (): number => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

export interface GodDecisionInfo {
  /** search iterations of the last decision */
  rollouts: number;
  ms: number;
  /** root moves considered */
  candidates: number;
  /** emulated rollouts of the re-scoring / placement comparison (diagnostics) */
  emu?: number;
  /** the re-scoring changed the tree's choice (diagnostics) */
  changed?: boolean;
}

interface Memory {
  key: string;
  owner: Int8Array;
  power: Int8Array;
  seenTurn: Int32Array;
}

/** What to think about while the UI animates the move just returned (Web Worker only). */
interface Ponder {
  /** positions after the move: win / loss outcome with their weights */
  roots: { sim: Sim; w: number; lastTo: number }[];
  spentMs: number;
}

const PONDER_LIMIT_MS = 3000;
/** iterations every search runs even when its time budget is already used up (slow devices) */
const MIN_ITERS = 16;

/** Stateful GOD decision maker (one per bot / worker). */
export class GodBrain {
  readonly opts: typeof DEFAULT_GOD_OPTIONS & GodOptions;
  readonly P: GodParams;
  private rng: FastRng;
  private topo: Topo | null = null;
  private topoKey = '';
  private mem: Memory | null = null;
  /** belief over the three streak counters: probability of the values 0..4 */
  private luckBelief: Float64Array[] = [];
  private luckPrior: Float64Array[] = [];
  private lastFight: { turn: number; to: number; bucket: number } | null = null;
  private attackKey = '';
  private lastTo = -1;
  private tree: AttackTree | null = null;
  private treeKey = '';
  private game: GameTree | null = null;
  private gameKey = '';
  private ponderState: Ponder | null = null;
  /** the decision being made is in the opening (rounds 0 .. openingRounds−1) */
  private inOpening = false;
  /** Master search for the masterCand placement candidate */
  private masterBrain: MasterBrain | null = null;
  /** Master search anchoring duel attacks (kept for the match: its tree and forced continuation) */
  private anchorAtk: MasterBrain | null = null;
  /** diagnostics: anchored decisions and deviations from Master */
  anchorStats = { decisions: 0, deviations: 0 };
  anchorLast: { n: number; mean: number; sd: number; deviated: boolean } | null = null;
  /** diagnostics: the candidates of the last compared duel placement (cell, points added), Master's first when anchored */
  lastPlaceCands: { cands: [number, number][][]; anchor: number } | null = null;
  /** diagnostics: the candidates of the last re-scored attack (Master's choice first when anchored) */
  lastRescore: { cands: number[]; anchor: number; lastTo: number } | null = null;
  /** emulated rollouts past this time (ms, performance clock) search minimally */
  private emuDeadline = Infinity;
  lastInfo: GodDecisionInfo = { rollouts: 0, ms: 0, candidates: 0 };

  constructor(seed?: number, opts: GodOptions = {}) {
    this.opts = { ...DEFAULT_GOD_OPTIONS, ...opts };
    this.P = { ...DEFAULT_PARAMS, ...opts.params };
    this.rng = new FastRng(botSeed(seed));
  }

  // -------------------------------------------------------------- setup

  private topoFor(state: MatchState): Topo {
    const key = [
      state.seed,
      state.field.cells.length,
      state.settings.players.join(','),
      state.settings.duelRules,
      state.field.cells.map((c) => c.maxPower).join(''),
    ].join('|');
    if (!this.topo || key !== this.topoKey) {
      this.topo = new Topo(state);
      this.topoKey = key;
      this.luckPrior = stationaryCounters(this.topo);
      this.luckBelief = this.luckPrior.map((d) => d.slice());
      this.mem = null;
      this.tree = null;
      this.game = null;
    }
    return this.topo;
  }

  private stackW(): StackWeights {
    return { ...GOD_STACK, ...this.opts.stack };
  }

  /**
   * Cells GOD looks at: everything (the default, like the other bots, also under darkness and exploration
   * fog); with `fairFog` only its own cells and their neighbours under darkness.
   */
  visible(state: MatchState, me: number, fair = false): Uint8Array {
    const { cells, adj } = state.field;
    const vis = new Uint8Array(cells.length);
    const ch = fair ? false : this.opts.cheat;
    if (
      !state.settings.darkness ||
      (!this.opts.fairFog && !fair) ||
      ch === true ||
      (ch === 'open' && state.turn < this.opts.openingRounds) ||
      (ch === 'attack' && state.phase === 'attack') ||
      (ch === 'power' && state.phase === 'power')
    ) {
      vis.fill(1);
      return vis;
    }
    cells.forEach((c, i) => {
      if (c.owner === me) {
        vis[i] = 1;
        for (const n of adj[i]) vis[n] = 1;
      }
    });
    return vis;
  }

  /**
   * Belief board: visible cells as they are, remembered cells as last seen (enemy power grows by one per
   * round up to capacity), never seen cells neutral. `hidden` = enemy power GOD cannot place on the board
   * (public HUD total minus the believed power), counted in the evaluation.
   */
  private belief(state: MatchState, me: number, topo: Topo): { sim: Sim; hidden: number } {
    const sim = new Sim(topo, new FastRng(1));
    const { cells } = state.field;
    const n = cells.length;
    const vis = this.visible(state, me);
    // experiments with partial cheating: the memory only learns what GOD really sees
    const real = typeof this.opts.cheat === 'string' ? this.visible(state, me, true) : vis;
    const memKey = `${state.seed}|${n}|${me}`;
    if (!this.mem || this.mem.key !== memKey) {
      this.mem = { key: memKey, owner: new Int8Array(n).fill(-1), power: new Int8Array(n), seenTurn: new Int32Array(n).fill(-1) };
    }
    const mem = this.mem;
    let anyHidden = false;
    for (let i = 0; i < n; i++) {
      const c = cells[i];
      if (vis[i]) {
        const o = c.owner === NEUTRAL || c.power <= 0 ? -1 : c.owner;
        sim.owner[i] = o;
        // neutral cells normally have no power; puzzle positions may have armed grey cells
        sim.power[i] = c.power;
        if (real[i]) {
          mem.owner[i] = o;
          mem.power[i] = sim.power[i];
          mem.seenTurn[i] = state.turn;
        }
      } else {
        anyHidden = true;
        const o = mem.owner[i];
        if (o >= 0 && o !== me && (state.outAt[o] ?? -1) < 0) {
          sim.owner[i] = o;
          const age = Math.max(0, state.turn - mem.seenTurn[i]);
          sim.power[i] = Math.min(topo.cap[i], Math.max(1, mem.power[i] + age));
        } else {
          sim.owner[i] = -1;
          sim.power[i] = 0;
        }
      }
    }
    sim.recount();
    if (anyHidden && this.opts.phantoms) this.addPhantoms(state, me, topo, sim, vis);
    let hidden = 0;
    if (anyHidden) {
      for (let p = 0; p < topo.slots; p++) {
        if (p === me) continue;
        let bp = 0;
        for (let i = 0; i < n; i++) if (sim.owner[i] === p) bp += sim.power[i];
        hidden += Math.max(0, scoreOf(state, p) - bp);
      }
    }
    return { sim, hidden };
  }

  /**
   * Darkness: the HUD tells how many cells and how much power every player has. Enemy cells GOD cannot
   * place on the board are put where they most likely are: the unseen believed-neutral cells closest to
   * that enemy's known cells (or, with none known, the unseen cells farthest from GOD), with the unplaced
   * power spread over them. Uses only GOD's own view and the public totals.
   */
  private addPhantoms(state: MatchState, me: number, topo: Topo, sim: Sim, vis: Uint8Array) {
    const n = topo.n;
    const { adjStart, adj } = topo;
    const free = (i: number) => !vis[i] && sim.owner[i] < 0;
    // distance from GOD's cells (for enemies never seen)
    const dist = new Int32Array(n).fill(-1);
    const q = new Int32Array(n);
    let h = 0;
    let t = 0;
    for (let i = 0; i < n; i++) if (sim.owner[i] === me) (dist[i] = 0), (q[t++] = i);
    while (h < t) {
      const x = q[h++];
      for (let k = adjStart[x]; k < adjStart[x + 1]; k++) {
        const y = adj[k];
        if (dist[y] < 0) (dist[y] = dist[x] + 1), (q[t++] = y);
      }
    }
    for (let p = 0; p < topo.slots; p++) {
      if (p === me || (state.outAt[p] ?? -1) >= 0) continue;
      let known = 0;
      let knownPow = 0;
      for (let i = 0; i < n; i++) if (sim.owner[i] === p) (known++, (knownPow += sim.power[i]));
      let missing = cellCount(state, p) - known;
      if (missing <= 0) continue;
      const seen = new Uint8Array(n);
      h = 0;
      t = 0;
      for (let i = 0; i < n; i++) if (sim.owner[i] === p) (seen[i] = 1), (q[t++] = i);
      if (t === 0) {
        let far = -1;
        for (let i = 0; i < n; i++) if (free(i) && (far < 0 || dist[i] > dist[far])) far = i;
        if (far < 0) continue;
        seen[far] = 1;
        q[t++] = far;
      }
      const picked: number[] = [];
      // the first queue entries are known cells (not free) unless the anchor is a free cell
      while (h < t && picked.length < missing) {
        const x = q[h++];
        if (free(x)) picked.push(x);
        for (let k = adjStart[x]; k < adjStart[x + 1]; k++) {
          const y = adj[k];
          if (!seen[y] && free(y)) (seen[y] = 1), (q[t++] = y);
        }
      }
      if (!picked.length) continue;
      missing = picked.length;
      let pow = Math.max(missing, scoreOf(state, p) - knownPow);
      for (let j = 0; j < picked.length; j++) {
        const c = picked[j];
        const share = Math.max(1, Math.min(topo.cap[c], Math.round(pow / (picked.length - j))));
        sim.owner[c] = p;
        sim.power[c] = share;
        pow -= share;
      }
    }
    sim.recount();
  }

  /** opponents still in the match (public: the HUD shows every player's cell count) */
  private opponentsAlive(state: MatchState, me: number): number {
    let k = 0;
    for (let p = 0; p < state.settings.players.length; p++) if (p !== me && cellCount(state, p) > 0) k++;
    return k;
  }

  private multi(state: MatchState, me: number): boolean {
    if (this.opts.mode === 'duel') return false;
    if (this.opts.mode === 'multi') return true;
    return this.opponentsAlive(state, me) >= 2;
  }

  /** Update the streak-counter belief with the outcome of GOD's previous fight (same turn). */
  private observe(state: MatchState, me: number) {
    const lf = this.lastFight;
    this.lastFight = null;
    if (!lf || lf.turn !== state.turn || lf.bucket < 0) return;
    const won = state.field.cells[lf.to].owner === me;
    const k = lf.bucket;
    const limit = k === 0 ? 3 : 2;
    const p = k === 0 ? 0.25 : k === 1 ? 0.5 : 0.75;
    const b = this.luckBelief[k];
    const nb = new Float64Array(b.length);
    if (!won) nb[0] = 1;
    else {
      // a bot win moves the counter up by one (a forced flip would have been a loss)
      let z = 0;
      for (let c = 0; c < b.length - 1; c++) {
        const c1 = c + 1;
        const pw = c1 < limit ? p : c1 === limit ? p * 0.5 : 0;
        nb[c1] += b[c] * pw;
        z += b[c] * pw;
      }
      if (z > 0) for (let c = 0; c < nb.length; c++) nb[c] /= z;
      else nb[0] = 1;
    }
    this.luckBelief[k] = nb;
  }

  private sampleLuck(sim: Sim, rng: FastRng) {
    for (let k = 0; k < 3; k++) {
      const b = this.luckBelief[k];
      let r = rng.next();
      let c = 0;
      while (c < b.length - 1 && r >= b[c]) {
        r -= b[c];
        c++;
      }
      sim.luck[k] = c;
    }
  }

  /** the opening (first rounds) decides most matches: it gets the bigger budgets */
  private opening(state: MatchState): boolean {
    return state.turn < this.opts.openingRounds;
  }

  private budgetMs(firstOfTurn: boolean, ctx: BotContext, opening: boolean, duel: boolean): number {
    const o = this.opts;
    const later = Math.max(opening ? o.openingAttackMs : o.attackMs, o.attackSpeedFactor * ctx.speedMs);
    const ms = firstOfTurn ? (opening ? o.openingFirstMs : o.firstAttackMs) : later;
    // duels are decided in the opening: later rounds think less so the opening can think more
    const scaled = duel ? (opening ? ms : ms * o.duelLateScale) : ms * o.multiScale;
    return Math.min(o.maxDecisionMs, opening ? Math.min(scaled, o.openingMaxMs) : scaled);
  }

  // -------------------------------------------------------------- attack

  decideAttack(state: MatchState, ctx: BotContext): AttackMove | null {
    this.ponderState = null;
    if (state.ended || state.phase !== 'attack') return null;
    const me = state.current;
    const t0 = now();
    const topo = this.topoFor(state);
    const key = `${state.seed}:${state.turn}:${me}`;
    const firstOfTurn = key !== this.attackKey;
    if (firstOfTurn) {
      this.attackKey = key;
      this.luckBelief = this.luckPrior.map((d) => d.slice());
      this.lastFight = null;
      this.lastTo = -1;
    } else this.observe(state, me);
    const seed = this.rng.u32();
    const { sim: root, hidden } = this.belief(state, me, topo);
    const opening = this.opening(state);
    this.inOpening = opening;
    const budget = this.budgetMs(firstOfTurn, ctx, opening, !this.multi(state, me));
    const rng = new FastRng(seed ^ 0x51);

    let move: number;
    let iters = 0;
    let count: number;
    let treeMove = -1;
    let emu = 0;
    if (this.multi(state, me)) {
      const tree = this.gameTree(root, me, `A:${key}`, seed, hidden, false);
      tree.horizon = 2;
      const g = new GState(root);
      g.cur = me;
      g.lastTo = this.lastTo;
      const moves = tree.moves(g);
      count = moves.length;
      if (count > 1) iters = this.runGame(tree, g, budget, t0, rng, this.opts.rollouts);
      move = count === 0 ? -1 : count === 1 ? moves[0] : tree.best(g);
    } else {
      const tree = this.attackTree(root, me, key, seed, hidden);
      const moves = tree.moves(root, this.lastTo);
      count = moves.length;
      const rescore = (firstOfTurn || this.opts.rescoreAll || (opening && this.opts.rescoreAllOpening)) && count > 1 && this.opts.attackEmu > 1;
      // Master's own choice: the default that GOD has to beat
      let anchorMove = -1;
      let pinned = false;
      let treeBudget = budget;
      if (count > 1 && this.anchored(state)) {
        const am = this.opts.anchorMs;
        const ms = opening ? (firstOfTurn ? am[0] : am[1]) : firstOfTurn ? am[2] : am[3];
        const ta = now();
        anchorMove = this.masterAttackChoice(state, ms, seed);
        if (anchorMove >= 0 && (this.opts.anchorMode === 'chance' || this.opts.anchorMode === 'chanceP')) {
          // Master's sure captures (greys, or a margin of 2+) stand: GOD only re-judges chance fights
          const c = state.field.cells;
          const f = c[anchorMove >> 10];
          const t = c[anchorMove & 1023];
          if (engineChance(f.power, t.owner === NEUTRAL ? 0 : t.power) >= 1) pinned = true;
        }
        const spent = now() - t0;
        // the tree gets what is left of its budget, at least half of it (Master's time counts)
        treeBudget = spent + Math.max(budget - spent, budget * 0.5);
        void ta;
      }
      if (count > 1 && !pinned) {
        const copy = root.clone();
        const rh = tree.rootHash(root);
        const fixed = this.opts.rollouts;
        for (;;) {
          if (fixed !== undefined) {
            if (iters >= fixed) break;
          } else if (iters >= MIN_ITERS && (iters & 7) === 0 && now() - t0 >= treeBudget) break;
          copy.copyFrom(root);
          this.sampleLuck(copy, rng);
          tree.iterate(copy, this.lastTo, new FastRng(rng.u32()), rh);
          iters++;
        }
      }
      move = count === 0 ? -1 : count === 1 ? moves[0] : pinned ? anchorMove : tree.best(root, this.lastTo).move;
      treeMove = move;
      if (anchorMove >= 0 && !rescore && !pinned) {
        // no rollouts for this decision: deviate from Master only when the tree's values say so clearly
        this.anchorStats.decisions++;
        const st = tree.rootStats(root, this.lastTo);
        const a = st.find((x) => x.move === anchorMove);
        const b = st.find((x) => x.move === move);
        let keep = true;
        if (a && b && move !== anchorMove && a.n > 0 && b.n > 0) {
          const se = 0.15 * Math.sqrt(1 / a.n + 1 / b.n);
          if (b.mean - a.mean > Math.max(this.opts.anchorMin, this.opts.anchorZ * se)) keep = false;
        }
        if (keep) move = anchorMove;
        else this.anchorStats.deviations++;
      }
      // first attack of the turn: re-score the tree's favourites by emulated continuations and replies
      if (rescore && !pinned) {
        let top = tree
          .rootStats(root, this.lastTo)
          .filter((x) => x.move >= 0 && x.n > 0)
          .sort((x, y) => y.n - x.n)
          .slice(0, this.opts.attackEmu);
        if (anchorMove >= 0) top = [{ move: anchorMove, n: 0, mean: NaN }, ...top.filter((x) => x.move !== anchorMove)];
        // Master's own choice (a short real Master search) as one more candidate
        const ma = this.opts.masterAtk ?? 0;
        if (ma > 0 && !(state.settings.darkness && this.opts.fairFog)) {
          const mb = new MasterBrain(seed ^ 0x1234, this.opts.rollouts !== undefined ? { playouts: Math.max(40, this.opts.rollouts >> 2) } : { firstAttackMs: ma, firstAttackRuns: 60, maxDecisionMs: ma * 2 });
          const m = mb.decideAttack(state, { speedMs: 0 });
          if (m) {
            const code = m.from * 1024 + m.to;
            if (!top.some((x) => x.move === code)) top.push({ move: code, n: 0, mean: NaN });
          }
        }
        this.lastRescore = { cands: top.map((x) => x.move), anchor: anchorMove, lastTo: this.lastTo };
        if (top.length === 1) move = top[0].move;
        if (top.length > 1) {
          const { playEmu, placeModel, finish } = this.emulator(root, me, seed, hidden, state);
          const scratch = root.clone();
          const run = (c: number, i: number): number => {
            scratch.copyFrom(root);
            const r = new FastRng((Math.imul(seed ^ (i * 0x9e3779b9), 0x85ebca6b) ^ (i + 7)) >>> 0);
            scratch.rng = r;
            this.sampleLuck(scratch, r);
            const mv = top[c].move;
            scratch.fight(mv >> 10, mv & 1023);
            playEmu(scratch, me, r, mv & 1023);
            placeModel(scratch, me);
            return finish(scratch, r);
          };
          const res = this.halving(
            top.length,
            run,
            this.opts.emuAttackRollouts ?? Math.round(0.16 * (this.opts.rollouts ?? 1000)),
            t0,
            Math.min(this.opts.maxDecisionMs, firstOfTurn ? (opening ? this.opts.openingRescoreMs : this.opts.rescoreMs * this.opts.duelLateScale) : opening ? this.opts.openingRescoreOtherMs : this.opts.rescoreMs * this.opts.duelLateScale),
            anchorMove >= 0 ? 0 : -1,
          );
          move = top[res.best].move;
          iters += res.spent;
          emu = res.spent;
        }
      }
    }
    this.lastInfo = { rollouts: iters, ms: now() - t0, candidates: count, emu, changed: emu > 0 && move !== treeMove };
    // never end the phase only because the search had no answer (starved budget): expert fallback
    if (move < 0 && count > 0) move = this.fallbackMove(root, me, move);
    if (move < 0) return null;
    const from = move >> 10;
    const to = move & 1023;
    if (checkAttack(state, from, to) !== null) return firstLegalAttack(state); // model / engine mismatch: never
    this.lastTo = to;
    const cells = state.field.cells;
    const a = cells[from].power;
    const d = cells[to].owner === NEUTRAL ? 0 : cells[to].power;
    const p = engineChance(a, d);
    this.lastFight = { turn: state.turn, to, bucket: p === 0.25 ? 0 : p === 0.5 ? 1 : p === 0.75 ? 2 : -1 };
    if (this.opts.rollouts === undefined && !this.multi(state, me)) this.preparePonder(root, from, to, p);
    return { from, to };
  }

  /** Master-anchored decisions: duels on the true position (never with the fair fog) */
  private anchored(state: MatchState): boolean {
    return this.opts.anchor && !(state.settings.darkness && this.opts.fairFog) && !this.multi(state, state.current);
  }

  private masterOpts(kind: 'atk' | 'pow', ms: number) {
    if (this.opts.rollouts !== undefined) return { playouts: this.opts.anchorPlayouts ?? this.opts.rollouts };
    return kind === 'atk'
      ? { firstAttackMs: 1, firstAttackRuns: 60, attackRuns: 40, attackSpeedFactor: 1, maxDecisionMs: 1500 }
      : { powerMsPerSource: ms / 4, powerMaxMs: ms, powerRuns: 40, maxDecisionMs: ms * 2 };
  }

  /** Master's own attack for this position (its real search; ms of thinking in real-time mode), −1 if none */
  private masterAttackChoice(state: MatchState, ms: number, seed: number): number {
    this.anchorAtk ??= new MasterBrain(seed ^ 0x2b, this.masterOpts('atk', ms));
    // later attacks think attackSpeedFactor × speedMs; the first attack of a turn max(firstAttackMs, that)
    const m = this.anchorAtk.decideAttack(state, { speedMs: ms });
    return m ? m.from * 1024 + m.to : -1;
  }

  /**
   * The search found nothing to play although attacks exist. GOD never voluntarily stops (it has no
   * STOP move), so −1 here can only mean "no statistics" (e.g. a starved time budget): play Master's
   * expert move instead.
   */
  private fallbackMove(root: Sim, me: number, move: number): number {
    const mv = masterAttack(root, me, { lastTo: this.lastTo });
    return mv >= 0 ? mv : move;
  }

  /** closed-form leaves are possible with the default evaluation weights outside duel rules */
  private fastLeaf(t: Topo, hidden: number, P = this.P): { pCell: number; qPow: number; hidden: number; clamp?: boolean } | undefined {
    if (t.duel || P.pPow || P.pInt || P.pExposed || P.qCell || P.qInt !== P.qPow) return undefined;
    return { pCell: P.pCell, qPow: P.qPow, hidden, clamp: !!P.clampMap };
  }

  private attackTree(root: Sim, me: number, key: string, seed: number, hidden: number): AttackTree {
    if (!this.tree || this.treeKey !== key || this.tree.size > 120_000) {
      const P = this.P;
      const memo = { lastTo: -1 };
      this.tree = new AttackTree(
        root.t,
        me,
        { stop: false, forced: !this.opts.unforced, c: this.opts.c, fast: this.fastLeaf(root.t, hidden) },
        (b) => evalPhase(b, me, P, hidden),
        (b, lastTo) => {
          memo.lastTo = lastTo;
          return masterAttack(b, me, memo);
        },
        seed,
      );
      this.treeKey = key;
    }
    return this.tree;
  }

  private gameTree(root: Sim, me: number, key: string, seed: number, hidden: number, adversarial: boolean): GameTree {
    if (!this.game || this.gameKey !== key || this.game.size > 150_000) {
      this.game = new GameTree(
        root.t,
        me,
        this.P,
        { stop: false, forced: true, c: this.opts.c, powerCells: this.opts.powerCells, adversarial, stack: this.stackW() },
        seed,
      );
      this.gameKey = key;
    }
    this.game.hidden = hidden;
    return this.game;
  }

  private runGame(tree: GameTree, root: GState, budgetMs: number, t0: number, rng: FastRng, fixed: number | undefined): number {
    const copy = new GState(root.sim.clone());
    let it = 0;
    for (;;) {
      if (fixed !== undefined) {
        if (it >= fixed) break;
      } else if (it >= MIN_ITERS && (it & 7) === 0 && now() - t0 >= budgetMs) break;
      copy.copyFrom(root);
      this.sampleLuck(copy.sim, rng);
      tree.iterate(copy, new FastRng(rng.u32()));
      it++;
    }
    return it;
  }

  // -------------------------------------------------------------- pondering

  /** Remember the position after the move just chosen (both outcomes) to search it in the background. */
  private preparePonder(root: Sim, from: number, to: number, p: number) {
    const roots: Ponder['roots'] = [];
    if (p >= 1 || p <= 0) {
      const s = root.clone();
      s.apply(from, to, p >= 1);
      roots.push({ sim: s, w: 1, lastTo: to });
    } else {
      const w = root.clone();
      w.apply(from, to, true);
      const l = root.clone();
      l.apply(from, to, false);
      roots.push({ sim: w, w: p, lastTo: to }, { sim: l, w: 1 - p, lastTo: to });
    }
    this.ponderState = { roots, spentMs: 0 };
  }

  /**
   * Think ahead between decisions (Web Worker only): search the positions after the last chosen attack
   * in the turn's tree, so the next decision starts from a warm tree. Returns false when done.
   */
  ponder(sliceMs: number): boolean {
    const ps = this.ponderState;
    const tree = this.tree;
    if (!ps || !tree || ps.spentMs > PONDER_LIMIT_MS) return false;
    const t0 = now();
    const copy = ps.roots[0].sim.clone();
    let i = 0;
    while (now() - t0 < sliceMs) {
      const r = ps.roots.length === 1 || this.rng.next() < ps.roots[0].w ? ps.roots[0] : ps.roots[1];
      if (tree.moves(r.sim, r.lastTo).length === 0) {
        if (ps.roots.every((x) => tree.moves(x.sim, x.lastTo).length === 0)) return false;
        continue;
      }
      copy.copyFrom(r.sim);
      this.sampleLuck(copy, this.rng);
      tree.iterate(copy, r.lastTo, new FastRng(this.rng.u32()));
      if (++i > 100000) break;
    }
    ps.spentMs += now() - t0;
    return true;
  }

  // -------------------------------------------------------------- power

  decidePower(state: MatchState, _ctx: BotContext): Map<number, number> {
    this.ponderState = null;
    const me = state.current;
    if (state.ended || state.phase !== 'power' || state.powerLeft <= 0) return new Map();
    const t0 = now();
    const topo = this.topoFor(state);
    this.observe(state, me);
    this.attackKey = '';
    const seed = this.rng.u32();
    const { sim: root, hidden } = this.belief(state, me, topo);
    if (this.multi(state, me)) return this.gamePower(state, root, me, t0, seed, hidden);
    if (this.opts.duelPower === 'emulate') return this.emulatePower(state, root, me, t0, seed, hidden);
    // duel: threat minimums, then the best attack stacks, the rest on the border
    const sim = root.clone();
    let left = threatMinimums(sim, me, state.powerLeft, 0);
    left = stackPlace(sim, me, left, left, 0, this.stackW());
    smartyPlace(sim, me, left);
    this.lastInfo = { rollouts: 0, ms: now() - t0, candidates: 1 };
    return this.toPlacement(state, root, sim, me);
  }

  /**
   * Duel placement as a best response: candidates "threat minimums + fill cell X (+ the usual rest)" for
   * the best attack-stack cells, each scored by rollouts in which the opponent's whole turn is played by a
   * small tree search with Master's objective (a faithful emulation of Master-like play), then GOD's next
   * attack phase by the same small search, then evalPhase. Common random numbers + successive halving.
   */
  private emulatePower(state: MatchState, root: Sim, me: number, t0: number, seed: number, hidden: number): Map<number, number> {
    const left = state.powerLeft;
    const w = this.stackW();
    const base = root.clone();
    const l0 = threatMinimums(base, me, left, 0);
    const order = stackOrder(base, me, w).slice(0, this.opts.emuCands);
    const cands: Sim[] = [];
    const seen = new Set<string>();
    const push = (s: Sim) => {
      const k = s.power.join(',');
      if (!seen.has(k)) {
        seen.add(k);
        cands.push(s);
      }
    };
    {
      const s = base.clone();
      const l = stackPlace(s, me, l0, l0, 0, w);
      smartyPlace(s, me, l);
      push(s);
    }
    for (const c of order) {
      const s = base.clone();
      let l = l0;
      const v = Math.min(l, s.t.cap[c] - s.power[c]);
      s.power[c] += v;
      l -= v;
      l = stackPlace(s, me, l, l, 0, w);
      smartyPlace(s, me, l);
      push(s);
    }
    if (this.opts.emuExtra) {
      const fillTo = (s: Sim, c: number, l: number) => {
        const v = Math.max(0, Math.min(l, s.t.cap[c] - s.power[c]));
        s.power[c] += v;
        return l - v;
      };
      // all-in without threat minimums on each of the three best cells
      const raw = stackOrder(root, me, w).slice(0, 3);
      for (const c of raw) {
        const s = root.clone();
        let l = fillTo(s, c, left);
        l = stackPlace(s, me, l, l, 0, w);
        smartyPlace(s, me, l);
        push(s);
      }
      // a safer margin
      {
        const s = root.clone();
        let l = threatMinimums(s, me, left, 1);
        l = stackPlace(s, me, l, l, 0, w);
        smartyPlace(s, me, l);
        push(s);
      }
      // minimums, then the rest split between the two best cells
      if (order.length >= 2 && l0 > 1) {
        const s = base.clone();
        const h = Math.ceil(l0 / 2);
        let l = l0 - h + fillTo(s, order[0], h);
        l = fillTo(s, order[1], l);
        l = stackPlace(s, me, l, l, 0, w);
        smartyPlace(s, me, l);
        push(s);
      }
    }
    // Master's own placement (a short real Master search on the true position) as one more candidate:
    // it often spreads points in ways the stack candidates never try; the rollouts judge it like the rest
    const mc = this.opts.masterCand ?? 0;
    if (mc > 0 && !(state.settings.darkness && this.opts.fairFog)) {
      this.masterBrain ??= new MasterBrain(seed, this.opts.rollouts !== undefined ? { playouts: Math.max(40, this.opts.rollouts >> 2) } : { powerMaxMs: mc, powerMsPerSource: mc / 4, maxDecisionMs: mc * 2 });
      const pl = this.masterBrain.decidePower(state, { speedMs: 0 });
      const s = root.clone();
      for (const [c, v] of pl) s.power[c] += v;
      push(s);
    }
    // Master's own placement: the default GOD has to beat (candidate 0, never eliminated)
    let anchorCand = -1;
    if (this.anchored(state)) {
      const am = this.opts.anchorMs;
      const ms = this.opening(state) ? am[4] : am[5];
      const pl = new MasterBrain(seed ^ 0x3d, this.masterOpts('pow', ms)).decidePower(state, { speedMs: 0 });
      const s = root.clone();
      for (const [c, v] of pl) s.power[c] += v;
      const k = s.power.join(',');
      const at = cands.findIndex((x) => x.power.join(',') === k);
      if (at >= 0) cands.splice(at, 1);
      cands.unshift(s);
      anchorCand = 0;
      // 'chanceP': Master's placement always stands
      if (this.opts.anchorMode === 'chanceP') cands.length = 1;
    }
    if (cands.length === 1) {
      this.lastInfo = { rollouts: 0, ms: now() - t0, candidates: cands.length };
      return this.toPlacement(state, root, cands[0], me);
    }
    this.lastPlaceCands = {
      cands: cands.map((x) => {
        const d: [number, number][] = [];
        for (let i = 0; i < root.t.n; i++) if (x.power[i] > root.power[i]) d.push([i, x.power[i] - root.power[i]]);
        return d;
      }),
      anchor: anchorCand,
    };
    const { finish } = this.emulator(root, me, seed, hidden, state);
    const scratch = root.clone();
    const run = (c: number, i: number): number => {
      scratch.copyFrom(cands[c]);
      const r = new FastRng((Math.imul(seed ^ (i * 0x9e3779b9), 0x85ebca6b) ^ (i + 1)) >>> 0);
      scratch.rng = r;
      this.sampleLuck(scratch, r);
      return finish(scratch, r);
    };
    this.inOpening = this.opening(state);
    const ms = this.inOpening ? this.opts.openingPowerMs : this.opts.powerMs * this.opts.duelLateScale;
    const best = this.halving(cands.length, run, this.opts.emuRollouts ?? Math.round(0.4 * (this.opts.rollouts ?? 1000)), t0, Math.min(ms, this.opts.maxDecisionMs), anchorCand, this.opts.anchorZPow ?? this.opts.anchorZ);
    this.lastInfo = { rollouts: best.spent, ms: now() - t0, candidates: cands.length, emu: best.spent, changed: best.best !== 0 };
    return this.toPlacement(state, root, cands[best.best], me);
  }

  /**
   * Emulation of Master-like play: every attack decision by a small UCT search with Master's objective
   * (evalPhase from the mover's point of view, expert rollouts), placements by threat minimums + the
   * attack-stack key.
   */
  private emulator(root: Sim, me: number, seed: number, hidden: number, state: MatchState) {
    const emu = new Map<number, AttackTree>();
    const P = this.P;
    const w = this.stackW();
    const treeFor = (slot: number) => {
      let t = emu.get(slot);
      if (!t) {
        const memo = { lastTo: -1 };
        const asMaster = slot !== me && this.opts.emuNominal && root.t.kind[slot] === PK_MASTER;
        // Master's objective: clamp((reinforcement + cells) / enemy units − 0.3) / 2.7)
        const PE: GodParams = asMaster ? { ...P, clampMap: true, evalDuelStray: 0.5 } : P;
        t = new AttackTree(
          root.t,
          slot,
          { stop: false, forced: true, c: 0.25, fast: this.fastLeaf(root.t, slot === me ? hidden : 0, PE), nominal: asMaster },
          (b) => evalPhase(b, slot, PE, slot === me ? hidden : 0),
          (b, lastTo) => {
            memo.lastTo = lastTo;
            return masterAttack(b, slot, memo);
          },
          seed ^ (slot * 7919),
        );
        emu.set(slot, t);
      }
      return t;
    };
    // the emulated opponent must be about as strong as the real one: a real-time Master searches a lot,
    // so real-time GOD emulates with 128 iterations per move (fixed-budget mode: 32, fast and deterministic)
    const iters = this.opts.emuIters ?? (this.opts.rollouts === undefined ? 128 : 32);
    const tmp = root.clone();
    const playEmu = (sim: Sim, slot: number, rng: FastRng, lastTo = -1, maxMoves = 200): number => {
      const t = treeFor(slot);
      let first = -1;
      for (let k = 0; k < maxMoves; k++) {
        const moves = t.moves(sim, lastTo);
        if (!moves.length || sim.aliveCount() <= 1) break;
        let mv = moves[0];
        if (moves.length > 1) {
          // past the decision's hard deadline (a slow device): finish the rollout with minimal searches
          const todo = this.emuDeadline < Infinity && now() > this.emuDeadline ? Math.min(iters, 8) : iters;
          t.reset();
          const rh = t.rootHash(sim);
          for (let i = 0; i < todo; i++) {
            tmp.copyFrom(sim);
            tmp.rng = rng;
            t.iterate(tmp, lastTo, rng, rh);
          }
          mv = t.best(sim, lastTo).move;
        }
        if (mv < 0) break;
        if (first < 0) first = mv;
        sim.fight(mv >> 10, mv & 1023);
        lastTo = mv & 1023;
      }
      return first;
    };
    // GOD's own placement inside a rollout (ownPlace) and the opponents' (oppPlace), see ownPlacer
    const own = this.ownPlacer(state, this.opts.ownPlace ?? 'model', seed ^ 0x6f);
    const opp = (this.opts.oppPlace ?? 'model') === 'model' ? null : this.ownPlacer(state, this.opts.oppPlace!, seed ^ 0x70);
    const placeModel = (sim: Sim, slot: number, left = sim.income(slot)) => {
      if (slot === me) return own(sim, slot, left);
      if (opp && root.t.kind[slot] === PK_MASTER) return opp(sim, slot, left);
      let l = threatMinimums(sim, slot, left, 0);
      l = stackPlace(sim, slot, l, l, 0, w);
      smartyPlace(sim, slot, l);
    };
    const depth = this.opts.emuDepth;
    const tail = this.opts.emuTail === 'all' || (this.opts.emuTail === 'opening' && this.inOpening);
    const slots = root.t.slots;
    const chainLeaf = this.opts.chainLeaf ?? 0;
    const scratch2 = root.clone();
    /** after GOD's placement: every opponent's emulated turn, GOD's next attack phase (+ extra rounds) */
    const finish = (sim: Sim, rng: FastRng): number => {
      for (let d = 0; d <= depth; d++) {
        if (d > 0) placeModel(sim, me);
        for (let k = 1; k < slots; k++) {
          const q = (me + k) % slots;
          if (sim.cnt[q] <= 0) continue;
          playEmu(sim, q, rng);
          if (sim.cnt[me] === 0) return 0;
          placeModel(sim, q);
        }
        playEmu(sim, me, rng);
      }
      if (tail) {
        // the enemy moves next: GOD's modelled placement, then every opponent's emulated attacks, so
        // chains through GOD's weak lines are seen by the evaluation
        placeModel(sim, me);
        for (let k = 1; k < slots; k++) {
          const q = (me + k) % slots;
          if (sim.cnt[q] <= 0) continue;
          playEmu(sim, q, rng);
          if (sim.cnt[me] === 0) return 0;
        }
      }
      if (chainLeaf > 0 && !tail) {
        // exposure to sure enemy chains after GOD's (modelled) placement, the enemy's income on the chain's start
        scratch2.copyFrom(sim);
        scratch2.rng = sim.rng;
        placeModel(scratch2, me);
        const lost = chainExposure(scratch2, me, (x) => scratch2.income(x));
        return evalPhase(sim, me, P, hidden, chainLeaf * P.pCell * lost);
      }
      return evalPhase(sim, me, P, hidden);
    };
    return { playEmu, placeModel, finish };
  }

  /**
   * Diagnostics (scripts/god-fidelity.ts): the emulator's choice for the player to move in `state`, as if
   * that player were GOD's opponent: its next attack (from → to, given its previous attack of the turn)
   * or its whole placement.
   */
  emuProbe(state: MatchState, lastTo = -1, policy: 'emu' | 'expert' = 'emu'): AttackMove | Map<number, number> | null {
    const slot = state.current;
    const me = (slot + 1) % state.settings.players.length;
    const topo = this.topoFor(state);
    const root = new Sim(topo, new FastRng(1));
    state.field.cells.forEach((c, i) => {
      root.owner[i] = c.owner === NEUTRAL || c.power <= 0 ? -1 : c.owner;
      root.power[i] = c.power;
    });
    root.recount();
    const seed = this.rng.u32();
    const { playEmu, placeModel } = this.emulator(root, me, seed, 0, state);
    const sim = root.clone();
    const rng = new FastRng(seed ^ 0x33);
    sim.rng = rng;
    this.sampleLuck(sim, rng);
    if (state.phase === 'attack') {
      const mv = policy === 'expert' ? masterAttack(sim, slot, { lastTo }) : playEmu(sim, slot, rng, lastTo, 1);
      return mv < 0 ? null : { from: mv >> 10, to: mv & 1023 };
    }
    placeModel(sim, slot, state.powerLeft);
    const out = new Map<number, number>();
    for (let i = 0; i < topo.n; i++) if (sim.power[i] > root.power[i]) out.set(i, sim.power[i] - root.power[i]);
    return out;
  }

  /**
   * Diagnostics (scripts/god-oracle.ts): the emulated-rollout values of attack candidates `cands` (codes
   * from·1024 + to) in the attack position `state` (GOD to move, `lastTo` = its previous target this turn),
   * `n` rollouts each with common random numbers, exactly as the re-scoring of decideAttack runs them.
   * Returns vals[c][i].
   */
  rescoreProbe(state: MatchState, lastTo: number, cands: number[], n: number, seed: number): number[][] {
    const me = state.current;
    const topo = this.topoFor(state);
    this.luckBelief = this.luckPrior.map((d) => d.slice());
    const { sim: root, hidden } = this.belief(state, me, topo);
    this.inOpening = this.opening(state);
    const { playEmu, placeModel, finish } = this.emulator(root, me, seed, hidden, state);
    const scratch = root.clone();
    const vals = cands.map(() => [] as number[]);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < cands.length; c++) {
        scratch.copyFrom(root);
        const r = new FastRng((Math.imul(seed ^ (i * 0x9e3779b9), 0x85ebca6b) ^ (i + 7)) >>> 0);
        scratch.rng = r;
        this.sampleLuck(scratch, r);
        const mv = cands[c];
        scratch.fight(mv >> 10, mv & 1023);
        playEmu(scratch, me, r, mv & 1023);
        placeModel(scratch, me);
        vals[c].push(finish(scratch, r));
      }
    }
    void lastTo;
    return vals;
  }

  /**
   * Diagnostics (scripts/god-oracle.ts): emulated-rollout values of placement candidates (cell, points)
   * in the placement position `state`, `n` rollouts each with common random numbers, as emulatePower runs
   * them. Returns vals[c][i].
   */
  placeRescoreProbe(state: MatchState, cands: [number, number][][], n: number, seed: number): number[][] {
    const me = state.current;
    const topo = this.topoFor(state);
    this.luckBelief = this.luckPrior.map((d) => d.slice());
    const { sim: root, hidden } = this.belief(state, me, topo);
    this.inOpening = this.opening(state);
    const boards = cands.map((pl) => {
      const b = root.clone();
      for (const [c, v] of pl) b.power[c] += v;
      return b;
    });
    const { finish } = this.emulator(root, me, seed, hidden, state);
    const scratch = root.clone();
    const vals = cands.map(() => [] as number[]);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < cands.length; c++) {
        scratch.copyFrom(boards[c]);
        const r = new FastRng((Math.imul(seed ^ (i * 0x9e3779b9), 0x85ebca6b) ^ (i + 1)) >>> 0);
        scratch.rng = r;
        this.sampleLuck(scratch, r);
        vals[c].push(finish(scratch, r));
      }
    }
    return vals;
  }

  /**
   * Diagnostics (scripts/god-placefid.ts): the placement of the player to move in `state` by one of the
   * in-rollout placement models ('model' = the emulator's threat minimums + attack stacks, 'expert' =
   * Master's rollout policy, 'search:N' = a Master search with N playouts per step).
   */
  placeProbe(state: MatchState, model: string): Map<number, number> {
    const slot = state.current;
    const topo = this.topoFor(state);
    const root = new Sim(topo, new FastRng(1));
    state.field.cells.forEach((c, i) => {
      root.owner[i] = c.owner === NEUTRAL || c.power <= 0 ? -1 : c.owner;
      root.power[i] = c.power;
    });
    root.recount();
    const seed = this.rng.u32();
    const sim = root.clone();
    sim.rng = new FastRng(seed ^ 0x33);
    const place = this.ownPlacer(state, model, seed);
    place(sim, slot, state.powerLeft);
    const out = new Map<number, number>();
    for (let i = 0; i < topo.n; i++) if (sim.power[i] > root.power[i]) out.set(i, sim.power[i] - root.power[i]);
    return out;
  }

  /** an in-rollout placement model (see placeProbe) */
  private ownPlacer(state: MatchState, model: string, seed: number): (sim: Sim, slot: number, left: number) => void {
    const w = this.stackW();
    if (model.startsWith('search:')) {
      const mp = new MasterPlacer(state, seed ^ 0x5a, Number(model.slice(7)));
      return (sim, slot, left) => {
        // Master's dice restart from the rollout's own generator (deterministic, independent of call order)
        const l = mp.place(sim, slot, left, sim.rng.u32());
        if (l > 0) smartyPlace(sim, slot, l);
      };
    }
    if (model === 'expert')
      return (sim, slot, left) => {
        let l = threatMinimums(sim, slot, left, 0);
        l = masterExpertRest(sim, slot, l);
        smartyPlace(sim, slot, l);
      };
    if (model === 'mstack')
      return (sim, slot, left) => {
        let l = threatMinimums(sim, slot, left, 0);
        l = stackPlace(sim, slot, l, l, 0);
        smartyPlace(sim, slot, l);
      };
    return (sim, slot, left) => {
      let l = threatMinimums(sim, slot, left, 0);
      l = stackPlace(sim, slot, l, l, 0, w);
      smartyPlace(sim, slot, l);
    };
  }

  /** successive halving with common random numbers (rollout i uses the same dice for every candidate) */
  private halving(count: number, run: (c: number, i: number) => number, fixed: number, t0: number, ms: number, anchor = -1, z = this.opts.anchorZ): { best: number; spent: number } {
    const sums = new Float64Array(count);
    const vals: number[][] = Array.from({ length: count }, () => []);
    const exec = (c: number) => {
      const v = run(c, done[c]++);
      vals[c].push(v);
      return v;
    };
    const done = new Int32Array(count);
    let alive = Array.from({ length: count }, (_, i) => i);
    let spent = 0;
    const timed = this.opts.rollouts === undefined;
    let hard = Math.min(this.opts.maxDecisionMs, ms * 1.1 + 20);
    if (this.inOpening) hard = Math.min(hard, this.opts.openingMaxMs);
    if (this.opts.rollouts === undefined) this.emuDeadline = t0 + hard;
    const tStart = now();
    for (const c of alive) {
      sums[c] += exec(c);
      spent++;
    }
    let total = fixed;
    if (timed) {
      const per = Math.max(1e-3, (now() - tStart) / spent);
      total = spent + Math.max(0, Math.floor((ms - (now() - t0)) / per));
    }
    // anchorConfirm: part of the rollouts is kept to confirm the winner against the anchor on fresh dice
    const confirm = anchor >= 0 ? (this.opts.anchorConfirm ?? 0) : 0;
    const totalAll = total;
    if (confirm > 0) total = spent + Math.floor(Math.max(0, total - spent) * (1 - confirm));
    const rounds = Math.max(1, Math.ceil(Math.log2(count)));
    for (let r = 0; r < rounds && alive.length > 1; r++) {
      const per = Math.floor(Math.max(0, total - spent) / ((rounds - r) * alive.length));
      const target = done[alive[0]] + per;
      for (const c of alive) {
        while (done[c] < target) {
          if (timed && now() - t0 > hard) break;
          sums[c] += exec(c);
          spent++;
        }
      }
      alive.sort((a, b) => sums[b] / done[b] - sums[a] / done[a] || a - b);
      alive = alive.slice(0, Math.max(1, Math.ceil(alive.length / 2)));
      // the anchor (Master's choice) is never eliminated: the final comparison is against it
      if (anchor >= 0 && !alive.includes(anchor)) alive.push(anchor);
      if (timed && now() - t0 > hard) break;
      if (anchor >= 0 && alive.length === 2 && r === rounds - 1) break;
    }
    alive.sort((a, b) => sums[b] / done[b] - sums[a] / done[a] || a - b);
    let best = alive[0];
    if (anchor >= 0) {
      this.anchorStats.decisions++;
      if (best !== anchor) {
        // paired comparison on the common rollouts (same dice): deviate only on a clear gain
        let va = vals[best];
        let vb = vals[anchor];
        if (confirm > 0) {
          // the winner of the halving is biased upwards (the best of several noisy means): judge it
          // against the anchor only on fresh rollouts (new dice indices)
          const s0 = Math.max(done[best], done[anchor]);
          done[best] = s0;
          done[anchor] = s0;
          const ca: number[] = [];
          const cb: number[] = [];
          const per = timed ? Infinity : Math.max(6, Math.floor((totalAll - spent) / 2));
          while (ca.length < per) {
            if (timed && (now() - t0 > ms || now() - t0 > hard)) break;
            ca.push(run(best, done[best]++));
            cb.push(run(anchor, done[anchor]++));
            spent += 2;
          }
          va = ca;
          vb = cb;
        }
        const n = Math.min(va.length, vb.length);
        let m = 0;
        let q = 0;
        for (let i = 0; i < n; i++) {
          const d = va[i] - vb[i];
          m += d;
          q += d * d;
        }
        const mean = n ? m / n : 0;
        const sd = n > 1 ? Math.sqrt(Math.max(0, q / n - mean * mean) * (n / (n - 1))) : Infinity;
        const clear = n >= 6 && mean > this.opts.anchorMin && mean > (z * sd) / Math.sqrt(n);
        this.anchorLast = { n, mean, sd, deviated: clear };
        if (clear) this.anchorStats.deviations++;
        else best = anchor;
      }
    }
    this.emuDeadline = Infinity;
    return { best, spent };
  }

  /** whole-turn search: forced threat minimums, then one searched chunk at a time */
  private gamePower(state: MatchState, root: Sim, me: number, t0: number, seed: number, hidden: number): Map<number, number> {
    const tree = this.gameTree(root, me, `P:${state.seed}:${state.turn}:${me}`, seed, hidden, false);
    tree.horizon = 1;
    const g = new GState(root.clone());
    g.phase = 1;
    g.cur = me;
    g.reinf = threatMinimums(g.sim, me, state.powerLeft, 0);
    g.order = stackOrder(g.sim, me, this.stackW()).slice(0, this.opts.powerCells);
    g.cursor = 0;
    const rng = new FastRng(seed ^ 0x77);
    const o = this.opts;
    const budget = Math.min(o.powerMs * o.multiScale, o.maxDecisionMs, this.opening(state) ? o.openingMaxMs : Infinity);
    let total = 0;
    let decisions = 0;
    let guard = 0;
    while (g.phase === 1 && g.cur === me && g.reinf > 0 && guard++ < 64) {
      const moves = tree.moves(g);
      if (moves.length <= 1) break;
      const fixed = o.rollouts === undefined ? undefined : decisions === 0 ? o.rollouts : Math.max(20, o.rollouts >> 1);
      const until = decisions === 0 ? budget * 0.5 : now() - t0 + Math.max(1, (budget - (now() - t0)) * 0.5);
      total += this.runGame(tree, g, until, t0, rng, fixed);
      decisions++;
      const mv = tree.best(g);
      if (mv === GameTree.END || mv < 0) break;
      tree.applyPlacement(g, mv);
    }
    if (g.reinf > 0) smartyPlace(g.sim, me, g.reinf);
    this.lastInfo = { rollouts: total, ms: now() - t0, candidates: decisions };
    return this.toPlacement(state, root, g.sim, me);
  }

  /** placement map = believed board after placing − before (own cells are always seen exactly) */
  private toPlacement(state: MatchState, root: Sim, sim: Sim, me: number): Map<number, number> {
    const out = new Map<number, number>();
    const cells = state.field.cells;
    const left = state.powerLeft;
    let sum = 0;
    for (let i = 0; i < cells.length; i++) {
      const add = sim.power[i] - root.power[i];
      if (add > 0 && cells[i].owner === me) {
        const k = Math.min(add, cells[i].maxPower - cells[i].power, left - sum);
        if (k > 0) {
          out.set(i, k);
          sum += k;
        }
      }
    }
    return sum === left ? out : completePlacement(state, out);
  }
}

/** Fill a partial placement up to state.powerLeft (SmartyPower for the rest). */
function completePlacement(state: MatchState, partial: Map<number, number>): Map<number, number> {
  let sum = 0;
  for (const v of partial.values()) sum += v;
  if (sum > state.powerLeft) return smartyPower(state);
  const s2 = structuredClone(state);
  for (const [c, v] of partial) s2.field.cells[c].power += v;
  s2.powerLeft = state.powerLeft - sum;
  const out = new Map(partial);
  for (const [c, v] of smartyPower(s2)) out.set(c, (out.get(c) ?? 0) + v);
  return out;
}

/** Stationary distribution of the three streak counters for this line-up (share of people seats). */
function stationaryCounters(topo: Topo): Float64Array[] {
  let persons = 0;
  for (let p = 0; p < topo.slots; p++) persons += topo.person[p];
  const share = persons / topo.slots;
  const rng = new FastRng(777);
  const ps = [0.25, 0.5, 0.75];
  const out: Float64Array[] = [];
  for (let k = 0; k < 3; k++) {
    const limit = k === 0 ? 3 : 2;
    const hist = new Float64Array(5);
    let c = 0;
    const N = 20000;
    for (let i = 0; i < N; i++) {
      const human = rng.next() < share;
      let win = rng.next() < ps[k];
      if (win !== human) c++;
      else c = 0;
      if ((c === limit && rng.next() < 0.5) || c > limit) {
        c = 0;
        win = human;
      }
      hist[Math.min(4, c)]++;
    }
    for (let v = 0; v < 5; v++) hist[v] /= N;
    out.push(hist);
  }
  return out;
}
