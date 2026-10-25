/**
 * A test path between one host and one guest with latency, jitter and loss (timer based, so it runs
 * under fake timers): models a slow public relay (e.g. an overloaded MQTT broker) or a WebRTC channel
 * that dies silently (`blackhole`).
 */
import { BaseMultiHost } from '../../src/net/hub';
import { Emitter } from '../../src/net/emitter';
import type { Transport, TransportError, TransportEvents, TransportRole } from '../../src/net/transport';

export interface PathConf {
  /** one-way delay */
  latencyMs: number;
  /** extra random delay 0..jitterMs (reorders messages) */
  jitterMs?: number;
  /** probability that a message is lost */
  drop?: number;
  seed?: number;
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class LossyPath {
  /** silently lose everything (no close event): a dead WebRTC channel */
  blackhole = false;
  /** messages actually sent (for traffic assertions) */
  sent = 0;
  lost = 0;
  readonly host: LossyHost;
  readonly guest: LossyGuest;
  private rand: () => number;
  up = false;

  constructor(
    public conf: PathConf,
    readonly clientId = 'G',
    readonly code = 'AB2C',
  ) {
    this.rand = rng(conf.seed ?? 1);
    this.host = new LossyHost(this);
    this.guest = new LossyGuest(this);
  }

  /** both ends open after one latency (ready at once) */
  connect(delayMs = this.conf.latencyMs) {
    setTimeout(() => {
      if (this.up) return;
      this.up = true;
      this.host.join();
      this.guest.setOpen(true);
    }, delayMs);
  }

  disconnect() {
    if (!this.up) return;
    this.up = false;
    this.host.leave();
    this.guest.setOpen(false);
  }

  /** @internal */
  carry(fn: () => void) {
    this.sent++;
    if (this.blackhole || this.rand() < (this.conf.drop ?? 0)) {
      this.lost++;
      return;
    }
    const d = this.conf.latencyMs + (this.conf.jitterMs ?? 0) * this.rand();
    setTimeout(() => {
      if (this.up) fn();
    }, d);
  }
}

export class LossyHost extends BaseMultiHost {
  code: string;
  private joined = false;
  constructor(private p: LossyPath) {
    super();
    this.code = p.code;
    queueMicrotask(() => this.em.emit('ready', p.code));
  }
  get clients(): string[] {
    return this.joined ? [this.p.clientId] : [];
  }
  isOpen(cid: string): boolean {
    return this.joined && cid === this.p.clientId;
  }
  send(cid: string, msg: unknown): boolean {
    if (!this.isOpen(cid)) return false;
    const w = JSON.stringify(msg);
    this.p.carry(() => this.p.guest._rx(JSON.parse(w)));
    return true;
  }
  kick(): void {
    this.p.disconnect();
  }
  close(): void {
    this.p.disconnect();
  }
  /** @internal */
  join() {
    this.joined = true;
    this.em.emit('join', this.p.clientId);
  }
  /** @internal */
  leave() {
    if (!this.joined) return;
    this.joined = false;
    this.em.emit('leave', this.p.clientId);
  }
  /** @internal */
  _rx(msg: unknown) {
    if (this.joined) this.em.emit('message', this.p.clientId, msg);
  }
}

export class LossyGuest implements Transport {
  readonly role: TransportRole = 'guest';
  isOpen = false;
  remoteClientId = 'H';
  private em = new Emitter<TransportEvents>();
  constructor(private p: LossyPath) {
    queueMicrotask(() => this.em.emit('ready', p.code));
  }
  get code() {
    return this.p.code;
  }
  send(msg: unknown): boolean {
    if (!this.isOpen) return false;
    const w = JSON.stringify(msg);
    this.p.carry(() => this.p.host._rx(JSON.parse(w)));
    return true;
  }
  close(): void {
    this.p.disconnect();
  }
  /** @internal */
  setOpen(open: boolean) {
    if (this.isOpen === open) return;
    this.isOpen = open;
    this.em.emit(open ? 'open' : 'close');
  }
  /** @internal */
  _rx(msg: unknown) {
    if (this.isOpen) this.em.emit('message', msg);
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
