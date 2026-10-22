/**
 * Multi-guest transports for battle rooms: one host, several guests, each guest connection identified
 * by the guest's persistent clientId. The guest side uses the ordinary 1:1 `Transport` interface.
 *
 * This file defines the host-side interface and an in-memory hub for unit tests
 * (`createLoopbackHub`: 1 host + N guests with connect / disconnect / drop / reload controls).
 */
import { Emitter, type Unsubscribe } from './emitter';
import type { Transport, TransportError, TransportEvents, TransportRole } from './transport';

export interface MultiHostEvents {
  /** the room is registered; `code` is the final room code */
  ready: (code: string) => void;
  /** a guest connection opened (also on every reconnect) */
  join: (clientId: string) => void;
  /** a guest connection closed */
  leave: (clientId: string) => void;
  message: (clientId: string, msg: unknown) => void;
  error: (err: TransportError) => void;
}

/** Host side of a battle room: many reconnecting guest links keyed by clientId. */
export interface MultiHostTransport {
  /** room code (null until the room is registered) */
  readonly code: string | null;
  /** clientIds with an open link right now */
  readonly clients: string[];
  isOpen(clientId: string): boolean;
  /** send a JSON-serialisable message to one guest; false (dropped) when that link is not open */
  send(clientId: string, msg: unknown): boolean;
  /** close one guest's link (it may dial again) */
  kick(clientId: string): void;
  onReady(cb: (code: string) => void): Unsubscribe;
  onJoin(cb: (clientId: string) => void): Unsubscribe;
  onLeave(cb: (clientId: string) => void): Unsubscribe;
  onMessage(cb: (clientId: string, msg: unknown) => void): Unsubscribe;
  onError(cb: (err: TransportError) => void): Unsubscribe;
  /** permanently close the room */
  close(): void;
}

export abstract class BaseMultiHost implements MultiHostTransport {
  protected em = new Emitter<MultiHostEvents>();
  abstract readonly code: string | null;
  abstract readonly clients: string[];
  abstract isOpen(clientId: string): boolean;
  abstract send(clientId: string, msg: unknown): boolean;
  abstract kick(clientId: string): void;
  abstract close(): void;
  onReady(cb: (code: string) => void) {
    return this.em.on('ready', cb);
  }
  onJoin(cb: (clientId: string) => void) {
    return this.em.on('join', cb);
  }
  onLeave(cb: (clientId: string) => void) {
    return this.em.on('leave', cb);
  }
  onMessage(cb: (clientId: string, msg: unknown) => void) {
    return this.em.on('message', cb);
  }
  onError(cb: (err: TransportError) => void) {
    return this.em.on('error', cb);
  }
}

// ====================================================================== loopback hub (tests)

const wire = (msg: unknown) => JSON.stringify(msg);

export class LoopbackHubHost extends BaseMultiHost {
  closed = false;
  /** messages sent per clientId (parsed), for assertions */
  readonly sent = new Map<string, unknown[]>();
  constructor(
    private hub: LoopbackHub,
    public code: string | null,
  ) {
    super();
  }
  get clients(): string[] {
    return [...this.hub.links()].filter((id) => this.isOpen(id));
  }
  isOpen(clientId: string): boolean {
    return !this.closed && this.hub.isUp(clientId) && this.hub.host === this;
  }
  send(clientId: string, msg: unknown): boolean {
    if (!this.isOpen(clientId)) return false;
    const w = wire(msg);
    let list = this.sent.get(clientId);
    if (!list) this.sent.set(clientId, (list = []));
    list.push(JSON.parse(w));
    if (this.hub.shouldDrop('host', clientId)) return true;
    const target = this.hub.guestEndpoint(clientId);
    const epoch = this.hub.epoch(clientId);
    this.hub.pending++;
    queueMicrotask(() => {
      this.hub.pending--;
      if (target && this.hub.epoch(clientId) === epoch && this.isOpen(clientId)) target._emit('message', JSON.parse(w));
    });
    return true;
  }
  kick(clientId: string): void {
    this.hub.disconnect(clientId, false);
  }
  close(): void {
    if (this.closed) return;
    const current = this.hub.host === this;
    this.closed = true;
    if (current) for (const id of this.hub.links()) this.hub.drop(id);
  }
  /** @internal */
  _emit<K extends keyof MultiHostEvents>(type: K, ...args: Parameters<MultiHostEvents[K]>) {
    if (!this.closed) this.em.emit(type, ...args);
  }
}

