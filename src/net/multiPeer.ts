/**
 * PeerJS host of a battle room: registers `infweb-b-<CODE>` on the public broker and accepts up to
 * `maxGuests` data connections, each identified by the guest's clientId (connection metadata, as sent by
 * `PeerTransport.join`). A guest that reconnects replaces its previous connection. Speaks the same
 * keep-alive control frames as PeerTransport, so a PeerTransport guest detects dead links and re-dials.
 */
import type { DataConnection, Peer, PeerOptions } from 'peerjs';
import { BaseMultiHost } from './hub';
import { BATTLE_PEER_ID_PREFIX, generateBattleCode, hostPeerId } from './room';
import { DEFAULT_ICE_SERVERS, type PeerTransportOptions, type TransportErrorCode } from './transport';

export interface MultiPeerHostOptions extends PeerTransportOptions {
  /** room code; random when omitted */
  code?: string;
  /** keep the code even if the broker still holds it (resume after reload): retry instead of regenerating */
  fixedCode?: boolean;
  /** accept at most this many simultaneous guests (default 5); more are refused with a 'busy' frame */
  maxGuests?: number;
}

type Ctl = { __ctl: 'hb' } | { __ctl: 'busy' };

let peerModule: Promise<typeof import('peerjs')> | null = null;
const loadPeerJs = () => (peerModule ??= import('peerjs'));
const backoff = (attempt: number) => Math.min(8000, 500 * 2 ** attempt) * (0.85 + Math.random() * 0.3);

interface Link {
  conn: DataConnection;
  lastRx: number;
}

export class MultiPeerHost extends BaseMultiHost {
  code: string | null;
  private opts: MultiPeerHostOptions & { heartbeatMs: number; deadAfterMs: number; maxGuests: number; idPrefix: string };
  private peer: Peer | null = null;
  private links = new Map<string, Link>();
  private closed = false;
  private everReady = false;
  private fixedCode: boolean;
  private brokerFails = 0;
  private idTaken = 0;
  private reconnectAttempt = 0;
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private onPageHide = (e: PageTransitionEvent) => {
    if (!e.persisted) this.peer?.destroy();
  };

  constructor(opts: MultiPeerHostOptions) {
    super();
    this.opts = { heartbeatMs: 2000, deadAfterMs: 9000, maxGuests: 5, idPrefix: BATTLE_PEER_ID_PREFIX, ...opts };
    this.code = opts.code ?? null;
    this.fixedCode = !!opts.fixedCode && !!opts.code;
    if (typeof window !== 'undefined') window.addEventListener('pagehide', this.onPageHide);
    void this.createPeer();
  }

  get clients(): string[] {
    return [...this.links.keys()];
  }

  isOpen(clientId: string): boolean {
    return this.links.has(clientId);
  }

  send(clientId: string, msg: unknown): boolean {
    const l = this.links.get(clientId);
    if (!l) return false;
    try {
      void l.conn.send(JSON.stringify(msg));
      return true;
    } catch (e) {
      this.debug('send failed', e);
      return false;
    }
  }

