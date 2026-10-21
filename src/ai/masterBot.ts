import { checkAttack } from '../core/engine';
import type { MatchState } from '../core/types';
import { botSeed, firstLegalAttack, smartyPower } from './common';
import { MasterBrain, type MasterOptions } from './master';
import type { MasterRequest, MasterResponse } from './masterProtocol';
import type { AttackMove, Bot, BotContext } from './types';

export interface MasterBotOptions extends MasterOptions {
  seed?: number;
  /** force the synchronous in-thread search even when Web Workers are available */
  sync?: boolean;
  /** if the worker does not answer within this many ms, compute in-thread instead */
  workerTimeoutMs?: number;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Pending = { resolve: (r: MasterResponse) => void; reject: (e: unknown) => void };

/**
 * Main-thread Master: forwards decisions to a Web Worker (so the UI never freezes); falls back to the
 * same search running synchronously when Worker is unavailable (Node tests) or the worker fails.
 * Results are validated against the engine before being returned.
 */
export class MasterBot implements Bot {
  readonly type = 'master' as const;
  private worker: Worker | null = null;
  private brain: MasterBrain | null = null;
  private readonly seed: number;
  private readonly options: MasterBotOptions;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  /** stats of the last decision */
  lastInfo = { runs: 0, ms: 0 };

  constructor(options: MasterBotOptions = {}) {
    this.options = options;
    this.seed = botSeed(options.seed);
    if (!options.sync && typeof Worker !== 'undefined') {
      try {
        this.worker = new Worker(new URL('./master.worker.ts', import.meta.url), { type: 'module' });
        this.worker.onmessage = (e: MessageEvent<MasterResponse>) => {
          const p = this.pending.get(e.data.id);
          if (!p) return;
          this.pending.delete(e.data.id);
          p.resolve(e.data);
        };
        this.worker.onerror = (e) => this.failWorker(e);
        const { seed: _s, sync: _y, workerTimeoutMs: _w, ...searchOpts } = options;
        this.worker.postMessage({ id: 0, kind: 'init', seed: this.seed, options: searchOpts } satisfies MasterRequest);
      } catch {
        this.worker = null;
      }
    }
  }

  private localBrain(): MasterBrain {
    if (!this.brain) {
      const { seed: _s, sync: _y, workerTimeoutMs: _w, ...searchOpts } = this.options;
      this.brain = new MasterBrain(this.seed, searchOpts);
    }
    return this.brain;
  }

  private failWorker(err: unknown) {
    const w = this.worker;
    this.worker = null;
    w?.terminate();
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private ask(req: DistributiveOmit<MasterRequest, 'id'>): Promise<MasterResponse> {
    const w = this.worker!;
    const id = this.nextId++;
    const timeout = this.options.workerTimeoutMs ?? 8000;
    return new Promise<MasterResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('master worker timeout'));
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
      w.postMessage({ ...req, id } as MasterRequest);
    });
  }

  async nextAttack(state: MatchState, ctx: BotContext): Promise<AttackMove | null> {
    let move: AttackMove | null = null;
    let done = false;
    if (this.worker) {
      try {
        const r = await this.ask({ kind: 'attack', state, ctx });
        if (r.kind === 'attack') {
          move = r.move;
          this.lastInfo = { runs: r.runs, ms: r.ms };
          done = true;
        }
      } catch {
        this.failWorker(new Error('worker failed'));
      }
    }
    if (!done) {
      const brain = this.localBrain();
      move = brain.decideAttack(state, ctx);
      this.lastInfo = brain.lastInfo;
    }
    if (move && checkAttack(state, move.from, move.to) !== null) move = firstLegalAttack(state);
    return move;
  }

  async placePower(state: MatchState, ctx: BotContext): Promise<Map<number, number>> {
    let placement: Map<number, number> | null = null;
    if (this.worker) {
      try {
        const r = await this.ask({ kind: 'power', state, ctx });
        if (r.kind === 'power') {
          placement = new Map(r.placement);
          this.lastInfo = { runs: r.runs, ms: r.ms };
        }
      } catch {
        this.failWorker(new Error('worker failed'));
      }
    }
    if (!placement) {
      const brain = this.localBrain();
      placement = brain.decidePower(state, ctx);
      this.lastInfo = brain.lastInfo;
    }
    return isValidPlacement(state, placement) ? placement : smartyPower(state);
  }

  dispose(): void {
    this.failWorker(new Error('disposed'));
  }
}

export function isValidPlacement(state: MatchState, placement: Map<number, number>): boolean {
  let sum = 0;
  for (const [cell, n] of placement) {
    const c = state.field.cells[cell];
    if (!c || c.owner !== state.current || !Number.isInteger(n) || n < 0 || c.power + n > c.maxPower) return false;
    sum += n;
  }
  return sum === state.powerLeft;
}
