/**
 * Multi-path links: the direct WebRTC channel and every relay (PeerJS signalling relay, Nostr, MQTT)
 * are started TOGETHER, and each game message travels on the best path that is open right now:
 *
 *   - the direct link while it is healthy (pongs keep arriving on it);
 *   - otherwise every open relay at once (the receiver keeps the first copy).
 *
 * A thin reliability layer makes the paths interchangeable: every message carries the sender's session
 * id, a sequence number and a cumulative ack; the receiver delivers strictly in order without
 * duplicates; anything not acknowledged within a short timeout (≈ 1.5 × RTT, 0.4-4 s) is sent again on
 * ALL open paths. So a direct link that dies silently costs one timeout, not a reconnect, and a lost
 * relay message is repaired in about a second instead of waiting for the game's own resync.
 *
 * The fields ride along inside the game message (`_i` sender session, `_p` receiver session as the
 * sender knows it, `_s` seq, `_a` ack) and control messages carry `_mp`: 'h' hello (sent on every path
 * when it opens, repeated until the peer knows us), 'k' ack, 'p'/'q' ping/pong (per-path RTT). Pages
 * from before this layer ignore the extra fields; their messages (no `_i`) are passed through as they
 * are, so a version mismatch still reaches the game protocol and shows «обновите страницу».
 *
 * A peer session id that changes means the other page was reloaded: sequence state is reset and the
 * upper layer sees a reconnect (close + open / leave + join), exactly as with a single transport.
 */
import { BaseMultiHost, type MultiHostTransport } from './hub';
import { Emitter, type Unsubscribe } from './emitter';
import { randomId } from './room';
import { netLog } from './netdebug';
import type { LinkKind, Transport, TransportError, TransportEvents, TransportRole } from './transport';

export type PathKind = 'direct' | 'peerrelay' | 'nostr' | 'mqtt';
export const PATH_KINDS: PathKind[] = ['direct', 'peerrelay', 'nostr', 'mqtt'];

export interface PathInfo {
  kind: PathKind;
  open: boolean;
  /** smoothed ping round trip on this path (ms), null until measured */
  rtt: number | null;
  /** fatal error that stopped this path (it may be restarted later) */
  failed: string | null;
}

export interface MpOptions {
  /** fields merged into every hello, so a page without this layer answers with its version error */
  helloProbe?: () => Record<string, unknown>;
  /** ping interval on the direct path */
  directPingMs?: number;
  /** ping interval on relays while they carry the game */
  relayPingMs?: number;
  /** ping interval on relays while the direct path is healthy */
  idlePingMs?: number;
  /** the direct path counts as unhealthy without inbound traffic for this long */
  directStaleMs?: number;
  helloRetryMs?: number;
  ackDelayMs?: number;
  minRtoMs?: number;
  maxRtoMs?: number;
  /** owner's timer period */
  tickMs?: number;
}

const MP_DEFAULTS: Required<Omit<MpOptions, 'helloProbe'>> = {
  directPingMs: 2000,
  relayPingMs: 2500,
  idlePingMs: 15000,
  directStaleMs: 5000,
  helloRetryMs: 1000,
  ackDelayMs: 20,
  minRtoMs: 250,
  maxRtoMs: 4000,
  tickMs: 50,
};

interface Ctl {
  _mp: 'h' | 'k' | 'p' | 'q';
  _i: string;
  _p: string | null;
  a?: number;
  /** ack: seqs above `a` still missing (selective ack → the sender re-sends them at once) */
  m?: number[];
  t?: number;
  k?: PathKind;
}

interface Pending {
  wire: string;
  first: number;
  last: number;
  tries: number;
  paths: PathKind[];
}