  kick(clientId: string): void {
    const l = this.links.get(clientId);
    if (l) this.drop(clientId, l.conn);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.hbTimer) clearInterval(this.hbTimer);
    if (this.retry) clearTimeout(this.retry);
    this.hbTimer = this.retry = null;
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', this.onPageHide);
    for (const [cid, l] of [...this.links]) this.drop(cid, l.conn);
    try {
      this.peer?.destroy();
    } catch {
      /* ignore */
    }
    this.peer = null;
  }

  // ------------------------------------------------------------ internals

  private debug(...a: unknown[]) {
    if (this.opts.log) console.log('[peer:battle-host]', ...a);
  }

  private fatal(code: TransportErrorCode, message: string) {
    if (this.closed) return;
    this.em.emit('error', { code, message, fatal: true });
    this.close();
  }

  private soft(code: TransportErrorCode, message: string) {
    this.debug('error', code, message);
    this.em.emit('error', { code, message, fatal: false });
  }

  private later(ms: number, fn: () => void) {
    if (this.retry) clearTimeout(this.retry);
    this.retry = setTimeout(() => {
      this.retry = null;
      if (!this.closed) fn();
    }, ms);
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
    if (!this.code || (!this.fixedCode && this.idTaken > 0)) this.code = generateBattleCode();
    const id = hostPeerId(this.code, this.opts.idPrefix);
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
      this.brokerFails = 0;
      this.idTaken = 0;
      this.reconnectAttempt = 0;
      this.fixedCode = true;
      if (!this.everReady) {
        this.everReady = true;
        this.em.emit('ready', this.code!);
      }
      if (!this.hbTimer) this.hbTimer = setInterval(() => this.heartbeat(), this.opts.heartbeatMs);
    });

    peer.on('connection', (conn) => {
      if (this.peer === peer) this.accept(conn);
    });

    peer.on('disconnected', () => {
      if (this.peer !== peer || peer.destroyed || this.closed) return;
      // the broker link only matters for new guests; open data channels keep working
      this.later(backoff(this.reconnectAttempt++), () => {
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
      this.peer = null;
      if (lastError === 'unavailable-id' && !this.everReady) {
        if (!this.fixedCode) {
          if (++this.idTaken > 6) return this.fatal('id-taken', 'Could not find a free room code');
          return this.later(50, () => void this.createPeer());
        }
        if (++this.idTaken > 12) return this.fatal('id-taken', `Room ${this.code} is taken`);
        return this.later(backoff(Math.min(this.idTaken, 4)), () => void this.createPeer());
      }
      if (!this.everReady && ++this.brokerFails > 4) return this.fatal('broker', 'Cannot reach the PeerJS signalling server');
      this.later(backoff(this.brokerFails), () => void this.createPeer());
    });

    peer.on('error', (err) => {
      if (this.peer !== peer) return;
      const type = (err as { type?: string }).type ?? 'unknown';
      lastError = type;
      switch (type) {
        case 'browser-incompatible':
          return this.fatal('unsupported', 'This browser does not support WebRTC data channels');
        case 'invalid-id':
        case 'invalid-key':
        case 'ssl-unavailable':
          return this.fatal('broker', err.message);
        case 'unavailable-id':
          if (this.everReady) this.soft('id-taken', err.message);
          return;
        case 'network':
        case 'server-error':
        case 'socket-error':
        case 'socket-closed':
          return this.soft('broker', err.message);
        default:
          return this.soft('webrtc', err.message);
      }
    });
  }

  private accept(conn: DataConnection) {
    const cid = (conn.metadata as { clientId?: unknown } | undefined)?.clientId;
    if (typeof cid !== 'string' || !cid) {
      conn.close();
      return;
    }
    conn.on('open', () => {
      if (this.closed) return conn.close();
      const old = this.links.get(cid);
      if (!old && this.links.size >= this.opts.maxGuests) {
        try {
          void conn.send(JSON.stringify({ __ctl: 'busy' } satisfies Ctl));
        } catch {
          /* ignore */
        }
        setTimeout(() => conn.close(), 1500);
        return;
      }
      if (old) this.drop(cid, old.conn);
      this.links.set(cid, { conn, lastRx: Date.now() });
      conn.on('data', (data) => {
        const l = this.links.get(cid);
        if (!l || l.conn !== conn) return;
        l.lastRx = Date.now();
        let msg: unknown = data;
        if (typeof data === 'string') {
          try {
            msg = JSON.parse(data);
          } catch {
            return;
          }
        }
        if ((msg as Partial<Ctl> | null)?.__ctl) return;
        this.em.emit('message', cid, msg);
      });
      conn.on('close', () => this.drop(cid, conn));
      conn.on('error', (e) => this.debug('connection error', cid, e.message));
      this.debug('guest connected', cid);
      this.em.emit('join', cid);
    });
  }

  private drop(cid: string, conn: DataConnection) {
    const l = this.links.get(cid);
    if (!l || l.conn !== conn) return;
    this.links.delete(cid);
    try {
      conn.close();
    } catch {
      /* ignore */
    }
    this.debug('guest left', cid);
    this.em.emit('leave', cid);
  }

  private heartbeat() {
    const now = Date.now();
    for (const [cid, l] of [...this.links]) {
      if (now - l.lastRx > this.opts.deadAfterMs) {
        this.debug('link dead', cid);
        this.drop(cid, l.conn);
        continue;
      }
      try {
        void l.conn.send(JSON.stringify({ __ctl: 'hb' } satisfies Ctl));
      } catch {
        /* ignore */
      }
    }
  }
}
