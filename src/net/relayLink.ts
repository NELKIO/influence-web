/**
 * A data-channel-like link over a "bus": any service that can carry small datagrams to an address
 * (the PeerJS signalling server, public Nostr relays). Used by peerSignalRelay.ts and nostrRelay.ts.
 *
 * Addresses are names inside a room: the host listens on 'h', each guest on its own 'g…' name. The bus
 * maps a name to whatever the service needs (a PeerJS id, a Nostr topic), derived from the room id, so
 * the room code itself never reaches the service.
 *
 * Everything on the bus is a batch of envelopes, deflated when that helps, AES-GCM encrypted with the
 * room key (relayCrypto) and chunked to the bus's frame size. Envelopes sent within `batchMs` to the same address share one
 * batch, so a burst of game messages costs one or a few bus messages.
 *
 * Link protocol (same semantics as a data channel): the guest dials until the host accepts; heartbeats
 * when idle; a link silent for `deadAfterMs` is closed (the guest dials again); bye closes; busy refuses
 * (duel room taken). Messages are numbered per link and duplicates (a bus may deliver twice) dropped.
 * Ordering and loss recovery are left to the layer above (multipath.ts).
 */
import { BaseMultiHost } from './hub';
import { Emitter, type Unsubscribe } from './emitter';
import { openBytes, packText, Reassembler, roomKeys, sealBytes, toFrames, unpackText, DEFAULT_KDF_ITERATIONS, type RoomKeys } from './relayCrypto';
import { randomId } from './room';
import { netLog } from './netdebug';
import type { RelayKind } from './mqttRelay';
import type { LinkKind, Transport, TransportError, TransportErrorCode, TransportEvents, TransportRole } from './transport';

// ---------------------------------------------------------------- bus

export interface RelayBus {
  /** can send right now */
  readonly up: boolean;
  /** our own address (may change, e.g. after a PeerJS id clash) */
  readonly me: string;
  /** largest frame in bytes the bus carries in one message */
  readonly maxFrame: number;
  send(to: string, frame: Uint8Array): void;
  onFrame(cb: (frame: Uint8Array) => void): Unsubscribe;
  onUp(cb: () => void): Unsubscribe;
  onDown(cb: () => void): Unsubscribe;
  /** the bus cannot work for this room (nothing reachable, our address taken for good) */
  onFail(cb: (code: TransportErrorCode, message: string) => void): Unsubscribe;
  /** the service says the address `to` is not there (PeerJS EXPIRE); optional */
  onAbsent?(cb: (to: string) => void): Unsubscribe;
  /** a small number telling the peer which servers we listen on (Nostr: a bitmask of relays); optional */
  advert?(): number | undefined;
  /** the peer at `to` listens on these servers (its advert) */
  setPeerAdvert?(to: string, advert: number): void;
  close(): void;
}

export interface BusContext {
  kind: RelayKind;
  /** hex room id derived from the room code (relayCrypto.roomKeys) */
  roomId: string;
  /** our address name: 'h' (host) or 'g…' (a guest) */
  me: string;
}

export type BusFactory = (ctx: BusContext) => RelayBus;

export class BusEvents {
  readonly em = new Emitter<{
    frame: (f: Uint8Array) => void;
    up: () => void;
    down: () => void;
    fail: (code: TransportErrorCode, message: string) => void;
    absent: (to: string) => void;
  }>();
  onFrame(cb: (frame: Uint8Array) => void) {
    return this.em.on('frame', cb);
  }
  onUp(cb: () => void) {
    return this.em.on('up', cb);
  }
  onDown(cb: () => void) {
    return this.em.on('down', cb);
  }
  onFail(cb: (code: TransportErrorCode, message: string) => void) {
    return this.em.on('fail', cb);
  }
  onAbsent(cb: (to: string) => void) {
    return this.em.on('absent', cb);
  }
}

// ---------------------------------------------------------------- link options

export interface RelayLinkOptions {
  /** PBKDF2 iterations for the room key (both sides must agree) */
  iterations?: number;
  /** send a heartbeat when nothing was sent for this long */
  heartbeatMs?: number;
  /** a link without inbound traffic for this long is closed (and re-dialled by the guest) */
  deadAfterMs?: number;
  /** guest: re-send the dial this often until accepted */
  dialRetryMs?: number;
  /** guest: give up (before the first open) after this many unanswered dials ('bad-code') */
  maxDials?: number;
  /** guest: the service said the host is absent this many times before the first open → 'bad-code' */
  maxAbsent?: number;
  /** collect envelopes for this long into one batch */
  batchMs?: number;
  /** label for logs ('peerrelay', 'nostr') */
  label?: string;
  log?: boolean;
}

