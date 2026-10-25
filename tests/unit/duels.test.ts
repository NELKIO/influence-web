import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as Duels from '../../src/ui/duels';
import { DuelSession } from '../../src/net/duelSession';
import { BroadcastTransport } from '../../src/net/broadcast';

// The duel slots of the app, run with the same-browser transport (?transport=bc), so nothing leaves
// the process. With it the slots live in sessionStorage.

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
let duels: typeof Duels;

beforeAll(async () => {
  g.location = { search: '?transport=bc', origin: 'https://example.org', hash: '' };
  g.sessionStorage = session;
  g.localStorage = new MapStorage();
  duels = await import('../../src/ui/duels');
});
afterEach(() => {
  for (const s of duels.listSlots()) duels.removeSlot(s.id);
  session.clear();
  vi.useRealTimers();
});
afterAll(() => {
  delete g.location;
  delete g.sessionStorage;
  delete g.localStorage;
});

const opts = { size: 'S' as const, darkness: false, turnTime: 0 };
const registry = () => JSON.parse(session.getItem('infweb.duelSlots') ?? '[]') as { id: string }[];

describe('duel slots', () => {
  it(`up to MAX_DUELS matches at once, newest first`, () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    expect(duels.MAX_DUELS).toBe(5);
    expect(duels.canCreate()).toBe(true);
    const ids: string[] = [];
    for (let i = 0; i < duels.MAX_DUELS; i++) {
      vi.setSystemTime(1_000_000 + i * 1000);
      const { id, session: s } = duels.hostDuel(opts);
      ids.push(id);
      expect(duels.slotSession(id)).toBe(s);
      expect(duels.slotIdOf(s)).toBe(id);
    }
    expect(duels.canCreate()).toBe(false);
    expect(duels.listSlots().map((s) => s.id)).toEqual([...ids].reverse());
    expect(new Set(ids).size).toBe(ids.length);
    expect(duels.myTurnCount()).toBe(0);
  });

  it('every slot has its own storage namespace; removeSlot leaves the room and clears it', async () => {
    const changes = vi.fn();
    const off = duels.onDuelsChange(changes);
    const a = duels.hostDuel(opts);
    const b = duels.hostDuel(opts);
    await vi.waitFor(() => expect(a.session.code && b.session.code).toBeTruthy());
    // each slot persisted its own session
    const keysOf = (id: string) => [...session.m.keys()].filter((k) => k.startsWith(`infweb.duel/${id}/`));
    await vi.waitFor(() => expect(keysOf(a.id).length && keysOf(b.id).length).toBeTruthy());
    expect(changes).toHaveBeenCalled();
    const leave = vi.spyOn(a.session, 'leave');
    duels.removeSlot(a.id);
    expect(leave).toHaveBeenCalled();
    expect(keysOf(a.id)).toEqual([]);
    expect(keysOf(b.id).length).toBeGreaterThan(0);
    expect(registry().map((r) => r.id)).toEqual([b.id]);
    expect(duels.slotSession(a.id)).toBeNull();
    expect(duels.slotIdOf(a.session)).toBeNull();
    expect(duels.canCreate()).toBe(true);
    off();
    // removing an unknown slot is harmless
    duels.removeSlot('nope');
  });

  it('joining a room you are already in returns that slot (your own hosted room too)', async () => {
    const host = duels.hostDuel(opts);
    await vi.waitFor(() => expect(host.session.code).toBeTruthy());
    expect(duels.joinDuel(host.session.code!).id).toBe(host.id);
    const other = outsideHost();
    await vi.waitFor(() => expect(other.code).toBeTruthy());
    const j1 = duels.joinDuel(other.code!);
    const j2 = duels.joinDuel(other.code!);
    expect(j2.id).toBe(j1.id);
    expect(j1.session.role).toBe('guest');
    expect(duels.listSlots()).toHaveLength(2);
    other.leave();
  });

  it('a guest slot connects to a host on another "tab" and is told when it is its turn while elsewhere', async () => {
    const notes: [string, string][] = [];
    duels.setDuelNotifier((kind, slot) => notes.push([kind, slot]));
    const host = outsideHost();
    await vi.waitFor(() => expect(host.code).toBeTruthy());
    const guest = duels.joinDuel(host.code!);
    await vi.waitFor(() => expect(host.state && guest.session.state).toBeTruthy(), { timeout: 4000 });
    // exactly one side moves first
    await vi.waitFor(() => expect(Number(host.isMyTurn) + Number(guest.session.isMyTurn)).toBe(1));
    expect(duels.myTurnCount()).toBe(Number(guest.session.isMyTurn));
    if (guest.session.isMyTurn) await vi.waitFor(() => expect(notes).toContainEqual(['turn', guest.id]));
    else expect(notes).toEqual([]);
    // while the slot is on screen nothing is announced
    notes.length = 0;
    duels.setViewing(guest.id);
    host.concede();
    await vi.waitFor(() => expect(guest.session.state?.ended).toBeTruthy());
    expect(notes).toEqual([]);
    duels.setViewing(null);
    duels.setDuelNotifier(() => {});
    host.leave();
  });

  it('resume after a reload: saved slots reconnect, slots without a saved match are dropped', async () => {
    const a = duels.hostDuel(opts);
    await vi.waitFor(() => expect(DuelSession.saved(storageView(a.id))).not.toBeNull());
    const code = a.session.code;
    // a slot whose storage is gone
    session.setItem('infweb.duelSlots', JSON.stringify([...registry(), { id: 'ghost', createdAt: 1 }]));
    // "reload": the old page's session goes away keeping its saved state, the module starts afresh
    a.session.dispose();
    vi.resetModules();
    const fresh = (await import('../../src/ui/duels')) as typeof Duels;
    expect(fresh.slotSession(a.id)).toBeNull();
    fresh.resumeAll();
    const back = fresh.slotSession(a.id);
    expect(back).not.toBeNull();
    expect(back!.code).toBe(code);
    expect(back!.role).toBe('host');
    expect(registry().map((r) => r.id)).toEqual([a.id]);
    // resuming twice keeps the same session
    fresh.resumeAll();
    expect(fresh.slotSession(a.id)).toBe(back);
    fresh.removeSlot(a.id);
    expect(registry()).toEqual([]);
  });
});

/** A host in "another tab": its own storage and client id, the same BroadcastChannel. */
function outsideHost() {
  const storage = new MapStorage();
  return DuelSession.host({ ...opts, symmetry: true, storage, transport: BroadcastTransport.host('outside-' + Math.random().toString(36).slice(2)) });
}

/** the namespaced storage of a slot, as DuelSession sees it */
function storageView(id: string) {
  const p = `infweb.duel/${id}/`;
  return { getItem: (k: string) => session.getItem(p + k), setItem: (k: string, v: string) => session.setItem(p + k, v), removeItem: (k: string) => session.removeItem(p + k) };
}