interface PeerIO {
  /** paths open to this peer right now */
  open(): PathKind[];
  send(kind: PathKind, obj: unknown): boolean;
  deliver(msg: unknown): void;
  /** the peer's session became known (first contact, or an older page: legacy) */
  known(): void;
  /** the peer page restarted (new session id) */
  changed(): void;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Reliability state towards one remote page. */
export class MpPeer {
  peerSid: string | null = null;
  /** the peer runs a page without this layer: messages pass through unchanged */
  legacy = false;
  stopped = false;
  private dead = new Set<string>();
  private txSeq = 0;
  private unacked = new Map<number, Pending>();
  private rxNext = 1;
  private rxBuf = new Map<number, Record<string, unknown>>();
  private ackDue = new Set<PathKind>();
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  private rtts = new Map<PathKind, number>();
  private lastRx = new Map<PathKind, number>();
  private openedAt = new Map<PathKind, number>();
  private lastPing = new Map<PathKind, number>();
  private helloAt = new Map<PathKind, number>();
  /** the peer has shown it knows our session id */
  private confirmed = false;
  private srtt: number | null = null;
  private rttvar = 0;
  /** a message sent on the direct path alone went unanswered at this time: avoid it until it speaks again */
  private directSuspectAt = 0;
  private o: Required<Omit<MpOptions, 'helloProbe'>>;

  constructor(
    readonly mySid: string,
    private io: PeerIO,
    private opts: MpOptions = {},
    private label = 'peer',
  ) {
    this.o = { ...MP_DEFAULTS, ...strip(opts) } as typeof this.o;
  }

  // ------------------------------------------------------------ queries

  rttOf(kind: PathKind): number | null {
    return this.rtts.get(kind) ?? null;
  }

  private directHealthy(now: number, open: PathKind[]): boolean {
    if (!open.includes('direct')) return false;
    const rx = this.lastRx.get('direct') ?? 0;
    if (this.directSuspectAt && rx <= this.directSuspectAt) return false;
    const since = Math.max(rx, this.openedAt.get('direct') ?? 0);
    return now - since < this.o.directStaleMs;
  }

  /** where a new message goes now */
  best(now = Date.now()): PathKind[] {
    const open = this.io.open();
    if (this.directHealthy(now, open)) return ['direct'];
    const relays = open.filter((k) => k !== 'direct');
    return relays.length ? relays : open;
  }

  linkKind(): LinkKind | null {
    const b = this.best();
    if (!b.length) return null;
    return b.includes('direct') ? 'direct' : 'relay';
  }

  /** round trip of the path(s) in use (the fastest relay when relayed) */
  bestRtt(): number | null {
    let r: number | null = null;
    for (const k of this.best()) {
      const v = this.rtts.get(k);
      if (v !== undefined && (r === null || v < r)) r = v;
    }
    return r ?? (this.srtt === null ? null : Math.round(this.srtt));
  }

  get unackedCount(): number {
    return this.unacked.size;
  }

  // ------------------------------------------------------------ path events

  pathOpened(kind: PathKind) {
    if (this.stopped) return;
    const now = Date.now();
    this.openedAt.set(kind, now);
    this.lastPing.delete(kind);
    this.sendHello(kind);
    // the new path carries what is still unacknowledged right away (seamless switch)
    if (this.peerSid && !this.legacy && this.unacked.size) {
      for (const [s, p] of this.unacked) this.io.send(kind, this.rewire(p, s));
    }
  }

  pathClosed(kind: PathKind) {
    this.openedAt.delete(kind);
    this.lastRx.delete(kind);
    this.rtts.delete(kind);
    this.helloAt.delete(kind);
  }

  // ------------------------------------------------------------ sending

  send(msg: unknown): boolean {
    if (this.stopped) return false;
    const now = Date.now();
    const paths = this.best(now);
    if (!paths.length) return false;
    if (this.legacy) {
      let ok = false;
      for (const k of paths) ok = this.io.send(k, msg) || ok;
      return ok;
    }
    if (!this.peerSid) return false;
    const env: Record<string, unknown> = isObj(msg) ? { ...msg } : { _w: msg };
    const seq = ++this.txSeq;
    env._i = this.mySid;
    env._p = this.peerSid;
    env._s = seq;
    env._a = this.rxNext - 1;
    const wire = JSON.stringify(env);
    this.unacked.set(seq, { wire, first: now, last: now, tries: 0, paths });
    if (this.unacked.size > 4000) this.unacked.delete(this.unacked.keys().next().value!);
    for (const k of paths) {
      this.io.send(k, env);
      this.ackDue.delete(k);
    }
    netLog('tx', { peer: this.label, seq, paths, bytes: wire.length, t: typeof (msg as { t?: unknown })?.t === 'string' ? (msg as { t: string }).t : undefined });
    return true;
  }

