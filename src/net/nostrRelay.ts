/**
 * Relay over public Nostr relays: independent servers run by different people, reachable where the
 * MQTT brokers are not (measured from Russia, with and without a VPN, October 2026).
 *
 * Messages are EPHEMERAL events (kind 25050, in 20000-29999: relays forward them to live subscribers
 * and never store them), tagged ['t', topic] where the topic is a hash of the room id (itself a slow
 * hash of the code) and the address name, so neither the code nor the room id appears on a relay.
 * The content is a base64 frame of relayLink.ts (AES-GCM with the room key). Every event is signed
 * (Schnorr, as Nostr requires) with a throwaway key made for this session.
 *
 * The bus connects to several relays at once, subscribes to its own topic on each, publishes each
 * event on two of them (in turn) and drops duplicates by event id. Relays that refuse our events
 * (paid / web-of-trust / auth-only / banned) or close the subscription are dropped for the session;
 * relays that disconnect are retried with a growing pause; frozen sockets are replaced (see NostrBus).
 * The crypto code is loaded on first use.
 */
import { BusEvents, RelayLinkGuest, RelayLinkHost, type BusContext, type BusFactory, type RelayBus, type RelayLinkOptions } from './relayLink';
import { fromB64, toB64 } from './relayCrypto';
import { netLog } from './netdebug';
import { defaultWsFactory, type WsFactory, type WsLike } from './peerSignalRelay';
import type { RelayKind } from './mqttRelay';

/**
 * Public relays that accepted anonymous ephemeral events from a fresh key and forwarded them (scanned
 * October 2026 from a Russian home connection without a VPN and through a VPN). The first five carried
 * 60 events (~80 KB) on one socket from Russia without freezing; the well-known big relays after them
 * (Cloudflare / Hetzner hosted) freeze there after ~16-30 KB but are solid through a VPN.
 */
export const DEFAULT_NOSTR_RELAYS = [
  'wss://relay.wavlake.com',
  'wss://fanfares.nostr1.com',
  'wss://relay.mleku.dev',
  'wss://nostr.21crypto.ch',
  'wss://relay.agora.social',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.damus.io',
  'wss://nostr.mom',
];

export const NOSTR_KIND = 25050;

export interface NostrOptions extends RelayLinkOptions {
  relays?: string[];
  /** no relay up this long after the start → the path fails */
  connectTimeoutMs?: number;
  /** frame size in bytes (content is base64 of it) */
  frameBytes?: number;
  /** an EVENT not confirmed (OK) within this long means the socket froze: hop to a fresh one */
  okTimeoutMs?: number;
  /** publish each event on this many relays (taken in turn), default 2; subscriptions are on all */
  fanout?: number;
  ws?: WsFactory;
}

interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

interface Crypto {
  sign(msg: Uint8Array, sk: Uint8Array): Uint8Array;
  pub(sk: Uint8Array): Uint8Array;
  randomKey(): Uint8Array;
  sha256(b: Uint8Array): Uint8Array;
}

let cryptoMod: Promise<Crypto> | null = null;
/** the Schnorr / SHA-256 code, loaded on first use */
export function loadNostrCrypto(): Promise<Crypto> {
  return (cryptoMod ??= Promise.all([import('@noble/curves/secp256k1.js'), import('@noble/hashes/sha2.js')]).then(([c, h]) => ({
    sign: (m, sk) => c.schnorr.sign(m, sk),
    pub: (sk) => c.schnorr.getPublicKey(sk),
    randomKey: () => c.schnorr.utils.randomSecretKey(),
    sha256: (b) => h.sha256(b),
  })));
}

const enc = new TextEncoder();
const hex = (b: Uint8Array) => {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
};

/** Signs Nostr events with a throwaway key. */
export class NostrSigner {
  readonly pubkey: string;
  private sk: Uint8Array;
  constructor(private c: Crypto) {
    this.sk = c.randomKey();
    this.pubkey = hex(c.pub(this.sk));
  }
  event(kind: number, tags: string[][], content: string, createdAt = Math.floor(Date.now() / 1000)): NostrEvent {
    const idb = this.c.sha256(enc.encode(JSON.stringify([0, this.pubkey, createdAt, kind, tags, content])));
    return { id: hex(idb), pubkey: this.pubkey, created_at: createdAt, kind, tags, content, sig: hex(this.c.sign(idb, this.sk)) };
  }
  topic(text: string): string {
    return hex(this.c.sha256(enc.encode(text))).slice(0, 32);
  }
}