const LINK_DEFAULTS: Required<Omit<RelayLinkOptions, 'log' | 'label'>> = {
  iterations: DEFAULT_KDF_ITERATIONS,
  heartbeatMs: 8000,
  deadAfterMs: 25000,
  dialRetryMs: 1500,
  maxDials: 10,
  maxAbsent: 2,
  batchMs: 15,
};

/** `u`: the sender's bus advert (which servers it listens on) */
type Env = (
  | { k: 'dial'; f: string; s: string; r: string; a: number }
  | { k: 'accept'; f: string; s: string; a: number }
  | { k: 'busy' | 'hb' | 'bye'; f: string; s: string; r?: string }
  | { k: 'msg'; f: string; s: string; r?: string; n: number; d: unknown }
) & { u?: number };

const isEnv = (x: unknown): x is Env => {
  const e = x as Partial<Env> | null;
  return !!e && typeof e === 'object' && typeof e.k === 'string' && typeof e.f === 'string' && typeof e.s === 'string';
};

const frameId = () => globalThis.crypto.getRandomValues(new Uint32Array(1))[0];

/** Serialises async work (encryption / decryption) so batches keep their order. */
class Queue {
  private tail: Promise<void> = Promise.resolve();
  run(fn: () => Promise<void> | void): void {
    this.tail = this.tail.then(fn).catch((e) => console.warn('[relay]', e));
  }
  get idle(): Promise<void> {
    return this.tail;
  }
}

/** Remembers which message numbers were seen (a window of the last 1024). */
class SeenSet {
  private set = new Set<number>();
  private low = 0;
  /** true if `n` is new */
  add(n: number): boolean {
    if (n <= this.low || this.set.has(n)) return false;
    this.set.add(n);
    if (this.set.size > 1024) {
      const sorted = [...this.set].sort((a, b) => a - b);
      for (const x of sorted.slice(0, sorted.length - 1024)) this.set.delete(x);
      this.low = sorted[sorted.length - 1025] ?? this.low;
    }
    return true;
  }
}

/** Batching, encryption, chunking and decryption shared by both ends of a link. */
class Wire {
  private out = new Map<string, string[]>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private outQ = new Queue();
  private inQ = new Queue();
  private rebuild = new Reassembler(64);
  lastTx = 0;

  constructor(
    private batchMs: number,
    private getBus: () => RelayBus | null,
    private getKey: () => CryptoKey | null,
    private onEnv: (env: Env) => void,
  ) {}

  /** queue an envelope (serialised now: payload objects may change after send() returns) */
  push(to: string, env: Env, now = false) {
    let list = this.out.get(to);
    if (!list) this.out.set(to, (list = []));
    list.push(JSON.stringify(env));
    this.lastTx = Date.now();
    if (now || this.batchMs <= 0) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), this.batchMs);
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const bus = this.getBus();
    const key = this.getKey();
    if (!bus || !key) {
      this.out.clear();
      return;
    }
    for (const [to, list] of this.out) {
      const text = `[${list.join(',')}]`;
      this.outQ.run(async () => {
        const blob = await sealBytes(key, await packText(text));
        for (const f of toFrames(blob, bus.maxFrame, frameId())) bus.send(to, f);
      });
    }
    this.out.clear();
  }

  /** resolves when everything queued so far went to the bus */
  async drained(): Promise<void> {
    this.flush();
    await this.outQ.idle;
  }

  receive(frame: Uint8Array) {
    const key = this.getKey();
    if (!key) return;
    this.inQ.run(async () => {
      const blob = this.rebuild.push(frame);
      if (!blob) return;
      const packet = await openBytes(key, blob);
      if (!packet) return;
      const v = await unpackText(packet);
      const list = Array.isArray(v) ? v : [v];
      for (const e of list) if (isEnv(e)) this.onEnv(e);
    });
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.out.clear();
  }
}

/** FNV-1a of a string as 8 hex digits (stable short names). */
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ====================================================================== guest