  private rewire(p: Pending, seq: number): Record<string, unknown> {
    const obj = JSON.parse(p.wire) as Record<string, unknown>;
    obj._a = this.rxNext - 1;
    obj._s = seq;
    return obj;
  }

  private ctl(kind: PathKind, c: Omit<Ctl, '_i' | '_p'>, extra?: Record<string, unknown>) {
    this.io.send(kind, { ...extra, ...c, _i: this.mySid, _p: this.peerSid });
  }

  private sendHello(kind: PathKind) {
    this.helloAt.set(kind, Date.now());
    this.ctl(kind, { _mp: 'h' }, this.opts.helloProbe?.());
  }

  private sendAck() {
    const a = this.rxNext - 1;
    const c: Omit<Ctl, '_i' | '_p'> = { _mp: 'k', a };
    if (this.rxBuf.size) {
      const top = Math.max(...this.rxBuf.keys());
      const m: number[] = [];
      for (let s = this.rxNext; s < top && m.length < 32; s++) if (!this.rxBuf.has(s)) m.push(s);
      c.m = m;
    }
    const open = new Set(this.io.open());
    let sent = false;
    for (const k of this.ackDue) {
      if (!open.has(k)) continue;
      this.ctl(k, c);
      sent = true;
    }
    if (!sent) for (const k of this.best()) this.ctl(k, c);
    this.ackDue.clear();
  }

  // ------------------------------------------------------------ receiving

  receive(kind: PathKind, raw: unknown) {
    if (this.stopped) return;
    const now = Date.now();
    this.lastRx.set(kind, now);
    if (!isObj(raw)) return this.legacyIn(raw);
    if (typeof raw._mp === 'string') return this.onCtl(kind, raw as unknown as Ctl, now);
    if (typeof raw._i !== 'string' || typeof raw._s !== 'number') return this.legacyIn(raw);
    if (!this.learn(raw._i)) return;
    if (raw._p !== this.mySid) {
      // addressed to an earlier page of ours: tell the peer who we are now
      this.sendHello(kind);
      return;
    }
    this.confirmed = true;
    if (typeof raw._a === 'number') this.onAck(raw._a, kind, now);
    const s = raw._s;
    this.ackDue.add(kind);
    if (!this.ackTimer)
      this.ackTimer = setTimeout(() => {
        this.ackTimer = null;
        if (!this.stopped && this.ackDue.size) this.sendAck();
      }, this.o.ackDelayMs);
    if (s < this.rxNext || this.rxBuf.has(s)) {
      netLog('rx', { peer: this.label, seq: s, path: kind, dup: true });
      return;
    }
    delete raw._i;
    delete raw._p;
    delete raw._s;
    delete raw._a;
    this.rxBuf.set(s, raw);
    if (this.rxBuf.size > 4000) this.rxBuf.delete(this.rxBuf.keys().next().value!);
    netLog('rx', { peer: this.label, seq: s, path: kind, gap: s !== this.rxNext });
    while (this.rxBuf.has(this.rxNext) && !this.stopped) {
      const m = this.rxBuf.get(this.rxNext)!;
      this.rxBuf.delete(this.rxNext);
      this.rxNext++;
      this.io.deliver('_w' in m ? m._w : m);
    }
  }

  private legacyIn(raw: unknown) {
    if (this.peerSid) return; // a page with this layer never sends bare messages
    if (!this.legacy) {
      this.legacy = true;
      netLog('legacy-peer', { peer: this.label });
      this.io.known();
    }
    this.io.deliver(raw);
  }

