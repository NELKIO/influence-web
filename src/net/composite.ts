/**
 * Composite transports: a direct WebRTC link (PeerJS) when possible, the MQTT relay otherwise.
 *
 * Guest: dials WebRTC first; when the data channel is not open within `fallbackMs` (default 5 s), or
 * PeerJS reports a WebRTC / broker / unknown-room problem, it switches to the relay for good (the
 * relay decides whether the room exists). A direct link that drops and does not come back within
 * `fallbackMs` also switches. Host: listens on both and answers each guest on the link that guest
 * uses right now. Room codes are chosen without PeerJS: if PeerJS cannot register, the relay alone
 * carries the room.
 *
 * Link mode: 'auto' (default), 'direct' (PeerJS only) or 'relay' (relay only); pages pick it with
 * `?transport=direct|relay` (and `?transport=bc` for the BroadcastChannel test transport).
 */
import { BaseMultiHost, type MultiHostTransport } from './hub';
import { Emitter, type Unsubscribe } from './emitter';
import { MultiPeerHost } from './multiPeer';
import { RelayGuest, RelayHost, type RelayKind, type RelayOptions } from './mqttRelay';
import {
  BATTLE_CODE_LENGTH,
  BATTLE_PEER_ID_PREFIX,
  CODE_LENGTH,
  generateBattleCode,
  generateCode,
  PEER_ID_PREFIX,
} from './room';
import {
  PeerTransport,
  type LinkKind,
  type PeerTransportOptions,
  type Transport,
  type TransportError,
  type TransportEvents,
  type TransportRole,
} from './transport';

export type LinkMode = 'auto' | 'direct' | 'relay';

/** Link mode from the page URL (`?transport=direct|relay`), 'auto' otherwise. */
export function linkModeFromUrl(): LinkMode {
  if (typeof location === 'undefined') return 'auto';
  const v = new URLSearchParams(location.search).get('transport');
  return v === 'direct' || v === 'relay' ? v : 'auto';
}

export interface NetLinkOptions {
  /** PeerJS tuning */
  peer?: Omit<PeerTransportOptions, 'clientId'>;
  /** relay tuning (brokers, client factory, timings); false disables the relay */
  relay?: RelayOptions | false;
  /** default: from the URL, else 'auto' */
  mode?: LinkMode;
  /** guest: switch to the relay when WebRTC is not open after this long (default 5000) */
  fallbackMs?: number;
}

// ====================================================================== guest

export interface CompositeGuestOptions {
  /** creates the direct transport (null: none) */
  direct: (() => Transport) | null;
  /** creates the relay transport (null: none) */
  relay: (() => Transport) | null;
  fallbackMs?: number;
}

const FALLBACK_CODES = new Set(['webrtc', 'broker', 'bad-code', 'unsupported']);