export class RelayLinkGuest implements Transport {
  readonly role: TransportRole = 'guest';
  isOpen = false;
  remoteClientId: string | null = null;
  private em = new Emitter<TransportEvents>();
  private o: Required<Omit<RelayLinkOptions, 'log' | 'label'>>;
  private label: string;
  private log: boolean;
  private keys: RoomKeys | null = null;
  private bus: RelayBus | null = null;
  private wire: Wire;
  private sid = randomId(6);
  private hostSid: string | null = null;
  private attempt = 1;
  private dials = 0;
  private absent = 0;
  private lastDial = 0;
  private lastRx = 0;
  private outN = 0;
  private seen = new SeenSet();
  private everOpened = false;
  private readyEmitted = false;
  private closed = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private offs: Unsubscribe[] = [];

  constructor(
    readonly kind: RelayKind,
    public code: string,
    private clientId: string,
    private factory: BusFactory,
    opts: RelayLinkOptions = {},
  ) {
    this.o = { ...LINK_DEFAULTS, ...strip(opts) } as typeof this.o;
    this.label = opts.label ?? 'relay';
    this.log = !!opts.log;
    this.wire = new Wire(
      this.o.batchMs,
      () => this.bus,
      () => this.keys?.key ?? null,
      (e) => this.rx(e),
    );
    void this.start();
  }

  get linkKind(): LinkKind | null {
    return this.isOpen ? 'relay' : null;
  }

  private debug(...a: unknown[]) {
    if (this.log) console.log(`[${this.label}:guest ${this.code}]`, ...a);
  }

  private async start() {
    try {
      this.keys = await roomKeys(this.kind, this.code, this.o.iterations);
    } catch (e) {
      return this.fatal('unsupported', String(e));
    }
    if (this.closed) return;
    // a stable name per client and room (a PeerJS id); the bus changes it if it is taken
    const bus = this.factory({ kind: this.kind, roomId: this.keys.roomId, me: `g${shortHash(`${this.clientId}|${this.keys.roomId}`)}` });
    this.bus = bus;
    this.offs.push(
      bus.onFrame((f) => this.wire.receive(f)),
      bus.onUp(() => {
        this.debug('bus up');
        if (!this.readyEmitted) {
          this.readyEmitted = true;
          this.em.emit('ready', this.code);
        }
        if (!this.isOpen) this.dial();
      }),
      bus.onFail((code, message) => this.fatal(code, message)),
    );
    if (bus.onAbsent)
      this.offs.push(
        bus.onAbsent((to) => {
          if (to !== 'h' || this.isOpen) return;
          this.absent++;
          this.debug('host absent', this.absent);
          if (!this.everOpened && this.absent >= this.o.maxAbsent) this.fatal('bad-code', `Room ${this.code} not found`);
        }),
      );
    const tick = Math.max(20, Math.min(this.o.dialRetryMs, this.o.heartbeatMs, 250));
    this.timer = setInterval(() => this.watch(), tick);
    if (bus.up) {
      this.readyEmitted = true;
      this.em.emit('ready', this.code);
      this.dial();
    }
  }

  private watch() {
    if (this.closed || !this.bus?.up) return;
    const now = Date.now();
    if (this.isOpen) {
      if (now - this.lastRx > this.o.deadAfterMs) return this.linkDown('link silent');
      if (now - this.wire.lastTx >= this.o.heartbeatMs) this.env({ k: 'hb', f: this.clientId, s: this.sid, r: this.bus.me });
    } else if (now - this.lastDial >= this.o.dialRetryMs) this.dial();
  }

  private dial() {
    if (this.closed || this.isOpen || !this.bus) return;
    this.lastDial = Date.now();
    if (!this.everOpened && ++this.dials > this.o.maxDials) return this.fatal('bad-code', `Room ${this.code} does not answer`);
    this.env({ k: 'dial', f: this.clientId, s: this.sid, r: this.bus.me, a: this.attempt }, true);
  }

  private env(e: Env, now = false) {
    const u = this.bus?.advert?.();
    if (u !== undefined) e.u = u;
    this.wire.push('h', e, now);
  }