  /** note the peer's session id; false if it is a dead (replaced) session */
  private learn(sid: string): boolean {
    if (sid === this.peerSid) return true;
    if (this.dead.has(sid)) return false;
    if (this.peerSid === null) {
      this.peerSid = sid;
      this.legacy = false;
      this.io.known();
      return true;
    }
    netLog('peer-restarted', { peer: this.label, old: this.peerSid, sid });
    this.dead.add(this.peerSid);
    this.txSeq = 0;
    this.unacked.clear();
    this.rxNext = 1;
    this.rxBuf.clear();
    this.ackDue.clear();
    this.confirmed = false;
    this.peerSid = sid;
    this.io.changed();
    return true;
  }

  private onCtl(kind: PathKind, c: Ctl, now: number) {
    if (typeof c._i !== 'string' || !this.learn(c._i)) return;
    if (c._p === this.mySid) this.confirmed = true;
    switch (c._mp) {
      case 'h':
        if (c._p !== this.mySid) this.sendHello(kind);
        return;
      case 'k':
        if (c._p !== this.mySid || typeof c.a !== 'number') return;
        this.onAck(c.a, kind, now);
        if (Array.isArray(c.m)) this.fastRetransmit(c.m, now);
        return;
      case 'p':
        this.ctl(kind, { _mp: 'q', t: c.t, k: kind });
        return;
      case 'q': {
        if (typeof c.t !== 'number') return;
        const r = Math.max(0, now - c.t);
        const old = this.rtts.get(kind);
        const v = old === undefined ? r : Math.round(old * 0.6 + r * 0.4);
        this.rtts.set(kind, v);
        netLog('rtt', { peer: this.label, kind, ms: r });
        return;
      }
      default:
        return;
    }
  }

  /** the peer reported holes: send those messages again at once on every open path */
  private fastRetransmit(missing: unknown[], now: number) {
    const gap = Math.max(40, (this.srtt ?? 200) * 0.5);
    const open = this.io.open();
    for (const x of missing) {
      if (typeof x !== 'number') continue;
      const p = this.unacked.get(x);
      if (!p || now - p.last < gap) continue;
      p.tries++;
      p.last = now;
      p.paths = open;
      const obj = this.rewire(p, x);
      for (const k of open) this.io.send(k, obj);
      netLog('tx', { peer: this.label, seq: x, paths: open, try: p.tries, fast: true });
    }
  }

  private onAck(a: number, kind: PathKind, now: number) {
    for (const [s, p] of this.unacked) {
      if (s > a) break;
      const ms = now - p.first;
      if (p.tries === 0) {
        if (this.srtt === null) {
          this.srtt = ms;
          this.rttvar = ms / 2;
        } else {
          this.rttvar = this.rttvar * 0.75 + Math.abs(this.srtt - ms) * 0.25;
          this.srtt = this.srtt * 0.875 + ms * 0.125;
        }
      }
      netLog('ack', { peer: this.label, seq: s, ms, path: kind, tries: p.tries, sentOn: p.paths });
      this.unacked.delete(s);
    }
  }

  private rto(): number {
    if (this.srtt === null) return Math.max(this.o.minRtoMs, Math.min(this.o.maxRtoMs, (this.bestRtt() ?? 600) * 1.5 + 200));
    return Math.max(this.o.minRtoMs, Math.min(this.o.maxRtoMs, this.srtt + Math.max(100, 4 * this.rttvar)));
  }

  // ------------------------------------------------------------ timer

  tick(now = Date.now()) {
    if (this.stopped) return;
    const open = this.io.open();
    if (!open.length) return;
    if (!this.confirmed && !this.legacy)
      for (const k of open) if (now - (this.helloAt.get(k) ?? 0) >= this.o.helloRetryMs) this.sendHello(k);
    if (!this.peerSid || this.legacy) return;
    if (this.unacked.size) {
      const rto = this.rto();
      for (const [s, p] of this.unacked) {
        if (now - p.last < rto * 2 ** Math.min(p.tries, 3)) continue;
        if (p.tries === 0 && p.paths.length === 1 && p.paths[0] === 'direct' && open.length > 1) {
          this.directSuspectAt = now;
          netLog('direct-suspect', { peer: this.label, seq: s });
        }
        p.tries++;
        p.last = now;
        p.paths = open;
        const obj = this.rewire(p, s);
        for (const k of open) this.io.send(k, obj);
        netLog('tx', { peer: this.label, seq: s, paths: open, try: p.tries });
      }
    }
    const healthy = this.directHealthy(now, open);
    for (const k of open) {
      const every = k === 'direct' ? this.o.directPingMs : healthy ? this.o.idlePingMs : this.o.relayPingMs;
      if (now - (this.lastPing.get(k) ?? 0) < every) continue;
      this.lastPing.set(k, now);
      this.ctl(k, { _mp: 'p', t: now, k });
    }
  }

