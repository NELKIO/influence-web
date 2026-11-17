import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const values = new Map<string, string>();
const fetcher = vi.fn<typeof fetch>();
const hits = () => [...values].filter(([key]) => key.startsWith('infweb.siteHit.')).map(([, v]) => v).sort();
const ok = (value: number) => new Response(JSON.stringify({ value }));
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  values.clear();
  fetcher.mockReset();
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('location', { hostname: 'nelkio.github.io' });
  vi.stubGlobal('navigator', { onLine: false });
  vi.stubGlobal('localStorage', {
    get length() { return values.size; }, key: (i: number) => [...values.keys()][i],
    getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k),
  });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('anonymous site counters', () => {
  it('keeps offline visits and games across reload and drains only unacknowledged hits on recovery', async () => {
    const first = await import('../../src/sitestats');
    first.countVisit(); first.countGame();
    expect(hits()).toEqual(['games', 'opens', 'visitors']);
    expect(fetcher).not.toHaveBeenCalled();
    vi.resetModules();
    const next = await import('../../src/sitestats');
    next.countVisit();
    expect(hits()).toEqual(['games', 'opens', 'opens', 'visitors']);
    vi.stubGlobal('navigator', { onLine: true });
    fetcher.mockResolvedValueOnce(ok(271)).mockRejectedValueOnce(new Error('offline')).mockImplementation(async () => ok(42));
    await next.flushCounts();
    expect(hits().length).toBe(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hits()).toEqual([]);
    expect(fetcher.mock.calls.filter(([u]) => String(u).endsWith('/games'))).toHaveLength(1);
  });
  it('uses only confirmed per-counter values, and distinguishes zero from unavailable', async () => {
    const stats = await import('../../src/sitestats');
    fetcher.mockResolvedValueOnce(ok(270)).mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce(ok(0));
    expect(await stats.readCounter('opens')).toBe(270);
    expect(await stats.readCounter('opens')).toBe(null);
    expect(stats.lastKnownCounter('opens')?.value).toBe(270);
    expect(stats.lastKnownCounter('games')).toBe(null);
    expect(await stats.readCounter('games')).toBe(0);
    expect(stats.lastKnownCounter('games')?.value).toBe(0);
  });
  it('never queues hits on a development site', async () => {
    vi.stubGlobal('location', { hostname: 'localhost' });
    const stats = await import('../../src/sitestats');
    stats.countVisit(); stats.countGame();
    expect(hits()).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