  private rx(env: Env) {
    if (this.closed) return;
    if (typeof env.u === 'number') this.bus?.setPeerAdvert?.('h', env.u);
    switch (env.k) {
      case 'accept':
        if (this.isOpen || env.a !== this.attempt) return;
        this.hostSid = env.s;
        this.remoteClientId = env.f;
        this.lastRx = Date.now();
        this.dials = 0;
        this.isOpen = true;
        this.everOpened = true;
        this.debug('link open');
        netLog('relay-open', { path: this.label, role: 'guest' });
        this.em.emit('open');
        return;
      case 'busy':
        return this.fatal('room-full', `Room ${this.code} is full`);
      case 'msg':
        if (!this.isOpen) return;
        if (env.s !== this.hostSid) return this.hostRestarted();
        this.lastRx = Date.now();
        if (this.seen.add(env.n)) this.em.emit('message', env.d);
        return;
      case 'hb':
        if (!this.isOpen) return;
        if (env.s !== this.hostSid) return this.hostRestarted();
        this.lastRx = Date.now();
        return;
      case 'bye':
        if (this.isOpen && env.s === this.hostSid) this.linkDown('host closed the link');
        return;
      default:
        return;
    }
  }

  private hostRestarted() {
    this.linkDown('host restarted');
    this.dial();
  }

  private linkDown(reason: string) {
    if (!this.isOpen) return;
    this.debug('link down:', reason);
    netLog('relay-down', { path: this.label, role: 'guest', reason });
    this.isOpen = false;
    this.attempt++;
    this.lastDial = 0;
    this.seen = new SeenSet();
    this.em.emit('close');
  }

  send(msg: unknown): boolean {
    if (!this.isOpen || this.closed || !this.bus) return false;
    this.env({ k: 'msg', f: this.clientId, s: this.sid, r: this.bus.me, n: ++this.outN, d: msg });
    return true;
  }

  private fatal(code: TransportErrorCode, message: string) {
    if (this.closed) return;
    this.debug('fatal', code, message);
    this.em.emit('error', { code, message, fatal: true });
    this.close();
  }

