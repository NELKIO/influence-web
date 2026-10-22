/**
 * Relay transports over public MQTT-over-WebSocket brokers: the fallback when WebRTC cannot connect
 * (VPNs, symmetric NATs, blocked UDP). Works for duels (1:1, via `SingleHost`) and battle rooms.
 *
 * Topics (all payloads AES-GCM encrypted with a key derived from the room code, see relayCrypto):
 *   infweb/v1/<duel|battle>/<roomId>/p        retained presence of the host (cleared on close; the
 *                                             MQTT will clears it when the host vanishes)
 *   infweb/v1/<duel|battle>/<roomId>/h        host inbox (every guest publishes here)
 *   infweb/v1/<duel|battle>/<roomId>/g/<sid>  inbox of one guest session
 *
 * The host connects to ALL brokers, publishes its presence and listens on each; it answers a guest on
 * the broker that guest dialled through. A guest connects to all brokers at once, uses the first one
 * where it sees the room's presence and drops the others; no presence anywhere → 'bad-code'.
 *
 * On top of MQTT a small link protocol gives the same semantics as a data channel: dial / accept
 * (open), heartbeats (a silent link is closed after `deadAfterMs`), bye (close), per-session message
 * counters (QoS 1 may duplicate: duplicates are dropped). Messages above `chunkSize` are chunked.
 */
import { BaseMultiHost } from './hub';
import { Emitter } from './emitter';
import { open, Reassembler, roomKeys, seal, sealText, toFrames, DEFAULT_KDF_ITERATIONS, type RoomKeys } from './relayCrypto';
import { randomId } from './room';
import type { LinkKind, Transport, TransportError, TransportErrorCode, TransportEvents, TransportRole } from './transport';

// ---------------------------------------------------------------- MQTT client abstraction

/** The subset of an mqtt.js client the relay uses (injectable for tests). */
export interface MqttLike {
  connected: boolean;
  on(ev: string, cb: (...args: any[]) => void): unknown;
  subscribe(topic: string | string[], opts: { qos: 0 | 1 }, cb?: (err?: Error | null) => void): unknown;
  unsubscribe(topic: string | string[], cb?: (err?: Error | null) => void): unknown;
  publish(topic: string, payload: Uint8Array, opts: { qos: 0 | 1; retain?: boolean }, cb?: (err?: Error) => void): unknown;
  end(force?: boolean, opts?: object, cb?: () => void): unknown;
}

export interface MqttConnectOptions {
  clientId: string;
  clean: boolean;
  keepalive: number;
  reconnectPeriod: number;
  connectTimeout: number;
  resubscribe: boolean;
  protocolVersion: 4;
  will?: { topic: string; payload: Uint8Array; qos: 0 | 1; retain: boolean };
}

export type MqttFactory = (url: string, opts: MqttConnectOptions) => MqttLike | Promise<MqttLike>;

/** Public brokers that accept anonymous MQTT over secure WebSockets, in order of preference. */
export const DEFAULT_RELAY_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
];

let mqttModule: Promise<typeof import('mqtt')> | null = null;
export const defaultMqttFactory: MqttFactory = async (url, opts) => {
  const mod = await (mqttModule ??= import('mqtt'));
  const connect = (mod.default?.connect ?? (mod as unknown as { connect: typeof mod.default.connect }).connect) as (
    u: string,
    o: object,
  ) => unknown;
  return connect(url, opts) as MqttLike;
};

export type RelayKind = 'duel' | 'battle';

export interface RelayOptions {
  brokers?: string[];
  factory?: MqttFactory;
  /** PBKDF2 iterations for the room key (both sides must agree) */
  iterations?: number;
  heartbeatMs?: number;
  /** a link without traffic for this long is closed (and re-dialled by the guest) */
  deadAfterMs?: number;
  /** guest: wait this long on a connected broker for the room's presence */
  presenceTimeoutMs?: number;
  /** guest: re-send the dial this often until accepted */
  dialRetryMs?: number;
  /** guest: give up (before the first open) after this many unanswered dials */
  maxDials?: number;
  /** a broker that has not connected after this long counts as unreachable */
  connectTimeoutMs?: number;
  /** host (new room): wait this long for an existing presence before claiming the code */
  claimMs?: number;
  /** guest: the chosen broker is down this long → try all brokers again */
  reRaceMs?: number;
  /** split messages above this many bytes */
  chunkSize?: number;
  log?: boolean;
}