interface RelayConn {
  url: string;
  /** the socket in use */
  ws: WsLike | null;
  /** a fresh socket being opened to replace `ws` (connection hopping) */
  next: WsLike | null;
  up: boolean;
  writable: boolean;
  /** dropped for this session (refuses us) */
  dead: boolean;
  fails: number;
  everUp: boolean;
  /** recent 'rate-limited' refusals (times) */
  limited: number[];
  timer: ReturnType<typeof setTimeout> | null;
  /** bytes sent / received on `ws`; bytes of the events on `ws` the relay confirmed */
  tx: number;
  rx: number;
  txOk: number;
  /** when `ws` last received anything / an OK */
  lastRxAt: number;
  lastOkAt: number;
  /** consecutive sockets that froze without confirming a single event (the relay ignores us) */
  silent: number;
  lastHop: number;
  /** consecutive replacement sockets that failed to open; no new hop before `hopAfter` */
  hopFails: number;
  hopAfter: number;
  /** events sent on `ws` and not confirmed by an OK yet */
  unconfirmed: Map<string, { at: number; text: string }>;
  /** bytes (sent + received) a socket to this relay carried before it froze (smallest seen), null: never froze */
  budget: number | null;
  freezes: number;
}

const backoff = (n: number) => Math.min(60_000, 2000 * 2 ** n) * (0.85 + Math.random() * 0.3);
const REFUSED = /^(blocked|banned|restricted|pow|auth-required|invalid|error)/i;

/**
 * Connection hopping. Some networks (seen in Russia without a VPN, 2025-2026) let a TLS connection to
 * foreign hosting carry only ~10-16 KB and then silently freeze it (no reset). Every EVENT gets an OK
 * from the relay, so an OK that does not come within `okTimeoutMs` means the socket is frozen: a fresh
 * socket replaces it and the unconfirmed events are sent again on it (receivers drop copies by id).
 * The bytes a socket carried before freezing are remembered per relay, and later sockets are replaced
 * in advance (make-before-break) at 70% of that, before they freeze; events meant for a socket that is
 * being replaced wait and go out on the new one.
 */
export class NostrBus extends BusEvents implements RelayBus {
  readonly me: string;
  readonly maxFrame: number;
  private conns = new Map<string, RelayConn>();
  private signer: NostrSigner | null = null;
  private myTopic = '';
  private topics = new Map<string, string>();
  private seen = new Set<string>();
  private seenOrder: string[] = [];
  private pending: { to: string; frame: Uint8Array }[] = [];
  private closed = false;
  private wasUp = false;
  private failTimer: ReturnType<typeof setTimeout> | null = null;
  private watch: ReturnType<typeof setInterval> | null = null;
  private sub = `iw${Math.random().toString(36).slice(2, 10)}`;
  private factory: WsFactory;
  private okTimeoutMs: number;
  private turn = 0;
  /** which of our relays each peer address listens on (bitmask over the relay list) */
  private peerMasks = new Map<string, number>();

  constructor(
    private ctx: BusContext,
    private o: NostrOptions = {},
  ) {
    super();
    this.me = ctx.me;
    // small events: a socket that freezes after a few kilobytes must still get whole events through
    this.maxFrame = o.frameBytes ?? 2400;
    this.factory = o.ws ?? defaultWsFactory;
    this.okTimeoutMs = o.okTimeoutMs ?? 1500;
    void this.start();
  }

  get up(): boolean {
    for (const c of this.conns.values()) if (c.up && c.writable) return true;
    return false;
  }

  /** relays in use right now (diagnostics) */
  get relaysUp(): string[] {
    return [...this.conns.values()].filter((c) => c.up && c.writable).map((c) => c.url);
  }

  /** bitmask of the relays (by position in the list) we can be reached on right now */
  advert(): number {
    let m = 0;
    let i = 0;
    for (const c of this.conns.values()) {
      if (c.up && c.writable && i < 31) m |= 1 << i;
      i++;
    }
    return m;
  }

  setPeerAdvert(to: string, advert: number): void {
    this.peerMasks.set(to, advert);
  }

  /** per relay: sockets that froze so far (diagnostics, tests) */
  get freezes(): Record<string, number> {
    return Object.fromEntries([...this.conns.values()].map((c) => [c.url, c.freezes]));
  }

