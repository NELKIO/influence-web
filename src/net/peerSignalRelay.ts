/**
 * Relay through the PeerJS signalling server: the same public service (wss://0.peerjs.com) that sets
 * up WebRTC also forwards small messages between two registered ids. When WebRTC itself cannot connect
 * (VPNs, mobile carrier NAT, no TURN) the signalling server is usually still reachable, so it can carry
 * the (tiny) game traffic.
 *
 * Each side opens its OWN WebSocket to the broker (separate from the WebRTC Peer), registered under an
 * id derived from the room id (never the code) and the role: `iwr-<room>-h` for the host, `iwr-<room>-g…`
 * for a guest. Payloads are the encrypted frames of relayLink.ts, base64 inside CANDIDATE messages (the
 * broker validates the shape of a candidate: `{candidate: {candidate: string}, type, connectionId}`),
 * marked with connectionId 'iwrelay1'.
 *
 * Broker facts (measured October 2026): a WebSocket message above ~16 KB closes the socket (1009), so
 * frames stay below 10 KB (≈ 13.6 KB as base64 JSON); messages sent before {"type":"OPEN"} are lost;
 * a message to an absent id comes back as EXPIRE after ~5 s; malformed messages close the socket; and
 * Cloudflare rate-limits new WebSockets per IP (HTTP 429 for about an hour), so reconnects back off
 * hard and nothing polls. A HEARTBEAT every 10 s keeps the socket registered.
 */
import { BusEvents, RelayLinkGuest, RelayLinkHost, type BusContext, type BusFactory, type RelayBus, type RelayLinkOptions } from './relayLink';
import { fromB64, toB64 } from './relayCrypto';
import { randomId } from './room';
import { netLog } from './netdebug';
import type { RelayKind } from './mqttRelay';

/** The minimal WebSocket surface the bus uses (injectable for tests). */
export interface WsLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type WsFactory = (url: string) => WsLike;

export const defaultWsFactory: WsFactory = (url) => new WebSocket(url) as unknown as WsLike;

export interface PeerRelayOptions extends RelayLinkOptions {
  /** broker host, default the PeerJS cloud */
  brokerHost?: string;
  brokerPort?: number;
  brokerPath?: string;
  brokerKey?: string;
  secure?: boolean;
  /** id namespace on the broker */
  idPrefix?: string;
  /** WebSocket keep-alive (ms) */
  pingMs?: number;
  /** consecutive failed connects (never registered) before the path gives up */
  maxConnectFails?: number;
  /** frame size in bytes */
  frameBytes?: number;
  ws?: WsFactory;
}

export const PEER_RELAY_MARK = 'iwrelay1';
const PEERJS_VERSION = '1.5.5';

/** broker URL of one id */
export function peerBrokerUrl(o: PeerRelayOptions, id: string): string {
  const host = o.brokerHost ?? '0.peerjs.com';
  const secure = o.secure ?? true;
  const port = o.brokerPort ?? (secure ? 443 : 80);
  const path = (o.brokerPath ?? '/').replace(/\/?$/, '/');
  const key = o.brokerKey ?? 'peerjs';
  return `${secure ? 'wss' : 'ws'}://${host}:${port}${path}peerjs?key=${encodeURIComponent(key)}&id=${encodeURIComponent(id)}&token=${randomId(6)}&version=${PEERJS_VERSION}`;
}

const backoff = (n: number, base: number, max: number) => Math.min(max, base * 2 ** n) * (0.85 + Math.random() * 0.3);

export class PeerSignalBus extends BusEvents implements RelayBus {
  up = false;
  me: string;
  readonly maxFrame: number;
  private ws: WsLike | null = null;
  private closed = false;
  private pending: string[] = [];
  private fails = 0;
  private everUp = false;
  private idTaken = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private prefix: string;
  private factory: WsFactory;

  constructor(
    ctx: BusContext,
    private o: PeerRelayOptions = {},
  ) {
    super();
    this.me = ctx.me;
    this.maxFrame = o.frameBytes ?? 10_000;
    this.prefix = `${o.idPrefix ?? 'iwr-'}${ctx.kind === 'duel' ? 'd' : 'b'}${ctx.roomId.slice(0, 16)}-`;
    this.factory = o.ws ?? defaultWsFactory;
    queueMicrotask(() => this.connect());
  }

  /** broker id of an address name */
  idOf(name: string): string {
    return `${this.prefix}${name}`;
  }

  private nameOf(id: unknown): string | null {
    return typeof id === 'string' && id.startsWith(this.prefix) ? id.slice(this.prefix.length) : null;
  }

