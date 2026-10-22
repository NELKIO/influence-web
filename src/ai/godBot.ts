import { checkAttack } from '../core/engine';
import type { MatchState } from '../core/types';
import { botSeed, firstLegalAttack, smartyPower } from './common';
import { GodBrain, type GodOptions } from './god';
import type { GodRequest, GodResponse } from './godProtocol';
import { isValidPlacement } from './masterBot';
import type { AttackMove, Bot, BotContext } from './types';

export interface GodBotOptions extends GodOptions {
  seed?: number;
  /** force the synchronous in-thread search even when Web Workers are available */
  sync?: boolean;
  /** if the worker does not answer within this many ms, compute in-thread instead */
  workerTimeoutMs?: number;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Pending = { resolve: (r: GodResponse) => void; reject: (e: unknown) => void };

/**
 * Main-thread GOD: forwards decisions to a Web Worker (the UI never freezes); falls back to the same
 * search running synchronously when Worker is unavailable (Node tests) or the worker fails.
 * Every answer is validated against the engine before it is returned.
 */
export class GodBot implements Bot {
  readonly type = 'god' as const;
  private worker: Worker | null = null;
  private brain: GodBrain | null = null;
  private readonly seed: number;
  private readonly options: GodBotOptions;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private disposed = false;
  /** stats of the last decision */
  lastInfo = { rollouts: 0, ms: 0 };

  constructor(options: GodBotOptions = {}) {
    this.options = options;
    this.seed = botSeed(options.seed);
    if (!options.sync && typeof Worker !== 'undefined') {
      try {
        this.worker = new Worker(new URL('./god.worker.ts', import.meta.url), { type: 'module' });
        this.worker.onmessage = (e: MessageEvent<GodResponse>) => {
          const p = this.pending.get(e.data.id);
          if (!p) return;
          this.pending.delete(e.data.id);
          p.resolve(e.data);
        };
        this.worker.onerror = (e) => this.failWorker(e);
        this.worker.postMessage({ id: 0, kind: 'init', seed: this.seed, options: this.searchOptions() } satisfies GodRequest);
      } catch {
        this.worker = null;
      }
    }
  }

  private searchOptions(): GodOptions {
    const { seed: _s, sync: _y, workerTimeoutMs: _w, ...searchOpts } = this.options;
    return searchOpts;
  }

  private localBrain(): GodBrain {
    this.brain ??= new GodBrain(this.seed, this.searchOptions());
    return this.brain;
  }

  private failWorker(err: unknown) {
    const w = this.worker;
    this.worker = null;
    w?.terminate();
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private ask(req: DistributiveOmit<GodRequest, 'id'>): Promise<GodResponse> {
    const w = this.worker!;
    const id = this.nextId++;
    const timeout = this.options.workerTimeoutMs ?? 8000;
    return new Promise<GodResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('god worker timeout'));
      }, timeout);
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      w.postMessage({ ...req, id } as GodRequest);
    });
  }

  async nextAttack(state: MatchState, ctx: BotContext): Promise<AttackMove | null> {
    if (this.disposed) return null;
    let move: AttackMove | null = null;
    let done = false;
    if (this.worker) {
      try {
        const r = await this.ask({ kind: 'attack', state, ctx });
        if (r.kind === 'attack') {
          move = r.move;
          this.lastInfo = { rollouts: r.rollouts, ms: r.ms };
          done = true;
        }
      } catch {
        this.failWorker(new Error('worker failed'));
      }
    }
    if (this.disposed) return null;
    if (!done) {
      const brain = this.localBrain();
      move = brain.decideAttack(state, ctx);
      this.lastInfo = { rollouts: brain.lastInfo.rollouts, ms: brain.lastInfo.ms };
    }
    if (move && checkAttack(state, move.from, move.to) !== null) move = firstLegalAttack(state);
    return move;
  }

  async placePower(state: MatchState, ctx: BotContext): Promise<Map<number, number>> {
    if (this.disposed) return new Map();
    let placement: Map<number, number> | null = null;
    if (this.worker) {
      try {
        const r = await this.ask({ kind: 'power', state, ctx });
        if (r.kind === 'power') {
          placement = new Map(r.placement);
          this.lastInfo = { rollouts: r.rollouts, ms: r.ms };
        }
      } catch {
        this.failWorker(new Error('worker failed'));
      }
    }
    if (this.disposed) return new Map();
    if (!placement) {
      const brain = this.localBrain();
      placement = brain.decidePower(state, ctx);
      this.lastInfo = { rollouts: brain.lastInfo.rollouts, ms: brain.lastInfo.ms };
    }
    return isValidPlacement(state, placement) ? placement : smartyPower(state);
  }

  dispose(): void {
    this.disposed = true;
    this.failWorker(new Error('disposed'));
  }
}
