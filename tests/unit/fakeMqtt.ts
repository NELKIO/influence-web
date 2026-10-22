/**
 * In-memory MQTT network for relay tests: several brokers (keyed by URL) with retained messages,
 * wills, per-client reachability, broker outages and auto-reconnect like mqtt.js.
 */
import type { MqttConnectOptions, MqttFactory, MqttLike } from '../../src/net/mqttRelay';

type Cb = (...a: any[]) => void;

export class FakeBroker {
  clients = new Set<FakeClient>();
  retained = new Map<string, Uint8Array>();
  up = true;
  /** every publish seen (topic, payload), for assertions */
  log: { topic: string; payload: Uint8Array; retain: boolean }[] = [];
  constructor(readonly url: string) {}

  deliver(topic: string, payload: Uint8Array, retain: boolean) {
    this.log.push({ topic, payload, retain });
    if (retain) {
      if (payload.length) this.retained.set(topic, payload);
      else this.retained.delete(topic);
    }
    for (const c of this.clients) if (c.subs.has(topic)) c.receive(topic, payload);
  }
}

export class FakeClient implements MqttLike {
  connected = false;
  subs = new Set<string>();
  private handlers = new Map<string, Set<Cb>>();
  private ended = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private net: FakeMqttNet,
    readonly broker: FakeBroker,
    readonly label: string,
    readonly opts: MqttConnectOptions,
  ) {
    this.timer = setTimeout(() => this.tryConnect(), net.connectDelayMs);
  }

  private reachable() {
    return this.broker.up && !this.net.blocked(this.label, this.broker.url);
  }

  private tryConnect() {
    this.timer = null;
    if (this.ended) return;
    if (!this.reachable()) {
      this.emit('error', new Error('unreachable'));
      this.emit('close');
      if (this.opts.reconnectPeriod > 0) this.timer = setTimeout(() => this.tryConnect(), this.opts.reconnectPeriod);
      return;
    }
    this.connected = true;
    this.broker.clients.add(this);
    this.emit('connect');
  }

  /** the network drops this client (no DISCONNECT: the will fires) */
  drop() {
    if (!this.connected) return;
    this.connected = false;
    this.broker.clients.delete(this);
    this.subs.clear();
    if (this.opts.will) this.broker.deliver(this.opts.will.topic, this.opts.will.payload, this.opts.will.retain);
    this.emit('offline');
    this.emit('close');
    if (!this.ended && this.opts.reconnectPeriod > 0) this.timer = setTimeout(() => this.tryConnect(), this.opts.reconnectPeriod);
  }

  on(ev: string, cb: Cb) {
    let s = this.handlers.get(ev);
    if (!s) this.handlers.set(ev, (s = new Set()));
    s.add(cb);
    return this;
  }

  private emit(ev: string, ...a: unknown[]) {
    for (const cb of this.handlers.get(ev) ?? []) cb(...a);
  }

  receive(topic: string, payload: Uint8Array) {
    const copy = payload.slice();
    queueMicrotask(() => {
      if (this.connected && this.subs.has(topic)) this.emit('message', topic, copy);
    });
  }

  subscribe(topic: string | string[], _opts: { qos: 0 | 1 }, cb?: (err?: Error | null) => void) {
    const list = Array.isArray(topic) ? topic : [topic];
    queueMicrotask(() => {
      if (!this.connected) return cb?.(new Error('not connected'));
      for (const t of list) {
        this.subs.add(t);
        const r = this.broker.retained.get(t);
        if (r) this.receive(t, r);
      }
      cb?.(null);
    });
    return this;
  }

  unsubscribe(topic: string | string[], cb?: (err?: Error | null) => void) {
    for (const t of Array.isArray(topic) ? topic : [topic]) this.subs.delete(t);
    cb?.(null);
    return this;
  }

  publish(topic: string, payload: Uint8Array, opts: { qos: 0 | 1; retain?: boolean }, cb?: (err?: Error) => void) {
    if (!this.connected) {
      cb?.(new Error('not connected'));
      return this;
    }
    const p = payload.slice();
    const broker = this.broker;
    if (this.net.dropPublish?.(this.label, topic, p)) return this;
    queueMicrotask(() => {
      broker.deliver(topic, p, !!opts.retain);
      cb?.();
    });
    return this;
  }

  end(force?: boolean) {
    if (this.ended) return this;
    this.ended = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.connected) {
      this.connected = false;
      this.broker.clients.delete(this);
      // a forced end skips DISCONNECT: the broker publishes the will
      if (force && this.opts.will) this.broker.deliver(this.opts.will.topic, this.opts.will.payload, this.opts.will.retain);
      this.emit('close');
    }
    return this;
  }
}

export class FakeMqttNet {
  brokers = new Map<string, FakeBroker>();
  connectDelayMs = 5;
  private blocks = new Map<string, Set<string>>();
  /** return true to silently drop a publish */
  dropPublish: ((label: string, topic: string, payload: Uint8Array) => boolean) | null = null;
  clients: FakeClient[] = [];

  constructor(readonly urls: string[] = ['wss://a.test/mqtt', 'wss://b.test/mqtt', 'wss://c.test/mqtt']) {
    for (const u of urls) this.brokers.set(u, new FakeBroker(u));
  }

  broker(url: string): FakeBroker {
    return this.brokers.get(url)!;
  }

  /** client `label` cannot reach `url` */
  block(label: string, url: string) {
    let s = this.blocks.get(label);
    if (!s) this.blocks.set(label, (s = new Set()));
    s.add(url);
  }

  unblock(label: string, url: string) {
    this.blocks.get(label)?.delete(url);
  }

  blocked(label: string, url: string) {
    return this.blocks.get(label)?.has(url) ?? false;
  }

  /** broker outage: all its clients drop (and reconnect once it is back) */
  setUp(url: string, up: boolean) {
    const b = this.broker(url);
    b.up = up;
    if (!up) for (const c of [...b.clients]) c.drop();
  }

  /** factory for one participant (`label` is used for reachability rules) */
  factory(label: string): MqttFactory {
    return (url, opts) => {
      const b = this.brokers.get(url);
      if (!b) throw new Error(`no broker ${url}`);
      const c = new FakeClient(this, b, label, opts);
      this.clients.push(c);
      return c;
    };
  }

  /** connected clients of `label` per broker url */
  connectedOf(label: string): string[] {
    return this.clients.filter((c) => c.label === label && c.connected).map((c) => c.broker.url);
  }
}