const DEFAULTS: Required<Omit<RelayOptions, 'factory' | 'log'>> = {
  brokers: DEFAULT_RELAY_BROKERS,
  iterations: DEFAULT_KDF_ITERATIONS,
  heartbeatMs: 2500,
  deadAfterMs: 12000,
  presenceTimeoutMs: 3500,
  dialRetryMs: 1500,
  maxDials: 10,
  connectTimeoutMs: 8000,
  claimMs: 800,
  reRaceMs: 15000,
  chunkSize: 60000,
};

type Env =
  | { k: 'dial'; f: string; s: string; a: number }
  | { k: 'accept'; f: string; s: string; a: number }
  | { k: 'busy' | 'hb' | 'bye'; f: string; s: string }
  | { k: 'msg'; f: string; s: string; n: number; d: unknown };

interface Presence {
  k: 'room';
  v: 1;
  /** host session id (changes when the host page reloads) */
  h: string;
  /** host clientId */
  c: string;
}

const isEnv = (x: unknown): x is Env => {
  const e = x as Partial<Env> | null;
  return !!e && typeof e === 'object' && typeof e.k === 'string' && typeof e.f === 'string' && typeof e.s === 'string';
};
const isPresence = (x: unknown): x is Presence => {
  const p = x as Partial<Presence> | null;
  return !!p && p.k === 'room' && typeof p.h === 'string' && typeof p.c === 'string';
};

const topics = (kind: RelayKind, roomId: string) => {
  const base = `infweb/v1/${kind}/${roomId}`;
  return { presence: `${base}/p`, host: `${base}/h`, guest: (sid: string) => `${base}/g/${sid}` };
};

function mqttOptions(o: Required<Omit<RelayOptions, 'factory' | 'log'>>, will?: MqttConnectOptions['will']): MqttConnectOptions {
  return {
    clientId: `infweb_${randomId(6)}`,
    clean: true,
    keepalive: 20,
    reconnectPeriod: 2000,
    connectTimeout: o.connectTimeoutMs,
    resubscribe: true,
    protocolVersion: 4,
    ...(will ? { will } : {}),
  };
}

/** Serialises async work (encryption / decryption) so messages keep their order. */
class Queue {
  private tail: Promise<void> = Promise.resolve();
  run(fn: () => Promise<void> | void): void {
    this.tail = this.tail.then(fn).catch((e) => console.warn('[relay]', e));
  }
}

const frameId = () => globalThis.crypto.getRandomValues(new Uint32Array(1))[0];
const toBytes = (p: unknown): Uint8Array => (p instanceof Uint8Array ? p : new Uint8Array(p as ArrayBuffer));

// ====================================================================== guest

interface GuestConn {
  url: string;
  client: MqttLike | null;
  startedAt: number;
  connectedAt: number;
  failed: boolean;
}

/** Guest side of a relay link (duel or battle). */
export class RelayGuest implements Transport {
  readonly role: TransportRole = 'guest';
  isOpen = false;
  remoteClientId: string | null = null;
  private em = new Emitter<TransportEvents>();
  private o: Required<Omit<RelayOptions, 'factory' | 'log'>>;
  private factory: MqttFactory;
  private keys: RoomKeys | null = null;
  private t: ReturnType<typeof topics> | null = null;
  private sid = randomId(6);
  private conns = new Map<string, GuestConn>();
  private chosen: string | null = null;
  private chosenDownSince = 0;
  private hostSid: string | null = null;
  private attempt = 1;
  private dials = 0;
  private lastDial = 0;
  private lastRx = 0;
  private lastHb = 0;
  private outN = 0;
  private inN = new Map<string, number>();
  private everOpened = false;
  private readyEmitted = false;
  private closed = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private outQ = new Queue();
  private inQ = new Queue();
  private rebuild = new Map<string, Reassembler>();

