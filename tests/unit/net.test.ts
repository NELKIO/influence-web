import { afterEach, describe, expect, it, vi } from 'vitest';
import * as E from '../../src/core/engine';
import { DuelSession } from '../../src/net/duelSession';
import { MemoryStorage } from '../../src/net/persist';
import { parseMessage, PROTOCOL_VERSION, stateHash } from '../../src/net/protocol';
import { CODE_ALPHABET, generateCode, hostPeerId, inviteUrl, isValidCode, normalizeCode, parseInvite } from '../../src/net/room';
import { createLoopbackPair } from '../../src/net/transport';
import { active, expectSame, fakeTimers, makeDuo, nextScriptedAttack, playScriptedTurn } from './netHelpers';

afterEach(() => {
  vi.useRealTimers();
});

describe('room codes & invites', () => {
  it('generates valid unambiguous codes', () => {
    for (let i = 0; i < 500; i++) {
      const c = generateCode();
      expect(c).toMatch(/^[A-Z2-9]{4}$/);
      expect(isValidCode(c)).toBe(true);
      expect(c).not.toMatch(/[01OI]/);
    }
    expect(CODE_ALPHABET).not.toMatch(/[01OI]/);
    expect(isValidCode('AB0C')).toBe(false);
    expect(isValidCode('ABC')).toBe(false);
    expect(normalizeCode(' ab-2c ')).toBe('AB2C');
    expect(hostPeerId('AB2C')).toBe('infweb-AB2C');
  });

  it('builds and parses invite links', () => {
    const url = inviteUrl('XY7Z', 'https://example.org');
    expect(url).toBe(`https://example.org${import.meta.env.BASE_URL}#/duel/XY7Z`);
    expect(parseInvite(url)).toBe('XY7Z');
    expect(parseInvite('#/duel/xy7z')).toBe('XY7Z');
    expect(parseInvite('/duel/XY7Z/')).toBe('XY7Z');
    expect(parseInvite('#/duel/XY0Z')).toBe(null);
    expect(parseInvite('#/daily')).toBe(null);
  });
});

describe('protocol', () => {
  it('validates messages', () => {
    expect(parseMessage({ t: 'action', seq: 1, a: { t: 'attack', from: 1, to: 2, win: true } })).toBeTruthy();
    expect(parseMessage(JSON.stringify({ t: 'action', seq: 3, a: { t: 'endTurn' } }))).toBeTruthy();
    expect(parseMessage({ t: 'action', seq: 0, a: { t: 'endTurn' } })).toBe(null);
    expect(parseMessage({ t: 'action', seq: 1, a: { t: 'power', cell: 1, amount: 0 } })).toBe(null);
    expect(parseMessage({ t: 'action', seq: 1, a: { t: 'attack', from: 1, to: 2 } })).toBe(null);
    expect(parseMessage({ t: 'nope' })).toBe(null);
    expect(parseMessage('not json')).toBe(null);
    expect(parseMessage(null)).toBe(null);
    const h = parseMessage({ t: 'hello', v: 1, clientId: 'x', name: 'n', matchId: null, seq: 0, hash: '' });
    expect(h && h.t === 'hello' && h.ended === null && h.rematch === false).toBe(true);
  });
});