  private topicOf(name: string): string {
    let t = this.topics.get(name);
    if (!t) this.topics.set(name, (t = this.signer!.topic(`infweb/nostr/v1|${this.ctx.kind}|${this.ctx.roomId}|${name}`)));
    return t;
  }

  private async start() {
    let c: Crypto;
    try {
      c = await loadNostrCrypto();
    } catch (e) {
      this.em.emit('fail', 'unsupported', `Could not load the Nostr crypto: ${String(e)}`);
      return;
    }
    if (this.closed) return;
    this.signer = new NostrSigner(c);
    this.myTopic = this.topicOf(this.me);
    for (const url of this.o.relays ?? DEFAULT_NOSTR_RELAYS) {
      const conn: RelayConn = {
        url,
        ws: null,
        next: null,
        up: false,
        writable: true,
        dead: false,
        fails: 0,
        everUp: false,
        limited: [],
        timer: null,
        tx: 0,
        rx: 0,
        txOk: 0,
        lastRxAt: 0,
        lastOkAt: 0,
        silent: 0,
        lastHop: 0,
        hopFails: 0,
        hopAfter: 0,
        unconfirmed: new Map(),
        budget: null,
        freezes: 0,
      };
      this.conns.set(url, conn);
      this.connect(conn);
    }
    this.failTimer = setTimeout(() => {
      this.failTimer = null;
      if (!this.closed && ![...this.conns.values()].some((x) => x.everUp)) this.em.emit('fail', 'broker', 'No Nostr relay is reachable');
    }, this.o.connectTimeoutMs ?? 12_000);
    this.watch = setInterval(() => this.watchdog(), Math.max(100, Math.min(500, this.okTimeoutMs / 4)));
  }