export class CompositeGuest implements Transport {
  readonly role: TransportRole = 'guest';
  isOpen = false;
  private em = new Emitter<TransportEvents>();
  private active: Transport | null = null;
  private kind: LinkKind = 'direct';
  private offs: Unsubscribe[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readyEmitted = false;
  private closed = false;
  private fallbackMs: number;
  /** why the guest switched to the relay (null: did not) */
  fellBackBecause: string | null = null;

  constructor(
    public code: string | null,
    private opts: CompositeGuestOptions,
  ) {
    this.fallbackMs = opts.fallbackMs ?? 5000;
    if (opts.direct) this.use('direct', opts.direct());
    else if (opts.relay) this.use('relay', opts.relay());
    else queueMicrotask(() => this.em.emit('error', { code: 'unsupported', message: 'no transport', fatal: true }));
  }

  get remoteClientId(): string | null {
    return this.active?.remoteClientId ?? null;
  }

  get linkKind(): LinkKind | null {
    return this.isOpen ? this.kind : null;
  }

  private use(kind: LinkKind, t: Transport) {
    this.kind = kind;
    this.active = t;
    this.offs = [
      t.onReady((c) => {
        if (this.readyEmitted) return;
        this.readyEmitted = true;
        this.em.emit('ready', c);
      }),
      t.onOpen(() => {
        if (this.active !== t) return;
        this.clearTimer();
        this.isOpen = true;
        this.em.emit('open');
      }),
      t.onClose(() => {
        if (this.active !== t) return;
        if (this.isOpen) {
          this.isOpen = false;
          this.em.emit('close');
        }
        if (kind === 'direct') this.armFallback('direct link lost');
      }),
      t.onMessage((m) => {
        if (this.active === t) this.em.emit('message', m);
      }),
      t.onError((e) => {
        if (this.active !== t) return;
        if (kind === 'direct' && this.opts.relay && FALLBACK_CODES.has(e.code) && !(e.code === 'bad-code' && this.everOpenedDirect)) {
          this.toRelay(`direct: ${e.code}`);
          return;
        }
        this.em.emit('error', e);
      }),
    ];
    if (kind === 'direct') {
      t.onOpen(() => (this.everOpenedDirect = true));
      this.armFallback('direct link not open in time');
    }
  }

  private everOpenedDirect = false;

  private armFallback(reason: string) {
    if (!this.opts.relay || this.kind !== 'direct' || this.closed) return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.kind === 'direct' && !this.isOpen) this.toRelay(reason);
    }, this.fallbackMs);
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private toRelay(reason: string) {
    if (this.closed || this.kind === 'relay' || !this.opts.relay) return;
    this.fellBackBecause = reason;
    this.clearTimer();
    const old = this.active;
    this.offs.forEach((f) => f());
    this.offs = [];
    this.active = null;
    old?.close();
    if (this.isOpen) {
      this.isOpen = false;
      this.em.emit('close');
    }
    this.use('relay', this.opts.relay());
  }

  send(msg: unknown): boolean {
    return this.isOpen && !!this.active?.send(msg);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimer();
    const t = this.active;
    this.offs.forEach((f) => f());
    this.offs = [];
    t?.close();
    if (this.isOpen) {
      this.isOpen = false;
      this.em.emit('close');
    }
  }

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

// ====================================================================== host (many guests)

export interface CompositeHostOptions {
  code: string;
  direct: ((code: string) => MultiHostTransport) | null;
  relay: (() => RelayHost) | null;
}

/**
 * Host side over both paths. A guest is open while any of its links is open; replies go to the link
 * it joined last. Switching links counts as a reconnect (leave + join) so the session re-handshakes.
 */
export class CompositeHost extends BaseMultiHost {
  code: string;
  private direct: MultiHostTransport | null = null;
  private relay: RelayHost | null = null;
  private routes = new Map<string, { direct: boolean; relay: boolean; active: LinkKind }>();
  private offs: Unsubscribe[] = [];
  private readyEmitted = false;
  private failed = { direct: false, relay: false };
  private closed = false;

  constructor(private opts: CompositeHostOptions) {
    super();
    this.code = opts.code;
    if (opts.relay) {
      this.relay = opts.relay();
      this.code = this.relay.code;
      this.wire('relay', this.relay);
    } else this.failed.relay = true;
    if (opts.direct) this.startDirect(this.code);
    else this.failed.direct = true;
  }

  private startDirect(code: string) {
    const d = this.opts.direct!(code);
    this.direct = d;
    this.failed.direct = false;
    this.wire('direct', d);
  }

