/**
 * In-process fakes of the public services the relays use, behind the injectable WebSocket factory:
 *
 *  - FakePeerBroker: the PeerJS signalling server as measured (OPEN after connect, ID-TAKEN, CANDIDATE
 *    forwarding with `src`, EXPIRE ~5 s after a message to an absent id, queued delivery to an id that
 *    connects within that time, HEARTBEAT; a message above `maxMessage` bytes closes the socket with
 *    1009, a malformed candidate closes it with 1000).
 *  - FakeNostrNet: several Nostr relays (REQ with kinds / #t filters, EVENT → OK and live fan-out to
 *    matching subscriptions, CLOSE), relays that are down or refuse writes ('restricted').
 */
import type { WsFactory, WsLike } from '../../src/net/peerSignalRelay';

type Ev = { data: unknown };

/** A fake WebSocket: the server side calls deliver()/drop(); asynchronous like the real one. */
export class FakeWs implements WsLike {
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: Ev) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  /** largest message this socket sent */
  maxSent = 0;
  /** freeze after this many bytes in both directions together (null: never), like DPI that stalls TLS flows */
  budget: number | null = null;
  used = 0;
  frozen = false;
  private spend(n: number): boolean {
    this.used += n;
    if (this.budget !== null && this.used > this.budget) this.frozen = true;
    return !this.frozen;
  }
  constructor(
    readonly url: string,
    private server: { onClientMessage(ws: FakeWs, data: string): void; onClientClose(ws: FakeWs): void },
    private latency: () => number,
  ) {}
  /** server: accept the connection */
  accept() {
    setTimeout(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.({});
    }, this.latency());
  }
  /** server: refuse the connection (e.g. HTTP 429 / unreachable) */
  refuse() {
    setTimeout(() => {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.onerror?.({});
      this.onclose?.({ code: 1006 });
    }, this.latency());
  }
  /** server → client */
  deliver(data: string) {
    if (!this.spend(data.length)) return;
    setTimeout(() => {
      if (this.readyState === 1) this.onmessage?.({ data });
    }, this.latency());
  }
  /** server closes the socket */
  drop(code = 1006, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dead = true;
    this.server.onClientClose(this);
    setTimeout(() => this.onclose?.({ code, reason }), 0);
  }
  /** the server dropped us: what we still send is lost */
  private dead = false;
  send(data: string): void {
    if (this.readyState !== 1) throw new Error('not open');
    this.maxSent = Math.max(this.maxSent, data.length);
    if (!this.spend(data.length)) return;
    const s = this.server;
    // like a real socket, data sent before close() still reaches the server
    setTimeout(() => {
      if (!this.dead) s.onClientMessage(this, data);
    }, this.latency());
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    setTimeout(() => {
      this.dead = true;
      this.server.onClientClose(this);
    }, this.latency() + 1);
    setTimeout(() => this.onclose?.({ code: 1000 }), 0);
  }
}

// ====================================================================== PeerJS broker

export class FakePeerBroker {
  clients = new Map<string, FakeWs>();
  /** refuse new connections (rate limited / unreachable) */
  down = false;
  latencyMs = 2;
  maxMessage = 16384;
  expireMs = 5000;
  /** every client message (for assertions) */
  log: { from: string; data: string }[] = [];
  closes: { id: string; code: number }[] = [];
  private queued = new Map<string, { from: string; msg: string; at: number; timer: ReturnType<typeof setTimeout> }[]>();
  private ids = new Map<FakeWs, string>();

  readonly ws: WsFactory = (url) => {
    const u = new URL(url);
    const id = u.searchParams.get('id') ?? '';
    const ws = new FakeWs(url, this, () => this.latencyMs);
    if (this.down) {
      ws.refuse();
      return ws;
    }
    ws.accept();
    setTimeout(() => {
      if (ws.readyState !== 1) return;
      if (this.clients.has(id)) {
        ws.deliver(JSON.stringify({ type: 'ID-TAKEN', payload: { msg: 'ID is taken' } }));
        setTimeout(() => ws.drop(1000), this.latencyMs * 2 + 1);
        return;
      }
      this.clients.set(id, ws);
      this.ids.set(ws, id);
      ws.deliver(JSON.stringify({ type: 'OPEN' }));
      for (const q of this.queued.get(id) ?? []) {
        clearTimeout(q.timer);
        ws.deliver(q.msg);
      }
      this.queued.delete(id);
    }, this.latencyMs + 1);
    return ws;
  };