  stop() {
    this.stopped = true;
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = null;
    this.unacked.clear();
    this.rxBuf.clear();
  }
}

// ====================================================================== guest

export interface GuestPathSpec {
  kind: PathKind;
  create: () => Transport;
}

export interface MultiPathGuestOptions extends MpOptions {
  /** two paths say "no such room": give the others this long before reporting it */
  badCodeGraceMs?: number;
  /** a failed path is started again after this long (doubling up to maxRestartMs) */
  restartMs?: number;
  maxRestartMs?: number;
}

interface GSlot {
  spec: GuestPathSpec;
  t: Transport | null;
  offs: Unsubscribe[];
  open: boolean;
  err: TransportError | null;
  restarts: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const ERROR_RANK: Record<string, number> = { 'room-full': 5, webrtc: 4, 'bad-code': 3, broker: 2, 'id-taken': 1, unsupported: 0 };

export class MultiPathGuest implements Transport {
  readonly role: TransportRole = 'guest';
  isOpen = false;
  private em = new Emitter<TransportEvents>();
  private peer: MpPeer;
  private slots: GSlot[];
  private readyEmitted = false;
  private everOpen = false;
  private closed = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private badCodeTimer: ReturnType<typeof setTimeout> | null = null;
  private o: MultiPathGuestOptions;

  constructor(
    public code: string,
    specs: GuestPathSpec[],
    opts: MultiPathGuestOptions = {},
  ) {
    this.o = opts;
    this.peer = new MpPeer(
      randomId(6),
      {
        open: () => this.slots.filter((s) => s.open).map((s) => s.spec.kind),
        send: (k, obj) => this.slots.find((s) => s.spec.kind === k)?.t?.send(obj) ?? false,
        deliver: (m) => this.em.emit('message', m),
        known: () => this.update(),
        changed: () => {
          if (this.isOpen) {
            this.isOpen = false;
            this.em.emit('close');
          }
          this.update();
        },
      },
      opts,
      'host',
    );
    this.slots = specs.map((spec) => ({ spec, t: null, offs: [], open: false, err: null, restarts: 0, timer: null }));
    if (!specs.length) queueMicrotask(() => this.fatal({ code: 'unsupported', message: 'no transport', fatal: true }));
    for (const s of this.slots) this.start(s);
    this.timer = setInterval(() => this.peer.tick(), opts.tickMs ?? MP_DEFAULTS.tickMs);
  }

  get remoteClientId(): string | null {
    for (const s of this.slots) if (s.t?.remoteClientId) return s.t.remoteClientId;
    return null;
  }

  get linkKind(): LinkKind | null {
    return this.isOpen ? this.peer.linkKind() : null;
  }

  /** ping round trip of the path in use (ms) */
  get linkRtt(): number | null {
    return this.isOpen ? this.peer.bestRtt() : null;
  }

  get paths(): PathInfo[] {
    return this.slots.map((s) => ({ kind: s.spec.kind, open: s.open, rtt: this.peer.rttOf(s.spec.kind), failed: s.err?.code ?? null }));
  }

