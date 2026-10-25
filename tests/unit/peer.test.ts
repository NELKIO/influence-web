import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PeerTransport, type TransportError } from '../../src/net/transport';
import { MultiPeerHost } from '../../src/net/multiPeer';

/**
 * PeerJS replaced by an in-process broker: peers register ids, `connect` links two data connections
 * whose messages arrive in a microtask. Failures (taken ids, a broker that is down) are switchable.
 */
const fake = vi.hoisted(() => {
  type Fn = (...a: any[]) => void;
  class Em {
    private h = new Map<string, Fn[]>();
    on(ev: string, fn: Fn) {
      this.h.set(ev, [...(this.h.get(ev) ?? []), fn]);
      return this;
    }
    emit(ev: string, ...a: unknown[]) {
      for (const fn of this.h.get(ev) ?? []) fn(...a);
    }
  }
  const broker = {
    peers: new Map<string, FakePeer>(),
    created: [] as FakePeer[],
    down: false,
    /** ids the broker still holds for someone else */
    taken: new Set<string>(),
    reset() {
      this.peers.clear();
      this.created = [];
      this.down = false;
      this.taken.clear();
    },
  };
  class FakeConn extends Em {
    open = false;
    closed = false;
    other: FakeConn | null = null;
    sent: unknown[] = [];
    constructor(
      public peer: string,
      public metadata: unknown,
    ) {
      super();
    }
    send(d: unknown) {
      if (this.closed) throw new Error('closed');
      this.sent.push(d);
      const o = this.other;
      if (this.open && o) queueMicrotask(() => !o.closed && o.emit('data', d));
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      this.open = false;
      this.emit('close');
      this.other?.close();
    }
    /** what the other side sent, parsed, without heartbeats */
    received() {
      return (this.other?.sent ?? []).map((d) => JSON.parse(d as string)).filter((m) => !m.__ctl);
    }
  }
  class FakePeer extends Em {
    open = false;
    disconnected = false;
    destroyed = false;
    reconnects = 0;
    conns: FakeConn[] = [];
    constructor(
      public id: string,
      public options: unknown,
    ) {
      super();
      broker.created.push(this);
      queueMicrotask(() => {
        if (this.destroyed) return;
        if (broker.down) {
          this.emit('error', Object.assign(new Error('Lost connection to server'), { type: 'network' }));
          this.destroy();
          return;
        }
        if (broker.taken.has(id) || broker.peers.has(id)) {
          this.emit('error', Object.assign(new Error(`ID "${id}" is taken`), { type: 'unavailable-id' }));
          this.destroy();
          return;
        }
        broker.peers.set(id, this);
        this.open = true;
        this.emit('open', id);
      });
    }
    connect(target: string, opts: { metadata?: unknown }) {
      const mine = new FakeConn(target, opts.metadata);
      this.conns.push(mine);
      queueMicrotask(() => {
        const host = broker.peers.get(target);
        if (!host || host.destroyed) {
          this.emit('error', Object.assign(new Error(`Could not connect to peer ${target}`), { type: 'peer-unavailable' }));
          return;
        }
        const theirs = new FakeConn(this.id, opts.metadata);
        mine.other = theirs;
        theirs.other = mine;
        host.conns.push(theirs);
        host.emit('connection', theirs);
        queueMicrotask(() => {
          if (mine.closed || theirs.closed) return;
          mine.open = theirs.open = true;
          theirs.emit('open');
          mine.emit('open');
        });
      });
      return mine;
    }
    disconnect() {
      this.disconnected = true;
      this.emit('disconnected');
    }
    reconnect() {
      this.reconnects++;
      this.disconnected = false;
      this.emit('open', this.id);
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.open = false;
      if (broker.peers.get(this.id) === this) broker.peers.delete(this.id);
      for (const c of this.conns) c.close();
      this.emit('close');
    }
  }
  return { broker, FakePeer, FakeConn };
});

vi.mock('peerjs', () => ({ Peer: fake.FakePeer, default: { Peer: fake.FakePeer } }));

const { broker } = fake;
type Conn = InstanceType<typeof fake.FakeConn>;

