/**
 * Transports: a logical, reconnecting message channel between the duel host and its guest.
 *
 * A transport may open and close several times during its life (network drops, page reloads on the
 * other side). `onOpen` fires on every (re)connection, `onClose` on every drop. Fatal problems
 * (bad room code, broker unreachable, room full) are reported via `onError` with `fatal: true`,
 * after which the transport stops trying.
 */
import type { DataConnection, Peer, PeerOptions } from 'peerjs';
import { Emitter, type Unsubscribe } from './emitter';
import { generateCode, hostPeerId, isValidCode, PEER_ID_PREFIX, randomId } from './room';

export type TransportRole = 'host' | 'guest';

export type TransportErrorCode =
  /** guest: no room with that code (host not on the broker) */
  | 'bad-code'
  /** guest: the room already has another guest */
  | 'room-full'
  /** host: could not register the room id on the broker */
  | 'id-taken'
  /** cannot reach / lost the signalling broker */
  | 'broker'
  /** WebRTC negotiation or data channel problem */
  | 'webrtc'
  /** browser lacks WebRTC */
  | 'unsupported';

export interface TransportError {
  code: TransportErrorCode;
  message: string;
  fatal: boolean;
}

export interface TransportEvents {
  /** the room is registered (host) / dialing can start (guest); `code` is the room code */
  ready: (code: string) => void;
  open: () => void;
  close: () => void;
  message: (msg: unknown) => void;
  error: (err: TransportError) => void;
}

export interface Transport {
  readonly role: TransportRole;
  /** room code (host: null until the broker accepted the id) */
  readonly code: string | null;
  readonly isOpen: boolean;
  /** clientId of the connected / bound remote side if known */
  readonly remoteClientId: string | null;
  /** send a JSON-serialisable message; returns false (message dropped) when not open */
  send(msg: unknown): boolean;
  onReady(cb: (code: string) => void): Unsubscribe;
  onOpen(cb: () => void): Unsubscribe;
  onClose(cb: () => void): Unsubscribe;
  onMessage(cb: (msg: unknown) => void): Unsubscribe;
  onError(cb: (err: TransportError) => void): Unsubscribe;
  /** permanently close (no reconnects) */
  close(): void;
}

abstract class BaseTransport implements Transport {
  protected em = new Emitter<TransportEvents>();
  abstract readonly role: TransportRole;
  abstract readonly code: string | null;
  abstract readonly isOpen: boolean;
  abstract readonly remoteClientId: string | null;
  abstract send(msg: unknown): boolean;
  abstract close(): void;
  onReady(cb: (code: string) => void) {
    return this.em.on('ready', cb);
  }
  onOpen(cb: () => void) {
    return this.em.on('open', cb);
  }
  onClose(cb: () => void) {
    return this.em.on('close', cb);
  }
  onMessage(cb: (msg: unknown) => void) {
    return this.em.on('message', cb);
  }
  onError(cb: (err: TransportError) => void) {
    return this.em.on('error', cb);
  }
}

// ====================================================================== loopback (tests)

/**
 * In-memory transport endpoint. Messages are JSON round-tripped and delivered asynchronously
 * (microtask), in order. Use `createLoopbackPair()`; `await link.flush()` to deliver everything.
 */
export class LoopbackTransport extends BaseTransport {
  peer: LoopbackTransport | null = null;
  isOpen = false;
  closed = false;
  remoteClientId: string | null = null;
  /** messages this endpoint sent (JSON strings), for assertions */
  readonly sent: unknown[] = [];

  constructor(
    readonly role: TransportRole,
    public code: string | null,
    private link: LoopbackLink,
  ) {
    super();
  }

  send(msg: unknown): boolean {
    if (!this.isOpen || !this.peer || this.closed) return false;
    const wire = JSON.stringify(msg);
    this.sent.push(JSON.parse(wire));
    if (this.link.shouldDrop(this)) return true;
    const target = this.peer;
    this.link.pending++;
    queueMicrotask(() => {
      this.link.pending--;
      if (target.isOpen && target.peer === this && !target.closed) target.em.emit('message', JSON.parse(wire));
    });
    return true;
  }

  /** deliver `msg` to this endpoint as if the peer had sent it */
  inject(msg: unknown): void {
    this.em.emit('message', JSON.parse(JSON.stringify(msg)));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.link.endpointClosed(this);
  }

  /** @internal */
  _setOpen(open: boolean) {
    if (this.closed || this.isOpen === open) return;
    this.isOpen = open;
    this.em.emit(open ? 'open' : 'close');
  }