  constructor(
    readonly kind: RelayKind,
    public code: string,
    private clientId: string,
    opts: RelayOptions = {},
  ) {
    this.o = { ...DEFAULTS, ...stripUndefined(opts) } as typeof this.o;
    this.factory = opts.factory ?? defaultMqttFactory;
    this.log = !!opts.log;
    void this.start();
  }

  private log: boolean;
  private debug(...a: unknown[]) {
    if (this.log) console.log(`[relay:guest ${this.code}]`, ...a);
  }

  get linkKind(): LinkKind | null {
    return this.isOpen ? 'relay' : null;
  }

  /** broker in use (after the room was found) */
  get broker(): string | null {
    return this.chosen;
  }

  private async start() {
    try {
      this.keys = await roomKeys(this.kind, this.code, this.o.iterations);
    } catch (e) {
      return this.fatal('unsupported', String(e));
    }
    if (this.closed) return;
    this.t = topics(this.kind, this.keys.roomId);
    this.connectAll();
    const tick = Math.max(20, Math.min(this.o.heartbeatMs, this.o.dialRetryMs, 500));
    this.timer = setInterval(() => this.watch(), tick);
  }

  private connectAll() {
    for (const url of this.o.brokers) void this.connectBroker(url);
  }

  private async connectBroker(url: string) {
    const conn: GuestConn = { url, client: null, startedAt: Date.now(), connectedAt: 0, failed: false };
    this.conns.set(url, conn);
    let client: MqttLike;
    try {
      client = await this.factory(url, mqttOptions(this.o));
    } catch (e) {
      conn.failed = true;
      this.debug('factory failed', url, e);
      return;
    }
    if (this.closed || this.conns.get(url) !== conn) {
      client.end(true);
      return;
    }
    conn.client = client;
    client.on('connect', () => {
      if (this.conns.get(url) !== conn) return;
      this.debug('broker connected', url);
      conn.connectedAt = Date.now();
      conn.failed = false;
      client.subscribe([this.t!.presence, this.t!.guest(this.sid)], { qos: 1 });
      if (this.chosen === url) {
        this.chosenDownSince = 0;
        if (!this.isOpen) this.dial(true);
      }
    });
    client.on('message', (topic: string, payload: unknown) => {
      if (this.conns.get(url) === conn) this.inQ.run(() => this.rx(url, topic, toBytes(payload)));
    });
    const down = () => {
      if (this.conns.get(url) !== conn) return;
      if (this.chosen === url) {
        if (!this.chosenDownSince) this.chosenDownSince = Date.now();
        this.linkDown('broker connection lost');
      }
    };
    client.on('close', down);
    client.on('offline', down);
    client.on('error', (e: Error) => this.debug('broker error', url, e?.message));
  }

  private watch() {
    if (this.closed) return;
    const now = Date.now();
    if (!this.chosen) {
      for (const c of this.conns.values()) if (!c.connectedAt && now - c.startedAt > this.o.connectTimeoutMs) c.failed = true;
      const conns = [...this.conns.values()];
      const pending = conns.filter((c) => !c.failed && (!c.connectedAt || now - c.connectedAt < this.o.presenceTimeoutMs));
      if (pending.length === 0) {
        const reached = conns.some((c) => !c.failed && c.connectedAt);
        if (this.everOpened) return this.reRace();
        if (reached) return this.fatal('bad-code', `Room ${this.code} not found`);
        return this.fatal('broker', 'No relay server is reachable');
      }
      return;
    }
    if (this.chosenDownSince && now - this.chosenDownSince > this.o.reRaceMs) return this.reRace();
    const conn = this.conns.get(this.chosen);
    if (!conn?.client?.connected) return;
    if (this.isOpen) {
      if (now - this.lastRx > this.o.deadAfterMs) return this.linkDown('link silent');
      if (now - this.lastHb >= this.o.heartbeatMs) {
        this.lastHb = now;
        this.sendEnv({ k: 'hb', f: this.clientId, s: this.sid });
      }
    } else if (now - this.lastDial >= this.o.dialRetryMs) this.dial(false);
  }

