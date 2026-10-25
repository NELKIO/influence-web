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
 * The bus connects to several relays at once, subscribes to its own topic on each, publishes every
 * event to all relays that are up and drops duplicates by event id. Relays that refuse our events
 * (paid / web-of-trust / auth-only relays) or close the subscription are dropped for the session;
 * relays that disconnect are retried with a growing pause. The crypto code is loaded on first use.
 */
import { BusEvents, RelayLinkGuest, RelayLinkHost, type BusContext, type BusFactory, type RelayBus, type RelayLinkOptions } from './relayLink';
import { fromB64, toB64 } from './relayCrypto';
import { netLog } from './netdebug';
import { defaultWsFactory, type WsFactory, type WsLike } from './peerSignalRelay';
import type { RelayKind } from './mqttRelay';

/** Public relays that accepted anonymous ephemeral events from a fresh key and forwarded them (October 2026). */
export const DEFAULT_NOSTR_RELAYS = [
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://nostr.mom',
  'wss://relay.damus.io',
  'wss://relay.nostr.net',
  'wss://relay.snort.social',
];

export const NOSTR_KIND = 25050;

export interface NostrOptions extends RelayLinkOptions {
  relays?: string[];
  /** no relay up this long after the start → the path fails */
  connectTimeoutMs?: number;
  /** frame size in bytes (content is base64 of it) */
  frameBytes?: number;
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
  ws: WsLike | null;
  up: boolean;
  writable: boolean;
  /** dropped for this session (refuses us) */
  dead: boolean;
  fails: number;
  everUp: boolean;
  /** recent 'rate-limited' refusals (times) */
  limited: number[];
  timer: ReturnType<typeof setTimeout> | null;
}

const backoff = (n: number) => Math.min(60_000, 2000 * 2 ** n) * (0.85 + Math.random() * 0.3);
const REFUSED = /^(blocked|banned|restricted|pow|auth-required|invalid|error)/i;

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
  private sub = `iw${Math.random().toString(36).slice(2, 10)}`;
  private factory: WsFactory;

  constructor(
    private ctx: BusContext,
    private o: NostrOptions = {},
  ) {
    super();
    this.me = ctx.me;
    this.maxFrame = o.frameBytes ?? 16_000;
    this.factory = o.ws ?? defaultWsFactory;
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
      const conn: RelayConn = { url, ws: null, up: false, writable: true, dead: false, fails: 0, everUp: false, limited: [], timer: null };
      this.conns.set(url, conn);
      this.connect(conn);
    }
    this.failTimer = setTimeout(() => {
      this.failTimer = null;
      if (!this.closed && ![...this.conns.values()].some((x) => x.everUp)) this.em.emit('fail', 'broker', 'No Nostr relay is reachable');
    }, this.o.connectTimeoutMs ?? 12_000);
  }

  private connect(conn: RelayConn) {
    if (this.closed || conn.dead) return;
    let ws: WsLike;
    try {
      ws = this.factory(conn.url);
    } catch {
      return this.retry(conn);
    }
    conn.ws = ws;
    ws.onopen = () => {
      if (conn.ws !== ws) return;
      try {
        ws.send(JSON.stringify(['REQ', this.sub, { kinds: [NOSTR_KIND], '#t': [this.myTopic] }]));
      } catch {
        return;
      }
      conn.up = true;
      conn.everUp = true;
      conn.fails = 0;
      netLog('nostr-up', { relay: conn.url });
      this.changed();
    };
    ws.onmessage = (ev) => {
      if (conn.ws !== ws) return;
      let m: unknown[];
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (!Array.isArray(m)) return;
      switch (m[0]) {
        case 'EVENT':
          if (m[1] === this.sub) this.onEvent(m[2] as NostrEvent);
          return;
        case 'OK':
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
          return;
        case 'CLOSED':
          if (m[1] === this.sub) this.drop(conn, `subscription closed: ${String(m[2] ?? '')}`);
          return;
        default:
          return;
      }
    };
    ws.onclose = () => {
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

  /** this relay refuses us: drop it for the session */
  private drop(conn: RelayConn, reason: string) {
    if (conn.dead) return;
    conn.dead = true;
    conn.writable = false;
    conn.up = false;
    netLog('nostr-drop', { relay: conn.url, reason });
    const ws = conn.ws;
    conn.ws = null;
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
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

  send(to: string, frame: Uint8Array): void {
    if (this.closed) return;
    if (!this.signer || !this.up) {
      this.pending.push({ to, frame });
      if (this.pending.length > 32) this.pending.shift();
      return;
    }
    const ev = this.signer.event(NOSTR_KIND, [['t', this.topicOf(to)]], toB64(frame));
    const text = JSON.stringify(['EVENT', ev]);
    for (const c of this.conns.values()) {
      if (!c.up || !c.writable || !c.ws) continue;
      try {
        c.ws.send(text);
      } catch {
        /* onclose handles it */
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.failTimer) clearTimeout(this.failTimer);
    this.failTimer = null;
    for (const c of this.conns.values()) {
      if (c.timer) clearTimeout(c.timer);
      c.timer = null;
      const ws = c.ws;
      c.ws = null;
      c.up = false;
      try {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify(['CLOSE', this.sub]));
        ws?.close();
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
