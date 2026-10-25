import { afterEach, describe, expect, it, vi } from 'vitest';
import { BroadcastTransport, useBroadcastTransport } from '../../src/net/broadcast';
import { BroadcastBattleGuest, BroadcastBattleHost } from '../../src/net/broadcastBattle';
import type { TransportError } from '../../src/net/transport';

// Two endpoints in one process talk over Node's BroadcastChannel, like two tabs of one browser.

const opened: { close(): void }[] = [];
const track = <T extends { close(): void }>(t: T): T => (opened.push(t), t);
afterEach(() => {
  for (const t of opened.splice(0)) t.close();
  vi.useRealTimers();
});

let n = 0;
/** a fresh room code per test (valid alphabet), so tests never hear each other */
const code4 = () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[n++ % 32] + 'Q' + 'R' + 'S';
const code5 = () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[n++ % 32] + 'WXYZ';

function events(t: { onOpen(f: () => void): unknown; onClose(f: () => void): unknown; onMessage(f: (m: unknown) => void): unknown; onError(f: (e: TransportError) => void): unknown }) {
  const log = { open: 0, close: 0, msgs: [] as unknown[], errors: [] as TransportError[] };
  t.onOpen(() => log.open++);
  t.onClose(() => log.close++);
  t.onMessage((m) => log.msgs.push(m));
  t.onError((e) => log.errors.push(e));
  return log;
}

describe('BroadcastTransport (duels)', () => {
  it('is enabled by ?transport=bc only', () => {
    expect(useBroadcastTransport()).toBe(false);
    const g = globalThis as { location?: unknown };
    g.location = { search: '?transport=bc' };
    try {
      expect(useBroadcastTransport()).toBe(true);
      g.location = { search: '?transport=peer' };
      expect(useBroadcastTransport()).toBe(false);
    } finally {
      delete g.location;
    }
  });

  it('host and guest connect, exchange messages both ways and close', async () => {
    const code = code4();
    const host = track(BroadcastTransport.host('host-1', code));
    const ready: string[] = [];
    host.onReady((c) => ready.push(c));
    const h = events(host);
    expect(host.send({ x: 1 })).toBe(false);
    const guest = track(BroadcastTransport.join(code, 'guest-1'));
    guest.onReady((c) => ready.push('g' + c));
    const g = events(guest);
    await vi.waitFor(() => expect(host.isOpen && guest.isOpen).toBe(true));
    expect(ready).toEqual([code, 'g' + code]);
    expect(host.role).toBe('host');
    expect(guest.role).toBe('guest');
    expect(host.remoteClientId).toBe('guest-1');
    expect(guest.remoteClientId).toBe('host-1');
    expect([h.open, g.open]).toEqual([1, 1]);

    expect(host.send({ t: 'hello', n: [1, 2] })).toBe(true);
    expect(guest.send({ t: 'hi' })).toBe(true);
    await vi.waitFor(() => expect(g.msgs).toEqual([{ t: 'hello', n: [1, 2] }]));
    await vi.waitFor(() => expect(h.msgs).toEqual([{ t: 'hi' }]));

    guest.close();
    expect(guest.isOpen).toBe(false);
    expect(guest.send({})).toBe(false);
    await vi.waitFor(() => expect(h.close).toBe(1));
    expect(host.isOpen).toBe(false);
    // closing twice is harmless
    guest.close();
  });

  it('the same guest reconnects after a reload; a different one is turned away', async () => {
    const code = code4();
    const host = track(BroadcastTransport.host('host', code));
    const h = events(host);
    const g1 = track(BroadcastTransport.join(code, 'me'));
    await vi.waitFor(() => expect(g1.isOpen).toBe(true));
    g1.close();
    await vi.waitFor(() => expect(host.isOpen).toBe(false));
    // "reload": a new endpoint with the same client id
    const g2 = track(BroadcastTransport.join(code, 'me'));
    const e2 = events(g2);
    await vi.waitFor(() => expect(g2.isOpen && host.isOpen).toBe(true));
    expect(h.open).toBe(2);
    host.send('again');
    await vi.waitFor(() => expect(e2.msgs).toEqual(['again']));

    const other = track(BroadcastTransport.join(code, 'stranger'));
    const eo = events(other);
    await vi.waitFor(() => expect(eo.errors.map((e) => e.code)).toEqual(['room-full']));
    expect(eo.errors[0].fatal).toBe(true);
    expect(other.isOpen).toBe(false);
    expect(host.remoteClientId).toBe('me');
  });

  it('the host closing tells the guest', async () => {
    const code = code4();
    const host = track(BroadcastTransport.host('h', code));
    const guest = track(BroadcastTransport.join(code, 'g'));
    const g = events(guest);
    await vi.waitFor(() => expect(guest.isOpen).toBe(true));
    host.close();
    await vi.waitFor(() => expect(g.close).toBe(1));
    expect(host.send('x')).toBe(false);
  });

  it('an invalid code fails at once; a room nobody hosts fails after the retries', async () => {
    const bad = track(BroadcastTransport.join('ab', 'g'));
    const b = events(bad);
    await vi.waitFor(() => expect(b.errors).toEqual([{ code: 'bad-code', message: 'invalid code', fatal: true }]));

    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const lonely = track(BroadcastTransport.join(code4(), 'g'));
    const l = events(lonely);
    await Promise.resolve();
    vi.advanceTimersByTime(300 * 10);
    expect(l.errors).toEqual([]);
    vi.advanceTimersByTime(400);
    expect(l.errors.map((e) => e.code)).toEqual(['bad-code']);
  });

  it('a generated host code is a valid duel code', async () => {
    const host = track(BroadcastTransport.host('h'));
    const codes: string[] = [];
    host.onReady((c) => codes.push(c));
    await vi.waitFor(() => expect(codes).toHaveLength(1));
    expect(codes[0]).toMatch(/^[A-Z2-9]{4}$/);
    expect(host.code).toBe(codes[0]);
  });
});

