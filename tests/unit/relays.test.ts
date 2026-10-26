/**
 * The PeerJS-signalling relay and the Nostr relay against in-process fakes of the services, and the
 * multipath composite switching between paths.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import type { MatchSettings, PlayerType } from '../../src/core/types';
import { battleHash } from '../../src/net/battleProtocol';
import { BattleGuest, BattleHost } from '../../src/net/battleRoom';
import { DuelSession } from '../../src/net/duelSession';
import { createLoopbackHub } from '../../src/net/hub';
import { MultiPathGuest, MultiPathHost } from '../../src/net/multipath';
import { createNostrGuest, NOSTR_KIND, type NostrOptions } from '../../src/net/nostrRelay';
import { createPeerRelayGuest, createPeerRelayHost, PEER_RELAY_MARK, type PeerRelayOptions } from '../../src/net/peerSignalRelay';
import { stateHash } from '../../src/net/protocol';
import { FakeNostrNet, FakePeerBroker } from './fakeRelays';
import { nextScriptedAttack, playScriptedTurn } from './netHelpers';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 8000, label = 'condition'): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`);
    await sleep(5);
  }
}

const FAST = { iterations: 1000, dialRetryMs: 80, heartbeatMs: 300, deadAfterMs: 1500, batchMs: 5 };
const MP = { readyWaitMs: 0, restartMs: 300, maxRestartMs: 1000 };

let brokers: FakePeerBroker[] = [];
afterEach(() => {
  for (const b of brokers) b.stop();
  brokers = [];
});
function broker(): FakePeerBroker {
  const b = new FakePeerBroker();
  brokers.push(b);
  return b;
}
const peerOpts = (b: FakePeerBroker, extra: PeerRelayOptions = {}): PeerRelayOptions => ({ ...FAST, ws: b.ws, pingMs: 500, ...extra });
const nostrOpts = (n: FakeNostrNet, extra: NostrOptions = {}): NostrOptions => ({ ...FAST, ws: n.ws, relays: n.urls, connectTimeoutMs: 1500, ...extra });

function settings(players: PlayerType[], size: MatchSettings['size'] = 'S'): MatchSettings {
  return { kind: 'battleOnline' as MatchSettings['kind'], size, players, darkness: false, symmetry: true, crowded: false, unions: false, shuffle: false, duelRules: false };
}

async function playDuel(host: DuelSession, guest: DuelSession, turns: number) {
  for (let i = 0; i < turns && !host.state!.ended; i++) {
    await until(() => host.seq === guest.seq && host.status === 'playing' && guest.status === 'playing', 8000, 'duel in sync');
    const s = host.isMyTurn ? host : guest;
    playScriptedTurn(s, 8);
  }
  await until(() => host.seq === guest.seq, 8000, 'final sync');
  expect(stateHash(guest.state!)).toBe(stateHash(host.state!));
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

// ====================================================================== PeerJS signalling relay

describe('PeerJS signalling relay', () => {
  it('a duel over the broker alone; ids and payloads never show the code; messages stay under the size limit', async () => {
    const b = broker();
    const host = DuelSession.host({ storage: null, clientId: 'H', size: 'S', hostFirst: true, pingMs: 0, code: 'QW7K', linkMode: 'peerrelay', peerRelay: peerOpts(b), mp: MP });
    await until(() => host.status === 'waiting', 4000, 'host waiting');
    const guest = DuelSession.join('QW7K', { storage: null, clientId: 'G', pingMs: 0, linkMode: 'peerrelay', peerRelay: peerOpts(b), mp: MP });
    await until(() => host.status === 'playing' && guest.status === 'playing', 6000, 'playing');
    expect(guest.link).toBe('relay');
    await playDuel(host, guest, 8);
    for (const m of b.log) {
      expect(m.from).not.toContain('QW7K');
      expect(m.data).not.toContain('QW7K');
      expect(m.data).not.toContain('"action"');
      expect(m.data.length).toBeLessThan(b.maxMessage);
    }
    expect(b.log.some((m) => m.data.includes(PEER_RELAY_MARK))).toBe(true);
    expect(b.closes).toEqual([]);
    host.leave();
    guest.leave();
  });

  it('a big state is chunked below the broker limit and arrives intact', async () => {
    const b = broker();
    const players: PlayerType[] = ['human', 'online', 'online', 'online', 'online', 'online'];
    const host = BattleHost.create({ settings: settings(players, 'XXL'), seed: 4, storage: null, clientId: 'H', heartbeatMs: 0, code: 'B2GST', linkMode: 'peerrelay', peerRelay: peerOpts(b), mp: MP });
    await until(() => host.status === 'lobby', 4000, 'lobby');
    const guests = [1, 2, 3, 4, 5].map((i) => BattleGuest.join('B2GST', { storage: null, clientId: `G${i}`, linkMode: 'peerrelay', peerRelay: peerOpts(b), mp: MP, helloRetryMs: 200 }));
    await until(() => host.canStart, 15000, 'seated');
    host.start();
    await until(() => guests.every((g) => g.status === 'playing'), 15000, 'playing');
    for (const g of guests) expect(battleHash(g.state!)).toBe(battleHash(host.state!));
    const frames = b.log.filter((m) => m.data.includes(PEER_RELAY_MARK));
    expect(Math.max(...frames.map((m) => m.data.length))).toBeLessThan(16384);
    expect(frames.length).toBeGreaterThan(5 * 3);
    expect(b.closes).toEqual([]);
    await playBattle(host, guests, 3);
    host.close();
  }, 30000);

  it('an unknown room is reported as a bad code (the broker answers EXPIRE)', async () => {
    const b = broker();
    b.expireMs = 150;
    const g = createPeerRelayGuest('duel', 'ZZ9Z', 'G', peerOpts(b, { maxDials: 100 }));
    const errs: string[] = [];
    g.onError((e) => errs.push(e.code));
    await until(() => errs.length > 0, 4000, 'error');
    expect(errs).toEqual(['bad-code']);
  });

  it('a host id still held by a stale socket is retried until free (ID-TAKEN)', async () => {
    const b = broker();
    const h1 = createPeerRelayHost('duel', 'AB2C', 'H', peerOpts(b));
    await new Promise<void>((r) => h1.onReady(() => r()));
    // a reload: the old page's socket lingers for a moment
    const h2 = createPeerRelayHost('duel', 'AB2C', 'H', peerOpts(b));
    let ready = false;
    h2.onReady(() => (ready = true));
    await sleep(300);
    expect(ready).toBe(false);
    h1.detach();
    await until(() => ready, 6000, 'second host registered');
    const g = createPeerRelayGuest('duel', 'AB2C', 'G', peerOpts(b));
    await until(() => g.isOpen && h2.isOpen('G'), 4000, 'guest link');
    h2.close();
    g.close();
  });

  it('the broker drops the host socket mid-match: it comes back and the match goes on', async () => {
    const b = broker();
    const host = DuelSession.host({ storage: null, clientId: 'H', size: 'S', hostFirst: true, pingMs: 0, code: 'RC2X', linkMode: 'peerrelay', peerRelay: peerOpts(b), mp: MP });
    await until(() => host.status === 'waiting');
    const guest = DuelSession.join('RC2X', { storage: null, clientId: 'G', pingMs: 0, linkMode: 'peerrelay', peerRelay: peerOpts(b), mp: MP });
    await until(() => host.status === 'playing' && guest.status === 'playing');
    await playDuel(host, guest, 2);
    const hostId = [...b.clients.keys()].find((id) => id.endsWith('-h'))!;
    b.dropClient(hostId);
    await sleep(50);
    await playDuel(host, guest, 4);
    host.leave();
    guest.leave();
  }, 20000);

  it('a broker that refuses connections makes the path fail (no tight reconnect loop)', async () => {
    const b = broker();
    b.down = true;
    const g = createPeerRelayGuest('duel', 'AB2C', 'G', peerOpts(b));
    const errs: string[] = [];
    g.onError((e) => errs.push(e.code));
    await until(() => errs.length > 0, 20000, 'error');
    expect(errs).toEqual(['broker']);
  }, 25000);
});

// ====================================================================== Nostr

describe('Nostr relay', () => {
  it('a battle over Nostr: a dead relay and a paid one are skipped; events are ephemeral, tagged by hash, signed', async () => {
    const n = new FakeNostrNet(['wss://ok.test', 'wss://down.test', 'wss://paid.test']);
    n.relay('wss://down.test').up = false;
    n.relay('wss://paid.test').restricted = true;
    const host = BattleHost.create({ settings: settings(['human', 'online', 'online']), seed: 2, storage: null, clientId: 'H', heartbeatMs: 0, code: 'NSTRA', linkMode: 'nostr', nostr: nostrOpts(n), mp: MP });
    await until(() => host.status === 'lobby', 4000, 'lobby');
    const guests = [1, 2].map((i) => BattleGuest.join('NSTRA', { storage: null, clientId: `G${i}`, linkMode: 'nostr', nostr: nostrOpts(n), mp: MP, helloRetryMs: 200 }));
    await until(() => host.canStart, 8000, 'seated');
    host.start();
    await until(() => guests.every((g) => g.status === 'playing'), 8000, 'playing');
    await playBattle(host, guests, 6);
    const evs = n.relay('wss://ok.test').events;
    expect(evs.length).toBeGreaterThan(10);
    for (const e of evs.slice(0, 20)) {
      expect(e.kind).toBe(NOSTR_KIND);
      expect(e.kind >= 20000 && e.kind < 30000).toBe(true);
      expect(JSON.stringify(e)).not.toContain('NSTRA');
      expect(e.tags[0][0]).toBe('t');
      expect(e.tags[0][1]).toMatch(/^[0-9a-f]{32}$/);
      const ev = e as typeof e & { id: string; sig: string; pubkey: string };
      expect(schnorr.verify(hexToBytes(ev.sig), hexToBytes(ev.id), hexToBytes(ev.pubkey))).toBe(true);
    }
    host.close();
  });

  it('every event arrives through three relays: copies are dropped, nothing is applied twice', async () => {
    const n = new FakeNostrNet();
    const o = nostrOpts(n, { fanout: 3 });
    const host = DuelSession.host({ storage: null, clientId: 'H', size: 'S', hostFirst: true, pingMs: 0, code: 'DD2P', linkMode: 'nostr', nostr: o, mp: MP });
    await until(() => host.status === 'waiting');
    const guest = DuelSession.join('DD2P', { storage: null, clientId: 'G', pingMs: 0, linkMode: 'nostr', nostr: o, mp: MP });
    const resyncs: string[] = [];
    host.on('resync', (r) => resyncs.push(r));
    guest.on('resync', (r) => resyncs.push(r));
    await until(() => host.status === 'playing' && guest.status === 'playing');
    await playDuel(host, guest, 8);
    expect(resyncs).toEqual([]);
    // the same event was published on all three relays
    const ids = n.urls.map((u) => new Set(n.relay(u).events.map((e) => e.id)));
    const common = [...ids[0]].filter((id) => ids[1].has(id) && ids[2].has(id));
    expect(common.length).toBeGreaterThan(10);
    host.leave();
    guest.leave();
  });

  it('relays whose sockets freeze after a few kilobytes (DPI): fresh sockets take over, the match goes on', async () => {
    const n = new FakeNostrNet(['wss://r1.test', 'wss://r2.test']);
    for (const u of n.urls) n.relay(u).freezeAfter = 9000;
    const o = nostrOpts(n, { okTimeoutMs: 400 });
    const host = DuelSession.host({ storage: null, clientId: 'H', size: 'L', hostFirst: true, pingMs: 0, code: 'FR2Z', linkMode: 'nostr', nostr: o, mp: MP });
    await until(() => host.status === 'waiting');
    const guest = DuelSession.join('FR2Z', { storage: null, clientId: 'G', pingMs: 0, linkMode: 'nostr', nostr: o, mp: MP });
    const resyncs: string[] = [];
    guest.on('resync', (r) => resyncs.push(r));
    await until(() => host.status === 'playing' && guest.status === 'playing', 15000, 'playing');
    await playDuel(host, guest, 8);
    expect(resyncs).toEqual([]);
    // many sockets were needed, and none carried much more than the limit
    expect(n.relay('wss://r1.test').sockets).toBeGreaterThanOrEqual(4);
    host.leave();
    guest.leave();
  }, 30000);

  it('a relay crashes mid-match: the others carry on; a lossy relay is repaired by re-sends', async () => {
    const n = new FakeNostrNet();
    n.relay('wss://r2.test').dropRate = 0.3;
    const host = DuelSession.host({ storage: null, clientId: 'H', size: 'S', hostFirst: true, pingMs: 0, code: 'CR4S', linkMode: 'nostr', nostr: nostrOpts(n), mp: MP });
    await until(() => host.status === 'waiting');
    const guest = DuelSession.join('CR4S', { storage: null, clientId: 'G', pingMs: 0, linkMode: 'nostr', nostr: nostrOpts(n), mp: MP });
    await until(() => host.status === 'playing' && guest.status === 'playing');
    await playDuel(host, guest, 3);
    n.relay('wss://r1.test').crash();
    await playDuel(host, guest, 6);
    host.leave();
    guest.leave();
  });
});

// ====================================================================== multipath

describe('multipath', () => {
  it('direct not open: the relay carries the game; the direct link opens later and takes over; it dies and the relay continues — no reconnect', async () => {
    const b = broker();
    const hub = createLoopbackHub('AB2C');
    const hostT = new MultiPathHost(
      [
        { kind: 'direct', create: () => hub.host },
        { kind: 'peerrelay', create: (c) => createPeerRelayHost('duel', c, 'H', peerOpts(b)) },
      ],
      { code: 'AB2C', ...MP },
    );
    const guestT = new MultiPathGuest('AB2C', [
      { kind: 'direct', create: () => hub.guest('G', { autoConnect: false }) },
      { kind: 'peerrelay', create: () => createPeerRelayGuest('duel', 'AB2C', 'G', peerOpts(b)) },
    ]);
    const { SingleHost } = await import('../../src/net/composite');
    const host = DuelSession.host({ storage: null, clientId: 'H', size: 'S', hostFirst: true, pingMs: 0, transport: new SingleHost(hostT) });
    const guest = DuelSession.join('AB2C', { storage: null, clientId: 'G', pingMs: 0, transport: guestT });
    let drops = 0;
    guest.on('connection', (c) => !c && drops++);
    host.on('connection', (c) => !c && drops++);
    await until(() => host.status === 'playing' && guest.status === 'playing');
    expect(guest.link).toBe('relay');
    await playDuel(host, guest, 3);
    hub.connect('G');
    await until(() => guest.link === 'direct' && host.link === 'direct', 4000, 'switch to direct');
    await playDuel(host, guest, 3);
    hub.disconnect('G');
    await until(() => guest.link === 'relay', 4000, 'back on the relay');
    await playDuel(host, guest, 3);
    expect(drops).toBe(0);
    expect(guestT.paths.map((p) => p.kind)).toEqual(['direct', 'peerrelay']);
    host.leave();
    guest.leave();
  });

  it('all paths fail before opening → one fatal error, the most telling one', async () => {
    const b = broker();
    b.expireMs = 100;
    const n = new FakeNostrNet(['wss://gone.test']);
    n.relay('wss://gone.test').up = false;
    const g = new MultiPathGuest(
      'AB2C',
      [
        { kind: 'peerrelay', create: () => createPeerRelayGuest('duel', 'AB2C', 'G', peerOpts(b)) },
        { kind: 'nostr', create: () => createNostrGuest('duel', 'AB2C', 'G', nostrOpts(n, { connectTimeoutMs: 300 })) },
      ],
      MP,
    );
    const errs: string[] = [];
    g.onError((e) => errs.push(e.code));
    await until(() => errs.length > 0, 6000, 'fatal');
    expect(errs).toEqual(['bad-code']);
  });

  it('a page from before the multipath layer gets its version error (legacy messages pass through)', async () => {
    const n = new FakeNostrNet();
    const host = DuelSession.host({ storage: null, clientId: 'H', size: 'S', pingMs: 0, code: 'LG3C', linkMode: 'nostr', nostr: nostrOpts(n), mp: MP });
    await until(() => host.status === 'waiting');
    // an "old" guest: speaks the relay link but not the multipath layer, protocol v1
    const old = createNostrGuest('duel', 'LG3C', 'OLD', nostrOpts(n));
    const got: unknown[] = [];
    old.onMessage((m) => got.push(m));
    await until(() => old.isOpen, 4000, 'old guest link');
    old.send({ t: 'hello', v: 1, clientId: 'OLD', name: 'old', matchId: null, seq: 0, hash: '' });
    await until(() => got.some((m) => (m as { t?: string }).t === 'reject'), 4000, 'reject');
    const rej = got.find((m) => (m as { t?: string }).t === 'reject') as { reason: string; v: number };
    expect(rej.reason).toBe('version');
    // the probe hello an old page would see is a valid v1-shaped hello carrying the new version
    const probe = got.find((m) => (m as { _mp?: string })._mp === 'h') as { t: string; v: number };
    expect(probe.t).toBe('hello');
    expect(probe.v).toBe(2);
    old.close();
    host.leave();
  });
});

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