  private reRace() {
    this.debug('re-racing brokers');
    for (const c of this.conns.values()) c.client?.end(true);
    this.conns.clear();
    this.chosen = null;
    this.chosenDownSince = 0;
    this.connectAll();
  }

  private async rx(url: string, topic: string, payload: Uint8Array) {
    if (this.closed || !this.keys) return;
    if (topic === this.t!.presence) {
      if (!payload.length) return; // cleared: the host left; a guest that is in already hears it from the host
      const blob = payload[0] === 1 ? payload.subarray(1) : null;
      const p = blob && (await open(this.keys.key, blob));
      if (!isPresence(p)) return;
      if (!this.chosen) return this.choose(url, p);
      if (this.chosen === url && p.h !== this.hostSid) {
        // the host page was reloaded: its new session does not know our link
        this.hostSid = p.h;
        if (this.isOpen) this.linkDown('host restarted');
        this.dial(true);
      }
      return;
    }
    if (topic !== this.t!.guest(this.sid) || (this.chosen && url !== this.chosen)) return;
    let r = this.rebuild.get(url);
    if (!r) this.rebuild.set(url, (r = new Reassembler()));
    const blob = r.push(payload);
    if (!blob) return;
    const env = await open(this.keys.key, blob);
    if (!isEnv(env) || this.closed) return;
    switch (env.k) {
      case 'accept':
        if (this.isOpen || env.a !== this.attempt) return;
        this.hostSid = env.s;
        this.remoteClientId = env.f;
        this.lastRx = Date.now();
        this.lastHb = 0;
        this.dials = 0;
        this.isOpen = true;
        this.everOpened = true;
        this.debug('link open via', url);
        this.em.emit('open');
        return;
      case 'busy':
        return this.fatal('room-full', `Room ${this.code} is full`);
      case 'msg': {
        if (!this.isOpen || env.s !== this.hostSid) return;
        this.lastRx = Date.now();
        const last = this.inN.get(env.s) ?? 0;
        if (env.n <= last) return;
        this.inN.set(env.s, env.n);
        this.em.emit('message', env.d);
        return;
      }
      case 'hb':
        if (this.isOpen && env.s === this.hostSid) this.lastRx = Date.now();
        return;
      case 'bye':
        if (this.isOpen && env.s === this.hostSid) this.linkDown('host closed the link');
        return;
    }
  }

  private choose(url: string, p: Presence) {
    this.debug('room found on', url);
    this.chosen = url;
    this.hostSid = p.h;
    this.remoteClientId = p.c;
    for (const [u, c] of [...this.conns]) {
      if (u === url) continue;
      c.client?.end(true);
      this.conns.delete(u);
    }
    if (!this.readyEmitted) {
      this.readyEmitted = true;
      this.em.emit('ready', this.code);
    }
    this.dial(true);
  }

  private dial(fresh: boolean) {
    if (this.closed || this.isOpen || !this.chosen) return;
    if (fresh && !this.everOpened) this.dials = Math.max(0, this.dials - 1);
    this.lastDial = Date.now();
    if (!this.everOpened && ++this.dials > this.o.maxDials) return this.fatal('broker', `Room ${this.code} does not answer`);
    this.sendEnv({ k: 'dial', f: this.clientId, s: this.sid, a: this.attempt });
  }

  private linkDown(reason: string) {
    if (!this.isOpen) return;
    this.debug('link down:', reason);
    this.isOpen = false;
    this.attempt++;
    this.lastDial = 0;
    this.em.emit('close');
  }

