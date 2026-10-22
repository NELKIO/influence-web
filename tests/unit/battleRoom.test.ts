import { afterEach, describe, expect, it, vi } from 'vitest';
import * as E from '../../src/core/engine';
import type { FightEvent, MatchState } from '../../src/core/types';
import { battleHash, parseBattleMessage } from '../../src/net/battleProtocol';
import { concedeSeat, localizeBattleState, shuffledSeatOrder } from '../../src/net/battleRules';
import { BattleGuest, BattleHost } from '../../src/net/battleRoom';
import { createLoopbackHub } from '../../src/net/hub';
import { buildScenario } from '../../src/core/scenarios';
import { MemoryStorage } from '../../src/net/persist';
import {
  BATTLE_CODE_LENGTH,
  generateBattleCode,
  inviteBattleUrl,
  isValidBattleCode,
  parseBattleInvite,
  parseInvite,
  routeJoinCode,
} from '../../src/net/room';
import {
  addGuest,
  battleSettings,
  expectAllSame,
  guestOf,
  heal,
  hostBotTurn,
  makeRoom,
  playTurn,
  reloadGuest,
  reloadHost,
  send,
  type Room,
} from './battleHelpers';
import { fakeTimers } from './netHelpers';

afterEach(() => {
  vi.useRealTimers();
});

async function playOut(room: Room, maxTurns = 400, check = true): Promise<number> {
  let turns = 0;
  while (!room.host.state!.ended && turns < maxTurns) {
    const ok = await playTurn(room);
    expect(ok, `turn ${turns} could be played`).toBe(true);
    turns++;
    if (check) expectAllSame(room, `after turn ${turns}`);
  }
  return turns;
}