  private start(slot: GSlot) {
    if (this.closed) return;
    const kind = slot.spec.kind;
    let t: Transport;
    try {
      t = slot.spec.create();
    } catch (e) {
      slot.err = { code: 'unsupported', message: String(e), fatal: true };
      return;
    }
    slot.t = t;
    slot.err = null;
    slot.offs = [
      t.onReady(() => {
        if (this.readyEmitted) return;
        this.readyEmitted = true;
        this.em.emit('ready', this.code);
      }),
      t.onOpen(() => {
        if (slot.t !== t || slot.open) return;
        slot.open = true;
        slot.restarts = 0;
        netLog('path', { kind, open: true });
        this.peer.pathOpened(kind);
        this.update();
      }),
      t.onClose(() => {
        if (slot.t !== t || !slot.open) return;
        slot.open = false;
        netLog('path', { kind, open: false });
        this.peer.pathClosed(kind);
        this.update();
      }),
      t.onMessage((m) => {
        if (slot.t === t) this.peer.receive(kind, m);
      }),
      t.onError((e) => {
        if (slot.t === t) this.pathError(slot, e);
      }),
    ];
  }

  private update() {
    if (this.closed) return;
    const want = this.slots.some((s) => s.open) && (this.peer.peerSid !== null || this.peer.legacy);
    if (want && !this.isOpen) {
      this.isOpen = true;
      this.everOpen = true;
      if (this.badCodeTimer) clearTimeout(this.badCodeTimer);
      this.badCodeTimer = null;
      this.em.emit('open');
    } else if (!want && this.isOpen) {
      this.isOpen = false;
      this.em.emit('close');
    }
  }

  private pathError(slot: GSlot, e: TransportError) {
    netLog('path-error', { kind: slot.spec.kind, code: e.code, fatal: e.fatal, message: e.message });
    if (!e.fatal) return;
    if (e.code === 'room-full') return this.fatal(e);
    slot.offs.forEach((f) => f());
    slot.offs = [];
    const t = slot.t;
    slot.t = null;
    slot.err = e;
    try {
      t?.close();
    } catch {
      /* ignore */
    }
    if (slot.open) {
      slot.open = false;
      this.peer.pathClosed(slot.spec.kind);
      this.update();
    }
    if (!this.everOpen) {
      const alive = this.slots.filter((s) => s.t);
      if (!alive.length) {
        const worst = this.slots
          .map((s) => s.err)
          .filter((x): x is TransportError => !!x)
          .sort((a, b) => (ERROR_RANK[b.code] ?? 0) - (ERROR_RANK[a.code] ?? 0))[0];
        return this.fatal(worst ?? e);
      }
      const badCodes = this.slots.filter((s) => s.err?.code === 'bad-code').length;
      if (badCodes >= 2 && !this.badCodeTimer)
        this.badCodeTimer = setTimeout(() => {
          this.badCodeTimer = null;
          if (!this.everOpen && !this.closed) this.fatal({ code: 'bad-code', message: `Room ${this.code} not found`, fatal: true });
        }, this.o.badCodeGraceMs ?? 4000);
    }
    const base = this.o.restartMs ?? 20_000;
    const ms = Math.min(this.o.maxRestartMs ?? 120_000, base * 2 ** slot.restarts++);
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = setTimeout(() => {
      slot.timer = null;
      if (!this.closed && !slot.t) {
        netLog('path-restart', { kind: slot.spec.kind });
        this.start(slot);
      }
    }, ms);
  }

  send(msg: unknown): boolean {
    return this.isOpen && this.peer.send(msg);
  }