  private sendEnv(env: Env) {
    const url = this.chosen;
    const conn = url ? this.conns.get(url) : null;
    if (!conn?.client || !this.keys) return;
    const client = conn.client;
    const key = this.keys.key;
    const topic = this.t!.host;
    const text = JSON.stringify(env); // now: the payload objects may change after send() returns
    this.outQ.run(async () => {
      const blob = await sealText(key, text);
      for (const f of toFrames(blob, this.o.chunkSize, frameId())) client.publish(topic, f, { qos: 1 });
    });
  }

  send(msg: unknown): boolean {
    if (!this.isOpen || this.closed) return false;
    this.sendEnv({ k: 'msg', f: this.clientId, s: this.sid, n: ++this.outN, d: msg });
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
    if (this.isOpen) this.sendEnv({ k: 'bye', f: this.clientId, s: this.sid });
    const wasOpen = this.isOpen;
    this.closed = true;
    this.isOpen = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const conns = [...this.conns.values()];
    this.conns.clear();
    this.outQ.run(() => {
      for (const c of conns) c.client?.end(false);
    });
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
  url: string;
  sid: string;
  a: number;
  lastRx: number;
  out: number;
  inN: number;
}

interface HostConn {
  client: MqttLike | null;
  connected: boolean;
}

export interface RelayHostOptions extends RelayOptions {
  clientId: string;
  /** keep the code (resume); otherwise a code taken by another live room is replaced by `generate()` */
  fixed?: boolean;
  generate?: () => string;
}

/** Host side of the relay: many guest links, all brokers. */
export class RelayHost extends BaseMultiHost {
  code: string;
  private o: Required<Omit<RelayOptions, 'factory' | 'log'>>;
  private factory: MqttFactory;
  private clientId: string;
  private fixed: boolean;
  private generate: (() => string) | null;
  private sid = randomId(6);
  private keys: RoomKeys | null = null;
  private t: ReturnType<typeof topics> | null = null;
  private conns = new Map<string, HostConn>();
  private links = new Map<string, HostLink>();
  private claimed: boolean;
  private claiming = false;
  private collision = false;
  private readyEmitted = false;
  private closed = false;
  private startedAt = Date.now();
  private lastHb = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private outQ = new Queue();
  private inQ = new Queue();
  private rebuild = new Map<string, Reassembler>();
  private log: boolean;
  private generation = 0;

  constructor(
    readonly kind: RelayKind,
    code: string,
    opts: RelayHostOptions,
  ) {
    super();
    this.code = code;
    this.o = { ...DEFAULTS, ...stripUndefined(opts) } as typeof this.o;
    this.factory = opts.factory ?? defaultMqttFactory;
    this.clientId = opts.clientId;
    this.fixed = !!opts.fixed;
    this.generate = opts.generate ?? null;
    this.claimed = this.fixed || !this.generate;
    this.log = !!opts.log;
    void this.start();
    const tick = Math.max(20, Math.min(this.o.heartbeatMs, 500));
    this.timer = setInterval(() => this.watch(), tick);
  }