  private wire(kind: LinkKind, t: MultiHostTransport) {
    this.offs.push(
      t.onReady((code) => {
        if (kind === 'relay') {
          if (code !== this.code) {
            // the relay had to pick another code: move the direct path too
            this.code = code;
            if (this.direct) {
              const old = this.direct;
              this.direct = null;
              old.close();
              if (this.opts.direct) this.startDirect(code);
            }
          }
          this.emitReady();
        } else if (t === this.direct && (this.failed.relay || !this.relay)) this.emitReady();
      }),
      t.onJoin((cid) => {
        if (kind === 'direct' && t !== this.direct) return;
        const r = this.routes.get(cid);
        if (!r) {
          this.routes.set(cid, { direct: kind === 'direct', relay: kind === 'relay', active: kind });
          this.em.emit('join', cid);
          return;
        }
        r[kind] = true;
        r.active = kind;
        // a new connection of a known guest (re-dial or switch of path): the session re-handshakes
        this.em.emit('leave', cid);
        this.em.emit('join', cid);
      }),
      t.onLeave((cid) => {
        if (kind === 'direct' && t !== this.direct) return;
        const r = this.routes.get(cid);
        if (!r) return;
        r[kind] = false;
        if (r.active !== kind) return;
        const other: LinkKind = kind === 'direct' ? 'relay' : 'direct';
        if (r[other]) {
          r.active = other;
          return;
        }
        this.routes.delete(cid);
        this.em.emit('leave', cid);
      }),
      t.onMessage((cid, m) => {
        if (kind === 'direct' && t !== this.direct) return;
        this.em.emit('message', cid, m);
      }),
      t.onError((e) => {
        if (kind === 'direct' && t !== this.direct) return;
        if (e.fatal) {
          this.failed[kind] = true;
          if (kind === 'relay' && this.direct && this.direct.code && !this.readyEmitted && this.directReady) this.emitReady();
        }
        if (e.fatal && this.failed.direct && this.failed.relay) this.em.emit('error', e);
        else this.em.emit('error', { ...e, fatal: false });
      }),
    );
    if (kind === 'direct') this.offs.push(t.onReady(() => (this.directReady = true)));
  }

  private directReady = false;

  private emitReady() {
    if (this.readyEmitted || this.closed) return;
    this.readyEmitted = true;
    this.em.emit('ready', this.code);
  }

  get clients(): string[] {
    return [...this.routes.keys()];
  }

  isOpen(clientId: string): boolean {
    return this.routes.has(clientId);
  }

  linkOf(clientId: string): LinkKind | null {
    return this.routes.get(clientId)?.active ?? null;
  }

  private via(clientId: string): MultiHostTransport | null {
    const r = this.routes.get(clientId);
    if (!r) return null;
    return r.active === 'relay' ? this.relay : this.direct;
  }

  send(clientId: string, msg: unknown): boolean {
    return !!this.via(clientId)?.send(clientId, msg);
  }

  kick(clientId: string): void {
    this.direct?.kick(clientId);
    this.relay?.kick(clientId);
  }

  refuse(clientId: string): void {
    const t = this.via(clientId);
    if (t?.refuse) t.refuse(clientId);
    else t?.kick(clientId);
  }

  /** the relay host (for diagnostics) */
  get relayHost(): RelayHost | null {
    return this.relay;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.direct?.close();
    this.relay?.close();
  }

  /** stop without clearing the relay presence (page reload / dispose: the room is resumed later) */
  detach(): void {
    if (this.closed) return;
    this.closed = true;
    this.direct?.close();
    this.relay?.detach();
  }
}

// ====================================================================== host (one guest, duels)

/**
 * 1:1 host Transport over a MultiHostTransport: the first guest (or `expectClientId`) is bound,
 * everybody else is refused ('room-full' on their side).
 */
export class SingleHost implements Transport {
  readonly role: TransportRole = 'host';
  isOpen = false;
  remoteClientId: string | null;
  private em = new Emitter<TransportEvents>();
  private offs: Unsubscribe[];

  constructor(
    readonly multi: MultiHostTransport,
    expectClientId: string | null = null,
  ) {
    this.remoteClientId = expectClientId;
    this.offs = [
      multi.onReady((c) => this.em.emit('ready', c)),
      multi.onJoin((cid) => {
        if (this.remoteClientId && cid !== this.remoteClientId) {
          if (multi.refuse) multi.refuse(cid);
          else multi.kick(cid);
          return;
        }
        this.remoteClientId = cid;
        if (this.isOpen) this.em.emit('close');
        this.isOpen = true;
        this.em.emit('open');
      }),
      multi.onLeave((cid) => {
        if (cid !== this.remoteClientId || !this.isOpen) return;
        this.isOpen = false;
        this.em.emit('close');
      }),
      multi.onMessage((cid, m) => {
        if (cid === this.remoteClientId && this.isOpen) this.em.emit('message', m);
      }),
      multi.onError((e) => this.em.emit('error', e)),
    ];
  }