beforeAll(async () => {
  // both transports load PeerJS lazily (a dynamic import, cached per module): warm both caches so
  // that in the tests a peer exists after a few event-loop turns
  await import('peerjs');
  const warm = [new MultiPeerHost({ clientId: 'w', code: 'WARMW' }), PeerTransport.host({ clientId: 'w', code: 'WARM' })];
  await vi.waitFor(() => expect(broker.created.length).toBe(2), { timeout: 10000 });
  for (const t of warm) t.close();
});
beforeEach(() => {
  broker.reset();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

/** run pending microtasks / module loads and advance the clock */
async function tick(ms = 0) {
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
  if (ms) {
    await vi.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
  }
}

function log(t: { onOpen(f: () => void): unknown; onClose(f: () => void): unknown; onMessage(f: (m: unknown) => void): unknown; onError(f: (e: TransportError) => void): unknown; onReady(f: (c: string) => void): unknown }) {
  const l = { ready: [] as string[], open: 0, close: 0, msgs: [] as unknown[], errors: [] as TransportError[] };
  t.onReady((c) => l.ready.push(c));
  t.onOpen(() => l.open++);
  t.onClose(() => l.close++);
  t.onMessage((m) => l.msgs.push(m));
  t.onError((e) => l.errors.push(e));
  return l;
}

const peerOf = (id: string) => broker.peers.get(id)!;
/** the host-side connection of a guest */
const hostConn = (hostId: string, clientId: string) =>
  peerOf(hostId).conns.filter((c: Conn) => (c.metadata as { clientId?: string })?.clientId === clientId && !c.closed).at(-1) as Conn;

// ====================================================================== PeerTransport (1:1 duels)

describe('PeerTransport over a fake broker', () => {
  it('a host registers infweb-CODE; a guest dials it; messages flow both ways as JSON', async () => {
    const host = PeerTransport.host({ clientId: 'H', code: 'ABCD' });
    const h = log(host);
    await tick();
    expect(h.ready).toEqual(['ABCD']);
    expect(broker.peers.has('infweb-ABCD')).toBe(true);
    const guest = PeerTransport.join('ABCD', { clientId: 'G' });
    const g = log(guest);
    await tick();
    expect(g.ready).toEqual(['ABCD']);
    expect(host.isOpen && guest.isOpen).toBe(true);
    expect(host.remoteClientId).toBe('G');
    expect(host.linkKind).toBe('direct');
    expect(host.send({ a: 1 })).toBe(true);
    expect(guest.send({ b: [2] })).toBe(true);
    await tick();
    expect(g.msgs).toEqual([{ a: 1 }]);
    expect(h.msgs).toEqual([{ b: [2] }]);
    // the guest's own peer id lives in the room's namespace
    expect(broker.created.some((p) => /^infweb-ABCD-g/.test(p.id))).toBe(true);
    guest.close();
    await tick();
    expect(h.close).toBe(1);
    expect(host.isOpen).toBe(false);
    expect(host.send('x')).toBe(false);
    host.close();
  });

  it('a random host code is generated (and regenerated when taken)', async () => {
    const host = PeerTransport.host({ clientId: 'H' });
    const h = log(host);
    await tick();
    expect(h.ready[0]).toMatch(/^[A-Z2-9]{4}$/);
    host.close();
    // every id taken: it keeps trying new codes, then gives up
    broker.reset();
    const all = new Proxy(broker.taken, { get: (t, k) => (k === 'has' ? () => true : Reflect.get(t, k)) });
    (broker as { taken: Set<string> }).taken = all as Set<string>;
    const busy = PeerTransport.host({ clientId: 'H' });
    const b = log(busy);
    for (let i = 0; i < 10; i++) await tick(100);
    expect(b.errors.at(-1)).toMatchObject({ code: 'id-taken', fatal: true });
    const ids = new Set(broker.created.map((p) => p.id));
    expect(ids.size).toBeGreaterThan(1);
    broker.taken = new Set();
  });

  it('heartbeats keep the link; silence drops it and the guest redials', async () => {
    const host = PeerTransport.host({ clientId: 'H', code: 'ABCD', heartbeatMs: 1000, deadAfterMs: 3000 });
    const h = log(host);
    const guest = PeerTransport.join('ABCD', { clientId: 'G', heartbeatMs: 1000, deadAfterMs: 3000 });
    const g = log(guest);
    await tick();
    await tick();
    expect(guest.isOpen).toBe(true);
    // both sides beat: nothing drops
    await tick(5000);
    expect(h.close + g.close).toBe(0);
    const hc = hostConn('infweb-ABCD', 'G');
    expect(hc.sent.some((d) => JSON.parse(d as string).__ctl === 'hb')).toBe(true);
    // the host goes silent (its sends vanish): the guest notices and redials
    hc.send = () => {};
    await tick(4500);
    expect(g.close).toBeGreaterThanOrEqual(1);
    await tick(3000);
    expect(guest.isOpen).toBe(true);
    expect(g.open).toBeGreaterThanOrEqual(2);
    host.close();
    guest.close();
  });

  it('a second guest is refused with "busy": a fatal room-full on its side', async () => {
    const host = PeerTransport.host({ clientId: 'H', code: 'ABCD' });
    const guest = PeerTransport.join('ABCD', { clientId: 'G' });
    await tick();
    await tick();
    const other = PeerTransport.join('ABCD', { clientId: 'X' });
    const o = log(other);
    await tick();
    await tick();
    expect(o.errors).toEqual([expect.objectContaining({ code: 'room-full', fatal: true })]);
    expect(host.remoteClientId).toBe('G');
    expect(guest.isOpen).toBe(true);
    host.close();
    guest.close();
  });

  it('a resumed host only accepts the guest it expects', async () => {
    const host = PeerTransport.host({ clientId: 'H', code: 'ABCD', expectClientId: 'G' });
    const stranger = PeerTransport.join('ABCD', { clientId: 'X' });
    const s = log(stranger);
    await tick();
    await tick();
    expect(s.errors.map((e) => e.code)).toEqual(['room-full']);
    const guest = PeerTransport.join('ABCD', { clientId: 'G' });
    await tick();
    await tick();
    expect(guest.isOpen && host.isOpen).toBe(true);
    host.close();
    guest.close();
  });

  it('a guest reconnects after the link drops (same host, new connection)', async () => {
    const host = PeerTransport.host({ clientId: 'H', code: 'ABCD' });
    const h = log(host);
    const guest = PeerTransport.join('ABCD', { clientId: 'G' });
    const g = log(guest);
    await tick();
    await tick();
    hostConn('infweb-ABCD', 'G').close();
    await tick();
    expect(g.close).toBe(1);
    expect(h.close).toBe(1);
    await tick(2000);
    expect(guest.isOpen && host.isOpen).toBe(true);
    expect([h.open, g.open]).toEqual([2, 2]);
    host.send('back');
    await tick();
    expect(g.msgs).toEqual(['back']);
    host.close();
    guest.close();
  });

  it('a missing room is a fatal bad-code; an invalid code fails before any peer is made', async () => {
    const guest = PeerTransport.join('ZZZZ', { clientId: 'G' });
    const g = log(guest);
    await tick();
    await tick();
    expect(g.errors).toEqual([expect.objectContaining({ code: 'bad-code', fatal: true })]);
    const n = broker.created.length;
    const bad = PeerTransport.join('ab!', { clientId: 'G' });
    const b = log(bad);
    await tick();
    expect(b.errors).toEqual([expect.objectContaining({ code: 'bad-code', fatal: true })]);
    expect(broker.created.length).toBe(n);
    // a battle-room code length is accepted when asked for: a peer is made and dials
    const five = PeerTransport.join('ABCDE', { clientId: 'G', codeLength: 5 });
    await tick();
    expect(broker.created.length).toBe(n + 1);
    expect(broker.created.at(-1)!.conns.map((c: Conn) => c.peer)).toEqual(['infweb-ABCDE']);
    five.close();
  });

  it('a broker that stays down is fatal after a few tries; browser-incompatible is fatal at once', async () => {
    broker.down = true;
    const host = PeerTransport.host({ clientId: 'H', code: 'ABCD' });
    const h = log(host);
    for (let i = 0; i < 12; i++) await tick(9000);
    expect(h.errors.filter((e) => !e.fatal).every((e) => e.code === 'broker')).toBe(true);
    expect(h.errors.at(-1)).toMatchObject({ code: 'broker', fatal: true });
    broker.down = false;

    const t = PeerTransport.host({ clientId: 'H', code: 'BCDE' });
    const l = log(t);
    await tick();
    peerOf('infweb-BCDE').emit('error', Object.assign(new Error('no webrtc'), { type: 'browser-incompatible' }));
    expect(l.errors).toEqual([expect.objectContaining({ code: 'unsupported', fatal: true })]);
  });

  it('a lost broker link is re-established; data channels are untouched', async () => {
    const host = PeerTransport.host({ clientId: 'H', code: 'ABCD' });
    const h = log(host);
    const guest = PeerTransport.join('ABCD', { clientId: 'G' });
    await tick();
    await tick();
    const p = peerOf('infweb-ABCD');
    p.disconnect();
    await tick(10000);
    expect(p.reconnects).toBe(1);
    expect(host.isOpen).toBe(true);
    expect(h.close).toBe(0);
    // soft errors do not close anything
    p.emit('error', Object.assign(new Error('socket'), { type: 'socket-error' }));
    p.emit('error', Object.assign(new Error('ice'), { type: 'webrtc' }));
    expect(h.errors.map((e) => [e.code, e.fatal])).toEqual([
      ['broker', false],
      ['webrtc', false],
    ]);
    expect(host.isOpen).toBe(true);
    host.close();
    guest.close();
  });

  it('a fixed code still held by the broker (resume) is retried, not replaced', async () => {
    broker.taken.add('infweb-ABCD');
    const host = PeerTransport.host({ clientId: 'H', code: 'ABCD' });
    const h = log(host);
    await tick(2000);
    expect(h.ready).toEqual([]);
    broker.taken.clear();
    await tick(10000);
    expect(h.ready).toEqual(['ABCD']);
    expect(new Set(broker.created.map((p) => p.id))).toEqual(new Set(['infweb-ABCD']));
    host.close();
  });
});

// ====================================================================== MultiPeerHost (battle rooms)

describe('MultiPeerHost over a fake broker', () => {
  const join = (clientId: string, code = 'ABCDE') => PeerTransport.join(code, { clientId, codeLength: 5, idPrefix: 'infweb-b-' });

  function hostLog(h: MultiPeerHost) {
    const l = { ready: [] as string[], joins: [] as string[], leaves: [] as string[], msgs: [] as [string, unknown][], errors: [] as TransportError[] };
    h.onReady((c) => l.ready.push(c));
    h.onJoin((c) => l.joins.push(c));
    h.onLeave((c) => l.leaves.push(c));
    h.onMessage((c, m) => l.msgs.push([c, m]));
    h.onError((e) => l.errors.push(e));
    return l;
  }

  it('registers infweb-b-CODE; guests join by clientId; messages are per guest', async () => {
    const host = new MultiPeerHost({ clientId: 'H', code: 'ABCDE' });
    const h = hostLog(host);
    await tick();
    expect(h.ready).toEqual(['ABCDE']);
    expect(broker.peers.has('infweb-b-ABCDE')).toBe(true);
    const a = join('A');
    const b = join('B');
    const la = log(a);
    const lb = log(b);
    await tick();
    await tick();
    expect(h.joins.sort()).toEqual(['A', 'B']);
    expect(host.clients.sort()).toEqual(['A', 'B']);
    expect(host.isOpen('A')).toBe(true);
    expect(host.linkOf('A')).toBe('direct');
    expect(host.linkOf('Z')).toBeNull();
    expect(host.send('A', { to: 'A' })).toBe(true);
    expect(host.send('Z', { to: 'Z' })).toBe(false);
    a.send({ from: 'A' });
    b.send({ from: 'B' });
    await tick();
    expect(la.msgs).toEqual([{ to: 'A' }]);
    expect(lb.msgs).toEqual([]);
    expect(h.msgs.sort()).toEqual([
      ['A', { from: 'A' }],
      ['B', { from: 'B' }],
    ]);
    // garbage and control frames are not messages
    const ca = hostConn('infweb-b-ABCDE', 'A');
    ca.emit('data', '{broken');
    ca.emit('data', JSON.stringify({ __ctl: 'hb' }));
    expect(h.msgs).toHaveLength(2);
    b.close();
    await tick();
    expect(h.leaves).toEqual(['B']);
    host.close();
    expect(la.close).toBe(1);
    a.close();
  });

  it('a random code when none is given', async () => {
    const host = new MultiPeerHost({ clientId: 'H' });
    const h = hostLog(host);
    await tick();
    expect(h.ready[0]).toMatch(/^[A-Z2-9]{5}$/);
    expect(host.code).toBe(h.ready[0]);
    host.close();
  });

  it('a connection without a clientId is closed', async () => {
    const host = new MultiPeerHost({ clientId: 'H', code: 'ABCDE' });
    const h = hostLog(host);
    await tick();
    const p = new fake.FakePeer('rogue', {});
    await tick();
    const c = p.connect('infweb-b-ABCDE', {});
    await tick();
    expect(c.closed).toBe(true);
    expect(h.joins).toEqual([]);
    host.close();
  });

  it('a full room refuses the next guest with "busy"; a known guest reconnecting replaces its link', async () => {
    const host = new MultiPeerHost({ clientId: 'H', code: 'ABCDE', maxGuests: 2 });
    const h = hostLog(host);
    const a = join('A');
    const b = join('B');
    await tick();
    await tick();
    const c = join('C');
    const lc = log(c);
    await tick();
    await tick();
    expect(lc.errors).toEqual([expect.objectContaining({ code: 'room-full', fatal: true })]);
    expect(h.joins.sort()).toEqual(['A', 'B']);
    await tick(2000);
    // A reloads: a new transport with the same clientId
    const a2 = join('A');
    const la2 = log(a2);
    await tick();
    await tick();
    expect(la2.open).toBe(1);
    expect(h.leaves).toEqual(['A']);
    expect(h.joins.sort()).toEqual(['A', 'A', 'B']);
    expect(host.clients.sort()).toEqual(['A', 'B']);
    host.send('A', 'hi');
    await tick();
    expect(la2.msgs).toEqual(['hi']);
    for (const t of [host, a, b, a2]) t.close();
  });

  it('kick drops one link; refuse sends "busy" and the guest gets a fatal room-full', async () => {
    const host = new MultiPeerHost({ clientId: 'H', code: 'ABCDE' });
    const h = hostLog(host);
    const a = join('A');
    const b = join('B');
    const la = log(a);
    const lb = log(b);
    await tick();
    await tick();
    host.kick('A');
    await tick();
    expect(h.leaves).toEqual(['A']);
    expect(la.close).toBe(1);
    host.refuse('B');
    await tick();
    expect(h.leaves).toEqual(['A', 'B']);
    expect(lb.errors).toEqual([expect.objectContaining({ code: 'room-full', fatal: true })]);
    // unknown ids are ignored
    host.kick('nobody');
    host.refuse('nobody');
    await tick(2000);
    host.close();
    a.close();
  });

  it('heartbeats; a silent guest is dropped', async () => {
    const host = new MultiPeerHost({ clientId: 'H', code: 'ABCDE', heartbeatMs: 1000, deadAfterMs: 3000 });
    const h = hostLog(host);
    const a = join('A');
    await tick();
    await tick();
    const toHost = hostConn('infweb-b-ABCDE', 'A');
    await tick(2500);
    expect(toHost.sent.some((d) => JSON.parse(d as string).__ctl === 'hb')).toBe(true);
    expect(h.leaves).toEqual([]);
    // the guest's frames stop arriving
    const guestSide = toHost.other!;
    guestSide.send = () => {};
    await tick(4500);
    expect(h.leaves).toEqual(['A']);
    host.close();
    a.close();
  });

  it('taken codes: a new one is drawn; a fixed (resumed) code is retried until it is free', async () => {
    broker.taken.add('infweb-b-ABCDE');
    const fresh = new MultiPeerHost({ clientId: 'H', code: 'ABCDE' });
    const f = hostLog(fresh);
    await tick(200);
    expect(f.ready).toHaveLength(1);
    expect(f.ready[0]).not.toBe('ABCDE');
    fresh.close();

    const fixed = new MultiPeerHost({ clientId: 'H', code: 'ABCDE', fixedCode: true });
    const x = hostLog(fixed);
    await tick(3000);
    expect(x.ready).toEqual([]);
    broker.taken.clear();
    await tick(10000);
    expect(x.ready).toEqual(['ABCDE']);
    fixed.close();
  });

  it('a broker that stays down is fatal; a lost broker link reconnects', async () => {
    broker.down = true;
    const host = new MultiPeerHost({ clientId: 'H', code: 'ABCDE' });
    const h = hostLog(host);
    for (let i = 0; i < 12; i++) await tick(9000);
    expect(h.errors.at(-1)).toMatchObject({ code: 'broker', fatal: true });
    broker.down = false;

    const ok = new MultiPeerHost({ clientId: 'H', code: 'BCDEF' });
    const l = hostLog(ok);
    await tick();
    const p = peerOf('infweb-b-BCDEF');
    p.disconnect();
    await tick(10000);
    expect(p.reconnects).toBe(1);
    expect(l.ready).toEqual(['BCDEF']);
    p.emit('error', Object.assign(new Error('x'), { type: 'server-error' }));
    p.emit('error', Object.assign(new Error('y'), { type: 'unavailable-id' }));
    p.emit('error', Object.assign(new Error('z'), { type: 'something' }));
    expect(l.errors.map((e) => [e.code, e.fatal])).toEqual([
      ['broker', false],
      ['id-taken', false],
      ['webrtc', false],
    ]);
    p.emit('error', Object.assign(new Error('bad key'), { type: 'invalid-key' }));
    expect(l.errors.at(-1)).toMatchObject({ code: 'broker', fatal: true });
    expect(p.destroyed).toBe(true);
  });
});