  private debug(...a: unknown[]) {
    if (this.log) console.log(`[relay:host ${this.code}]`, ...a);
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

  /** brokers the host is connected to right now */
  get brokers(): string[] {
    return [...this.conns].filter(([, c]) => c.connected).map(([u]) => u);
  }

  /** broker a guest's link uses */
  brokerOf(clientId: string): string | null {
    return this.links.get(clientId)?.url ?? null;
  }

  private async start() {
    const gen = ++this.generation;
    try {
      this.keys = await roomKeys(this.kind, this.code, this.o.iterations);
    } catch (e) {
      return this.fatal('unsupported', String(e));
    }
    if (this.closed || gen !== this.generation) return;
    this.t = topics(this.kind, this.keys.roomId);
    for (const url of this.o.brokers) void this.connectBroker(url, gen);
  }

  private async connectBroker(url: string, gen: number) {
    const conn: HostConn = { client: null, connected: false };
    this.conns.set(url, conn);
    const t = this.t!;
    let client: MqttLike;
    try {
      client = await this.factory(url, mqttOptions(this.o, { topic: t.presence, payload: new Uint8Array(0), qos: 1, retain: true }));
    } catch (e) {
      this.debug('factory failed', url, e);
      return;
    }
    if (this.closed || gen !== this.generation || this.conns.get(url) !== conn) {
      client.end(true);
      return;
    }
    conn.client = client;
    client.on('connect', () => {
      if (this.conns.get(url) !== conn) return;
      this.debug('broker connected', url);
      conn.connected = true;
      client.subscribe(t.host, { qos: 1 });
      if (!this.claimed) this.claim(client);
      else this.publishPresence(url);
    });
    client.on('message', (topic: string, payload: unknown) => {
      if (this.conns.get(url) === conn) this.inQ.run(() => this.rx(url, topic, toBytes(payload)));
    });
    const down = () => {
      if (this.conns.get(url) === conn) conn.connected = false;
    };
    client.on('close', down);
    client.on('offline', down);
    client.on('error', (e: Error) => this.debug('broker error', url, e?.message));
  }

  /** new room: make sure no other live room uses this code on the relay */
  private claim(client: MqttLike) {
    if (this.claiming) return;
    this.claiming = true;
    this.collision = false;
    const t = this.t!;
    const gen = this.generation;
    client.subscribe(t.presence, { qos: 1 }, () => {
      setTimeout(() => {
        if (this.closed || gen !== this.generation) return;
        client.unsubscribe(t.presence);
        this.claiming = false;
        if (this.collision && this.generate) {
          this.debug('code taken on the relay, picking another');
          this.restartWith(this.generate());
          return;
        }
        this.claimed = true;
        for (const [u, c] of this.conns) if (c.connected) this.publishPresence(u);
      }, this.o.claimMs);
    });
  }

  private restartWith(code: string) {
    for (const c of this.conns.values()) c.client?.end(true);
    this.conns.clear();
    this.code = code;
    this.claimed = false;
    this.claiming = false;
    void this.start();
  }

  private publishPresence(url: string) {
    const conn = this.conns.get(url);
    if (!conn?.client || !this.keys) return;
    const client = conn.client;
    const key = this.keys.key;
    const topic = this.t!.presence;
    const p: Presence = { k: 'room', v: 1, h: this.sid, c: this.clientId };
    this.outQ.run(async () => {
      const blob = await seal(key, p);
      client.publish(topic, toFrames(blob, 1e9, 0)[0], { qos: 1, retain: true });
      if (!this.readyEmitted && !this.closed) {
        this.readyEmitted = true;
        this.em.emit('ready', this.code);
      }
    });
  }

  private watch() {
    if (this.closed) return;
    const now = Date.now();
    if (!this.readyEmitted && now - this.startedAt > this.o.connectTimeoutMs * 2 && !this.brokers.length) {
      return this.fatal('broker', 'No relay server is reachable');
    }
    if (now - this.lastHb >= this.o.heartbeatMs) {
      this.lastHb = now;
      for (const [cid, l] of [...this.links]) {
        if (now - l.lastRx > this.o.deadAfterMs) {
          this.debug('guest link dead', cid);
          this.dropLink(cid);
          continue;
        }
        this.sendTo(l, { k: 'hb', f: this.clientId, s: this.sid });
      }
    }
  }

  private async rx(url: string, topic: string, payload: Uint8Array) {
    if (this.closed || !this.keys) return;
    if (topic === this.t!.presence) {
      if (!this.claiming || !payload.length || payload[0] !== 1) return;
      const p = await open(this.keys.key, payload.subarray(1));
      if (isPresence(p) && p.c !== this.clientId) this.collision = true;
      return;
    }
    if (topic !== this.t!.host) return;
    let r = this.rebuild.get(url);
    if (!r) this.rebuild.set(url, (r = new Reassembler(64)));
    const blob = r.push(payload);
    if (!blob) return;
    const env = await open(this.keys.key, blob);
    if (!isEnv(env) || this.closed) return;
    const cid = env.f;
    const link = this.links.get(cid);
    const known = !!link && link.sid === env.s;
    switch (env.k) {
      case 'dial': {
        if (known && link!.a === env.a) {
          link!.url = url;
          link!.lastRx = Date.now();
          this.sendTo(link!, { k: 'accept', f: this.clientId, s: this.sid, a: env.a });
          return;
        }
        if (link) this.dropLink(cid);
        const l: HostLink = { url, sid: env.s, a: env.a, lastRx: Date.now(), out: 0, inN: 0 };
        this.links.set(cid, l);
        this.debug('guest link open', cid, 'via', url);
        this.sendTo(l, { k: 'accept', f: this.clientId, s: this.sid, a: env.a });
        this.em.emit('join', cid);
        return;
      }
      case 'msg':
        if (!known) return this.byeTo(url, env.s);
        link!.lastRx = Date.now();
        if (env.n <= link!.inN) return;
        link!.inN = env.n;
        this.em.emit('message', cid, env.d);
        return;
      case 'hb':
        if (!known) return this.byeTo(url, env.s);
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
  private byeTo(url: string, sid: string) {
    this.sendTo({ url, sid, a: 0, lastRx: 0, out: 0, inN: 0 }, { k: 'bye', f: this.clientId, s: this.sid });
  }

  private sendTo(l: HostLink, env: Env) {
    const conn = this.conns.get(l.url);
    if (!conn?.client || !this.keys) return false;
    const client = conn.client;
    const key = this.keys.key;
    const topic = this.t!.guest(l.sid);
    const text = JSON.stringify(env); // now: the payload objects may change after send() returns
    this.outQ.run(async () => {
      const blob = await sealText(key, text);
      for (const f of toFrames(blob, this.o.chunkSize, frameId())) client.publish(topic, f, { qos: 1 });
    });
    return conn.connected;
  }

  private dropLink(cid: string) {
    if (!this.links.delete(cid)) return;
    this.em.emit('leave', cid);
  }

  send(clientId: string, msg: unknown): boolean {
    const l = this.links.get(clientId);
    if (!l || this.closed) return false;
    return this.sendTo(l, { k: 'msg', f: this.clientId, s: this.sid, n: ++l.out, d: msg });
  }

  kick(clientId: string): void {
    const l = this.links.get(clientId);
    if (!l) return;
    this.sendTo(l, { k: 'bye', f: this.clientId, s: this.sid });
    this.dropLink(clientId);
  }

  /** refuse a guest (duel room already taken): it gets a fatal 'room-full' */
  refuse(clientId: string): void {
    const l = this.links.get(clientId);
    if (!l) return;
    this.sendTo(l, { k: 'busy', f: this.clientId, s: this.sid });
    this.dropLink(clientId);
  }

  private fatal(code: TransportErrorCode, message: string) {
    if (this.closed) return;
    this.em.emit('error', { code, message, fatal: true });
    this.close(false);
  }

  /** Close the room: guests get a bye, the presence is cleared (new guests then see 'bad-code'). */
  close(clearPresence = true): void {
    if (this.closed) return;
    for (const l of this.links.values()) this.sendTo(l, { k: 'bye', f: this.clientId, s: this.sid });
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const conns = [...this.conns.values()];
    const presence = this.t?.presence;
    this.conns.clear();
    this.links.clear();
    this.outQ.run(() => {
      for (const c of conns) {
        if (clearPresence && presence && c.client && c.connected) c.client.publish(presence, new Uint8Array(0), { qos: 1, retain: true });
        c.client?.end(false);
      }
    });
  }

  /**
   * Leave without clearing the presence (page reload / dispose): the room stays findable and the
   * resumed host takes over. (An abrupt disconnect clears it through the MQTT will.)
   */
  detach(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    const conns = [...this.conns.values()];
    this.conns.clear();
    this.links.clear();
    // a clean MQTT disconnect: the will (which clears the presence) is not published
    this.outQ.run(() => {
      for (const c of conns) c.client?.end(false);
    });
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}
