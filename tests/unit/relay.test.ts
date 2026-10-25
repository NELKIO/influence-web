import { describe, expect, it } from 'vitest';
import type { MatchSettings, PlayerType } from '../../src/core/types';
import { battleHash } from '../../src/net/battleProtocol';
import { BattleGuest, BattleHost } from '../../src/net/battleRoom';

import { DuelSession } from '../../src/net/duelSession';
import { RelayGuest, RelayHost, type RelayOptions } from '../../src/net/mqttRelay';
import { MemoryStorage } from '../../src/net/persist';
import { stateHash } from '../../src/net/protocol';
import { open, Reassembler, roomKeys, seal, toFrames } from '../../src/net/relayCrypto';
import { FakeMqttNet } from './fakeMqtt';
import { nextScriptedAttack, playScriptedTurn } from './netHelpers';

const FAST: RelayOptions = {
  heartbeatMs: 40,
  deadAfterMs: 2000,
  presenceTimeoutMs: 150,
  dialRetryMs: 50,
  maxDials: 30,
  connectTimeoutMs: 250,
  claimMs: 30,
  reRaceMs: 300,
  iterations: 1000,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 8000, label = 'condition'): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`);
    await sleep(5);
  }
}

function relay(net: FakeMqttNet, label: string, extra: RelayOptions = {}): RelayOptions {
  return { ...FAST, brokers: net.urls, factory: net.factory(label), ...extra };
}

function settings(players: PlayerType[], size: MatchSettings['size'] = 'S'): MatchSettings {
  return { kind: 'battleOnline' as MatchSettings['kind'], size, players, darkness: false, symmetry: true, crowded: false, unions: false, shuffle: false, duelRules: false };
}

const latin1 = (b: Uint8Array) => String.fromCharCode(...b);

/** host-device seat: greedy turn through host.act */
function hostTurn(h: BattleHost) {
  const st = h.state!;
  const seat = st.current;
  for (let i = 0; i < 30 && !st.ended; i++) {
    const mv = nextScriptedAttack(st);
    if (!mv) break;
    h.act(seat, { t: 'attack', from: mv.from, to: mv.to });
  }
  if (!st.ended) h.act(seat, { t: 'endTurn' });
}

async function guestTurn(g: BattleGuest) {
  for (let i = 0; i < 30; i++) {
    const st = g.state!;
    if (!g.canAct || st.phase !== 'attack') break;
    const mv = nextScriptedAttack(st);
    if (!mv) break;
    const r = await g.request({ t: 'attack', from: mv.from, to: mv.to });
    if (!r.ok) break;
  }
  if (g.canAct) await g.request({ t: 'endTurn' });
}

async function playBattle(h: BattleHost, guests: BattleGuest[], turns: number) {
  for (let i = 0; i < turns && !h.state!.ended; i++) {
    const st = h.state!;
    const seat = st.current;
    if (st.settings.players[seat] === 'human') hostTurn(h);
    else {
      const g = guests.find((x) => x.seat === seat)!;
      await until(() => g.canAct && g.seq === h.seq, 8000, `guest ${seat} ready`);
      await guestTurn(g);
    }
    await until(() => guests.every((g) => g.seq === h.seq), 8000, 'guests in sync');
    for (const g of guests) expect(battleHash(g.state!)).toBe(battleHash(h.state!));
  }
}

async function relayRoom(net: FakeMqttNet, players: PlayerType[], size: MatchSettings['size'] = 'S', extra: RelayOptions = {}) {
  const hostStorage = new MemoryStorage();
  const host = BattleHost.create({
    settings: settings(players, size),
    seed: 9,
    name: 'H',
    storage: hostStorage,
    clientId: 'HOSTC',
    heartbeatMs: 0,
    linkMode: 'mqtt',
    relay: relay(net, 'host', extra),
  });
  await until(() => host.status === 'lobby', 8000, 'host lobby');
  const n = players.filter((p) => p === 'online').length;
  const guests: BattleGuest[] = [];
  const storages: MemoryStorage[] = [];
  for (let i = 0; i < n; i++) {
    const storage = new MemoryStorage();
    storages.push(storage);
    guests.push(
      BattleGuest.join(host.code, { name: `g${i + 1}`, storage, clientId: `G${i + 1}`, linkMode: 'mqtt', relay: relay(net, `g${i + 1}`, extra), helloRetryMs: 100 }),
    );
  }
  await until(() => host.canStart && guests.every((g) => g.status === 'lobby' && g.roster.length > 0), 8000, 'all seats taken');
  return { host, guests, hostStorage, storages };
}

describe('relay crypto and framing', () => {
  it('derives stable keys per room, encrypts, and chunks', async () => {
    const a = await roomKeys('battle', 'ABCDE', 1000);
    const b = await roomKeys('battle', 'ABCDE', 1000);
    const c = await roomKeys('duel', 'ABCDE', 1000);
    expect(a.roomId).toBe(b.roomId);
    expect(a.roomId).not.toBe(c.roomId);
    expect(a.roomId).not.toContain('ABCDE');
    const blob = await seal(a.key, { hello: 'world', n: 1 });
    expect(latin1(blob)).not.toContain('world');
    expect(await open(a.key, blob)).toEqual({ hello: 'world', n: 1 });
    expect(await open(c.key, blob)).toBeNull();
    const big = new Uint8Array(10000).map((_, i) => i % 251);
    const frames = toFrames(big, 1000, 77);
    expect(frames.length).toBe(11);
    const r = new Reassembler();
    let out: Uint8Array | null = null;
    for (const f of frames) out = r.push(f) ?? out;
    expect(out).toEqual(big);
    expect(toFrames(new Uint8Array(10), 1000, 1)).toHaveLength(1);
  });
});

describe('relay battle rooms', () => {
  it('host + 2 guests play over the relay only; the brokers see only ciphertext', async () => {
    const net = new FakeMqttNet();
    const { host, guests } = await relayRoom(net, ['human', 'online', 'online']);
    // link kinds arrive by events on each side; wait for them rather than assume their order
    await until(() => host.roster[1].link === 'relay', 8000, 'host sees the relay link');
    await until(() => guests[0].link === 'relay' && guests[0].roster.find((r) => r.you)!.link === 'relay', 8000, 'guest on the relay');
    const resyncs: string[] = [];
    for (const g of guests) g.on('resync', (r) => resyncs.push(r));
    host.start();
    // the host moves at once: what was sent must not change with it (serialised at send time)
    hostTurn(host);
    await until(() => guests.every((g) => g.status === 'playing' && g.seq === host.seq));
    for (const g of guests) expect(battleHash(g.state!)).toBe(battleHash(host.state!));
    await playBattle(host, guests, 9);
    expect(resyncs).toEqual([]);
    for (const b of net.brokers.values()) {
      for (const m of b.log) {
        expect(m.topic).not.toContain(host.code);
        const text = latin1(m.payload);
        expect(text).not.toContain('bAct');
        expect(text).not.toContain('field');
      }
    }
    host.close();
  });

  it('a big state is chunked and arrives intact', async () => {
    const net = new FakeMqttNet();
    const { host, guests } = await relayRoom(net, ['human', 'online', 'online', 'online', 'online', 'online'], 'XXL', { chunkSize: 4000 });
    host.start();
    await until(() => guests.every((g) => g.status === 'playing'), 6000);
    for (const g of guests) expect(battleHash(g.state!)).toBe(battleHash(host.state!));
    const chunks = [...net.brokers.values()].flatMap((b) => b.log).filter((m) => m.payload[0] === 2);
    expect(chunks.length).toBeGreaterThan(10);
    await playBattle(host, guests, 2);
    host.close();
  });

  it('the host answers each guest on the broker it uses', async () => {
    const net = new FakeMqttNet();
    const [A, B, C] = net.urls;
    net.block('g1', A);
    net.block('g1', B);
    net.block('g2', B);
    net.block('g2', C);
    const ct = new RelayHost('battle', 'BRKRS', { ...relay(net, 'host'), clientId: 'H', fixed: true });
    await new Promise<void>((r) => ct.onReady(() => r()));
    const g1 = new RelayGuest('battle', ct.code, 'G1', relay(net, 'g1'));
    const g2 = new RelayGuest('battle', ct.code, 'G2', relay(net, 'g2'));
    const got: string[] = [];
    ct.onMessage((cid, m) => got.push(`${cid}:${(m as { x: string }).x}`));
    const g1got: unknown[] = [];
    g1.onMessage((m) => g1got.push(m));
    await until(() => g1.isOpen && g2.isOpen && ct.clients.length === 2);
    expect(g1.broker).toBe(C);
    expect(g2.broker).toBe(A);
    expect(ct.brokerOf('G1')).toBe(C);
    expect(ct.brokerOf('G2')).toBe(A);
    expect(ct.linkOf('G1')).toBe('relay');
    g1.send({ x: 'one' });
    g2.send({ x: 'two' });
    ct.send('G1', { y: 1 });
    await until(() => got.length === 2 && g1got.length === 1);
    expect(got.sort()).toEqual(['G1:one', 'G2:two']);
    // the reply to G1 went out on broker C only
    const g1Inbox = (url: string) => net.broker(url).log.filter((m) => m.topic.includes('/g/') && !m.retain).length;
    expect(g1Inbox(B)).toBe(0);
    ct.close();
    g1.close();
    g2.close();
  });

  it('unknown and closed rooms are reported as a bad code', async () => {
    const net = new FakeMqttNet();
    const nobody = BattleGuest.join('QWERT', { storage: new MemoryStorage(), clientId: 'X', linkMode: 'mqtt', relay: relay(net, 'x') });
    await until(() => nobody.status === 'error');
    expect(nobody.lastError?.code).toBe('bad-code');

    const { host, guests } = await relayRoom(net, ['human', 'online']);
    const code = host.code;
    host.start();
    await until(() => guests[0].status === 'playing');
    host.close();
    await until(() => guests[0].status === 'error');
    expect(guests[0].lastError?.code).toBe('closed');
    await sleep(30);
    const late = BattleGuest.join(code, { storage: new MemoryStorage(), clientId: 'Y', linkMode: 'mqtt', relay: relay(net, 'y') });
    await until(() => late.status === 'error');
    expect(late.lastError?.code).toBe('bad-code');
  });

  it('no reachable broker → broker error', async () => {
    const net = new FakeMqttNet();
    for (const u of net.urls) net.block('z', u);
    const g = BattleGuest.join('QWERT', { storage: new MemoryStorage(), clientId: 'Z', linkMode: 'mqtt', relay: relay(net, 'z') });
    await until(() => g.status === 'error');
    expect(g.lastError?.code).toBe('broker');
  });

  it('survives a broker outage (re-race to another broker) and a host page reload', async () => {
    const net = new FakeMqttNet();
    const { host, guests, hostStorage } = await relayRoom(net, ['human', 'online', 'online']);
    host.start();
    await until(() => guests.every((g) => g.status === 'playing'));
    await playBattle(host, guests, 3);
    // the broker both guests use goes away for good
    const used = net.urls[0];
    net.setUp(used, false);
    await until(() => guests.every((g) => !g.connected), 2000, 'guests notice');
    await until(() => guests.every((g) => g.connected && g.seq === host.seq), 6000, 'guests back via another broker');
    for (const g of guests) expect(battleHash(g.state!)).toBe(battleHash(host.state!));
    await playBattle(host, guests, 3);

    // host page reload: the room stays on the relay, guests re-dial the resumed host
    host.dispose();
    const h2 = BattleHost.resume(hostStorage, { heartbeatMs: 0, linkMode: 'mqtt', relay: relay(net, 'host2') })!;
    expect(h2.code).toBe(host.code);
    await until(() => guests.every((g) => g.connected) && h2.roster.filter((r) => r.kind === 'online').every((r) => r.connected), 6000, 'guests back after host reload');
    await until(() => guests.every((g) => g.seq === h2.seq));
    await playBattle(h2, guests, 4);
    h2.close();
  });
});

describe('relay duels', () => {
  it('a duel over the relay only, a third person is refused, guest reload resumes', async () => {
    const net = new FakeMqttNet();
    const host = DuelSession.host({
      storage: new MemoryStorage(),
      clientId: 'H',
      size: 'S',
      seed: 5,
      hostFirst: true,
      pingMs: 0,
      linkMode: 'mqtt',
      relay: relay(net, 'host'),
    });
    await until(() => host.status === 'waiting');
    const gStorage = new MemoryStorage();
    const guest = DuelSession.join(host.code!, { storage: gStorage, clientId: 'G', pingMs: 0, linkMode: 'mqtt', relay: relay(net, 'g') });
    await until(() => host.status === 'playing' && guest.status === 'playing');
    expect(host.link).toBe('relay');
    expect(guest.link).toBe('relay');
    const same = () => host.seq === guest.seq && stateHash(host.state!) === stateHash(guest.state!);
    for (let i = 0; i < 6 && !host.state!.ended; i++) {
      playScriptedTurn(host.isMyTurn ? host : guest);
      await until(same, 8000, 'duel in sync');
    }
    const third = DuelSession.join(host.code!, { storage: new MemoryStorage(), clientId: 'T', pingMs: 0, linkMode: 'mqtt', relay: relay(net, 't') });
    await until(() => third.status === 'error');
    expect(third.lastError?.code).toBe('room-full');
    // guest page reload
    guest.dispose();
    const g2 = DuelSession.resume({ storage: gStorage, pingMs: 0, linkMode: 'mqtt', relay: relay(net, 'g2') })!;
    await until(() => g2.status === 'playing' && g2.connected && host.connected);
    await until(() => host.seq === g2.seq && stateHash(host.state!) === stateHash(g2.state!));
    for (let i = 0; i < 4 && !host.state!.ended; i++) {
      playScriptedTurn(host.isMyTurn ? host : g2);
      await until(() => host.seq === g2.seq && stateHash(host.state!) === stateHash(g2.state!), 8000, 'duel in sync after reload');
    }
    host.leave();
    g2.leave();
  });

  it('an unknown duel code is a bad code over the relay', async () => {
    const net = new FakeMqttNet();
    const g = DuelSession.join('ZZ9Z', { storage: new MemoryStorage(), clientId: 'G', pingMs: 0, linkMode: 'mqtt', relay: relay(net, 'g') });
    await until(() => g.status === 'error');
    expect(g.lastError?.code).toBe('bad-code');
  });
});