  /** @internal */
  _emit<K extends keyof TransportEvents>(type: K, ...args: Parameters<TransportEvents[K]>) {
    this.em.emit(type, ...args);
  }
}

export class LoopbackLink {
  host: LoopbackTransport;
  guest: LoopbackTransport;
  pending = 0;
  up = false;
  private drops = new Map<LoopbackTransport, number>();

  constructor(
    readonly code: string,
    readonly guestClientId: string,
    readonly hostClientId: string,
  ) {
    this.host = new LoopbackTransport('host', code, this);
    this.guest = new LoopbackTransport('guest', code, this);
    this.wire();
  }

  private wire() {
    this.host.peer = this.guest;
    this.guest.peer = this.host;
    this.host.remoteClientId = this.guestClientId;
    this.guest.remoteClientId = this.hostClientId;
  }

  /** bring the link up: both endpoints fire `open` */
  connect(): void {
    this.up = true;
    queueMicrotask(() => {
      if (!this.up) return;
      this.host._setOpen(true);
      this.guest._setOpen(true);
    });
  }

  /** simulate a network drop: both endpoints fire `close`, in-flight messages are lost */
  disconnect(): void {
    this.up = false;
    this.host._setOpen(false);
    this.guest._setOpen(false);
  }

  /** drop the next `n` messages sent by `from` (silently) */
  dropNext(from: LoopbackTransport, n = 1): void {
    this.drops.set(from, (this.drops.get(from) ?? 0) + n);
  }

  /** @internal */
  shouldDrop(from: LoopbackTransport): boolean {
    const n = this.drops.get(from) ?? 0;
    if (n <= 0) return false;
    this.drops.set(from, n - 1);
    return true;
  }

  /** simulate a reload of the guest page: old endpoint dies, a fresh one is returned (call connect()) */
  newGuest(): LoopbackTransport {
    this.disconnect();
    this.guest.closed = true;
    this.guest = new LoopbackTransport('guest', this.code, this);
    this.wire();
    return this.guest;
  }

  /** simulate a reload of the host page */
  newHost(): LoopbackTransport {
    this.disconnect();
    this.host.closed = true;
    this.host = new LoopbackTransport('host', this.code, this);
    this.wire();
    queueMicrotask(() => this.host._emit('ready', this.code));
    return this.host;
  }

  /** @internal */
  endpointClosed(ep: LoopbackTransport) {
    if (ep === this.host || ep === this.guest) {
      const other = ep === this.host ? this.guest : this.host;
      this.up = false;
      ep.isOpen = false;
      other._setOpen(false);
    }
  }

  /** wait until all in-flight messages (and the reactions they trigger) are delivered */
  async flush(maxRounds = 10000): Promise<void> {
    for (let i = 0; i < maxRounds; i++) {
      await Promise.resolve();
      if (this.pending === 0) {
        // a couple of extra ticks for reactions scheduled after the last delivery
        await Promise.resolve();
        await Promise.resolve();
        if (this.pending === 0) return;
      }
    }
    throw new Error('LoopbackLink.flush: messages keep flowing');
  }
}

/**
 * Two connected in-memory endpoints. `autoConnect` (default true) opens them on the next microtask;
 * the host endpoint fires `ready(code)` right away.
 */
export function createLoopbackPair(
  opts: { code?: string; guestClientId?: string; hostClientId?: string; autoConnect?: boolean } = {},
): LoopbackLink {
  const link = new LoopbackLink(opts.code ?? 'TEST', opts.guestClientId ?? 'guest-client', opts.hostClientId ?? 'host-client');
  queueMicrotask(() => link.host._emit('ready', link.code));
  if (opts.autoConnect !== false) link.connect();
  return link;
}

// ====================================================================== PeerJS

/**
 * ICE servers: Google's public STUN only. No TURN relay is configured: there is no well-known, free,
 * no-signup TURN service that is reliable (Open Relay now needs an account, and the relay PeerJS ships
 * as its default, `turn:{eu,us}-0.turn.peerjs.com:3478` peerjs/peerjsp, returned no relay candidates
 * when tested). Without TURN, peers behind two symmetric NATs / strict firewalls cannot connect.
 * A TURN server can be added via `PeerTransportOptions.peer.config.iceServers`.
 */
export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
];