  get code(): string | null {
    return this.multi.code;
  }

  get linkKind(): LinkKind | null {
    return this.isOpen && this.remoteClientId ? (this.multi.linkOf?.(this.remoteClientId) ?? null) : null;
  }

  send(msg: unknown): boolean {
    return this.isOpen && !!this.remoteClientId && this.multi.send(this.remoteClientId, msg);
  }

  close(): void {
    this.offs.forEach((f) => f());
    this.multi.close();
    if (this.isOpen) {
      this.isOpen = false;
      this.em.emit('close');
    }
  }

  /** close but keep the relay presence (resume later) */
  detach(): void {
    this.offs.forEach((f) => f());
    const m = this.multi as MultiHostTransport & { detach?: () => void };
    if (m.detach) m.detach();
    else m.close();
    this.isOpen = false;
  }

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

// ====================================================================== factories

interface HostFactoryOptions extends NetLinkOptions {
  clientId: string;
  /** room code (generated when omitted) */
  code?: string;
  /** keep the code no matter what (resume); a new room may move to another code on a collision */
  fixed?: boolean;
}

function hostParts(kind: RelayKind, o: HostFactoryOptions) {
  const mode = o.mode ?? linkModeFromUrl();
  const gen = kind === 'duel' ? () => generateCode() : () => generateBattleCode();
  const code = o.code ?? gen();
  const fixed = o.fixed ?? !!o.code;
  const relayOpts = o.relay === false ? null : (o.relay ?? {});
  const relay =
    mode !== 'direct' && relayOpts
      ? () => new RelayHost(kind, code, { ...relayOpts, clientId: o.clientId, fixed, generate: fixed ? undefined : gen })
      : null;
  const direct =
    mode !== 'relay'
      ? (c: string) =>
          new MultiPeerHost({
            ...o.peer,
            clientId: o.clientId,
            code: c,
            fixedCode: true,
            idPrefix: kind === 'duel' ? PEER_ID_PREFIX : BATTLE_PEER_ID_PREFIX,
            maxGuests: kind === 'duel' ? 2 : 5,
          })
      : null;
  return { code, relay, direct };
}

/** Battle room host: WebRTC + relay. */
export function createBattleHostTransport(o: HostFactoryOptions): CompositeHost {
  return new CompositeHost(hostParts('battle', o));
}

/** Duel host (1:1): WebRTC + relay. */
export function createDuelHostTransport(o: HostFactoryOptions & { expectClientId?: string | null }): SingleHost {
  return new SingleHost(new CompositeHost(hostParts('duel', o)), o.expectClientId ?? null);
}

function guestParts(kind: RelayKind, code: string, o: NetLinkOptions & { clientId: string }): CompositeGuestOptions {
  const mode = o.mode ?? linkModeFromUrl();
  const relayOpts = o.relay === false ? null : (o.relay ?? {});
  return {
    fallbackMs: o.fallbackMs,
    direct:
      mode !== 'relay'
        ? () =>
            PeerTransport.join(code, {
              ...o.peer,
              clientId: o.clientId,
              idPrefix: kind === 'duel' ? PEER_ID_PREFIX : BATTLE_PEER_ID_PREFIX,
              codeLength: kind === 'duel' ? CODE_LENGTH : BATTLE_CODE_LENGTH,
            })
        : null,
    relay: mode !== 'direct' && relayOpts ? () => new RelayGuest(kind, code, o.clientId, relayOpts) : null,
  };
}

export function createDuelGuestTransport(code: string, o: NetLinkOptions & { clientId: string }): CompositeGuest {
  return new CompositeGuest(code, guestParts('duel', code, o));
}

export function createBattleGuestTransport(code: string, o: NetLinkOptions & { clientId: string }): CompositeGuest {
  return new CompositeGuest(code, guestParts('battle', code, o));
}