describe('BroadcastBattleHost / Guest (battle rooms)', () => {
  function guestLog(g: BroadcastBattleGuest) {
    return events(g);
  }
  /** A host announces itself ("hostUp") once it is ready; guests that open after that dial once. */
  async function up(code: string) {
    const host = track(BroadcastBattleHost.create('host', code));
    await new Promise<void>((r) => host.onReady(() => r()));
    return host;
  }

  it('several guests join; messages are addressed; guests never see each other’s traffic', async () => {
    const code = code5();
    const host = track(BroadcastBattleHost.create('host', code));
    const joins: string[] = [];
    const leaves: string[] = [];
    const msgs: [string, unknown][] = [];
    const ready: string[] = [];
    host.onReady((c) => ready.push(c));
    await vi.waitFor(() => expect(ready).toHaveLength(1));
    host.onJoin((c) => joins.push(c));
    host.onLeave((c) => leaves.push(c));
    host.onMessage((c, m) => msgs.push([c, m]));
    const a = track(BroadcastBattleGuest.join(code, 'A'));
    const b = track(BroadcastBattleGuest.join(code, 'B'));
    const la = guestLog(a);
    const lb = guestLog(b);
    await vi.waitFor(() => expect(a.isOpen && b.isOpen).toBe(true));
    expect(ready).toEqual([code]);
    expect(joins.sort()).toEqual(['A', 'B']);
    expect(host.clients.sort()).toEqual(['A', 'B']);
    expect(host.isOpen('A')).toBe(true);
    expect(host.isOpen('C')).toBe(false);
    expect(a.role).toBe('guest');
    expect(a.remoteClientId).toBe('host');

    expect(host.send('A', { to: 'A' })).toBe(true);
    expect(host.send('B', { to: 'B' })).toBe(true);
    expect(host.send('C', { to: 'C' })).toBe(false);
    a.send({ from: 'A' });
    b.send({ from: 'B' });
    await vi.waitFor(() => expect(msgs).toHaveLength(2));
    await vi.waitFor(() => expect(la.msgs.length + lb.msgs.length).toBe(2));
    expect(la.msgs).toEqual([{ to: 'A' }]);
    expect(lb.msgs).toEqual([{ to: 'B' }]);
    expect(msgs.sort()).toEqual([
      ['A', { from: 'A' }],
      ['B', { from: 'B' }],
    ]);

    // a guest leaving
    b.close();
    await vi.waitFor(() => expect(leaves).toEqual(['B']));
    expect(host.clients).toEqual(['A']);
    expect(b.send('x')).toBe(false);
  });

  it('kick closes a guest’s link; the guest rejoining replaces its old link', async () => {
    const code = code5();
    const host = await up(code);
    const joins: string[] = [];
    const leaves: string[] = [];
    host.onJoin((c) => joins.push(c));
    host.onLeave((c) => leaves.push(c));
    const a = track(BroadcastBattleGuest.join(code, 'A'));
    const la = guestLog(a);
    await vi.waitFor(() => expect(a.isOpen).toBe(true));
    host.kick('A');
    await vi.waitFor(() => expect(la.close).toBe(1));
    expect(leaves).toEqual(['A']);
    host.kick('nobody');
    // a reload of the same guest
    const a2 = track(BroadcastBattleGuest.join(code, 'A'));
    await vi.waitFor(() => expect(a2.isOpen).toBe(true));
    expect(joins).toEqual(['A', 'A']);
    expect(host.clients).toEqual(['A']);
  });

  it('a host reload: the guests redial and are back in the room', async () => {
    const code = code5();
    const host = await up(code);
    const a = track(BroadcastBattleGuest.join(code, 'A'));
    const la = guestLog(a);
    await vi.waitFor(() => expect(a.isOpen).toBe(true));
    host.close();
    await vi.waitFor(() => expect(la.close).toBe(1));
    expect(a.isOpen).toBe(false);
    const again = track(BroadcastBattleHost.create('host', code));
    const joins: string[] = [];
    again.onJoin((c) => joins.push(c));
    await vi.waitFor(() => expect(a.isOpen).toBe(true), { timeout: 3000 });
    expect(joins).toEqual(['A']);
    expect(la.open).toBe(2);
    again.send('A', 'welcome back');
    await vi.waitFor(() => expect(la.msgs).toEqual(['welcome back']));
    // closing the host twice is harmless; sends after closing are dropped
    again.close();
    again.close();
    expect(again.send('A', 'x')).toBe(false);
  });

  it('bad or missing room codes are fatal for the guest', async () => {
    const bad = track(BroadcastBattleGuest.join('ABCD', 'A'));
    const lb = guestLog(bad);
    await vi.waitFor(() => expect(lb.errors).toEqual([{ code: 'bad-code', message: 'invalid code', fatal: true }]));

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const lonely = track(BroadcastBattleGuest.join(code5(), 'A'));
    const ll = guestLog(lonely);
    await Promise.resolve();
    vi.advanceTimersByTime(300 * 10);
    expect(ll.errors).toEqual([]);
    vi.advanceTimersByTime(400);
    expect(ll.errors.map((e) => e.code)).toEqual(['bad-code']);
    expect(lonely.send('x')).toBe(false);
  });
});
