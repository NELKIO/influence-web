/**
 * Action latency with injected delay and loss (fake timers): how long until a move made on one device
 * is applied on the other one.
 *
 * Root cause of the reported 10-15 s lag: on a lossy path (an overloaded public relay) a lost game
 * message is only repaired by the duel's own safety net (the peer reports the same lower seq in two
 * pongs, 5 s apart) or by a dead-link timeout and reconnect. The multipath layer acknowledges every
 * message and re-sends it after ≈ 1.5 × RTT on all paths.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SingleHost } from '../../src/net/composite';
import { DuelSession } from '../../src/net/duelSession';
import { MultiPathGuest, MultiPathHost, type PathKind } from '../../src/net/multipath';
import { stateHash } from '../../src/net/protocol';
import type { Transport } from '../../src/net/transport';
import { LossyPath, type PathConf } from './lossyPath';
import { nextScriptedAttack } from './netHelpers';

afterEach(() => {
  vi.useRealTimers();
});

const KINDS: PathKind[] = ['direct', 'nostr', 'peerrelay', 'mqtt'];

interface Run {
  delays: number[];
  /** moves undone on their own side by the host's full-state resync */
  reverted: number;
  resyncs: number;
  host: DuelSession;
  guest: DuelSession;
  guestT: Transport;
  closes: number;
}

const stats = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  const q = (f: number) => s[Math.min(s.length - 1, Math.floor(f * s.length))];
  return { n: s.length, median: q(0.5), p90: q(0.9), max: s[s.length - 1] };
};

/**
 * A scripted duel; every move is timed from the moment the active side made it to the moment the
 * other side applied it. `mp`: through the multipath layer; otherwise straight over paths[0].
 */
/** one turn of scripted moves (a few attacks, then end the turn) */
function turn(s: DuelSession, maxAttacks: number) {
  for (let i = 0; i < maxAttacks && s.canAct && s.state!.phase === 'attack'; i++) {
    const mv = nextScriptedAttack(s.state!);
    if (!mv || typeof s.attack(mv.from, mv.to) !== 'object') break;
  }
  if (s.canAct) s.endTurn();
}

async function duel(
  mp: boolean,
  confs: PathConf[],
  turns: number,
  hooks: { at?: (turn: number, paths: LossyPath[]) => void; connectAt?: number[]; kinds?: PathKind[] } = {},
): Promise<Run> {
  const kinds = hooks.kinds ?? KINDS;
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] });
  const paths = confs.map((c, i) => new LossyPath({ ...c, seed: 11 + i }));
  // until the match runs nothing is lost (the old single path cannot repair a lost setup at all)
  const drops = paths.map((p) => p.conf.drop ?? 0);
  paths.forEach((p) => (p.conf.drop = 0));
  paths.forEach((p, i) => p.connect(hooks.connectAt?.[i] ?? p.conf.latencyMs));
  const hostT = mp
    ? new SingleHost(new MultiPathHost(paths.map((p, i) => ({ kind: kinds[i], create: () => p.host })), { code: 'AB2C' }))
    : new SingleHost(paths[0].host);
  const guestT: Transport = mp ? new MultiPathGuest('AB2C', paths.map((p, i) => ({ kind: kinds[i], create: () => p.guest }))) : paths[0].guest;
  const host = DuelSession.host({ transport: hostT, storage: null, clientId: 'H', size: 'S', seed: 7, hostFirst: true, autoClaimTimeout: false });
  const guest = DuelSession.join('AB2C', { transport: guestT, storage: null, clientId: 'G' });
  // per acting side: seq -> when it was made; a move counts as arrived when the other side's seq
  // (same match) reaches it, whether by the move itself, a resend or a full-state sync
  const committed = { H: new Map<number, number>(), G: new Map<number, number>() };
  const delays: number[] = [];
  let closes = 0;
  let reverted = 0;
  let resyncs = 0;
  const check = () => {
    for (const [tag, me, other] of [
      ['H', host, guest],
      ['G', guest, host],
    ] as const) {
      for (const [q, t] of committed[tag]) {
        if (me.seq < q) {
          reverted++;
          committed[tag].delete(q);
        } else if (other.matchId === me.matchId && other.seq >= q) {
          delays.push(Date.now() - t);
          committed[tag].delete(q);
        }
      }
    }
  };
  for (const me of [host, guest]) {
    me.on('state', check);
    me.on('resync', () => resyncs++);
    me.on('connection', (c) => {
      if (!c) closes++;
    });
  }
  for (let i = 0; i < 400 && !(host.status === 'playing' && guest.status === 'playing'); i++) await vi.advanceTimersByTimeAsync(50);
  expect(host.status).toBe('playing');
  paths.forEach((p, i) => (p.conf.drop = drops[i]));
  let played = 0;
  for (let step = 0; step < 20000 && played < turns; step++) {
    await vi.advanceTimersByTimeAsync(100);
    for (const [s, tag] of [
      [host, 'H'],
      [guest, 'G'],
    ] as const) {
      if (!s.canAct || s.status !== 'playing' || s.state!.ended) continue;
      const seq0 = s.seq;
      turn(s, 6);
      for (let q = seq0 + 1; q <= s.seq; q++) committed[tag].set(q, Date.now());
      played++;
      hooks.at?.(played, paths);
    }
    if (host.state?.ended) break;
  }
  if (process.env.LAT_DEBUG) console.log('played', played, 'seqs', host.seq, guest.seq, 'status', host.status, guest.status, 'ended', !!host.state?.ended);
  // let everything settle, then both sides must agree
  for (let i = 0; i < 300 && host.seq !== guest.seq; i++) await vi.advanceTimersByTimeAsync(100);
  expect(guest.seq).toBe(host.seq);
  expect(stateHash(guest.state!)).toBe(stateHash(host.state!));
  check();
  return { delays, host, guest, guestT, closes, reverted, resyncs };
}