  onClientMessage(ws: FakeWs, data: string) {
    const id = this.ids.get(ws);
    if (!id) return;
    this.log.push({ from: id, data });
    if (data.length > this.maxMessage) return this.kill(ws, 1009);
    let m: { type?: string; dst?: string; payload?: { candidate?: { candidate?: unknown }; type?: unknown; connectionId?: unknown } };
    try {
      m = JSON.parse(data);
    } catch {
      return this.kill(ws, 1000);
    }
    if (m.type === 'HEARTBEAT') return;
    if (m.type !== 'CANDIDATE' || typeof m.dst !== 'string') return this.kill(ws, 1000);
    const p = m.payload;
    if (!p || typeof p.candidate !== 'object' || typeof p.candidate?.candidate !== 'string' || typeof p.type !== 'string' || typeof p.connectionId !== 'string')
      return this.kill(ws, 1000);
    const out = JSON.stringify({ ...m, src: id });
    const dst = this.clients.get(m.dst);
    if (dst) return dst.deliver(out);
    // absent: queue; EXPIRE to the sender if nobody claims it in time
    let q = this.queued.get(m.dst);
    if (!q) this.queued.set(m.dst, (q = []));
    const target = m.dst;
    const entry = {
      from: id,
      msg: out,
      at: Date.now(),
      timer: setTimeout(() => {
        const list = this.queued.get(target);
        if (list) {
          const i = list.indexOf(entry);
          if (i >= 0) list.splice(i, 1);
        }
        this.clients.get(id)?.deliver(JSON.stringify({ type: 'EXPIRE', src: target, dst: id }));
      }, this.expireMs),
    };
    q.push(entry);
  }

  onClientClose(ws: FakeWs) {
    const id = this.ids.get(ws);
    if (id && this.clients.get(id) === ws) this.clients.delete(id);
    this.ids.delete(ws);
  }

  private kill(ws: FakeWs, code: number) {
    this.closes.push({ id: this.ids.get(ws) ?? '?', code });
    ws.drop(code);
  }

  /** the broker drops the socket of `id` */
  dropClient(id: string) {
    this.clients.get(id)?.drop(1006);
  }

  stop() {
    for (const q of this.queued.values()) for (const e of q) clearTimeout(e.timer);
    this.queued.clear();
  }
}

// ====================================================================== Nostr relays

interface Sub {
  ws: FakeWs;
  id: string;
  kinds?: number[];
  tags?: string[];
}

export class FakeNostrRelay {
  up = true;
  /** refuse every event ('restricted: …') like a paid relay */
  restricted = false;
  /** silently lose this share of the events it should forward */
  dropRate = 0;
  /** every socket freezes after this many bytes (null: never) */
  freezeAfter: number | null = null;
  /** sockets accepted so far */
  sockets = 0;
  latencyMs = 3;
  subs: Sub[] = [];
  clients = new Set<FakeWs>();
  events: { id: string; kind: number; tags: string[][]; content: string }[] = [];
  constructor(readonly url: string) {}

  connect(ws: FakeWs) {
    if (!this.up) return ws.refuse();
    this.sockets++;
    ws.budget = this.freezeAfter;
    this.clients.add(ws);
    ws.accept();
  }

  onClientMessage(ws: FakeWs, data: string) {
    let m: unknown[];
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    if (m[0] === 'REQ') {
      const f = m[2] as { kinds?: number[]; '#t'?: string[] };
      this.subs = this.subs.filter((s) => !(s.ws === ws && s.id === m[1]));
      this.subs.push({ ws, id: String(m[1]), kinds: f.kinds, tags: f['#t'] });
      ws.deliver(JSON.stringify(['EOSE', m[1]]));
    } else if (m[0] === 'CLOSE') {
      this.subs = this.subs.filter((s) => !(s.ws === ws && s.id === m[1]));
    } else if (m[0] === 'EVENT') {
      const e = m[1] as { id: string; kind: number; tags: string[][]; content: string; sig: string; pubkey: string };
      if (this.restricted) return ws.deliver(JSON.stringify(['OK', e.id, false, 'restricted: sign up to write events']));
      if (typeof e.sig !== 'string' || e.sig.length !== 128 || e.pubkey?.length !== 64) return ws.deliver(JSON.stringify(['OK', e.id, false, 'invalid: bad signature']));
      this.events.push(e);
      ws.deliver(JSON.stringify(['OK', e.id, true, '']));
      for (const s of this.subs) {
        if (s.kinds && !s.kinds.includes(e.kind)) continue;
        if (s.tags && !e.tags.some((t) => t[0] === 't' && s.tags!.includes(t[1]))) continue;
        if (Math.random() < this.dropRate) continue;
        s.ws.deliver(JSON.stringify(['EVENT', s.id, e]));
      }
    }
  }

  onClientClose(ws: FakeWs) {
    this.clients.delete(ws);
    this.subs = this.subs.filter((s) => s.ws !== ws);
  }

  /** the relay goes away: every socket drops, new ones are refused until `up` again */
  crash() {
    this.up = false;
    for (const ws of [...this.clients]) ws.drop(1006);
  }
}

export class FakeNostrNet {
  relays = new Map<string, FakeNostrRelay>();
  constructor(urls: string[] = ['wss://r1.test', 'wss://r2.test', 'wss://r3.test']) {
    for (const u of urls) this.relays.set(u, new FakeNostrRelay(u));
  }
  get urls(): string[] {
    return [...this.relays.keys()];
  }
  relay(url: string): FakeNostrRelay {
    return this.relays.get(url)!;
  }
  readonly ws: WsFactory = (url) => {
    const r = this.relays.get(url);
    const ws = new FakeWs(url, r ?? { onClientMessage() {}, onClientClose() {} }, () => r?.latencyMs ?? 1);
    if (!r) ws.refuse();
    else r.connect(ws);
    return ws;
  };
}
