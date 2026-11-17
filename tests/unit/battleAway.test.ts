import { afterEach, describe, expect, it, vi } from 'vitest';
import * as E from '../../src/core/engine';
import { BattleGuest, BattleHost } from '../../src/net/battleRoom';
import { createLoopbackHub } from '../../src/net/hub';
import { MemoryStorage } from '../../src/net/persist';
import { addGuest, battleSettings, expectAllSame, playTurn, type Room, type RoomOptions } from './battleHelpers';
import { fakeTimers } from './netHelpers';

// A guest who vanishes: the host sees for how long, can give the seat to a bot or skip the turn, and
// the turn is skipped by itself after a long absence. A concede asked for while offline is not lost.

afterEach(() => {
  vi.useRealTimers();
});

async function room(o: RoomOptions & { awaySkipMs?: number }): Promise<Room> {
  const hub = createLoopbackHub('BTL25');
  const hostStorage = new MemoryStorage();
  const host = BattleHost.create({
    settings: battleSettings(o),
    seed: o.seed ?? 77,
    name: 'Hosty',
    storage: hostStorage,
    clientId: 'HOST',
    transport: hub.host,
    heartbeatMs: 0,
    awaySkipMs: o.awaySkipMs ?? 0,
  });
  const r: Room = { hub, host, hostStorage, guests: [], bots: new Map(), botSeed: 5, resyncs: [] };
  await hub.flush();
  const n = o.players.filter((p) => p === 'online').length;
  for (let i = 0; i < n; i++) addGuest(r, `G${i + 1}`);
  await hub.flush();
  return r;
}

/** play turns until it is `seat`'s turn */
async function until(r: Room, seat: number) {
  for (let i = 0; i < 30 && r.host.state!.current !== seat && !r.host.state!.ended; i++) expect(await playTurn(r)).toBe(true);
  expect(r.host.state!.current).toBe(seat);
}

describe('a guest who is away', () => {
  it('awaySince tracks the offline guest seat; back online clears it', async () => {
    fakeTimers();
    const r = await room({ players: ['human', 'online', 'online', 'dummy'], seed: 12 });
    r.host.start();
    await r.hub.flush();
    const g = r.guests[0];
    const seat = g.g.seat;
    expect(r.host.awaySince(seat)).toBeNull();
    const t0 = Date.now();
    r.hub.disconnect(g.cid);
    await r.hub.flush();
    expect(r.host.awaySince(seat)).toBe(t0);
    vi.advanceTimersByTime(20_000);
    expect(Date.now() - r.host.awaySince(seat)!).toBe(20_000);
    r.hub.connect(g.cid);
    await r.hub.flush();
    expect(r.host.awaySince(seat)).toBeNull();
    // the host's own seat and bots are never away
    expect(r.host.awaySince(0)).toBeNull();
    expect(r.host.awaySince(3)).toBeNull();
  });

  it('fillWithBots(type, [seat]) gives just that seat to a bot; the guest is told "replaced" when back', async () => {
    const r = await room({ players: ['human', 'online', 'online', 'dummy'], seed: 13 });
    r.host.start();
    await r.hub.flush();
    const [a, b] = r.guests;
    r.hub.disconnect(a.cid);
    r.hub.disconnect(b.cid);
    await r.hub.flush();
    expect(r.host.fillWithBots('hunter', [a.g.seat])).toEqual([a.g.seat]);
    await r.hub.flush();
    expect(r.host.players[a.g.seat]).toBe('hunter');
    expect(r.host.players[b.g.seat]).toBe('online');
    expect(r.host.awaySince(a.g.seat)).toBeNull();
    r.hub.connect(a.cid);
    r.hub.connect(b.cid);
    await r.hub.flush();
    expect(a.g.status).toBe('error');
    expect(a.g.lastError?.code).toBe('replaced');
    expect(b.g.status).toBe('playing');
    r.guests.splice(0, 1);
    expectAllSame(r);
  });

  it("the host can skip the away guest's turn", async () => {
    const r = await room({ players: ['human', 'online', 'dummy'], seed: 14 });
    r.host.start();
    await r.hub.flush();
    const g = r.guests[0];
    r.hub.disconnect(g.cid);
    await r.hub.flush();
    await until(r, g.g.seat);
    const turn = r.host.state!.turn;
    expect(r.host.act(g.g.seat, { t: 'endTurn' }).ok).toBe(true);
    expect(r.host.state!.current).not.toBe(g.g.seat);
    r.hub.connect(g.cid);
    await r.hub.flush();
    expectAllSame(r);
    expect(r.host.state!.turn).toBeGreaterThanOrEqual(turn);
  });

  it('after awaySkipMs offline, the away seat is skipped automatically on its turn (not before)', async () => {
    fakeTimers();
    const r = await room({ players: ['human', 'online', 'dummy'], seed: 15, awaySkipMs: 90_000 });
    r.host.start();
    await r.hub.flush();
    const g = r.guests[0];
    const seat = g.g.seat;
    await until(r, seat);
    r.hub.disconnect(g.cid);
    await r.hub.flush();
    expect(r.host.awaySkipAt).toBe(Date.now() + 90_000);
    vi.advanceTimersByTime(89_000);
    expect(r.host.state!.current).toBe(seat);
    vi.advanceTimersByTime(1_500);
    expect(r.host.state!.current).not.toBe(seat);
    // on its next turn the seat (still away for > 90 s) is skipped at once
    for (let i = 0; i < 30 && r.host.state!.current !== seat; i++) {
      if (!(await playTurn(r))) break;
    }
    vi.advanceTimersByTime(0);
    expect(r.host.state!.current).not.toBe(seat);
    // back online: no automatic skips any more
    r.hub.connect(g.cid);
    await r.hub.flush();
    expect(r.host.awaySkipAt).toBeNull();
    expectAllSame(r);
  });

  it('a guest who comes back in time is not skipped', async () => {
    fakeTimers();
    const r = await room({ players: ['human', 'online', 'dummy'], seed: 16, awaySkipMs: 90_000 });
    r.host.start();
    await r.hub.flush();
    const g = r.guests[0];
    await until(r, g.g.seat);
    r.hub.disconnect(g.cid);
    await r.hub.flush();
    vi.advanceTimersByTime(60_000);
    r.hub.connect(g.cid);
    await r.hub.flush();
    vi.advanceTimersByTime(60_000);
    expect(r.host.state!.current).toBe(g.g.seat);
  });
});

