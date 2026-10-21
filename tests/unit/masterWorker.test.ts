import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { checkAttack, createMatch } from '../../src/core/engine';
import type { MatchState } from '../../src/core/types';
import { MasterBot, isValidPlacement } from '../../src/ai/masterBot';
import { endAttack } from '../../src/core/engine';

/**
 * Exercise the Web Worker path in Node with an in-process fake Worker: the real master.worker.ts
 * module is loaded into a fake worker scope and messages are structured-cloned both ways.
 */
type Handler = ((e: { data: unknown }) => void) | null;
const scope: { onmessage: Handler; postMessage: (m: unknown) => void } = {
  onmessage: null,
  postMessage: () => {},
};
let lastWorker: FakeWorker | null = null;
let created = 0;

class FakeWorker {
  onmessage: Handler = null;
  onerror: Handler = null;
  terminated = false;
  constructor(url: URL, opts: { type: string }) {
    expect(String(url)).toContain('master.worker');
    expect(opts.type).toBe('module');
    created++;
    lastWorker = this;
    scope.postMessage = (m) => setTimeout(() => !this.terminated && this.onmessage?.({ data: structuredClone(m) }));
  }
  postMessage(m: unknown) {
    setTimeout(() => scope.onmessage?.({ data: structuredClone(m) }));
  }
  terminate() {
    this.terminated = true;
  }
}

beforeAll(async () => {
  vi.stubGlobal('self', scope);
  vi.stubGlobal('Worker', FakeWorker);
  await import('../../src/ai/master.worker');
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function match(): MatchState {
  return createMatch(
    {
      kind: 'single',
      size: 'M',
      players: ['master', 'hunter', 'dummy'],
      darkness: false,
      symmetry: true,
      crowded: false,
      unions: false,
      shuffle: false,
      duelRules: false,
    },
    { seed: 5 },
  );
}

describe('Master via Web Worker', () => {
  it('answers attacks and placements through the worker', async () => {
    const bot = new MasterBot({ seed: 1, firstAttackMs: 30, firstAttackRuns: 20, attackRuns: 10, powerMaxMs: 30 });
    expect(created).toBe(1);
    const s = match();
    const snap = JSON.stringify(s);
    const mv = await bot.nextAttack(s, { speedMs: 10 });
    expect(mv).not.toBeNull();
    expect(checkAttack(s, mv!.from, mv!.to)).toBeNull();
    expect(bot.lastInfo.runs).toBeGreaterThan(0);
    expect(JSON.stringify(s)).toBe(snap);
    endAttack(s);
    const pl = await bot.placePower(s, { speedMs: 10 });
    expect(isValidPlacement(s, pl)).toBe(true);
    bot.dispose();
    expect(lastWorker!.terminated).toBe(true);
  });

  it('falls back to the in-thread search when the worker dies', async () => {
    const bot = new MasterBot({ seed: 2, firstAttackMs: 10, firstAttackRuns: 10, attackRuns: 5, workerTimeoutMs: 50 });
    // kill the worker silently: it never answers
    lastWorker!.terminated = true;
    scope.onmessage = null;
    const s = match();
    const mv = await bot.nextAttack(s, { speedMs: 0 });
    expect(mv && checkAttack(s, mv.from, mv.to)).toBeNull();
  });
});