export interface PeerTransportOptions {
  /** our persistent client id (sent to the host as connection metadata) */
  clientId: string;
  /** extra PeerJS options (host/port/path/secure for a self-hosted broker, debug level, config) */
  peer?: PeerOptions;
  /** PeerJS id namespace, default 'infweb-' */
  idPrefix?: string;
  /** keep-alive interval (ms) */
  heartbeatMs?: number;
  /** a link with no inbound traffic for this long is considered dead and re-established */
  deadAfterMs?: number;
  /** guest: abort a single dial attempt after this long */
  dialTimeoutMs?: number;
  /** console logging */
  log?: boolean;
}

export interface PeerHostOptions extends PeerTransportOptions {
  /** fixed room code (resume after reload). If omitted a random code is generated (regenerated if taken). */
  code?: string;
  /** only accept this guest clientId (resume); otherwise the first guest to connect is bound */
  expectClientId?: string | null;
}

type Ctl = { __ctl: 'hb' } | { __ctl: 'busy' };

let peerModule: Promise<typeof import('peerjs')> | null = null;
const loadPeerJs = () => (peerModule ??= import('peerjs'));

const backoff = (attempt: number) => Math.min(8000, 500 * 2 ** attempt) * (0.85 + Math.random() * 0.3);

export class PeerTransport extends BaseTransport {
  readonly role: TransportRole;
  code: string | null;
  isOpen = false;
  remoteClientId: string | null;

  private opts: Required<Omit<PeerTransportOptions, 'peer'>> & { peer?: PeerOptions };
  private peer: Peer | null = null;
  private conn: DataConnection | null = null;
  private pendingConn: DataConnection | null = null;
  private closed = false;
  private fixedCode: boolean;
  private everOpened = false;
  private everReady = false;
  private brokerFails = 0;
  private idTaken = 0;
  private dialAttempt = 0;
  private reconnectAttempt = 0;
  private lastRx = 0;
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimers = new Map<'broker' | 'peer' | 'dial', ReturnType<typeof setTimeout>>();
  private dialTimer: ReturnType<typeof setTimeout> | null = null;
  private onPageHide = (e: PageTransitionEvent) => {
    if (!e.persisted) this.peer?.destroy();
  };

  /** Create a room on the public PeerJS broker. Listen to `onReady(code)` for the final code. */
  static host(opts: PeerHostOptions): PeerTransport {
    return new PeerTransport('host', opts.code ?? null, opts, opts.expectClientId ?? null);
  }

  /** Join room `code`. A missing room is reported as a fatal 'bad-code' error. */
  static join(code: string, opts: PeerTransportOptions): PeerTransport {
    return new PeerTransport('guest', code, opts, null);
  }

  private constructor(role: TransportRole, code: string | null, opts: PeerTransportOptions, expectClientId: string | null) {
    super();
    this.role = role;
    this.code = code;
    this.fixedCode = code !== null;
    this.remoteClientId = expectClientId;
    this.opts = {
      idPrefix: PEER_ID_PREFIX,
      heartbeatMs: 2000,
      deadAfterMs: 9000,
      dialTimeoutMs: 15000,
      log: false,
      ...opts,
    };
    if (typeof window !== 'undefined') window.addEventListener('pagehide', this.onPageHide);
    if (role === 'guest' && code !== null && !isValidCode(code)) {
      queueMicrotask(() => this.fatal('bad-code', `Invalid room code "${code}"`));
      return;
    }
    void this.createPeer();
  }