describe('a concede while offline', () => {
  it('is queued and delivered when the link is back', async () => {
    const r = await room({ players: ['human', 'online', 'online', 'dummy'], seed: 21 });
    r.host.start();
    await r.hub.flush();
    const g = r.guests[0];
    r.hub.disconnect(g.cid);
    await r.hub.flush();
    let res: unknown = null;
    void g.g.request({ t: 'concede' }).then((x) => (res = x));
    await r.hub.flush();
    expect(res).toBeNull();
    expect(g.g.concedePending).toBe(true);
    expect(E.isAlive(r.host.state!, g.g.seat)).toBe(true);
    r.hub.connect(g.cid);
    await r.hub.flush();
    expect(res).toMatchObject({ ok: true });
    expect(g.g.concedePending).toBe(false);
    expect(E.isAlive(r.host.state!, g.g.seat)).toBe(false);
    expectAllSame(r);
  });

  it('survives a reload of the guest page while offline', async () => {
    const r = await room({ players: ['human', 'online', 'online', 'dummy'], seed: 22 });
    r.host.start();
    await r.hub.flush();
    const g = r.guests[1];
    const seat = g.g.seat;
    r.hub.disconnect(g.cid);
    await r.hub.flush();
    const lands = E.cellsOf(r.host.state!, seat);
    void g.g.request({ t: 'concede', to: 0 });
    g.g.dispose();
    expect(BattleGuest.saved(g.storage)?.out).toBe(false);
    const again = BattleGuest.resume(g.storage, { transport: r.hub.guest(g.cid), helloRetryMs: 0 })!;
    expect(again.concedePending).toBe(true);
    g.g = again;
    await r.hub.flush();
    expect(E.isAlive(r.host.state!, seat)).toBe(false);
    expect(again.concedePending).toBe(false);
    expect(lands.length).toBeGreaterThan(0);
    expect(lands.every(i => r.host.state!.field.cells[i].owner === 0)).toBe(true);
    expectAllSame(r);
  });

  it('refuses the transfer if the selected opponent went out while the guest was offline', async () => {
    const r = await room({ players: ['human', 'online', 'online', 'dummy'], seed: 22 });
    r.host.start();
    await r.hub.flush();
    const g = r.guests[0];
    const target = r.guests[1].g.seat;
    r.hub.disconnect(g.cid);
    await r.hub.flush();
    const pending = g.g.request({ t: 'concede', to: target });
    expect(r.host.act(target, { t: 'concede', to: 0 }).ok).toBe(true);
    r.hub.connect(g.cid);
    await r.hub.flush();
    expect(await pending).toMatchObject({ ok: false, reason: 'notAlive' });
    expect(E.isAlive(r.host.state!, g.g.seat)).toBe(true);
    expectAllSame(r);
  });

  it.each(['god', 'split'] as const)('replays a %s concession across reconnect and reload', async (to) => {
    const r = await room({ players: ['human', 'online', 'online', 'dummy'], seed: 32 });
    r.host.start();
    await r.hub.flush();
    const guest = r.guests[0];
    const seat = guest.g.seat;
    const board = structuredClone(r.host.state!.field.cells);
    r.hub.disconnect(guest.cid);
    await r.hub.flush();
    void guest.g.request({ t: 'concede', to });
    guest.g.dispose();
    guest.g = BattleGuest.resume(guest.storage, { transport: r.hub.guest(guest.cid), helloRetryMs: 0 })!;
    await r.hub.flush();
    expect(guest.g.concedePending).toBe(false);
    expect(guest.g.state!.ended).toBeNull();
    expectAllSame(r);
    if (to === 'god') {
      expect(r.host.state!.field.cells).toEqual(board);
      expect(r.host.personSeats).toEqual([0]);
      expect(guest.g.state!.settings.players[seat]).toBe('god');
      expect(guest.g.state!.godTakeovers).toEqual([seat]);
      expect(await guest.g.request({ t: 'endTurn' })).toMatchObject({ ok: false, reason: 'notYourSeat' });
      expect(r.host.act(0, { t: 'concede', to: 'god' }).ok).toBe(true);
      await r.hub.flush();
      expect(r.host.personSeats).toEqual([0]);
      expectAllSame(r);
    } else {
      expect(E.isAlive(r.host.state!, seat)).toBe(false);
    }
  });

  it('a concede sent online does not time out silently', async () => {
    fakeTimers();
    const r = await room({ players: ['human', 'online', 'dummy'], seed: 23 });
    r.host.start();
    await r.hub.flush();
    const g = r.guests[0];
    r.hub.dropNext(g.cid, 'host', 1);
    let res: unknown = null;
    void g.g.request({ t: 'concede' }).then((x) => (res = x));
    await r.hub.flush();
    vi.advanceTimersByTime(60_000);
    await Promise.resolve();
    expect(res).toBeNull();
    expect(g.g.concedePending).toBe(true);
    // the next heartbeats make the guest re-send it
    for (let i = 0; i < 3; i++) {
      r.host.heartbeat();
      await r.hub.flush();
    }
    expect(res).toMatchObject({ ok: true });
    expect(E.isAlive(r.host.state!, g.g.seat)).toBe(false);
  });
});

describe('a host that falls silent', () => {
  it('a guest counts the host as offline after silenceMs without a word, and online again when heard', async () => {
    fakeTimers();
    const r = await room({ players: ['human', 'online', 'dummy'], seed: 31 });
    const g = r.guests[0].g;
    const conn: boolean[] = [];
    g.on('connection', (c) => conn.push(c));
    expect(g.online).toBe(true);
    // heartbeats keep it online
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(3000);
      r.host.heartbeat();
      await r.hub.flush();
    }
    expect(g.online).toBe(true);
    // the host's page vanished without closing the link: nothing arrives any more
    vi.advanceTimersByTime(11_000);
    expect(g.connected).toBe(true);
    expect(g.online).toBe(false);
    expect(conn).toEqual([false]);
    r.host.heartbeat();
    await r.hub.flush();
    expect(g.online).toBe(true);
    expect(conn).toEqual([false, true]);
  });
});