  private connect() {
    if (this.closed) return;
    let ws: WsLike;
    try {
      ws = this.factory(peerBrokerUrl(this.o, this.idOf(this.me)));
    } catch (e) {
      this.em.emit('fail', 'unsupported', String(e));
      return;
    }
    this.ws = ws;
    let registered = false;
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      let m: { type?: string; src?: string; payload?: { connectionId?: string; candidate?: { candidate?: unknown }; msg?: string } };
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      switch (m.type) {
        case 'OPEN':
          registered = true;
          this.fails = 0;
          this.idTaken = 0;
          this.everUp = true;
          this.up = true;
          netLog('peerrelay-open', { id: this.me });
          for (const p of this.pending.splice(0)) this.raw(p);
          this.em.emit('up');
          return;
        case 'CANDIDATE': {
          const p = m.payload;
          if (p?.connectionId !== PEER_RELAY_MARK) return;
          const c = p.candidate?.candidate;
          if (typeof c !== 'string' || !c.startsWith('iw:')) return;
          const frame = fromB64(c.slice(3));
          if (frame) this.em.emit('frame', frame);
          return;
        }
        case 'EXPIRE': {
          const name = this.nameOf(m.src);
          if (name) this.em.emit('absent', name);
          return;
        }
        case 'ID-TAKEN':
          this.idTaken++;
          netLog('peerrelay-id-taken', { id: this.me, n: this.idTaken });
          // a guest name is per client: another tab of the same browser may hold it → use a fresh one
          if (this.me !== 'h' && this.idTaken >= 2) this.me = `${this.me.slice(0, 9)}${randomId(2)}`;
          ws.close();
          return;
        case 'INVALID-KEY':
          this.em.emit('fail', 'broker', 'PeerJS broker rejected the key');
          this.close();
          return;
        case 'ERROR':
          netLog('peerrelay-error', { msg: m.payload?.msg });
          return;
        default:
          return;
      }
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      const wasUp = this.up;
      this.up = false;
      if (this.ping) clearInterval(this.ping);
      this.ping = null;
      netLog('peerrelay-closed', { id: this.me, code: ev?.code, registered });
      if (wasUp) this.em.emit('down');
      if (this.closed) return;
      if (!registered) {
        if (this.idTaken > 0) {
          if (this.me === 'h' && this.idTaken > 8) return this.giveUp('id-taken', 'The relay id of this room is taken');
          return this.later(backoff(Math.min(this.idTaken, 4), 500, 8000));
        }
        this.fails++;
        if (!this.everUp && this.fails >= (this.o.maxConnectFails ?? 3)) return this.giveUp('broker', 'Cannot reach the PeerJS server');
        return this.later(backoff(this.fails, 2000, 60_000));
      }
      // a registered socket dropped: come back soon, then slower
      this.later(backoff(this.fails++, 1000, 30_000));
    };
    ws.onerror = () => {
      /* onclose follows */
    };
    ws.onopen = () => {
      if (this.ws !== ws) return;
      if (this.ping) clearInterval(this.ping);
      this.ping = setInterval(() => {
        if (this.ws === ws && this.up) this.raw('{"type":"HEARTBEAT"}');
      }, this.o.pingMs ?? 10_000);
    };
  }

  private giveUp(code: 'broker' | 'id-taken', message: string) {
    this.em.emit('fail', code, message);
    this.close();
  }

  private later(ms: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, ms);
  }

  private raw(s: string) {
    try {
      this.ws?.send(s);
    } catch {
      /* the close handler reconnects */
    }
  }

  send(to: string, frame: Uint8Array): void {
    if (this.closed) return;
    const msg = JSON.stringify({
      type: 'CANDIDATE',
      dst: this.idOf(to),
      payload: { type: 'data', connectionId: PEER_RELAY_MARK, candidate: { candidate: `iw:${toB64(frame)}`, sdpMid: '0', sdpMLineIndex: 0 } },
    });
    if (this.up) this.raw(msg);
    else {
      // messages sent before OPEN are lost: keep a few for when the socket is registered
      this.pending.push(msg);
      if (this.pending.length > 64) this.pending.shift();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.up = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.ping) clearInterval(this.ping);
    this.timer = this.ping = null;
    this.pending = [];
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
  }
}

export function peerRelayBus(o: PeerRelayOptions = {}): BusFactory {
  return (ctx) => new PeerSignalBus(ctx, o);
}

export function createPeerRelayGuest(kind: RelayKind, code: string, clientId: string, o: PeerRelayOptions = {}): RelayLinkGuest {
  return new RelayLinkGuest(kind, code, clientId, peerRelayBus(o), { label: 'peerrelay', ...o });
}

export function createPeerRelayHost(kind: RelayKind, code: string, clientId: string, o: PeerRelayOptions = {}): RelayLinkHost {
  return new RelayLinkHost(kind, code, peerRelayBus(o), { label: 'peerrelay', ...o, clientId });
}
