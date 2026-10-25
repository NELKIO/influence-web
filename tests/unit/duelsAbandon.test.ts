import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as Duels from '../../src/ui/duels';
import { DuelSession } from '../../src/net/duelSession';
import { BroadcastTransport } from '../../src/net/broadcast';
import { getClientId } from '../../src/net/persist';

// Removing a running online duel: the loss is recorded at once and the concede reaches the opponent,
// now or when it is back online. Also: a broken slot registry never crashes, dead guest codes go away.

class MapStorage {
  m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}

const g = globalThis as Record<string, unknown>;
const session = new MapStorage();
const local = new MapStorage();
let duels: typeof Duels;

beforeAll(async () => {
  g.location = { search: '?transport=bc', origin: 'https://example.org', hash: '', hostname: 'localhost' };
  g.sessionStorage = session;
  g.localStorage = local;
  duels = await import('../../src/ui/duels');
});
afterEach(() => {
  for (const s of duels.listSlots()) duels.removeSlot(s.id);
  session.clear();
  local.clear();
});
afterAll(() => {
  delete g.location;
  delete g.sessionStorage;
  delete g.localStorage;
});

const opts = { size: 'S' as const, darkness: false, turnTime: 0 };
const REG = 'infweb.duelSlots';
const registry = () => JSON.parse(session.getItem(REG) ?? '[]') as { id: string; pending?: boolean }[];
const records = () => (JSON.parse(local.getItem('infweb.stats') ?? '{"records":[]}').records as { kind: string; win: boolean; place?: number }[]);

/** A host in "another tab": its own storage and client id, the same BroadcastChannel. */
function outsideHost(storage = new MapStorage()) {
  return { storage, s: DuelSession.host({ ...opts, symmetry: true, storage, transport: BroadcastTransport.host(getClientId(storage)) }) };
}

describe('a broken slot registry', () => {
  it.each(['null', '{}', '[null]', '[1, "x", {"id": 5}]', '[{"id": "ok"}]', '{bad json', '"str"'])('%s: no crash, no slots', (raw) => {
    session.setItem(REG, raw);
    expect(() => duels.listSlots()).not.toThrow();
    expect(duels.listSlots()).toEqual([]);
    expect(duels.canCreate()).toBe(true);
    expect(duels.myTurnCount()).toBe(0);
    expect(() => duels.resumeAll()).not.toThrow();
  });

  it('keeps the good entries next to broken ones', () => {
    session.setItem(REG, JSON.stringify([null, { id: 'ab12', createdAt: 5 }, { id: 3 }]));
    // the good slot has no saved session: resumeAll drops it, listSlots before that shows it
    expect(duels.listSlots().map((s) => s.id)).toEqual(['ab12']);
  });
});

describe('removing a running duel', () => {
  it('connected: a loss is recorded at once, the opponent gets the win, the slot is gone', async () => {
    const host = outsideHost();
    await vi.waitFor(() => expect(host.s.code).toBeTruthy());
    const mine = duels.joinDuel(host.s.code!);
    await vi.waitFor(() => expect(host.s.state && mine.session.state).toBeTruthy(), { timeout: 4000 });
    await vi.waitFor(() => expect(host.s.status).toBe('playing'));
    duels.abandonSlot(mine.id);
    expect(records()).toMatchObject([{ kind: 'duelOnline', win: false, place: 2 }]);
    expect(duels.listSlots()).toEqual([]);
    await vi.waitFor(() => expect(host.s.state!.ended).toMatchObject({ reason: 'concede', winner: host.s.localSlot }));
    await vi.waitFor(() => expect(registry()).toEqual([]), { timeout: 4000 });
    expect(records()).toHaveLength(1);
    host.s.leave();
  });

  it('opponent offline: the concede waits (hidden, not counted) and is delivered when it is back', { timeout: 15_000 }, async () => {
    const host = outsideHost();
    await vi.waitFor(() => expect(host.s.code).toBeTruthy());
    const code = host.s.code!;
    const mine = duels.joinDuel(code);
    await vi.waitFor(() => expect(host.s.state && mine.session.state).toBeTruthy(), { timeout: 4000 });
    // the opponent's page goes away (its match is saved)
    host.s.dispose();
    await vi.waitFor(() => expect(mine.session.connected).toBe(false));
    duels.abandonSlot(mine.id);
    expect(records()).toMatchObject([{ kind: 'duelOnline', win: false }]);
    expect(duels.listSlots()).toEqual([]);
    expect(registry()).toMatchObject([{ id: mine.id, pending: true }]);
    expect(duels.canCreate()).toBe(true);
    // nothing reached the opponent yet
    const back = DuelSession.resume({ storage: host.storage, transport: BroadcastTransport.host(getClientId(host.storage), code) })!;
    expect(back.state!.ended).toBeNull();
    await vi.waitFor(() => expect(back.state!.ended).toMatchObject({ reason: 'concede', winner: back.localSlot }), { timeout: 6000 });
    // delivered: the hidden slot is forgotten; the loss is not recorded twice
    await vi.waitFor(() => expect(registry()).toEqual([]), { timeout: 6000 });
    expect(duels.slotSession(mine.id)).toBeNull();
    expect(records()).toHaveLength(1);
    back.leave();
  });

  it('a removed match still waiting survives a reload and is delivered after it', { timeout: 15_000 }, async () => {
    const host = outsideHost();
    await vi.waitFor(() => expect(host.s.code).toBeTruthy());
    const code = host.s.code!;
    const mine = duels.joinDuel(code);
    await vi.waitFor(() => expect(host.s.state && mine.session.state).toBeTruthy(), { timeout: 4000 });
    host.s.dispose();
    await vi.waitFor(() => expect(mine.session.connected).toBe(false));
    duels.abandonSlot(mine.id);
    // our page reloads
    mine.session.dispose();
    vi.resetModules();
    const fresh = (await import('../../src/ui/duels')) as typeof Duels;
    fresh.resumeAll();
    expect(fresh.listSlots()).toEqual([]);
    expect(fresh.slotSession(mine.id)).not.toBeNull();
    const back = DuelSession.resume({ storage: host.storage, transport: BroadcastTransport.host(getClientId(host.storage), code) })!;
    await vi.waitFor(() => expect(back.state!.ended).toMatchObject({ reason: 'concede', winner: back.localSlot }), { timeout: 6000 });
    await vi.waitFor(() => expect(registry()).toEqual([]), { timeout: 6000 });
    expect(records()).toHaveLength(1);
    back.leave();
  });
});

describe('a dead guest code', () => {
  it('a guest slot that never reached a host is not resumed after a reload', async () => {
    const j = duels.joinDuel('ZZZZ');
    expect(duels.listSlots()).toHaveLength(1);
    j.session.dispose();
    vi.resetModules();
    const fresh = (await import('../../src/ui/duels')) as typeof Duels;
    fresh.resumeAll();
    expect(fresh.listSlots()).toEqual([]);
    expect(registry()).toEqual([]);
  });
});