describe('action latency with injected delay and loss', () => {
  const lossy: PathConf = { latencyMs: 150, jitterMs: 100, drop: 0.1 };

  it('root cause: losses on a single path without the multipath layer cost seconds, resyncs and undone moves', async () => {
    // ordered like one MQTT connection, but 10% of the messages are lost (broker stalls / reconnects)
    const r = await duel(false, [{ latencyMs: 150, drop: 0.1 }], 16);
    const s = stats(r.delays);
    console.log('single lossy path, no multipath layer:', s, 'resyncs', r.resyncs, 'moves undone', r.reverted);
    expect(s.max).toBeGreaterThan(4000);
    expect(r.resyncs + r.reverted).toBeGreaterThan(0);
    r.host.leave();
    r.guest.leave();
  });

  it('the multipath layer repairs the same losses within about a second', async () => {
    const r = await duel(true, [lossy], 16, { kinds: ['nostr'] });
    const s = stats(r.delays);
    console.log('single lossy path, multipath layer:', s, 'resyncs', r.resyncs, 'moves undone', r.reverted);
    expect(r.resyncs + r.reverted).toBe(0);
    expect(s.p90).toBeLessThan(1500);
    expect(s.max).toBeLessThan(3000);
    r.host.leave();
    r.guest.leave();
  });

  it('two lossy relays at once: the first copy wins', async () => {
    const r = await duel(true, [{ ...lossy, drop: 0.25 }, { ...lossy, drop: 0.25, latencyMs: 250 }], 16, { kinds: ['nostr', 'peerrelay'] });
    const s = stats(r.delays);
    console.log('two relays with 25% loss each:', s);
    expect(s.p90).toBeLessThan(1500);
    r.host.leave();
    r.guest.leave();
  });

  it('a direct link that dies silently mid-match: moves continue on the relay without a reconnect', async () => {
    const direct: PathConf = { latencyMs: 40 };
    const relay: PathConf = { latencyMs: 200, jitterMs: 50 };
    const r = await duel(true, [direct, relay], 20, {
      at: (turn, paths) => {
        if (turn === 6) paths[0].blackhole = true;
      },
    });
    const s = stats(r.delays);
    console.log('direct dies at turn 6, relay takes over:', s);
    expect(r.closes).toBe(0);
    expect(s.max).toBeLessThan(2500);
    expect(r.guestT.linkKind).toBe('relay');
    r.host.leave();
    r.guest.leave();
  });

  it('a direct link that opens late takes over from the relay seamlessly', async () => {
    const r = await duel(true, [{ latencyMs: 40 }, { latencyMs: 250 }], 14, { connectAt: [3000, 250] });
    expect(r.closes).toBe(0);
    expect(r.guestT.linkKind).toBe('direct');
    const late = r.delays.slice(-10);
    expect(Math.max(...late)).toBeLessThan(200);
    r.host.leave();
    r.guest.leave();
  });
});