describe('online duel over loopback', () => {
  it('sets up a match with mapped perspectives', async () => {
    const d = await makeDuo();
    expect(d.host.status).toBe('playing');
    expect(d.guest.status).toBe('playing');
    expect(d.guest.code).toBe('AB2C');
    expect(d.host.opponentName).toBe('Guesty');
    expect(d.guest.opponentName).toBe('Hosty');
    expect(d.host.localSlot).toBe(0);
    expect(d.guest.localSlot).toBe(1);
    const hs = d.host.state!;
    const gs = d.guest.state!;
    expect(hs.settings.kind).toBe('duelOnline');
    expect(hs.settings.duelRules).toBe(true);
    expect(hs.settings.players).toEqual(['human', 'remote']);
    expect(gs.settings.players).toEqual(['remote', 'human']);
    expect(gs.viewer).toBe(1);
    expect(d.host.matchId).toBe(d.guest.matchId);
    expectSame(hs, gs);
    expect(d.host.isMyTurn).toBe(true);
    expect(d.guest.isMyTurn).toBe(false);
  });

  it('plays a full scripted duel to the end with identical states every turn', async () => {
    const d = await makeDuo({ size: 'M', seed: 777 });
    const fights: number[] = [];
    const powers: number[] = [];
    d.guest.onRemoteFight(() => fights.push(1));
    d.host.onRemoteFight(() => fights.push(2));
    d.guest.onRemotePower((e) => powers.push(e.amount));
    const ends: { who: string; won: boolean; winner: number }[] = [];
    d.host.onEnd((e) => ends.push({ who: 'host', won: e.won, winner: e.winner }));
    d.guest.onEnd((e) => ends.push({ who: 'guest', won: e.won, winner: e.winner }));
    let turns = 0;
    while (!d.host.state!.ended && turns < 400) {
      const a = active(d);
      // the other one must not be able to act
      const other = a === d.host ? d.guest : d.host;
      const mv = nextScriptedAttack(a.state!);
      if (mv) expect(other.attack(mv.from, mv.to)).toBe('notYourTurn');
      expect(other.endTurn()).toBe(false);
      playScriptedTurn(a);
      await d.link.flush();
      expectSame(d.host.state, d.guest.state);
      expect(d.host.seq).toBe(d.guest.seq);
      turns++;
    }
    console.log(`scripted duel: ${turns} turns, ${fights.length} remote fights, winner slot ${d.host.state!.ended?.winner}`);
    expect(d.host.state!.ended).toBeTruthy();
    expect(d.guest.state!.ended).toBeTruthy();
    expect(d.host.state!.ended!.reason).toBe('elimination');
    expect(d.host.status).toBe('ended');
    expect(d.guest.status).toBe('ended');
    expect(ends).toHaveLength(2);
    const [h, g] = [ends.find((e) => e.who === 'host')!, ends.find((e) => e.who === 'guest')!];
    expect(h.winner).toBe(g.winner);
    expect(h.won).toBe(!g.won);
    expect(d.host.state!.ended!.humanWon).toBe(h.won);
    expect(d.guest.state!.ended!.humanWon).toBe(g.won);
    expect(fights.length).toBeGreaterThan(10);
    expect(powers.length).toBeGreaterThan(0);
    expect(d.resyncs).toEqual([]);
  });

  it('rejects out-of-turn and illegal remote actions (host state wins)', async () => {
    const d = await makeDuo();
    const before = stateHash(d.host.state!);
    const hostSent = d.link.host.sent.length;
    // host's turn: an action "from the guest" is out of turn
    d.link.host.inject({ t: 'action', seq: 1, a: { t: 'endAttack' } });
    expect(stateHash(d.host.state!)).toBe(before);
    expect(d.host.seq).toBe(0);
    expect(d.link.host.sent.slice(hostSent).some((m) => (m as { t: string }).t === 'sync')).toBe(true);
    await d.link.flush();
    expectSame(d.host.state, d.guest.state);

    // play host turn so it is the guest's turn
    playScriptedTurn(d.host);
    await d.link.flush();
    expect(d.guest.isMyTurn).toBe(true);
    const st = d.host.state!;
    const seq = d.host.seq;
    const own = E.cellsOf(st, d.guest.localSlot)[0];
    // non-adjacent attack
    const far = st.field.cells.findIndex((_, i) => i !== own && !st.field.adj[own].includes(i));
    const h1 = stateHash(st);
    d.link.host.inject({ t: 'action', seq: seq + 1, a: { t: 'attack', from: own, to: far, win: true } });
    expect(stateHash(d.host.state!)).toBe(h1);
    expect(d.host.seq).toBe(seq);
    // impossible outcome: attacking with power 1 can never win
    const weak = E.cellsOf(st, d.guest.localSlot).find((i) => st.field.cells[i].power < 2);
    if (weak !== undefined) {
      const tgt = st.field.adj[weak].find((n) => st.field.cells[n].owner !== d.guest.localSlot);
      if (tgt !== undefined) d.link.host.inject({ t: 'action', seq: seq + 1, a: { t: 'attack', from: weak, to: tgt, win: true } });
    }
    // power in attack phase
    d.link.host.inject({ t: 'action', seq: seq + 1, a: { t: 'power', cell: own, amount: 1 } });
    // gap
    d.link.host.inject({ t: 'action', seq: seq + 5, a: { t: 'endAttack' } });
    expect(stateHash(d.host.state!)).toBe(h1);
    expect(d.host.seq).toBe(seq);
    // garbage
    d.link.host.inject({ t: 'action', seq: 'x' });
    d.link.host.inject(42);
    await d.link.flush();
    expectSame(d.host.state, d.guest.state);
    // the guest can still play normally afterwards
    playScriptedTurn(d.guest);
    await d.link.flush();
    expectSame(d.host.state, d.guest.state);
    expect(d.host.isMyTurn).toBe(true);
  });

  it('impossible fight outcomes from the remote are rejected', async () => {
    const d = await makeDuo();
    playScriptedTurn(d.host); // now it's the guest's turn

    await d.link.flush();
    const gst = d.host.state!;
    const g = d.guest.localSlot;
    let found: { from: number; to: number } | null = null;
    for (const from of E.cellsOf(gst, g)) for (const to of E.targetsFrom(gst, from)) if (E.winChance(gst.field.cells[from].power, gst.field.cells[to].power) === 1) found ??= { from, to };
    expect(found).toBeTruthy();
    const h = stateHash(gst);
    d.link.host.inject({ t: 'action', seq: d.host.seq + 1, a: { t: 'attack', from: found!.from, to: found!.to, win: false } });
    expect(stateHash(d.host.state!)).toBe(h);
    expect(d.resyncs.some((r) => r.includes('impossible'))).toBe(true);
  });

  it('survives a disconnect: actions made offline are resent on reconnect', async () => {
    const d = await makeDuo({ size: 'M', seed: 99 });
    const statuses: string[] = [];
    d.guest.onStatus((s) => statuses.push(s));
    playScriptedTurn(d.host);
    await d.link.flush();
    d.link.disconnect();
    expect(d.guest.status).toBe('reconnecting');
    expect(d.host.status).toBe('reconnecting');
    expect(d.guest.connected).toBe(false);
    // guest keeps playing its turn while offline
    playScriptedTurn(d.guest);
    expect(d.guest.seq).toBeGreaterThan(d.host.seq);
    d.link.connect();
    await d.link.flush();
    expect(d.guest.status).toBe('playing');
    expect(d.host.status).toBe('playing');
    expect(statuses).toEqual(['reconnecting', 'playing']);
    expectSame(d.host.state, d.guest.state);
    expect(d.host.seq).toBe(d.guest.seq);
    expect(d.host.isMyTurn).toBe(true);
    // and the game goes on
    for (let i = 0; i < 4; i++) {
      playScriptedTurn(active(d));
      await d.link.flush();
      expectSame(d.host.state, d.guest.state);
    }
    expect(d.resyncs).toEqual([]);
  });

  it('messages lost in flight are recovered after reconnect', async () => {
    const d = await makeDuo({ size: 'M', seed: 5 });
    d.link.dropNext(d.link.host, 3);
    playScriptedTurn(d.host);
    await d.link.flush();
    // the guest saw a gap and asked for a sync; the host answered with its state
    expectSame(d.host.state, d.guest.state);
    expect(d.resyncs.length).toBeGreaterThan(0);
    expect(d.guest.isMyTurn).toBe(true);
  });

  it('resyncs from the host after a state mismatch (host state wins)', async () => {
    const d = await makeDuo({ size: 'M', seed: 42 });
    playScriptedTurn(d.host);
    await d.link.flush();
    // corrupt the guest's local copy
    const gs = d.guest.state!;
    const cell = gs.field.cells.find((c) => c.owner === d.host.localSlot)!;
    cell.power = cell.power === 1 ? 2 : 1;
    // guest plays; on endTurn the host's ack hash differs (or an action is illegal) -> sync
    playScriptedTurn(d.guest);
    await d.link.flush();
    expect(d.resyncs.length).toBeGreaterThan(0);
    expectSame(d.host.state, d.guest.state);
    // keep playing consistently
    for (let i = 0; i < 3; i++) {
      playScriptedTurn(active(d));
      await d.link.flush();
      expectSame(d.host.state, d.guest.state);
    }
  });

  it('resumes after a guest page reload from storage', async () => {
    const d = await makeDuo({ size: 'M', seed: 3 });
    playScriptedTurn(d.host);
    await d.link.flush();
    playScriptedTurn(d.guest);
    await d.link.flush();
    const seq = d.guest.seq;
    // reload: the guest page dies, a new session resumes from the same storage
    d.guest.dispose();
    const saved = DuelSession.saved(d.guestStorage);
    expect(saved).toMatchObject({ role: 'guest', code: 'AB2C', inMatch: true, ended: false });
    // meanwhile the host plays its turn (guest is offline)
    playScriptedTurn(d.host);
    const t = d.link.newGuest();
    const g2 = DuelSession.resume({ storage: d.guestStorage, transport: t, pingMs: 0 })!;
    expect(g2).toBeTruthy();
    expect(g2.status).toBe('reconnecting');
    expect(g2.seq).toBe(seq);
    expect(g2.localSlot).toBe(1);
    d.link.connect();
    await d.link.flush();
    expect(g2.status).toBe('playing');
    expectSame(d.host.state, g2.state);
    expect(g2.isMyTurn).toBe(true);
    playScriptedTurn(g2);
    await d.link.flush();
    expectSame(d.host.state, g2.state);
    // join() with the same code also resumes the saved session
    g2.dispose();
    const g3 = DuelSession.join('AB2C', { storage: d.guestStorage, transport: d.link.newGuest(), pingMs: 0 });
    expect(g3.seq).toBe(d.host.seq);
    d.link.connect();
    await d.link.flush();
    expectSame(d.host.state, g3.state);
  });

  it('resumes after a host page reload', async () => {
    const d = await makeDuo({ size: 'M', seed: 8 });
    playScriptedTurn(d.host);
    await d.link.flush();
    d.host.dispose();
    playScriptedTurn(d.guest); // guest plays while the host is gone
    const h2 = DuelSession.resume({ storage: d.hostStorage, transport: d.link.newHost(), pingMs: 0 })!;
    expect(h2.role).toBe('host');
    expect(h2.code).toBe('AB2C');
    d.link.connect();
    await d.link.flush();
    expectSame(h2.state, d.guest.state);
    expect(h2.isMyTurn).toBe(true);
    playScriptedTurn(h2);
    await d.link.flush();
    expectSame(h2.state, d.guest.state);
  });

  it('a guest that lost its storage gets the running match again', async () => {
    const d = await makeDuo();
    playScriptedTurn(d.host);
    await d.link.flush();
    d.guest.dispose();
    const g2 = DuelSession.join('AB2C', { storage: new MemoryStorage(), clientId: 'G', transport: d.link.newGuest(), pingMs: 0 });
    d.link.connect();
    await d.link.flush();
    expect(g2.status).toBe('playing');
    expectSame(d.host.state, g2.state);
    expect(g2.isMyTurn).toBe(true);
  });

  it('a different client cannot take over a running room', async () => {
    const d = await makeDuo();
    d.guest.dispose();
    const intruder = DuelSession.join('AB2C', { storage: new MemoryStorage(), clientId: 'X', transport: d.link.newGuest(), pingMs: 0 });
    const errors: string[] = [];
    intruder.onError((e) => errors.push(e.code));
    d.link.connect();
    await d.link.flush();
    expect(intruder.status).toBe('error');
    expect(errors).toContain('room-full');
    expect(d.host.peerClientId).toBe('G');
  });

  it('an invalid room code is a fatal error', async () => {
    const link = createLoopbackPair({ code: 'AB2C' });
    const guest = DuelSession.join('AB0C', { transport: link.guest, storage: null, clientId: 'G', pingMs: 0 });
    const errs: string[] = [];
    guest.onError((e) => errs.push(e.code));
    await link.flush();
    expect(guest.status).toBe('error');
    expect(errs).toEqual(['bad-code']);
  });

  it('protocol version mismatch is a fatal error', async () => {
    const link = createLoopbackPair();
    const host = DuelSession.host({ transport: link.host, storage: null, pingMs: 0, clientId: 'H' });
    const errs: string[] = [];
    host.onError((e) => errs.push(e.code));
    await link.flush();
    link.guest.send({ t: 'hello', v: PROTOCOL_VERSION + 1, clientId: 'G', name: 'old', matchId: null, seq: 0, hash: '' });
    await link.flush();
    expect(host.status).toBe('error');
    expect(errs).toEqual(['version']);
  });

  it('concede ends the match for both sides', async () => {
    const d = await makeDuo();
    playScriptedTurn(d.host);
    await d.link.flush();
    const ends: [string, boolean, string][] = [];
    d.host.onEnd((e) => ends.push(['host', e.won, e.reason]));
    d.guest.onEnd((e) => ends.push(['guest', e.won, e.reason]));
    expect(d.host.concede()).toBe(true); // allowed even when it's not our turn
    await d.link.flush();
    expect(ends).toEqual([
      ['host', false, 'concede'],
      ['guest', true, 'concede'],
    ]);
    expect(d.guest.state!.ended!.winner).toBe(d.guest.localSlot);
    expect(d.host.status).toBe('ended');
    expect(d.guest.status).toBe('ended');
    expect(d.guest.attack(0, 1)).toBe('notYourTurn');
    expect(d.host.concede()).toBe(false);
  });

  it('a concede made offline is delivered on reconnect', async () => {
    const d = await makeDuo();
    d.link.disconnect();
    d.guest.concede();
    expect(d.host.state!.ended).toBe(null);
    d.link.connect();
    await d.link.flush();
    expect(d.host.state!.ended).toMatchObject({ reason: 'concede', winner: d.host.localSlot, humanWon: true });
    expect(d.host.status).toBe('ended');
  });

  it('turn timer: the active client auto-finishes its turn when time runs out', async () => {
    fakeTimers();
    const d = await makeDuo({ turnTime: 10 });
    expect(d.host.turnDeadline).toBeGreaterThan(Date.now());
    expect(d.host.timeLeftMs()).toBe(10_000);
    const turns: boolean[] = [];
    d.guest.onTurn((t) => turns.push(t.mine));
    // host makes one attack then idles
    const mv = nextScriptedAttack(d.host.state!)!;
    d.host.attack(mv.from, mv.to);
    await d.link.flush();
    vi.advanceTimersByTime(9_000);
    await d.link.flush();
    expect(d.host.isMyTurn).toBe(true);
    vi.advanceTimersByTime(1_100);
    await d.link.flush();
    expect(d.host.isMyTurn).toBe(false);
    expect(d.guest.isMyTurn).toBe(true);
    expect(turns).toEqual([true]);
    expectSame(d.host.state, d.guest.state);
    expect(d.host.state!.ended).toBe(null);
    // guest idles too
    vi.advanceTimersByTime(10_100);
    await d.link.flush();
    expect(d.host.isMyTurn).toBe(true);
    expectSame(d.host.state, d.guest.state);
  });

  it('turn timer: a silent opponent loses by timeout after turnTime + 30 s', async () => {
    fakeTimers();
    const d = await makeDuo({ turnTime: 10 });
    playScriptedTurn(d.host);
    await d.link.flush();
    expect(d.guest.isMyTurn).toBe(true);
    // the guest's tab freezes / dies: it never sends anything again
    d.guest.dispose();
    const claimable: number[] = [];
    d.host.on('timeoutClaimable', () => claimable.push(1));
    const ends: [boolean, string][] = [];
    d.host.onEnd((e) => ends.push([e.won, e.reason]));
    vi.advanceTimersByTime(39_000);
    expect(d.host.state!.ended).toBe(null);
    vi.advanceTimersByTime(1_100);
    expect(claimable).toEqual([1]);
    expect(ends).toEqual([[true, 'timeout']]);
    expect(d.host.state!.ended!.winner).toBe(d.host.localSlot);
  });

  it('turn timer: a claim made while cut off reaches the opponent on reconnect; manual claim mode', async () => {
    fakeTimers();
    const link = createLoopbackPair({ code: 'TTTT' });
    const host = DuelSession.host({ transport: link.host, storage: null, clientId: 'H', size: 'S', turnTime: 5, hostFirst: false, pingMs: 0 });
    const guest = DuelSession.join('TTTT', { transport: link.guest, storage: null, clientId: 'G', pingMs: 0, autoClaimTimeout: false });
    await link.flush();
    // the guest moves first; cut the link so the host hears nothing from it
    expect(guest.isMyTurn).toBe(true);
    expect(host.isMyTurn).toBe(false);
    link.disconnect();
    // the guest auto-finishes its turn locally after 5 s (unsent: offline)
    vi.advanceTimersByTime(5_100);
    expect(guest.isMyTurn).toBe(false);
    // the host auto-claims at 5 + 30 s
    vi.advanceTimersByTime(30_000);
    expect(host.state!.ended).toMatchObject({ reason: 'timeout', winner: host.localSlot });
    link.connect();
    await link.flush();
    // on reconnect the guest adopts the host's verdict
    expect(guest.state!.ended).toMatchObject({ reason: 'timeout', winner: host.localSlot });
    expect(guest.status).toBe('ended');

    // manual mode: guest does not auto-claim
    const link2 = createLoopbackPair({ code: 'UUUU' });
    const h2 = DuelSession.host({ transport: link2.host, storage: null, clientId: 'H', size: 'S', turnTime: 5, hostFirst: true, pingMs: 0 });
    const g2 = DuelSession.join('UUUU', { transport: link2.guest, storage: null, clientId: 'G', pingMs: 0, autoClaimTimeout: false });
    await link2.flush();
    h2.dispose(); // host vanishes during its own turn
    expect(g2.claimTimeout()).toBe(false);
    vi.advanceTimersByTime(35_100);
    expect(g2.canClaimTimeout).toBe(true);
    expect(g2.state!.ended).toBe(null);
    expect(g2.claimTimeout()).toBe(true);
    expect(g2.state!.ended).toMatchObject({ reason: 'timeout', winner: g2.localSlot, humanWon: true });
  });

  it('rematch: both accept -> new match with the first mover swapped', async () => {
    const d = await makeDuo();
    d.guest.concede();
    await d.link.flush();
    const firstMatch = d.host.matchId;
    expect(d.host.localSlot).toBe(0);
    const r: string[] = [];
    d.guest.onRematch((x) => r.push(`${x.local}/${x.remote}`));
    expect(d.host.requestRematch()).toBe(true);
    await d.link.flush();
    expect(d.host.status).toBe('ended');
    expect(r).toEqual(['false/true']);
    expect(d.guest.requestRematch()).toBe(true);
    await d.link.flush();
    expect(d.host.matchId).not.toBe(firstMatch);
    expect(d.guest.matchId).toBe(d.host.matchId);
    expect(d.host.round).toBe(1);
    expect(d.guest.round).toBe(1);
    expect(d.host.localSlot).toBe(1);
    expect(d.guest.localSlot).toBe(0);
    expect(d.guest.isMyTurn).toBe(true);
    expect(d.host.status).toBe('playing');
    expect(d.guest.status).toBe('playing');
    expect(d.host.rematch).toEqual({ local: false, remote: false });
    expect(d.guest.state!.settings.players).toEqual(['human', 'remote']);
    expect(d.host.state!.settings.players).toEqual(['remote', 'human']);
    expectSame(d.host.state, d.guest.state);
    expect(d.guest.seq).toBe(0);
    playScriptedTurn(d.guest);
    await d.link.flush();
    expectSame(d.host.state, d.guest.state);
    // rematch requests are refused while playing
    expect(d.host.requestRematch()).toBe(false);
  });

  it('declined rematch does not start a match', async () => {
    const d = await makeDuo();
    d.host.concede();
    await d.link.flush();
    d.host.requestRematch();
    d.guest.declineRematch();
    await d.link.flush();
    expect(d.host.rematch).toEqual({ local: true, remote: false });
    expect(d.host.status).toBe('ended');
  });

  it('leave() forgets the saved session', async () => {
    const d = await makeDuo();
    expect(DuelSession.saved(d.hostStorage)).toBeTruthy();
    d.host.leave();
    expect(DuelSession.saved(d.hostStorage)).toBe(null);
    expect(DuelSession.resume({ storage: d.hostStorage })).toBe(null);
  });

  it('host waits for a guest; status flow', async () => {
    const link = createLoopbackPair({ code: 'WA7T', autoConnect: false });
    const host = DuelSession.host({ transport: link.host, storage: null, clientId: 'H', pingMs: 0 });
    const st: string[] = [];
    host.onStatus((s) => st.push(s));
    await link.flush();
    expect(host.status).toBe('waiting');
    expect(host.code).toBe('WA7T');
    expect(host.state).toBe(null);
    const guest = DuelSession.join('WA7T', { transport: link.guest, storage: null, clientId: 'G', pingMs: 0 });
    expect(guest.status).toBe('connecting');
    link.connect();
    await link.flush();
    expect(st).toEqual(['waiting', 'playing']);
    expect(guest.status).toBe('playing');
  });
});