  /** open a socket to the relay; `hop`: it replaces the current one as soon as it is open */
  private connect(conn: RelayConn, hop = false) {
    if (this.closed || conn.dead) return;
    if (hop && (conn.next || Date.now() < conn.hopAfter)) return;
    let ws: WsLike;
    try {
      ws = this.factory(conn.url);
    } catch {
      if (!hop) this.retry(conn);
      return;
    }
    if (hop) conn.next = ws;
    else conn.ws = ws;
    const current = () => conn.ws === ws || conn.next === ws;
    ws.onopen = () => {
      if (!current()) return;
      // limit 0: no stored events (some relays keep recent ephemeral ones), only live ones
      const req = JSON.stringify(['REQ', this.sub, { kinds: [NOSTR_KIND], '#t': [this.myTopic], limit: 0 }]);
      try {
        ws.send(req);
      } catch {
        return;
      }
      const hop = conn.next === ws;
      const old = hop ? conn.ws : null;
      if (hop) {
        conn.hopFails = 0;
        conn.next = null;
        conn.ws = ws;
        conn.lastHop = Date.now();
      }
      conn.tx = req.length;
      conn.rx = 0;
      conn.txOk = 0;
      conn.lastRxAt = conn.lastOkAt = Date.now();
      // events still unconfirmed on the previous socket go out again on this one (copies are dropped by id)
      const carry = [...conn.unconfirmed];
      conn.unconfirmed.clear();
      const now = Date.now();
      for (const [id, u] of carry) {
        try {
          ws.send(u.text);
        } catch {
          break;
        }
        conn.tx += u.text.length;
        conn.unconfirmed.set(id, { at: now, text: u.text });
      }
      if (hop) {
        netLog('nostr-hop', { relay: conn.url, carried: carry.length });
        try {
          old?.close();
        } catch {
          /* ignore */
        }
      }
      conn.up = true;
      conn.everUp = true;
      conn.fails = 0;
      netLog('nostr-up', { relay: conn.url });
      this.changed();
    };
    ws.onmessage = (ev) => {
      if (conn.ws !== ws) return;
      const data = String(ev.data);
      conn.rx += data.length;
      conn.lastRxAt = Date.now();
      let m: unknown[];
      try {
        m = JSON.parse(data);
      } catch {
        return;
      }
      if (!Array.isArray(m)) return;
      switch (m[0]) {
        case 'EVENT':
          if (m[1] === this.sub) this.onEvent(m[2] as NostrEvent);
          break;
        case 'OK': {
          const u = conn.unconfirmed.get(String(m[1]));
          conn.lastOkAt = Date.now();
          if (u) {
            conn.txOk += u.text.length;
            conn.silent = 0;
            conn.unconfirmed.delete(String(m[1]));
          }
          if (m[2] === false) {
            const reason = String(m[3] ?? '');
            netLog('nostr-refused', { relay: conn.url, reason });
            if (REFUSED.test(reason)) this.drop(conn, reason);
            else if (/^rate-limited/i.test(reason)) {
              // a relay that keeps limiting us loses events: drop it, the others carry the game
              const now = Date.now();
              conn.limited = conn.limited.filter((t) => now - t < 30_000);
              conn.limited.push(now);
              if (conn.limited.length >= 3) this.drop(conn, reason);
            }
          }
          break;
        }
        case 'CLOSED':
          if (m[1] === this.sub) this.drop(conn, `subscription closed: ${String(m[2] ?? '')}`);
          break;
        default:
          break;
      }
      this.maybeHop(conn);
    };
    ws.onclose = () => {
      if (conn.next === ws) {
        // the replacement did not open (the relay may limit new connections): wait before the next try,
        // and stop publishing on the old socket if it froze
        conn.next = null;
        conn.hopAfter = Date.now() + backoff(conn.hopFails++);
        if (conn.unconfirmed.size && conn.up) {
          conn.up = false;
          this.changed();
          if (conn.timer) clearTimeout(conn.timer);
          conn.timer = setTimeout(() => {
            conn.timer = null;
            const old = conn.ws;
            conn.ws = null;
            try {
              old?.close();
            } catch {
              /* ignore */
            }
            this.connect(conn);
          }, Math.max(0, conn.hopAfter - Date.now()));
        }
        return;
      }
      if (conn.ws !== ws) return;
      conn.ws = null;
      conn.up = false;
      this.changed();
      this.retry(conn);
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private retry(conn: RelayConn) {
    if (this.closed || conn.dead) return;
    if (conn.timer) clearTimeout(conn.timer);
    conn.timer = setTimeout(() => {
      conn.timer = null;
      this.connect(conn);
    }, backoff(conn.fails++));
  }

  /** an OK is overdue: the socket froze */
  private watchdog() {
    if (this.closed) return;
    const now = Date.now();
    for (const conn of this.conns.values()) {
      if (!conn.up || !conn.ws || conn.next) continue;
      let oldest = Infinity;
      let waiting = 0;
      for (const u of conn.unconfirmed.values()) {
        oldest = Math.min(oldest, u.at);
        waiting += u.text.length;
      }
      if (now - oldest < this.okTimeoutMs) continue;
      // frozen: nothing at all came back since that event went out, or (frozen upstream) other things
      // still arrive but no OK for anything for a while
      const noRx = conn.lastRxAt <= oldest;
      const noOk = conn.lastOkAt <= oldest && now - oldest >= this.okTimeoutMs * 2 && conn.unconfirmed.size >= 2;
      if (!noRx && !noOk) {
        // the relay is just slow to confirm, or skipped one: forget events left unconfirmed for long
        for (const [id, u] of conn.unconfirmed) if (now - u.at > this.okTimeoutMs * 3) conn.unconfirmed.delete(id);
        continue;
      }
      conn.freezes++;
      netLog('nostr-frozen', { relay: conn.url, tx: conn.tx, rx: conn.rx, ok: conn.txOk, waiting: conn.unconfirmed.size });
      if (conn.txOk === 0) {
        // not a single OK on this socket: maybe the relay just ignores us
        if (++conn.silent >= 3) {
          this.drop(conn, 'no answers');
          continue;
        }
      } else {
        // (a real freeze leaves several kilobytes; less is noise)
        const carried = Math.max(5000, conn.txOk + conn.rx);
        conn.budget = conn.budget === null ? carried : Math.min(conn.budget, carried);
      }
      void waiting;
      this.connect(conn, true);
    }
  }

  /** this relay's sockets froze before: replace this one before it gets there (`extra`: bytes about to be sent) */
  private maybeHop(conn: RelayConn, extra = 0): boolean {
    const b = conn.budget;
    if (b === null || conn.next || !conn.up) return !!conn.next;
    // a socket that has carried nothing yet keeps whatever it gets (one event must always fit); no storms
    if (conn.tx + conn.rx < 600 || conn.tx + conn.rx + extra <= b * 0.7 || Date.now() - conn.lastHop < 1500) return false;
    netLog('nostr-hop-early', { relay: conn.url, tx: conn.tx, rx: conn.rx });
    this.connect(conn, true);
    return !!conn.next;
  }

  /** this relay refuses us: drop it for the session */
  private drop(conn: RelayConn, reason: string) {
    if (conn.dead) return;
    conn.dead = true;
    conn.writable = false;
    conn.up = false;
    netLog('nostr-drop', { relay: conn.url, reason });
    for (const ws of [conn.ws, conn.next]) {
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    }
    conn.ws = conn.next = null;
    conn.unconfirmed.clear();
    this.changed();
  }

  private changed() {
    const up = this.up;
    if (up === this.wasUp) return;
    this.wasUp = up;
    if (up) {
      for (const p of this.pending.splice(0)) this.send(p.to, p.frame);
      this.em.emit('up');
    } else this.em.emit('down');
  }

  private onEvent(e: NostrEvent) {
    if (!e || typeof e.id !== 'string' || typeof e.content !== 'string' || e.kind !== NOSTR_KIND) return;
    if (!e.tags?.some((t) => t[0] === 't' && t[1] === this.myTopic)) return;
    if (this.seen.has(e.id)) return;
    this.seen.add(e.id);
    this.seenOrder.push(e.id);
    if (this.seenOrder.length > 4096) this.seen.delete(this.seenOrder.shift()!);
    const frame = fromB64(e.content);
    if (frame) this.em.emit('frame', frame);
  }

  private write(conn: RelayConn, text: string, id: string) {
    if (!conn.ws) return;
    const now = Date.now();
    if (conn.next || this.maybeHop(conn, text.length)) {
      // a fresh socket is on its way: the event goes out on it
      conn.unconfirmed.set(id, { at: now + this.okTimeoutMs, text });
      return;
    }
    try {
      conn.ws.send(text);
    } catch {
      return;
    }
    conn.tx += text.length;
    conn.unconfirmed.set(id, { at: now, text });
    if (conn.unconfirmed.size > 200) conn.unconfirmed.delete(conn.unconfirmed.keys().next().value!);
  }

  send(to: string, frame: Uint8Array): void {
    if (this.closed) return;
    if (!this.signer || !this.up) {
      this.pending.push({ to, frame });
      if (this.pending.length > 32) this.pending.shift();
      return;
    }
    const ev = this.signer.event(NOSTR_KIND, [['t', this.topicOf(to)]], toB64(frame));
    const text = JSON.stringify(['EVENT', ev]);
    // each event on `fanout` relays, taking them in turn: every socket carries a share of the traffic
    // (sockets may freeze after a few kilobytes), and a re-sent message goes out on other relays
    const all = [...this.conns.values()];
    let live = all.filter((c) => c.up && c.writable);
    // prefer the relays the peer said it listens on
    const mask = this.peerMasks.get(to);
    if (mask) {
      const both = live.filter((c) => mask & (1 << all.indexOf(c)));
      if (both.length) live = both;
    }
    const n0 = Math.max(1, this.o.fanout ?? 2);
    // relays whose sockets never froze first: no hops, no waiting for a fresh socket
    const smooth = live.filter((c) => c.freezes === 0);
    if (smooth.length >= n0) live = smooth;
    const n = Math.min(live.length, n0);
    for (let i = 0; i < n; i++) this.write(live[(this.turn + i) % live.length], text, ev.id);
    this.turn = (this.turn + n) % Math.max(1, live.length);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.failTimer) clearTimeout(this.failTimer);
    if (this.watch) clearInterval(this.watch);
    this.failTimer = this.watch = null;
    for (const c of this.conns.values()) {
      if (c.timer) clearTimeout(c.timer);
      c.timer = null;
      const ws = c.ws;
      const next = c.next;
      c.ws = c.next = null;
      c.up = false;
      try {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify(['CLOSE', this.sub]));
        ws?.close();
        next?.close();
      } catch {
        /* ignore */
      }
    }
    this.pending = [];
  }
}

export function nostrBus(o: NostrOptions = {}): BusFactory {
  return (ctx) => new NostrBus(ctx, o);
}

export function createNostrGuest(kind: RelayKind, code: string, clientId: string, o: NostrOptions = {}): RelayLinkGuest {
  return new RelayLinkGuest(kind, code, clientId, nostrBus(o), { label: 'nostr', ...o });
}

export function createNostrHost(kind: RelayKind, code: string, clientId: string, o: NostrOptions = {}): RelayLinkHost {
  return new RelayLinkHost(kind, code, nostrBus(o), { label: 'nostr', ...o, clientId });
}