export class LoopbackHubGuest implements Transport {
  readonly role: TransportRole = 'guest';
  private em = new Emitter<TransportEvents>();
  closed = false;
  readonly sent: unknown[] = [];
  remoteClientId: string | null = 'host';
  constructor(
    private hub: LoopbackHub,
    readonly clientId: string,
    public code: string | null,
  ) {}
  get isOpen(): boolean {
    return !this.closed && this.hub.guestEndpoint(this.clientId) === this && this.hub.isUp(this.clientId);
  }
  send(msg: unknown): boolean {
    if (!this.isOpen) return false;
    const w = wire(msg);
    this.sent.push(JSON.parse(w));
    if (this.hub.shouldDrop(this.clientId, 'host')) return true;
    const host = this.hub.host;
    const epoch = this.hub.epoch(this.clientId);
    this.hub.pending++;
    queueMicrotask(() => {
      this.hub.pending--;
      if (this.hub.host === host && this.hub.epoch(this.clientId) === epoch && this.isOpen) host._emit('message', this.clientId, JSON.parse(w));
    });
    return true;
  }
  close(): void {
    if (this.closed) return;
    const wasCurrent = this.hub.guestEndpoint(this.clientId) === this;
    if (wasCurrent) this.hub.disconnect(this.clientId, false);
    this.closed = true;
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
  /** @internal */
  _emit<K extends keyof TransportEvents>(type: K, ...args: Parameters<TransportEvents[K]>) {
    if (!this.closed) this.em.emit(type, ...args);
  }
}

interface LinkState {
  guest: LoopbackHubGuest;
  up: boolean;
  /** the test wants this link up (re-dialled automatically after a host reload) */
  want: boolean;
  epoch: number;
}

/**
 * In-memory battle room network. Messages are JSON round-tripped and delivered asynchronously
 * (microtasks) in order per link. `await hub.flush()` delivers everything in flight.
 */
export class LoopbackHub {
  host: LoopbackHubHost;
  pending = 0;
  private map = new Map<string, LinkState>();
  private drops = new Map<string, number>();
  constructor(readonly code: string) {
    this.host = new LoopbackHubHost(this, code);
    const h = this.host;
    queueMicrotask(() => h._emit('ready', code));
  }

  links(): string[] {
    return [...this.map.keys()];
  }
  isUp(clientId: string): boolean {
    return this.map.get(clientId)?.up ?? false;
  }
  epoch(clientId: string): number {
    return this.map.get(clientId)?.epoch ?? -1;
  }
  guestEndpoint(clientId: string): LoopbackHubGuest | null {
    return this.map.get(clientId)?.guest ?? null;
  }

  /**
   * A fresh guest endpoint for `clientId` (a new page / page reload: the previous endpoint of that
   * client dies). Connects on the next microtask unless `autoConnect` is false.
   */
  guest(clientId: string, opts: { autoConnect?: boolean; code?: string } = {}): LoopbackHubGuest {
    const old = this.map.get(clientId);
    if (old) {
      this.drop(clientId);
      old.guest.closed = true;
    }
    const g = new LoopbackHubGuest(this, clientId, opts.code ?? this.code);
    this.map.set(clientId, { guest: g, up: false, want: opts.autoConnect !== false, epoch: (old?.epoch ?? 0) + 1 });
    queueMicrotask(() => g._emit('ready', g.code ?? this.code));
    if (opts.autoConnect !== false) this.connect(clientId);
    return g;
  }

  /** bring a guest's link up (both sides fire open/join) on the next microtask */
  connect(clientId: string): void {
    const l = this.map.get(clientId);
    if (!l) return;
    l.want = true;
    queueMicrotask(() => {
      const cur = this.map.get(clientId);
      if (!cur || cur !== l || l.up || !l.want || l.guest.closed || this.host.closed) return;
      l.up = true;
      l.epoch++;
      this.host._emit('join', clientId);
      l.guest._emit('open');
    });
  }

  /** network drop of one guest link (in-flight messages are lost). `stayDown` keeps it down until connect(). */
  disconnect(clientId: string, stayDown = true): void {
    const l = this.map.get(clientId);
    if (!l) return;
    if (stayDown) l.want = false;
    this.drop(clientId);
  }

  /** @internal close the link now */
  drop(clientId: string): void {
    const l = this.map.get(clientId);
    if (!l || !l.up) return;
    l.up = false;
    l.epoch++;
    this.host._emit('leave', clientId);
    l.guest._emit('close');
  }

  /** drop the next `n` messages from `from` ('host' or a clientId) to `to` ('host' or a clientId) */
  dropNext(from: string, to: string, n = 1): void {
    const k = `${from}>${to}`;
    this.drops.set(k, (this.drops.get(k) ?? 0) + n);
  }

  /** forget all pending dropNext() counters (the network is healthy again) */
  clearDrops(): void {
    this.drops.clear();
  }

  /** @internal */
  shouldDrop(from: string, to: string): boolean {
    const k = `${from}>${to}`;
    const n = this.drops.get(k) ?? 0;
    if (n <= 0) return false;
    this.drops.set(k, n - 1);
    return true;
  }

  /**
   * Simulate a reload of the host page: every link drops, the old host endpoint dies and a new one is
   * returned; it fires `ready` and the guests that want to be connected re-dial.
   */
  newHost(): LoopbackHubHost {
    for (const id of this.links()) this.drop(id);
    this.host.closed = true;
    const h = new LoopbackHubHost(this, this.code);
    this.host = h;
    queueMicrotask(() => {
      h._emit('ready', this.code);
      for (const [id, l] of this.map) if (l.want && !l.guest.closed) this.connect(id);
    });
    return h;
  }

  /** reconnect every guest link that was dropped but is wanted (e.g. after kicks) */
  reconnectAll(): void {
    for (const [id, l] of this.map) if (!l.guest.closed) this.connect(id);
  }

  /** wait until all in-flight messages (and the reactions they trigger) are delivered */
  async flush(maxRounds = 100000): Promise<void> {
    for (let i = 0; i < maxRounds; i++) {
      await Promise.resolve();
      if (this.pending === 0) {
        for (let k = 0; k < 4; k++) await Promise.resolve();
        if (this.pending === 0) return;
      }
    }
    throw new Error('LoopbackHub.flush: messages keep flowing');
  }
}

export function createLoopbackHub(code = 'TESTB'): LoopbackHub {
  return new LoopbackHub(code);
}