  close(): void {
    if (this.closed) return;
    const wasOpen = this.isOpen;
    if (wasOpen && this.bus) this.env({ k: 'bye', f: this.clientId, s: this.sid, r: this.bus.me });
    this.closed = true;
    this.isOpen = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.offs.forEach((f) => f());
    this.offs = [];
    const bus = this.bus;
    void this.wire.drained().then(() => bus?.close());
    if (wasOpen) this.em.emit('close');
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

// ====================================================================== host

interface HostLink {
  /** the guest's address name */
  name: string;
  sid: string;
  a: number;
  lastRx: number;
  lastTx: number;
  out: number;
  seen: SeenSet;
}

export interface RelayLinkHostOptions extends RelayLinkOptions {
  clientId: string;
}

export class RelayLinkHost extends BaseMultiHost {
  code: string;
  private o: Required<Omit<RelayLinkOptions, 'log' | 'label'>>;
  private label: string;
  private log: boolean;
  private clientId: string;
  private sid = randomId(6);
  private keys: RoomKeys | null = null;
  private bus: RelayBus | null = null;
  private wire: Wire;
  private links = new Map<string, HostLink>();
  private readyEmitted = false;
  private closed = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private offs: Unsubscribe[] = [];

  constructor(
    readonly kind: RelayKind,
    code: string,
    private factory: BusFactory,
    opts: RelayLinkHostOptions,
  ) {
    super();
    this.code = code;
    this.o = { ...LINK_DEFAULTS, ...strip(opts) } as typeof this.o;
    this.label = opts.label ?? 'relay';
    this.log = !!opts.log;
    this.clientId = opts.clientId;
    this.wire = new Wire(
      this.o.batchMs,
      () => this.bus,
      () => this.keys?.key ?? null,
      (e) => this.rx(e),
    );
    void this.start();
  }

  private debug(...a: unknown[]) {
    if (this.log) console.log(`[${this.label}:host ${this.code}]`, ...a);
  }

  get clients(): string[] {
    return [...this.links.keys()];
  }

  isOpen(clientId: string): boolean {
    return this.links.has(clientId);
  }

  linkOf(clientId: string): LinkKind | null {
    return this.links.has(clientId) ? 'relay' : null;
  }

  private async start() {
    try {
      this.keys = await roomKeys(this.kind, this.code, this.o.iterations);
    } catch (e) {
      return this.fatal('unsupported', String(e));
    }
    if (this.closed) return;
    const bus = this.factory({ kind: this.kind, roomId: this.keys.roomId, me: 'h' });
    this.bus = bus;
    const ready = () => {
      if (this.readyEmitted || this.closed) return;
      this.readyEmitted = true;
      this.debug('ready');
      this.em.emit('ready', this.code);
    };
    this.offs.push(
      bus.onFrame((f) => this.wire.receive(f)),
      bus.onUp(ready),
      bus.onFail((code, message) => this.fatal(code, message)),
    );
    if (bus.up) ready();
    const tick = Math.max(20, Math.min(this.o.heartbeatMs, 500));
    this.timer = setInterval(() => this.watch(), tick);
  }

  private watch() {
    if (this.closed) return;
    const now = Date.now();
    for (const [cid, l] of [...this.links]) {
      if (now - l.lastRx > this.o.deadAfterMs) {
        this.debug('guest link dead', cid);
        this.dropLink(cid);
        continue;
      }
      if (this.bus?.up && now - l.lastTx >= this.o.heartbeatMs) this.sendTo(l, { k: 'hb', f: this.clientId, s: this.sid });
    }
  }

  private rx(env: Env) {
    if (this.closed) return;
    const cid = env.f;
    const link = this.links.get(cid);
    const known = !!link && link.sid === env.s;
    const r = (env as { r?: string }).r;
    if (known && r) link!.name = r;
    if (typeof env.u === 'number' && r) this.bus?.setPeerAdvert?.(r, env.u);
    switch (env.k) {
      case 'dial': {
        if (known && link!.a === env.a) {
          link!.lastRx = Date.now();
          this.sendTo(link!, { k: 'accept', f: this.clientId, s: this.sid, a: env.a }, true);
          return;
        }
        if (link) this.dropLink(cid);
        const l: HostLink = { name: env.r, sid: env.s, a: env.a, lastRx: Date.now(), lastTx: 0, out: 0, seen: new SeenSet() };
        this.links.set(cid, l);
        this.debug('guest link open', cid);
        netLog('relay-open', { path: this.label, role: 'host', cid });
        this.sendTo(l, { k: 'accept', f: this.clientId, s: this.sid, a: env.a }, true);
        this.em.emit('join', cid);
        return;
      }
      case 'msg':
        if (!known) return this.byeTo(env);
        link!.lastRx = Date.now();
        if (link!.seen.add(env.n)) this.em.emit('message', cid, env.d);
        return;
      case 'hb':
        if (!known) return this.byeTo(env);
        link!.lastRx = Date.now();
        return;
      case 'bye':
        if (known) this.dropLink(cid);
        return;
      default:
        return;
    }
  }

  /** tell an unknown guest session (e.g. after a host reload) to dial again */
  private byeTo(env: Env) {
    const name = (env as { r?: string }).r;
    if (name) this.wire.push(name, { k: 'bye', f: this.clientId, s: this.sid });
  }

  private sendTo(l: HostLink, env: Env, now = false): boolean {
    if (!this.bus) return false;
    const u = this.bus.advert?.();
    if (u !== undefined) env.u = u;
    l.lastTx = Date.now();
    this.wire.push(l.name, env, now);
    return this.bus.up;
  }

  private dropLink(cid: string) {
    if (!this.links.delete(cid)) return;
    netLog('relay-down', { path: this.label, role: 'host', cid });
    this.em.emit('leave', cid);
  }

  send(clientId: string, msg: unknown): boolean {
    const l = this.links.get(clientId);
    if (!l || this.closed) return false;
    this.sendTo(l, { k: 'msg', f: this.clientId, s: this.sid, n: ++l.out, d: msg });
    return true;
  }

  kick(clientId: string): void {
    const l = this.links.get(clientId);
    if (!l) return;
    this.sendTo(l, { k: 'bye', f: this.clientId, s: this.sid }, true);
    this.dropLink(clientId);
  }

  refuse(clientId: string): void {
    const l = this.links.get(clientId);
    if (!l) return;
    this.sendTo(l, { k: 'busy', f: this.clientId, s: this.sid }, true);
    this.dropLink(clientId);
  }

  private fatal(code: TransportErrorCode, message: string) {
    if (this.closed) return;
    this.debug('fatal', code, message);
    this.em.emit('error', { code, message, fatal: true });
    this.shutdown(false);
  }

  close(): void {
    this.shutdown(true);
  }

  /** stop without telling the guests (page reload: the resumed host takes the links over) */
  detach(): void {
    this.shutdown(false);
  }

  private shutdown(bye: boolean) {
    if (this.closed) return;
    if (bye) for (const l of this.links.values()) this.sendTo(l, { k: 'bye', f: this.clientId, s: this.sid });
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.offs.forEach((f) => f());
    this.offs = [];
    this.links.clear();
    const bus = this.bus;
    void this.wire.drained().then(() => bus?.close());
  }
}

function strip<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}