  send(msg: unknown): boolean {
    if (!this.conn || !this.isOpen) return false;
    try {
      // a JSON string over the default (binary, chunking) serializer: no 16 KB limit, plain JSON semantics
      void this.conn.send(JSON.stringify(msg));
      return true;
    } catch (e) {
      this.debug('send failed', e);
      return false;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', this.onPageHide);
    const wasOpen = this.isOpen;
    this.isOpen = false;
    try {
      this.conn?.close();
      this.pendingConn?.close();
      this.peer?.destroy();
    } catch {
      /* ignore */
    }
    this.conn = this.pendingConn = this.peer = null;
    if (wasOpen) this.em.emit('close');
  }

  // ------------------------------------------------------------ internals

  private debug(...a: unknown[]) {
    if (this.opts.log) console.log(`[peer:${this.role}]`, ...a);
  }

  private clearTimers() {
    if (this.hbTimer) clearInterval(this.hbTimer);
    for (const t of this.retryTimers.values()) clearTimeout(t);
    this.retryTimers.clear();
    if (this.dialTimer) clearTimeout(this.dialTimer);
    this.hbTimer = this.dialTimer = null;
  }

  private fatal(code: TransportErrorCode, message: string) {
    if (this.closed) return;
    this.debug('fatal', code, message);
    this.em.emit('error', { code, message, fatal: true });
    this.close();
  }

  private soft(code: TransportErrorCode, message: string) {
    this.debug('error', code, message);
    this.em.emit('error', { code, message, fatal: false });
  }

  private later(slot: 'broker' | 'peer' | 'dial', ms: number, fn: () => void) {
    const old = this.retryTimers.get(slot);
    if (old) clearTimeout(old);
    this.retryTimers.set(
      slot,
      setTimeout(() => {
        this.retryTimers.delete(slot);
        if (!this.closed) fn();
      }, ms),
    );
  }

  private peerOptions(): PeerOptions {
    return { config: { iceServers: DEFAULT_ICE_SERVERS }, debug: 1, ...this.opts.peer };
  }

  private async createPeer() {
    let mod: typeof import('peerjs');
    try {
      mod = await loadPeerJs();
    } catch (e) {
      this.fatal('unsupported', `Could not load PeerJS: ${String(e)}`);
      return;
    }
    if (this.closed) return;
    if (this.role === 'host' && !this.fixedCode) this.code = generateCode();
    const id =
      this.role === 'host' ? hostPeerId(this.code!, this.opts.idPrefix) : `${this.opts.idPrefix}${this.code}-g${randomId(5)}`;
    this.debug('creating peer', id);
    let peer: Peer;
    try {
      peer = new mod.Peer(id, this.peerOptions());
    } catch (e) {
      this.fatal('unsupported', String(e));
      return;
    }
    this.peer = peer;
    let lastError: string | null = null;

    peer.on('open', () => {
      if (this.peer !== peer) return;
      this.debug('broker open', peer.id);
      this.brokerFails = 0;
      this.idTaken = 0;
      this.reconnectAttempt = 0;
      if (this.role === 'host') this.fixedCode = true; // keep this code from now on
      if (!this.everReady) {
        this.everReady = true;
        this.em.emit('ready', this.code!);
      }
      if (this.role === 'guest' && !this.conn && !this.pendingConn) this.dial();
    });

    peer.on('connection', (conn) => {
      if (this.peer !== peer || this.role !== 'host') return;
      this.acceptConnection(conn);
    });

    peer.on('disconnected', () => {
      if (this.peer !== peer || peer.destroyed || this.closed) return;
      this.debug('broker disconnected');
      this.later('broker', backoff(this.reconnectAttempt++), () => {
        if (this.peer === peer && !peer.destroyed && peer.disconnected) {
          try {
            peer.reconnect();
          } catch (e) {
            this.debug('reconnect threw', e);
          }
        }
      });
    });

    peer.on('close', () => {
      if (this.peer !== peer || this.closed) return;
      // destroyed by PeerJS (failed before ever registering, or page hide)
      this.peer = null;
      this.debug('peer destroyed, last error', lastError);
      if (lastError === 'unavailable-id' && !this.everReady) {
        if (!this.fixedCode) {
          if (++this.idTaken > 6) return this.fatal('id-taken', 'Could not find a free room code');
          return this.later('peer', 50, () => void this.createPeer());
        }
        // fixed code (resume): the broker may still hold our previous socket for a while
        if (++this.idTaken > 12) return this.fatal('id-taken', `Room ${this.code} is taken`);
        return this.later('peer', backoff(Math.min(this.idTaken, 4)), () => void this.createPeer());
      }
      if (!this.everReady && ++this.brokerFails > 4) {
        return this.fatal('broker', 'Cannot reach the PeerJS signalling server');
      }
      this.later('peer', backoff(this.brokerFails), () => void this.createPeer());
    });

    peer.on('error', (err) => {
      if (this.peer !== peer) return;
      const type = (err as { type?: string }).type ?? 'unknown';
      lastError = type;
      this.debug('peer error', type, err.message);
      switch (type) {
        case 'peer-unavailable':
          if (this.role === 'guest' && this.pendingConn) this.onDialFailed(true);
          break;
        case 'browser-incompatible':
          this.fatal('unsupported', 'This browser does not support WebRTC data channels');
          break;
        case 'invalid-id':
        case 'invalid-key':
        case 'ssl-unavailable':
          this.fatal('broker', err.message);
          break;
        case 'unavailable-id':
          if (this.everReady) this.soft('id-taken', err.message); // reconnect failed; keep retrying
          break;
        case 'network':
        case 'server-error':
        case 'socket-error':
        case 'socket-closed':
          this.soft('broker', err.message);
          break;
        case 'webrtc':
          this.soft('webrtc', err.message);
          break;
        default:
          this.soft('webrtc', err.message);
      }
    });
  }

  // ---- host

  private acceptConnection(conn: DataConnection) {
    const cid = (conn.metadata as { clientId?: unknown } | undefined)?.clientId;
    const clientId = typeof cid === 'string' ? cid : null;
    this.debug('incoming connection from', clientId);
    conn.on('open', () => {
      if (this.closed) return conn.close();
      if (this.remoteClientId && clientId !== this.remoteClientId) {
        this.debug('rejecting second guest', clientId);
        try {
          void conn.send(JSON.stringify({ __ctl: 'busy' } satisfies Ctl));
        } catch {
          /* ignore */
        }
        setTimeout(() => conn.close(), 1500);
        return;
      }
      this.remoteClientId = clientId;
      if (this.conn && this.conn !== conn) this.dropConnection(this.conn, false);
      this.attach(conn);
    });
  }

  // ---- guest

  private dial() {
    if (this.closed || this.role !== 'guest' || !this.peer) return;
    if (this.conn || this.pendingConn) return;
    const peer = this.peer;
    if (peer.disconnected || !peer.open) return; // `open` handler will dial
    const target = hostPeerId(this.code!, this.opts.idPrefix);
    this.debug('dialing', target);
    const conn = peer.connect(target, { reliable: true, metadata: { clientId: this.opts.clientId } });
    this.pendingConn = conn;
    if (this.dialTimer) clearTimeout(this.dialTimer);
    this.dialTimer = setTimeout(() => {
      if (this.pendingConn === conn) this.onDialFailed(false);
    }, this.opts.dialTimeoutMs);
    conn.on('open', () => {
      if (this.pendingConn !== conn) return conn.close();
      if (this.dialTimer) clearTimeout(this.dialTimer);
      this.pendingConn = null;
      this.dialAttempt = 0;
      this.everOpened = true;
      this.attach(conn);
    });
    conn.on('close', () => {
      if (this.pendingConn === conn) this.onDialFailed(false);
    });
    conn.on('error', (e) => {
      this.debug('dial error', e.message);
      if (this.pendingConn === conn) this.onDialFailed(false);
    });
  }

  private onDialFailed(unavailable: boolean) {
    const conn = this.pendingConn;
    this.pendingConn = null;
    if (this.dialTimer) clearTimeout(this.dialTimer);
    try {
      conn?.close();
    } catch {
      /* ignore */
    }
    if (this.closed) return;
    if (unavailable && !this.everOpened) {
      return this.fatal('bad-code', `Room ${this.code} not found`);
    }
    if (!this.everOpened && this.dialAttempt >= 3) {
      return this.fatal('webrtc', 'Could not establish a peer-to-peer connection');
    }
    this.later('dial', backoff(this.dialAttempt++), () => this.dial());
  }

  // ---- shared

  private attach(conn: DataConnection) {
    this.conn = conn;
    this.lastRx = Date.now();
    conn.on('data', (data) => {
      if (this.conn !== conn) return;
      this.lastRx = Date.now();
      let msg: unknown = data;
      if (typeof data === 'string') {
        try {
          msg = JSON.parse(data);
        } catch {
          return;
        }
      }
      const ctl = (msg as Partial<Ctl> | null)?.__ctl;
      if (ctl === 'hb') return;
      if (ctl === 'busy') return this.fatal('room-full', `Room ${this.code} already has two players`);
      this.em.emit('message', msg);
    });
    conn.on('close', () => {
      if (this.conn === conn) this.dropConnection(conn, true);
    });
    conn.on('error', (e) => {
      this.debug('connection error', e.message);
    });
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.hbTimer = setInterval(() => this.heartbeat(), this.opts.heartbeatMs);
    this.isOpen = true;
    this.debug('connection open');
    this.em.emit('open');
  }

  private heartbeat() {
    const conn = this.conn;
    if (!conn) return;
    if (Date.now() - this.lastRx > this.opts.deadAfterMs) {
      this.debug('link dead (no traffic)');
      this.dropConnection(conn, true);
      return;
    }
    try {
      void conn.send(JSON.stringify({ __ctl: 'hb' } satisfies Ctl));
    } catch {
      /* ignore */
    }
  }

  private dropConnection(conn: DataConnection, redial: boolean) {
    if (this.conn !== conn) return;
    this.conn = null;
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.hbTimer = null;
    try {
      conn.close();
    } catch {
      /* ignore */
    }
    if (this.isOpen) {
      this.isOpen = false;
      this.debug('connection closed');
      this.em.emit('close');
    }
    if (redial && this.role === 'guest' && !this.closed) this.later('dial', backoff(this.dialAttempt++), () => this.dial());
  }
}