  private fatal(e: TransportError) {
    if (this.closed) return;
    this.em.emit('error', { ...e, fatal: true });
    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.badCodeTimer) clearTimeout(this.badCodeTimer);
    this.timer = this.badCodeTimer = null;
    this.peer.stop();
    for (const s of this.slots) {
      if (s.timer) clearTimeout(s.timer);
      s.timer = null;
      s.offs.forEach((f) => f());
      s.offs = [];
      const t = s.t;
      s.t = null;
      s.open = false;
      try {
        t?.close();
      } catch {
        /* ignore */
      }
    }
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

// ====================================================================== host

export interface HostPathSpec {
  kind: PathKind;
  /** a host transport for room `code` */
  create: (code: string) => MultiHostTransport;
}

export interface MultiPathHostOptions extends MpOptions {
  code: string;
  /** wait this long for the direct path to register before announcing the room on the relays alone */
  readyWaitMs?: number;
  restartMs?: number;
  maxRestartMs?: number;
}

interface HSlot {
  spec: HostPathSpec;
  h: MultiHostTransport | null;
  offs: Unsubscribe[];
  ready: boolean;
  err: TransportError | null;
  restarts: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface HPeer {
  peer: MpPeer;
  paths: Set<PathKind>;
  joined: boolean;
}

export class MultiPathHost extends BaseMultiHost {
  code: string;
  private slots: HSlot[];
  private peers = new Map<string, HPeer>();
  private sid = randomId(6);
  private readyEmitted = false;
  private closed = false;
  private startedAt = Date.now();
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    specs: HostPathSpec[],
    private o: MultiPathHostOptions,
  ) {
    super();
    this.code = o.code;
    this.slots = specs.map((spec) => ({ spec, h: null, offs: [], ready: false, err: null, restarts: 0, timer: null }));
    if (!specs.length) queueMicrotask(() => this.em.emit('error', { code: 'unsupported', message: 'no transport', fatal: true }));
    for (const s of this.slots) this.start(s);
    this.readyTimer = setTimeout(() => {
      this.readyTimer = null;
      this.maybeReady();
    }, o.readyWaitMs ?? 2500);
    this.timer = setInterval(() => {
      for (const p of this.peers.values()) p.peer.tick();
    }, o.tickMs ?? MP_DEFAULTS.tickMs);
  }

  get clients(): string[] {
    return [...this.peers].filter(([, p]) => p.joined).map(([cid]) => cid);
  }

  isOpen(clientId: string): boolean {
    return !!this.peers.get(clientId)?.joined;
  }

  linkOf(clientId: string): LinkKind | null {
    const p = this.peers.get(clientId);
    return p?.joined ? p.peer.linkKind() : null;
  }

  rttOf(clientId: string): number | null {
    const p = this.peers.get(clientId);
    return p?.joined ? p.peer.bestRtt() : null;
  }

  pathsOf(clientId: string): PathInfo[] {
    const p = this.peers.get(clientId);
    return this.slots.map((s) => ({
      kind: s.spec.kind,
      open: !!p?.paths.has(s.spec.kind),
      rtt: p?.peer.rttOf(s.spec.kind) ?? null,
      failed: s.err?.code ?? null,
    }));
  }

  /** state of each path of the room (registered / failed) */
  get paths(): { kind: PathKind; ready: boolean; failed: string | null }[] {
    return this.slots.map((s) => ({ kind: s.spec.kind, ready: s.ready, failed: s.err?.code ?? null }));
  }

  private entry(cid: string): HPeer {
    let e = this.peers.get(cid);
    if (e) return e;
    const self: HPeer = { peer: null as unknown as MpPeer, paths: new Set(), joined: false };
    self.peer = new MpPeer(
      this.sid,
      {
        open: () => [...self.paths],
        send: (k, obj) => this.slots.find((s) => s.spec.kind === k)?.h?.send(cid, obj) ?? false,
        deliver: (m) => {
          if (self.joined) this.em.emit('message', cid, m);
        },
        known: () => {
          if (!self.joined && self.paths.size) {
            self.joined = true;
            this.em.emit('join', cid);
          }
        },
        changed: () => {
          if (self.joined) this.em.emit('leave', cid);
          self.joined = self.paths.size > 0;
          if (self.joined) this.em.emit('join', cid);
        },
      },
      this.o,
      cid,
    );
    this.peers.set(cid, self);
    e = self;
    return e;
  }