describe('battle room codes', () => {
  it('uses 5-character codes, #/join links and routes a join box by length', () => {
    for (let i = 0; i < 50; i++) {
      const c = generateBattleCode();
      expect(c).toHaveLength(BATTLE_CODE_LENGTH);
      expect(isValidBattleCode(c)).toBe(true);
    }
    expect(inviteBattleUrl('ABCDE', 'https://x.io')).toMatch(/^https:\/\/x\.io\/.*#\/join\/ABCDE$/);
    expect(parseBattleInvite('https://x.io/influence-web/#/join/abcde')).toBe('ABCDE');
    expect(parseBattleInvite('#/join/ABCD')).toBeNull();
    expect(parseBattleInvite('#/join/AB0DE')).toBeNull();
    expect(parseInvite('#/duel/ABCD')).toBe('ABCD');
    expect(routeJoinCode('abcd')).toEqual({ kind: 'duel', code: 'ABCD' });
    expect(routeJoinCode(' ab-cde ')).toEqual({ kind: 'battle', code: 'ABCDE' });
    expect(routeJoinCode('https://x.io/#/join/QWERT')).toEqual({ kind: 'battle', code: 'QWERT' });
    expect(routeJoinCode('https://x.io/#/duel/QWER')).toEqual({ kind: 'duel', code: 'QWER' });
    expect(routeJoinCode('abc')).toBeNull();
  });
});

describe('battle rules', () => {
  it('concedeSeat neutralises the seat, passes its turn and the match goes on', () => {
    const st = E.createMatch(battleSettings({ players: ['online', 'online', 'hunter'], size: 'M' }), { seed: 3 });
    const cur = st.current;
    expect(concedeSeat(st, cur)).toBe(true);
    expect(E.cellsOf(st, cur)).toHaveLength(0);
    expect(st.outAt[cur]).toBe(0);
    expect(st.field.cells.every((c) => c.owner !== -1 || c.power === 0)).toBe(true);
    expect(st.current).not.toBe(cur);
    expect(st.phase).toBe('attack');
    expect(st.ended).toBeNull();
    expect(concedeSeat(st, cur)).toBe(false);
    // the second person concedes: only the bot is left and wins
    const other = [0, 1].find((s) => s !== cur)!;
    expect(concedeSeat(st, other)).toBe(true);
    expect(st.ended).toMatchObject({ winner: 2, humanWon: false, reason: 'concede' });
  });

  it('two seats: the other one wins', () => {
    const st = E.createMatch(battleSettings({ players: ['human', 'online'] }), { seed: 4 });
    concedeSeat(st, 1);
    expect(st.ended).toMatchObject({ winner: 0, humanWon: true, reason: 'concede' });
  });

  it('localizes kinds per guest and keeps the shuffle deterministic', () => {
    const st = E.createMatch(battleSettings({ players: ['human', 'online', 'dummy', 'online'] }), { seed: 1 });
    const g = localizeBattleState(st, 3);
    expect(g.settings.players).toEqual(['remote', 'remote', 'dummy', 'human']);
    expect(g.viewer).toBe(3);
    expect(battleHash(g)).toBe(battleHash(st));
    const s = battleSettings({ players: ['human', 'online', 'dummy', 'online', 'hunter'], shuffle: true });
    expect(shuffledSeatOrder(s, 9)).toEqual(shuffledSeatOrder(s, 9));
    expect(shuffledSeatOrder(s, 9)[0]).toBe(0);
    expect([...shuffledSeatOrder(s, 9)].sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it('validates messages', () => {
    expect(parseBattleMessage({ t: 'bReq', id: 'x', r: { t: 'attack', from: 1, to: 2 } })).toBeTruthy();
    expect(parseBattleMessage({ t: 'bReq', id: 'x', r: { t: 'addPower', cell: 1, amount: 0 } })).toBeNull();
    expect(parseBattleMessage({ t: 'bAct', matchId: 'm', seq: 0, seat: 0, a: { t: 'endTurn' }, h: '' })).toBeNull();
    expect(parseBattleMessage('{"t":"bTick","matchId":null,"seq":0,"h":""}')).toBeTruthy();
    expect(parseBattleMessage({ t: 'nope' })).toBeNull();
  });
});

describe('battle lobby', () => {
  it('assigns seats, shows the roster, rejects extra guests and starts when all seats are filled', async () => {
    const room = await makeRoom({ players: ['human', 'online', 'hunter', 'online'], guests: 1 });
    const { host } = room;
    expect(host.status).toBe('lobby');
    expect(host.code).toBe('BTL25');
    const g1 = room.guests[0].g;
    expect(g1.status).toBe('lobby');
    expect(g1.seat).toBe(1);
    expect(host.canStart).toBe(false);
    expect(host.start()).toBe(false);
    expect(host.roster.map((r) => [r.kind, r.connected, r.taken])).toEqual([
      ['human', true, false],
      ['online', true, true],
      ['hunter', true, false],
      ['online', false, false],
    ]);
    const g2 = addGuest(room, 'G2').g;
    await room.hub.flush();
    expect(g2.seat).toBe(3);
    expect(host.canStart).toBe(true);
    expect(g1.roster.map((r) => r.kind)).toEqual(['remote', 'human', 'hunter', 'remote']);
    expect(g1.roster[3].name).toBe('Guest G2');
    expect(g1.roster[0].onHost).toBe(true);
    expect(g2.roster[3].you).toBe(true);
    // a third guest finds no seat
    const g3 = addGuest(room, 'G3').g;
    await room.hub.flush();
    expect(g3.status).toBe('error');
    expect(g3.lastError?.code).toBe('full');
    // G2 drops and comes back: same seat
    room.hub.disconnect('G2');
    await room.hub.flush();
    expect(host.canStart).toBe(false);
    expect(g1.roster[3].connected).toBe(false);
    room.hub.connect('G2');
    await room.hub.flush();
    expect(g2.seat).toBe(3);
    expect(host.canStart).toBe(true);
    // start
    const starts: MatchState[] = [];
    g1.onState((s) => starts.push(s));
    expect(host.start()).toBe(true);
    await room.hub.flush();
    expect(host.status).toBe('playing');
    expect(g1.status).toBe('playing');
    expect(starts).toHaveLength(1);
    expectAllSame(room);
  });

  it('a guest leaving the lobby frees its seat; fillWithBots fills missing seats', async () => {
    const room = await makeRoom({ players: ['online', 'online', 'online'], guests: 2 });
    const { host } = room;
    room.guests[1].g.leave();
    await room.hub.flush();
    expect(host.roster[1].taken).toBe(false);
    expect(host.canStart).toBe(false);
    expect(host.fillWithBots('dummy')).toEqual([1, 2]);
    await room.hub.flush();
    expect(host.players).toEqual(['online', 'dummy', 'dummy']);
    expect(room.guests[0].g.roster.map((r) => r.kind)).toEqual(['human', 'dummy', 'dummy']);
    expect(room.guests[0].g.settings?.players).toEqual(['human', 'dummy', 'dummy']);
    expect(host.canStart).toBe(true);
    host.start();
    await room.hub.flush();
    room.guests.splice(1, 1);
    await playOut(room, 300);
    expectAllSame(room, 'end');
  });

  it('shuffle moves guests to their match seats', async () => {
    const room = await makeRoom({ players: ['human', 'online', 'dummy', 'online', 'hunter', 'online'], shuffle: true, seed: 11 });
    room.host.start();
    await room.hub.flush();
    const st = room.host.state!;
    const seats = room.guests.map((s) => s.g.seat);
    expect(new Set(seats).size).toBe(3);
    for (const seat of seats) expect(st.settings.players[seat]).toBe('online');
    for (const s of room.guests) expect(room.host.seatOf(s.cid)).toBe(s.g.seat);
    expectAllSame(room);
  });
});

describe('battle matches', () => {
  it('host + 2 guests + bot: identical states after every turn, to the end', async () => {
    const room = await makeRoom({ players: ['human', 'online', 'hunter', 'online'], size: 'S', seed: 21 });
    const fights: FightEvent[] = [];
    const order: string[] = [];
    const g = room.guests[0].g;
    g.onApplied((_a, f) => {
      order.push('applied');
      if (f) fights.push(f);
    });
    g.onState(() => order.push('state'));
    const ends: unknown[] = [];
    g.onEnd((e) => ends.push(e));
    room.host.start();
    await room.hub.flush();
    const turns = await playOut(room, 400);
    expect(turns).toBeGreaterThan(3);
    expect(fights.length).toBeGreaterThan(0);
    expect(order[0]).toBe('state');
    expect(order.indexOf('applied')).toBeLessThan(order.lastIndexOf('state'));
    if (room.host.state!.ended) {
      expect(room.host.status).toBe('ended');
      expect(g.status).toBe('ended');
      expect(ends).toHaveLength(1);
      const w = room.host.state!.ended!.winner;
      expect(g.state!.ended!.humanWon).toBe(w === g.seat);
    }
    expect(room.resyncs).toEqual([]);
  });

  it.each([
    [2, ['online', 'online', 'dummy', 'hunter', 'human']],
    [3, ['online', 'hunter', 'online', 'online', 'dummy']],
    [5, ['online', 'online', 'online', 'online', 'online', 'hunter']],
    [4, ['online', 'online', 'online', 'online', 'human', 'dummy']],
  ] as const)('%i guests + bots, darkness and shuffle', async (_n, players) => {
    const room = await makeRoom({ players: [...players], size: 'M', seed: 100 + players.length, darkness: true, shuffle: true });
    room.host.start();
    await room.hub.flush();
    await playOut(room, 250);
    expectAllSame(room, 'end');
    // darkness: each guest views from its own seat
    for (const { g } of room.guests) {
      expect(g.state!.viewer).toBe(g.seat);
      if (E.isAlive(g.state!, g.seat) && !g.state!.ended) {
        const vis = E.visibleCells(g.state!);
        expect(vis.some((v) => !v)).toBe(true);
      }
    }
    expect(room.resyncs).toEqual([]);
  });

  it('a scenario room: the host builds the scenario with the chosen seats, guests see it in darkness', async () => {
    const players = ['human', 'online', 'hunter', 'online', 'dummy', 'hunter'] as const;
    const room = await makeRoom({ players: [...players], size: 'XL', seed: 31, darkness: true, puzzle: 'landing' });
    expect(room.guests[0].g.settings?.puzzle).toBe('landing');
    room.host.start();
    await room.hub.flush();
    const st = room.host.state!;
    expect(st.settings.puzzle).toBe('landing');
    expect(st.settings.players).toEqual([...players]);
    expect(JSON.stringify(st.field)).toBe(JSON.stringify(buildScenario('landing', 31, undefined, [...players]).field));
    for (const { g } of room.guests) {
      expect(g.state!.settings.puzzle).toBe('landing');
      expect(E.visibleCells(g.state!).some((v) => !v)).toBe(true);
    }
    await playOut(room, 150);
    expectAllSame(room, 'end');
    expect(room.resyncs).toEqual([]);
  });

  it('rejects out-of-turn and illegal requests', async () => {
    const room = await makeRoom({ players: ['online', 'online', 'dummy'], seed: 5 });
    room.host.start();
    await room.hub.flush();
    const st = room.host.state!;
    const cur = guestOf(room, st.current)!.g;
    const other = room.guests.find((s) => s.g !== cur)!.g;
    const before = battleHash(st);
    // local pre-check
    expect(await other.request({ t: 'endTurn' })).toEqual({ ok: false, reason: 'notYourTurn' });
    // bypass the local check: raw request on the wire
    const ep = room.hub.guestEndpoint(room.guests.find((s) => s.g === other)!.cid)!;
    const answers: unknown[] = [];
    ep.onMessage((m) => (m as { t: string }).t === 'bRes' && answers.push(m));
    ep.send({ t: 'bReq', id: 'evil-1', r: { t: 'endTurn' } });
    ep.send({ t: 'bReq', id: 'evil-2', r: { t: 'attack', from: E.cellsOf(st, st.current)[0], to: 0 } });
    await room.hub.flush();
    expect(answers).toMatchObject([
      { id: 'evil-1', ok: false, reason: 'notYourTurn' },
      { id: 'evil-2', ok: false, reason: 'notYourTurn' },
    ]);
    // illegal moves of the current guest
    const own = E.cellsOf(st, cur.seat)[0];
    const far = st.field.cells.findIndex((_, i) => i !== own && !st.field.adj[own].includes(i));
    const curEp = room.hub.guestEndpoint(room.guests.find((s) => s.g === cur)!.cid)!;
    const curAnswers: { reason?: string }[] = [];
    curEp.onMessage((m) => (m as { t: string }).t === 'bRes' && curAnswers.push(m as { reason?: string }));
    curEp.send({ t: 'bReq', id: 'x1', r: { t: 'attack', from: own, to: far } });
    curEp.send({ t: 'bReq', id: 'x2', r: { t: 'addPower', cell: own, amount: 1 } });
    curEp.send({ t: 'bReq', id: 'x3', r: { t: 'attack', from: E.cellsOf(st, 2)[0], to: own } });
    await room.hub.flush();
    expect(curAnswers.map((a) => a.reason)).toEqual(['notAdjacent', 'wrongPhase', 'notOwn']);
    expect(battleHash(st)).toBe(before);
    expect(room.host.seq).toBe(0);
    // duplicates are answered from the cache, not applied twice
    curEp.send({ t: 'bReq', id: 'y1', r: { t: 'endAttack' } });
    curEp.send({ t: 'bReq', id: 'y1', r: { t: 'endAttack' } });
    await room.hub.flush();
    expect(room.host.seq).toBe(1);
    expect(curAnswers.slice(-2)).toMatchObject([{ ok: true }, { ok: true }]);
    expectAllSame(room);
  });

  it('a guest reconnecting mid-match gets its seat back and catches up', async () => {
    const room = await makeRoom({ players: ['online', 'hunter', 'online', 'dummy'], seed: 31 });
    room.host.start();
    await room.hub.flush();
    const away = room.guests[1];
    const seat = away.g.seat;
    room.hub.disconnect(away.cid);
    await room.hub.flush();
    expect(room.host.roster[seat].connected).toBe(false);
    // play until it is the absent guest's turn
    for (let i = 0; i < 20 && room.host.state!.current !== seat && !room.host.state!.ended; i++) await playTurn(room);
    expect(away.g.seq).toBeLessThan(room.host.seq);
    room.hub.connect(away.cid);
    await room.hub.flush();
    expect(away.g.seat).toBe(seat);
    expect(room.host.roster[seat].connected).toBe(true);
    expectAllSame(room);
    expect(room.resyncs).toEqual([]); // caught up from the log, no full sync
    await playOut(room, 100);
  });

  it('guest page reload resumes the seat', async () => {
    const room = await makeRoom({ players: ['online', 'online', 'hunter'], seed: 41 });
    room.host.start();
    await room.hub.flush();
    for (let i = 0; i < 4; i++) await playTurn(room);
    const cid = room.guests[0].cid;
    const seat = room.guests[0].g.seat;
    reloadGuest(room, cid);
    expect(room.guests[0].g.state).toBeTruthy(); // restored from storage before reconnecting
    await room.hub.flush();
    expect(room.guests[0].g.seat).toBe(seat);
    expect(room.guests[0].g.status).toBe('playing');
    expectAllSame(room);
    await playOut(room, 100);
  });

  it('host page reload: same code, state and seq; guests re-dial and continue', async () => {
    const room = await makeRoom({ players: ['human', 'online', 'online', 'dummy'], seed: 51 });
    room.host.start();
    await room.hub.flush();
    for (let i = 0; i < 5; i++) await playTurn(room);
    const seq = room.host.seq;
    const hash = battleHash(room.host.state!);
    const host = reloadHost(room);
    expect(host.code).toBe('BTL25');
    expect(host.seq).toBe(seq);
    expect(battleHash(host.state!)).toBe(hash);
    expect(host.status).toBe('playing');
    await room.hub.flush();
    for (const { g } of room.guests) expect(g.connected).toBe(true);
    expectAllSame(room);
    await playOut(room, 100);
    // a reload during the lobby keeps the seats
    const r2 = await makeRoom({ players: ['online', 'online', 'hunter'], guests: 1 });
    const h2 = reloadHost(r2);
    await r2.hub.flush();
    expect(h2.status).toBe('lobby');
    expect(h2.roster[0]).toMatchObject({ taken: true, connected: true, name: 'Guest G1' });
    addGuest(r2, 'G2');
    await r2.hub.flush();
    expect(h2.start()).toBe(true);
  });

  it('lost messages: gaps are re-sent, a lost last message is found by the heartbeat, lost requests are retried', async () => {
    const room = await makeRoom({ players: ['online', 'online', 'dummy'], seed: 61 });
    room.host.start();
    await room.hub.flush();
    const watcher = room.guests.find((s) => s.g.seat !== room.host.state!.current)!;
    room.hub.dropNext('host', watcher.cid, 2);
    await playTurn(room); // the gap is noticed by the next action (resend)
    for (let i = 0; i < 6; i++) await playTurn(room);
    expectAllSame(room, 'after gap');
    // drop the very last message: only the heartbeat reveals it
    while (!guestOf(room, room.host.state!.current)) await playTurn(room);
    const a = guestOf(room, room.host.state!.current)!;
    const b = room.guests.find((s) => s !== a)!;
    room.hub.dropNext('host', b.cid, 1);
    expect(await send(room, a.g, { t: 'endAttack' })).toMatchObject({ ok: true });
    expect(b.g.seq).toBe(room.host.seq - 1);
    room.host.heartbeat();
    await room.hub.flush();
    expect(b.g.seq).toBe(room.host.seq);
    expectAllSame(room, 'after heartbeat');
    // a lost request is re-sent after heartbeats and answered once
    room.hub.dropNext(a.cid, 'host', 1);
    let done: unknown = null;
    void a.g.request({ t: 'autoPower' }).then((r) => (done = r));
    await room.hub.flush();
    expect(done).toBeNull();
    expect(a.g.pendingRequests).toBe(1);
    room.host.heartbeat();
    await room.hub.flush();
    room.host.heartbeat();
    await room.hub.flush();
    expect(done).toMatchObject({ ok: true });
    expect(a.g.pendingRequests).toBe(0);
    expect(room.host.state!.powerLeft).toBe(0);
    expectAllSame(room, 'after retried request');
    expect(room.resyncs).toEqual([]);
    await playOut(room, 50);
  });

  it('a corrupted guest state is replaced by a full sync', async () => {
    const room = await makeRoom({ players: ['online', 'online', 'hunter'], seed: 71 });
    room.host.start();
    await room.hub.flush();
    const g = room.guests[0].g;
    const own = E.cellsOf(g.state!, g.seat)[0];
    g.state!.field.cells[own].power = 1 + (g.state!.field.cells[own].power % 3);
    for (let i = 0; i < 3; i++) await playTurn(room);
    room.host.heartbeat();
    await room.hub.flush();
    expectAllSame(room);
    expect(room.resyncs.some((r) => r.startsWith(`${room.guests[0].cid}:`))).toBe(true);
  });

  it('state changes the UI did not publish are pushed to the guests at the turn end / heartbeat', async () => {
    const room = await makeRoom({ players: ['human', 'online', 'dummy'], seed: 81 });
    room.host.start();
    await room.hub.flush();
    const st = room.host.state!;
    // tweak the authoritative state behind the net layer's back
    const own = E.cellsOf(st, 0)[0];
    st.field.cells[own].power = st.field.cells[own].maxPower;
    room.host.heartbeat();
    room.host.heartbeat();
    await room.hub.flush();
    expectAllSame(room);
    expect(room.resyncs.some((r) => r.startsWith('host:'))).toBe(true);
    // host-decided end (early finish)
    room.host.finish({ winner: 0, humanWon: true, reason: 'early', turn: st.turn });
    await room.hub.flush();
    expect(room.host.status).toBe('ended');
    expect(room.guests[0].g.status).toBe('ended');
    expect(room.guests[0].g.state!.ended).toMatchObject({ winner: 0, humanWon: false, reason: 'early' });
  });

  it('fillWithBots mid-match: a guest who left for good is replaced and told so when it returns', async () => {
    const room = await makeRoom({ players: ['online', 'online', 'online'], seed: 91 });
    room.host.start();
    await room.hub.flush();
    const gone = room.guests[2];
    const seat = gone.g.seat;
    room.hub.disconnect(gone.cid);
    await room.hub.flush();
    expect(room.host.fillWithBots('hunter')).toEqual([seat]);
    await room.hub.flush();
    expect(room.host.state!.settings.players[seat]).toBe('hunter');
    for (const s of room.guests.slice(0, 2)) {
      expect(s.g.state!.settings.players[seat]).toBe('hunter');
      expect(s.g.roster[seat].kind).toBe('hunter');
    }
    room.hub.connect(gone.cid);
    await room.hub.flush();
    expect(gone.g.status).toBe('error');
    expect(gone.g.lastError?.code).toBe('replaced');
    room.guests.splice(2, 1);
    await playOut(room, 300);
    expectAllSame(room, 'end');
  });

  it('concede by a guest: its cells turn neutral everywhere, the match goes on; last person standing wins', async () => {
    const room = await makeRoom({ players: ['online', 'online', 'online'], seed: 101 });
    room.host.start();
    await room.hub.flush();
    const st = room.host.state!;
    const quitter = room.guests.find((s) => s.g.seat !== st.current)!;
    const r = await send(room, quitter.g, { t: 'concede' });
    expect(r).toMatchObject({ ok: true });
    expect(E.cellsOf(st, quitter.g.seat)).toHaveLength(0);
    expect(st.ended).toBeNull();
    expectAllSame(room);
    // the current guest concedes during its own turn: the turn passes
    const cur = guestOf(room, st.current)!;
    expect(await send(room, cur.g, { t: 'concede' })).toMatchObject({ ok: true });
    expect(st.ended).toMatchObject({ reason: 'concede' });
    const winner = room.guests.find((s) => s !== quitter && s !== cur)!;
    expect(st.ended!.winner).toBe(winner.g.seat);
    expect(winner.g.state!.ended!.humanWon).toBe(true);
    expect(quitter.g.state!.ended!.humanWon).toBe(false);
    expectAllSame(room);
  });

  it('turn time: the host ends a stalled online turn', async () => {
    fakeTimers();
    const room = await makeRoom({ players: ['online', 'dummy'], seed: 111, turnTime: 30 });
    room.host.start();
    await room.hub.flush();
    const st = room.host.state!;
    if (st.current !== room.guests[0].g.seat) await hostBotTurn(room, st.current);
    await room.hub.flush();
    expect(st.current).toBe(room.guests[0].g.seat);
    expect(room.host.turnDeadline).not.toBeNull();
    const turn = st.turn;
    vi.advanceTimersByTime(31_000);
    await room.hub.flush();
    expect(st.current !== room.guests[0].g.seat || st.turn !== turn).toBe(true);
    expectAllSame(room);
  });

  it('closing the room tells the guests', async () => {
    const room = await makeRoom({ players: ['online', 'online'], seed: 121 });
    room.host.start();
    await room.hub.flush();
    room.host.close();
    await room.hub.flush();
    for (const { g, storage } of room.guests) {
      expect(g.status).toBe('error');
      expect(g.lastError?.code).toBe('closed');
      expect(BattleGuest.saved(storage)).toBeNull();
    }
    expect(BattleHost.saved(room.hostStorage)).toBeNull();
  });

  it('a guest with a bad code fails; a protocol-version mismatch is refused', async () => {
    const hub = createLoopbackHub('BTL25');
    const g = BattleGuest.join('abc', { transport: hub.guest('X'), storage: new MemoryStorage(), clientId: 'X' });
    await hub.flush();
    expect(g.status).toBe('error');
    expect(g.lastError?.code).toBe('bad-code');
    const room = await makeRoom({ players: ['online', 'online'], guests: 0 });
    const ep = room.hub.guest('V');
    const got: unknown[] = [];
    ep.onMessage((m) => got.push(m));
    await room.hub.flush();
    ep.send({ t: 'bHello', v: 99, clientId: 'V', name: 'v', matchId: null, seq: 0, hash: '' });
    await room.hub.flush();
    expect(got).toMatchObject([{ t: 'bReject', reason: 'version' }]);
  });
});

describe('battle room with many reconnecting guests', () => {
  it('heal() brings everybody back after a burst of drops', async () => {
    const room = await makeRoom({ players: ['online', 'online', 'online', 'online', 'hunter'], seed: 131, size: 'M' });
    room.host.start();
    await room.hub.flush();
    for (let i = 0; i < 8; i++) {
      for (const s of room.guests) if ((i + s.cid.length) % 3 === 0) room.hub.dropNext('host', s.cid, 1);
      if (!(await playTurn(room))) await heal(room);
    }
    await heal(room);
    expectAllSame(room);
  });
});