  private start(slot: HSlot) {
    if (this.closed) return;
    const kind = slot.spec.kind;
    let h: MultiHostTransport;
    try {
      h = slot.spec.create(this.code);
    } catch (e) {
      slot.err = { code: 'unsupported', message: String(e), fatal: true };
      return;
    }
    slot.h = h;
    slot.err = null;
    slot.ready = false;
    slot.offs = [
      h.onReady(() => {
        if (slot.h !== h) return;
        slot.ready = true;
        slot.restarts = 0;
        netLog('path', { kind, ready: true, code: this.code });
        this.maybeReady();
      }),
      h.onJoin((cid) => {
        if (slot.h !== h) return;
        const e = this.entry(cid);
        e.paths.add(kind);
        netLog('path', { kind, open: true, cid });
        e.peer.pathOpened(kind);
        // the peer may already be known (another path): nothing else to do
        if (!e.joined && (e.peer.peerSid || e.peer.legacy)) {
          e.joined = true;
          this.em.emit('join', cid);
        }
      }),
      h.onLeave((cid) => {
        if (slot.h !== h) return;
        this.pathLeft(cid, kind);
      }),
      h.onMessage((cid, m) => {
        if (slot.h !== h) return;
        const e = this.entry(cid);
        if (!e.paths.has(kind)) {
          e.paths.add(kind);
          e.peer.pathOpened(kind);
        }
        e.peer.receive(kind, m);
      }),
      h.onError((e) => {
        if (slot.h === h) this.pathError(slot, e);
      }),
    ];
  }

  private pathLeft(cid: string, kind: PathKind) {
    const e = this.peers.get(cid);
    if (!e || !e.paths.delete(kind)) return;
    netLog('path', { kind, open: false, cid });
    e.peer.pathClosed(kind);
    if (!e.paths.size && e.joined) {
      e.joined = false;
      this.em.emit('leave', cid);
    }
  }

  private maybeReady() {
    if (this.readyEmitted || this.closed) return;
    if (!this.slots.some((s) => s.ready)) return;
    const direct = this.slots.find((s) => s.spec.kind === 'direct');
    const directSettled = !direct || direct.ready || !direct.h;
    if (!directSettled && Date.now() - this.startedAt < (this.o.readyWaitMs ?? 2500)) return;
    this.readyEmitted = true;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    this.em.emit('ready', this.code);
  }

  private pathError(slot: HSlot, e: TransportError) {
    netLog('path-error', { kind: slot.spec.kind, code: e.code, fatal: e.fatal, message: e.message });
    if (!e.fatal) return;
    const kind = slot.spec.kind;
    slot.offs.forEach((f) => f());
    slot.offs = [];
    const h = slot.h;
    slot.h = null;
    slot.ready = false;
    slot.err = e;
    try {
      h?.close();
    } catch {
      /* ignore */
    }
    for (const cid of [...this.peers.keys()]) this.pathLeft(cid, kind);
    if (!this.readyEmitted && this.slots.every((s) => !s.h)) {
      this.em.emit('error', { ...e, fatal: true });
      this.close();
      return;
    }
    this.maybeReady();
    const base = this.o.restartMs ?? 15_000;
    const ms = Math.min(this.o.maxRestartMs ?? 120_000, base * 2 ** slot.restarts++);
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = setTimeout(() => {
      slot.timer = null;
      if (!this.closed && !slot.h) {
        netLog('path-restart', { kind });
        this.start(slot);
      }
    }, ms);
  }

  send(clientId: string, msg: unknown): boolean {
    const p = this.peers.get(clientId);
    return !!p?.joined && p.peer.send(msg);
  }

  kick(clientId: string): void {
    for (const s of this.slots) s.h?.kick(clientId);
  }

  refuse(clientId: string): void {
    for (const s of this.slots) {
      const h = s.h;
      if (!h?.isOpen(clientId)) continue;
      if (h.refuse) h.refuse(clientId);
      else h.kick(clientId);
    }
  }

  close(): void {
    this.shutdown(false);
  }

  /** stop but keep what lets the room be resumed (relay presence) */
  detach(): void {
    this.shutdown(true);
  }

  private shutdown(detach: boolean) {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.timer = this.readyTimer = null;
    for (const p of this.peers.values()) p.peer.stop();
    for (const s of this.slots) {
      if (s.timer) clearTimeout(s.timer);
      s.timer = null;
      s.offs.forEach((f) => f());
      s.offs = [];
      const h = s.h as (MultiHostTransport & { detach?: () => void }) | null;
      s.h = null;
      try {
        if (detach && h?.detach) h.detach();
        else h?.close();
      } catch {
        /* ignore */
      }
    }
  }
}

function strip<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && typeof v !== 'function') (out as Record<string, unknown>)[k] = v;
  return out;
}
