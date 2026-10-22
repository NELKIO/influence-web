/**
 * DuelSession — one online duel between this browser and a remote one.
 *
 * Owns the local, authoritative-for-this-side MatchState. The active player resolves fights locally
 * (engine.attack) and streams the outcome; the other side validates and replays it with a forced
 * outcome. After each turn the receiver acks with a state hash; on mismatch, gaps or illegal actions
 * the host's state wins and is pushed with `sync`. Everything needed to resume (state, seq, log, role,
 * room code) is persisted to localStorage after every change, so a page reload re-dials and continues.
 *
 * Slot numbering is identical on both sides (slot 0 moves first). Locally the own slot has type
 * 'human' and the opponent 'remote'.
 */
import * as E from '../core/engine';
import { Rng, randomSeed } from '../core/rng';
import type { AttackRefusal, FieldSize, FightEvent, MatchEnd, MatchSettings, MatchState } from '../core/types';
import { Emitter, type Unsubscribe } from './emitter';
import { defaultStorage, DUEL_SESSION_KEY, getClientId, readJson, writeJson, type KVStorage } from './persist';
import {
  PROTOCOL_VERSION,
  parseMessage,
  stateHash,
  type ActionMsg,
  type DuelAction,
  type HelloMsg,
  type NetMessage,
  type SetupMsg,
  type SyncMsg,
} from './protocol';
import { isValidCode, normalizeCode, randomId } from './room';
import { createDuelGuestTransport, createDuelHostTransport, type LinkMode } from './composite';
import type { RelayOptions } from './mqttRelay';
import type { LinkKind, PeerTransportOptions, Transport, TransportError, TransportErrorCode } from './transport';

export type DuelRole = 'host' | 'guest';
export type DuelStatus = 'connecting' | 'waiting' | 'playing' | 'reconnecting' | 'ended' | 'error';

export interface DuelError {
  code: TransportErrorCode | 'version' | 'protocol';
  message: string;
  fatal: boolean;
}

export interface DuelConfig {
  size: FieldSize;
  darkness: boolean;
  symmetry: boolean;
  /** seconds per turn, 0 = unlimited */
  turnTime: number;
}

export interface RemotePowerEvent {
  player: number;
  cell: number;
  amount: number;
}

export interface DuelEndEvent extends MatchEnd {
  /** true if the local player won */
  won: boolean;
}

export interface RematchState {
  local: boolean;
  remote: boolean;
}

export interface TurnInfo {
  current: number;
  mine: boolean;
  /** local epoch ms when the turn times out, null without a turn timer */
  deadline: number | null;
}

export interface DuelEvents {
  /** state changed (local or remote action, setup, sync) */
  state: (state: MatchState) => void;
  status: (status: DuelStatus) => void;
  /** transport link up/down */
  connection: (connected: boolean) => void;
  /** the opponent's attack was applied (animate it); fired before `state` */
  remoteFight: (ev: FightEvent) => void;
  /** the opponent added power to a cell; fired before `state` */
  remotePower: (ev: RemotePowerEvent) => void;
  /** any opponent action, after it was applied */
  remoteAction: (a: DuelAction) => void;
  /** a new turn started */
  turn: (info: TurnInfo) => void;
  end: (ev: DuelEndEvent) => void;
  error: (err: DuelError) => void;
  rematch: (r: RematchState) => void;
  /** opponent's display name became known / changed */
  opponent: (name: string) => void;
  /** the local state was (or is about to be) replaced by the host's because of a desync */
  resync: (reason: string) => void;
  /** opponent silent for turnTime + grace: `claimTimeout()` is now possible */
  timeoutClaimable: () => void;
}

export interface DuelOptions {
  /** display name sent to the opponent */
  name?: string;
  /** persistence; default localStorage, null disables */
  storage?: KVStorage | null;
  /** default: persisted random id from storage */
  clientId?: string;
  /** automatically claim a timeout win when the opponent is silent past turnTime + grace (default true) */
  autoClaimTimeout?: boolean;
  /** extra wait after the opponent's turn time before a timeout can be claimed (default 30 s) */
  timeoutGraceMs?: number;
  /** ping interval for `rtt` (default 5000, 0 disables) */
  pingMs?: number;
  /** PeerJS transport tuning (broker, ICE, logging) */
  peer?: Omit<PeerTransportOptions, 'clientId'>;
  /** relay fallback tuning (brokers, MQTT client factory); false disables the relay */
  relay?: RelayOptions | false;
  /** 'auto' (WebRTC, relay fallback), 'direct' or 'relay'; default from `?transport=` or 'auto' */
  linkMode?: LinkMode;
  /** guest: switch to the relay when WebRTC is not open after this long (ms, default 5000) */
  fallbackMs?: number;
}

export interface HostOptions extends DuelOptions, Partial<DuelConfig> {
  /** map seed of the first match */
  seed?: number;
  /** host moves first in the first match (default random); rematches alternate */
  hostFirst?: boolean;
  /** fixed room code instead of a random one */
  code?: string;
  /** custom transport (tests: LoopbackTransport) instead of PeerJS */
  transport?: Transport;
}

export interface JoinOptions extends DuelOptions {
  transport?: Transport;
  /** ignore a saved session for the same room code (default: resume it) */
  fresh?: boolean;
}

export interface ResumeOptions extends DuelOptions {
  transport?: Transport;
  /** ignore saves older than this (default 6 h) */
  maxAgeMs?: number;
}

export interface SavedDuelInfo {
  role: DuelRole;
  code: string;
  opponentName: string | null;
  inMatch: boolean;
  ended: boolean;
  savedAt: number;
}

interface SavedDuel {
  v: 1;
  role: DuelRole;
  code: string;
  clientId: string;
  peerClientId: string | null;
  name: string;
  opponentName: string | null;
  config: DuelConfig;
  matchId: string | null;
  state: MatchState | null;
  seq: number;
  log: ActionMsg[];
  logBase: number;
  hostSlot: number;
  round: number;
  turnStartedAt: number;
  rematchLocal: boolean;
  savedAt: number;
}

const LOG_MAX = 300;
const DEFAULT_CONFIG: DuelConfig = { size: 'L', darkness: false, symmetry: true, turnTime: 0 };

/** Copy of `state` (from any perspective) with `localSlot` as 'human' and the other slot as 'remote'. */
export function localizeState(state: MatchState, localSlot: number): MatchState {
  const s = structuredClone(state);
  s.settings.players = s.settings.players.map((_, i) => (i === localSlot ? 'human' : 'remote'));
  s.viewer = localSlot;
  s.selected = -1;
  if (s.ended) s.ended = { ...s.ended, humanWon: s.ended.winner === localSlot };
  return s;
}

/** MatchSettings of an online duel from the perspective of the player in `localSlot`. */
export function duelSettings(config: DuelConfig, localSlot: number): MatchSettings {
  return {
    kind: 'duelOnline',
    size: config.size,
    players: localSlot === 0 ? ['human', 'remote'] : ['remote', 'human'],
    darkness: config.darkness,
    symmetry: config.symmetry,
    crowded: false,
    unions: false,
    shuffle: false,
    duelRules: true,
    turnTime: config.turnTime,
  };
}

function netOpts(opts: DuelOptions) {
  return { peer: opts.peer, relay: opts.relay, mode: opts.linkMode, fallbackMs: opts.fallbackMs };
}

function resolveStorage(opts: DuelOptions): KVStorage | null {
  return opts.storage === undefined ? defaultStorage() : opts.storage;
}

export class DuelSession {
  readonly role: DuelRole;
  readonly clientId: string;
  readonly name: string;
  /** room code (host: null until the broker registered the room) */
  code: string | null;
  config: DuelConfig;

  status: DuelStatus = 'connecting';
  /** transport link is up */
  connected = false;
  opponentName: string | null = null;
  peerClientId: string | null = null;

  state: MatchState | null = null;
  matchId: string | null = null;
  /** own slot (0 moves first) */
  localSlot = -1;
  /** number of actions applied in the current match */
  seq = 0;
  /** 0 for the first match in this room, +1 per rematch */
  round = 0;
  rematch: RematchState = { local: false, remote: false };
  /** local epoch ms when the current turn started */
  turnStartedAt = 0;
  /** last measured round trip in ms */
  rtt: number | null = null;
  canClaimTimeout = false;
  lastError: DuelError | null = null;

  private transport: Transport;
  private storage: KVStorage | null;
  private opts: DuelOptions & { seed?: number; hostFirst?: boolean };
  private em = new Emitter<DuelEvents>();
  private unsubs: Unsubscribe[] = [];
  private log: ActionMsg[] = [];
  private logBase = 0;
  private hostSlot = 0;
  private ownHashes = new Map<number, string>();
  private peerHello = false;
  private lastPeerSeq = -1;
  private endNotified: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  // ------------------------------------------------------------------ construction

  /** Create a room. Listen for status 'waiting' (or read `code`) to show the room code / invite link. */
  static host(opts: HostOptions = {}): DuelSession {
    const storage = resolveStorage(opts);
    const clientId = opts.clientId ?? getClientId(storage);
    const transport = opts.transport ?? createDuelHostTransport({ ...netOpts(opts), clientId, code: opts.code });
    const config: DuelConfig = {
      size: opts.size ?? DEFAULT_CONFIG.size,
      darkness: opts.darkness ?? DEFAULT_CONFIG.darkness,
      symmetry: opts.symmetry ?? DEFAULT_CONFIG.symmetry,
      turnTime: Math.max(0, Math.floor(opts.turnTime ?? DEFAULT_CONFIG.turnTime)),
    };
    return new DuelSession('host', transport, { ...opts, storage, clientId }, config, null);
  }

  /** Join room `code` (case-insensitive). Resumes a saved guest session for the same code unless `fresh`. */
  static join(code: string, opts: JoinOptions = {}): DuelSession {
    const storage = resolveStorage(opts);
    const clientId = opts.clientId ?? getClientId(storage);
    const c = normalizeCode(code);
    const saved = opts.fresh ? null : readJson<SavedDuel>(storage, DUEL_SESSION_KEY);
    const resume = saved && saved.v === 1 && saved.role === 'guest' && saved.code === c ? saved : null;
    const transport = opts.transport ?? createDuelGuestTransport(c, { ...netOpts(opts), clientId });
    const s = new DuelSession('guest', transport, { ...opts, storage, clientId }, { ...DEFAULT_CONFIG }, resume);
    if (!transport.code) s.code = c;
    if (!isValidCode(c)) {
      queueMicrotask(() => s.fail({ code: 'bad-code', message: `Invalid room code "${code}"`, fatal: true }));
    }
    return s;
  }

  /** Resume the duel saved in storage (after a page reload). Returns null if there is none. */
  static resume(opts: ResumeOptions = {}): DuelSession | null {
    const storage = resolveStorage(opts);
    const saved = readJson<SavedDuel>(storage, DUEL_SESSION_KEY);
    if (!saved || saved.v !== 1 || Date.now() - saved.savedAt > (opts.maxAgeMs ?? 6 * 3600_000)) return null;
    const clientId = opts.clientId ?? saved.clientId ?? getClientId(storage);
    const transport =
      opts.transport ??
      (saved.role === 'host'
        ? createDuelHostTransport({ ...netOpts(opts), clientId, code: saved.code, fixed: true, expectClientId: saved.peerClientId })
        : createDuelGuestTransport(saved.code, { ...netOpts(opts), clientId }));
    return new DuelSession(saved.role, transport, { ...opts, storage, clientId, name: opts.name ?? saved.name }, saved.config, saved);
  }

  /** Summary of the saved duel (for a "resume duel?" prompt), or null. */
  static saved(storage: KVStorage | null = defaultStorage(), maxAgeMs = 6 * 3600_000): SavedDuelInfo | null {
    const s = readJson<SavedDuel>(storage, DUEL_SESSION_KEY);
    if (!s || s.v !== 1 || Date.now() - s.savedAt > maxAgeMs) return null;
    return {
      role: s.role,
      code: s.code,
      opponentName: s.opponentName,
      inMatch: !!s.state,
      ended: !!s.state?.ended,
      savedAt: s.savedAt,
    };
  }

  static clearSaved(storage: KVStorage | null = defaultStorage()): void {
    try {
      storage?.removeItem(DUEL_SESSION_KEY);
    } catch {
      /* ignore */
    }
  }

  private constructor(
    role: DuelRole,
    transport: Transport,
    opts: DuelOptions & { storage: KVStorage | null; clientId: string },
    config: DuelConfig,
    saved: SavedDuel | null,
  ) {
    this.role = role;
    this.transport = transport;
    this.storage = opts.storage;
    this.clientId = opts.clientId;
    this.name = (opts.name ?? saved?.name ?? '').slice(0, 40);
    this.opts = opts;
    this.config = config;
    this.code = transport.code;
    if (saved) this.restore(saved);

    this.unsubs.push(
      transport.onReady((code) => {
        this.code = code;
        if (!this.state && this.status === 'connecting' && role === 'host') this.setStatus('waiting');
        this.persist();
      }),
      transport.onOpen(() => this.handleOpen()),
      transport.onClose(() => this.handleClose()),
      transport.onMessage((m) => this.handleMessage(m)),
      transport.onError((e) => this.handleTransportError(e)),
    );
    if (transport.isOpen) queueMicrotask(() => this.handleOpen());
  }

  private restore(s: SavedDuel) {
    this.code = s.code;
    this.peerClientId = s.peerClientId;
    this.opponentName = s.opponentName;
    this.config = s.config;
    this.matchId = s.matchId;
    this.state = s.state;
    this.seq = s.seq;
    this.log = s.log ?? [];
    this.logBase = s.logBase ?? s.seq - this.log.length;
    this.hostSlot = s.hostSlot;
    this.round = s.round;
    this.turnStartedAt = s.turnStartedAt;
    this.rematch = { local: s.rematchLocal, remote: false };
    if (this.state) {
      this.localSlot = this.role === 'host' ? this.hostSlot : 1 - this.hostSlot;
      if (this.state.ended) {
        this.status = 'ended';
        this.endNotified = this.endKey();
      } else {
        this.status = 'reconnecting';
      }
      this.armTimer();
    }
  }

  // ------------------------------------------------------------------ public API: queries

  /** how the link to the opponent is carried right now ('direct' WebRTC or 'relay'), null when offline */
  get link(): LinkKind | null {
    return this.connected ? (this.transport.linkKind ?? null) : null;
  }

  get isHost(): boolean {
    return this.role === 'host';
  }

  get remoteSlot(): number {
    return this.localSlot < 0 ? -1 : 1 - this.localSlot;
  }

  get isMyTurn(): boolean {
    return !!this.state && !this.state.ended && this.state.current === this.localSlot;
  }

  /** local actions are accepted right now */
  get canAct(): boolean {
    return this.isMyTurn && (this.status === 'playing' || this.status === 'reconnecting');
  }

  /** local epoch ms when the current turn times out (null: no timer / no match) */
  get turnDeadline(): number | null {
    const t = this.config.turnTime;
    if (!t || !this.state || this.state.ended) return null;
    return this.turnStartedAt + t * 1000;
  }

  timeLeftMs(now = Date.now()): number | null {
    const d = this.turnDeadline;
    return d === null ? null : Math.max(0, d - now);
  }

  // ------------------------------------------------------------------ public API: events

  on<K extends keyof DuelEvents>(type: K, cb: DuelEvents[K]): Unsubscribe {
    return this.em.on(type, cb);
  }
  onState(cb: DuelEvents['state']) {
    return this.on('state', cb);
  }
  onStatus(cb: DuelEvents['status']) {
    return this.on('status', cb);
  }
  onRemoteFight(cb: DuelEvents['remoteFight']) {
    return this.on('remoteFight', cb);
  }
  onRemotePower(cb: DuelEvents['remotePower']) {
    return this.on('remotePower', cb);
  }
  onTurn(cb: DuelEvents['turn']) {
    return this.on('turn', cb);
  }
  onEnd(cb: DuelEvents['end']) {
    return this.on('end', cb);
  }
  onError(cb: DuelEvents['error']) {
    return this.on('error', cb);
  }
  onRematch(cb: DuelEvents['rematch']) {
    return this.on('rematch', cb);
  }
  onOpponent(cb: DuelEvents['opponent']) {
    return this.on('opponent', cb);
  }

  // ------------------------------------------------------------------ public API: actions

  /** Attack from own cell. Resolves locally and sends the outcome. */
  attack(from: number, to: number): FightEvent | AttackRefusal | 'notYourTurn' {
    if (!this.canAct) return 'notYourTurn';
    const r = E.attack(this.state!, from, to);
    if (typeof r === 'string') return r;
    this.commit({ t: 'attack', from, to, win: r.win });
    return r;
  }

  /** Switch to the power phase. */
  endAttack(): boolean {
    if (!this.canAct || this.state!.phase !== 'attack') return false;
    E.endAttack(this.state!);
    this.commit({ t: 'endAttack' });
    return true;
  }

  /** Add power to an own cell in the power phase. Returns the points actually added. */
  addPower(cell: number, amount = 1): number {
    if (!this.canAct || this.state!.phase !== 'power') return 0;
    const added = E.addPower(this.state!, cell, amount);
    if (added > 0) this.commit({ t: 'power', cell, amount: added });
    return added;
  }

  /** Distribute all remaining power (engine round-robin). Returns cell -> points added. */
  autoPower(): Map<number, number> {
    if (!this.canAct || this.state!.phase !== 'power') return new Map();
    const added = E.autoPower(this.state!);
    let first = true;
    for (const [cell, amount] of added) {
      this.commit({ t: 'power', cell, amount }, { quiet: true });
      first = false;
    }
    if (!first) this.afterChange();
    return added;
  }

  /**
   * Finish the turn. From the attack phase this also ends the attack; leftover power is
   * auto-distributed first. Returns false if it is not our turn.
   */
  endTurn(): boolean {
    if (!this.canAct) return false;
    const st = this.state!;
    if (st.phase === 'attack') {
      E.endAttack(st);
      this.commit({ t: 'endAttack' }, { quiet: true });
    }
    if (st.powerLeft > 0) {
      for (const [cell, amount] of E.autoPower(st)) this.commit({ t: 'power', cell, amount }, { quiet: true });
    }
    E.finishTurn(st);
    this.commit({ t: 'endTurn' });
    return true;
  }

  /** Give up the current match (allowed at any time). */
  concede(): boolean {
    const st = this.state;
    if (!st || st.ended || !this.matchId) return false;
    E.concede(st, this.localSlot);
    this.sendGame({ t: 'concede', matchId: this.matchId });
    this.afterChange();
    return true;
  }

  /** Claim a win because the opponent stayed silent too long (see `canClaimTimeout`). */
  claimTimeout(): boolean {
    const st = this.state;
    if (!this.canClaimTimeout || !st || st.ended || st.current !== this.remoteSlot || !this.matchId) return false;
    st.ended = { winner: this.localSlot, humanWon: true, reason: 'timeout', turn: st.turn };
    this.canClaimTimeout = false;
    this.sendGame({ t: 'timeout', matchId: this.matchId, seq: this.seq });
    this.afterChange();
    return true;
  }

  /** Ask for (or accept) a rematch after the match ended. The host starts it once both agreed. */
  requestRematch(): boolean {
    if (!this.state?.ended) return false;
    this.rematch = { ...this.rematch, local: true };
    this.sendGame({ t: 'rematch', accept: true });
    this.em.emit('rematch', { ...this.rematch });
    this.persist();
    this.maybeStartRematch();
    return true;
  }

  declineRematch(): void {
    this.rematch = { ...this.rematch, local: false };
    this.sendGame({ t: 'rematch', accept: false });
    this.em.emit('rematch', { ...this.rematch });
    this.persist();
  }

  /** Close the connection but keep the saved session (it can be resumed later). */
  dispose(): void {
    this.shutdown(true);
  }

  private shutdown(keepRoom: boolean) {
    if (this.closed) return;
    this.persist();
    this.closed = true;
    this.stopTimers();
    for (const u of this.unsubs) u();
    this.unsubs = [];
    // keepRoom: the relay presence of a hosted room stays, so the room can be resumed
    const t = this.transport as Transport & { detach?: () => void };
    if (keepRoom && t.detach) t.detach();
    else t.close();
    this.connected = false;
    this.em.clear();
  }

  /** Leave the room for good: close the connection and forget the saved session. */
  leave(): void {
    this.shutdown(false);
    DuelSession.clearSaved(this.storage);
  }

  // ------------------------------------------------------------------ transport events

  private handleOpen() {
    if (this.closed || this.status === 'error') return;
    this.connected = true;
    this.peerHello = false;
    this.em.emit('connection', true);
    if (this.role === 'guest') {
      this.sendHello();
      if (!this.state) this.setStatus('waiting');
    }
    this.startPing();
  }

  private handleClose() {
    if (this.closed || this.status === 'error') return;
    this.connected = false;
    this.peerHello = false;
    this.stopPing();
    this.em.emit('connection', false);
    if (this.state && !this.state.ended) this.setStatus('reconnecting');
    else if (!this.state) this.setStatus(this.role === 'host' && this.code ? 'waiting' : 'connecting');
  }

  private handleTransportError(e: TransportError) {
    if (e.fatal) this.fail(e);
    else {
      this.lastError = e;
      this.em.emit('error', e);
    }
  }

  private fail(err: DuelError) {
    if (this.closed || this.status === 'error') return;
    this.lastError = err;
    this.stopTimers();
    this.connected = false;
    this.setStatus('error');
    this.transport.close();
    // nothing worth resuming
    if (!this.state) DuelSession.clearSaved(this.storage);
    this.em.emit('error', err);
  }

  // ------------------------------------------------------------------ messages

  private send(msg: NetMessage): boolean {
    return this.transport.send(msg);
  }

  /** game messages are only sent after the hello exchange; anything missed is reconciled by it */
  private sendGame(msg: NetMessage) {
    if (this.peerHello) this.send(msg);
  }

  private sendHello() {
    const st = this.state;
    const hello: HelloMsg = {
      t: 'hello',
      v: PROTOCOL_VERSION,
      clientId: this.clientId,
      name: this.name,
      matchId: this.matchId,
      seq: this.seq,
      hash: st ? stateHash(st) : '',
      ended: st?.ended ?? null,
      rematch: this.rematch.local,
    };
    this.send(hello);
  }

  private handleMessage(raw: unknown) {
    if (this.closed || this.status === 'error') return;
    const msg = parseMessage(raw);
    if (!msg) return;
    switch (msg.t) {
      case 'hello':
        return this.onHello(msg);
      case 'setup':
        if (this.role === 'guest') this.onSetup(msg);
        return;
      case 'action':
        if (this.peerHello) this.onAction(msg);
        return;
      case 'sync':
        if (this.role === 'guest') this.onSync(msg);
        return;
      case 'syncReq':
        if (this.role === 'host' && this.state) this.sendSync(`guest request: ${msg.reason}`);
        return;
      case 'ack':
        return this.onAck(msg.seq, msg.hash);
      case 'concede':
        if (msg.matchId === this.matchId && this.state)
          this.adoptEnd({ winner: this.localSlot, humanWon: true, reason: 'concede', turn: this.state.turn });
        return;
      case 'timeout':
        if (msg.matchId === this.matchId && this.state)
          this.adoptEnd({ winner: this.remoteSlot, humanWon: false, reason: 'timeout', turn: this.state.turn });
        return;
      case 'rematch':
        this.rematch = { ...this.rematch, remote: msg.accept };
        this.em.emit('rematch', { ...this.rematch });
        this.maybeStartRematch();
        return;
      case 'ping':
        this.send({ t: 'pong', ts: msg.ts, seq: this.seq, matchId: this.matchId });
        return;
      case 'pong':
        this.rtt = Math.max(0, Date.now() - msg.ts);
        this.checkPeerProgress(msg.seq, msg.matchId);
        return;
      case 'reject':
        if (msg.reason === 'version')
          this.fail({ code: 'version', message: `Opponent runs protocol v${msg.v}, we run v${PROTOCOL_VERSION}`, fatal: true });
        else this.fail({ code: 'room-full', message: 'The room already has two players', fatal: true });
        return;
    }
  }

  private onHello(m: HelloMsg) {
    if (m.v !== PROTOCOL_VERSION) {
      this.send({ t: 'reject', reason: 'version', v: PROTOCOL_VERSION });
      this.fail({ code: 'version', message: `Opponent runs protocol v${m.v}, we run v${PROTOCOL_VERSION}`, fatal: true });
      return;
    }
    if (this.role === 'host' && this.peerClientId && m.clientId !== this.peerClientId) {
      this.send({ t: 'reject', reason: 'busy', v: PROTOCOL_VERSION });
      return;
    }
    this.peerClientId = m.clientId;
    const name = m.name.slice(0, 40);
    if (name !== this.opponentName) {
      this.opponentName = name;
      this.em.emit('opponent', name);
    }
    this.peerHello = true;

    if (this.role === 'host') {
      this.sendHello();
      if (!this.state) {
        this.startNewMatch();
        return;
      }
      if (m.matchId !== this.matchId) {
        this.sendSetup();
        this.afterHandshake();
        return;
      }
    } else if (!this.state || m.matchId !== this.matchId) {
      return; // the host follows up with `setup`
    }
    this.reconcile(m);
    this.afterHandshake();
  }

  /** compare with the peer's position after (re)connecting */
  private reconcile(m: HelloMsg) {
    const st = this.state!;
    this.rematch = { ...this.rematch, remote: m.rematch };
    if (m.ended && (m.ended.reason === 'concede' || m.ended.reason === 'timeout')) this.adoptEnd(m.ended);
    if (m.seq < this.seq) {
      this.resendFrom(m.seq);
    } else if (m.seq === this.seq && m.hash !== stateHash(st) && this.role === 'host') {
      this.sendSync('hash mismatch on reconnect');
    }
    this.em.emit('rematch', { ...this.rematch });
    this.maybeStartRematch();
  }

  private resendFrom(peerSeq: number) {
    if (peerSeq < this.logBase) {
      if (this.role === 'host') this.sendSync('peer too far behind');
      else this.send({ t: 'syncReq', matchId: this.matchId, reason: 'host behind log' });
      return;
    }
    for (const msg of this.log.slice(peerSeq - this.logBase)) this.send(msg);
  }

  private afterHandshake() {
    if (!this.state) return;
    this.setStatus(this.state.ended ? 'ended' : 'playing');
    this.persist();
    this.armTimer();
  }

  // ---- match setup (host)

  private startNewMatch() {
    const first = this.round === 0;
    const hostSlot = first
      ? this.opts.hostFirst === undefined
        ? new Rng(randomSeed()).int(2)
        : this.opts.hostFirst
          ? 0
          : 1
      : 1 - this.hostSlot;
    const seed = first && this.opts.seed !== undefined ? this.opts.seed : randomSeed();
    this.state = E.createMatch(duelSettings(this.config, hostSlot), { seed });
    this.hostSlot = hostSlot;
    this.localSlot = hostSlot;
    this.resetMatch(randomId(6), 0);
    this.sendSetup();
    this.setStatus('playing');
    this.em.emit('state', this.state);
    this.emitTurn();
    this.persist();
    this.armTimer();
  }

  private resetMatch(matchId: string, seq: number) {
    this.matchId = matchId;
    this.seq = seq;
    this.log = [];
    this.logBase = seq;
    this.ownHashes.clear();
    this.rematch = { local: false, remote: false };
    this.endNotified = null;
    this.canClaimTimeout = false;
    this.turnStartedAt = Date.now();
  }

  private sendSetup() {
    const st = this.state!;
    const msg: SetupMsg = {
      t: 'setup',
      v: PROTOCOL_VERSION,
      matchId: this.matchId!,
      state: st,
      seq: this.seq,
      hostSlot: this.hostSlot,
      seed: st.seed,
      turnTime: this.config.turnTime,
      round: this.round,
    };
    this.send(msg);
  }

  private sendSync(reason: string) {
    const st = this.state;
    if (!st || !this.matchId) return;
    this.em.emit('resync', reason);
    const msg: SyncMsg = { t: 'sync', matchId: this.matchId, seq: this.seq, state: st, hostSlot: this.hostSlot, round: this.round };
    this.send(msg);
  }

  private maybeStartRematch() {
    if (this.role !== 'host' || !this.state?.ended || !this.rematch.local || !this.rematch.remote || !this.peerHello) return;
    this.round++;
    this.startNewMatch();
  }

  // ---- guest adopts host state

  private onSetup(m: SetupMsg) {
    this.adoptState(m.matchId, m.state, m.seq, m.hostSlot, m.round);
  }

  private onSync(m: SyncMsg) {
    this.em.emit('resync', 'host sync');
    this.adoptState(m.matchId, m.state, m.seq, m.hostSlot, m.round);
  }

  private adoptState(matchId: string, remote: MatchState, seq: number, hostSlot: number, round: number) {
    const prev = this.state;
    const newMatch = matchId !== this.matchId || !prev;
    const st = localizeState(remote, 1 - hostSlot);
    if (!newMatch && prev) {
      st.chronicle = prev.chronicle;
      st.rng = prev.rng;
      st.luck = prev.luck;
    } else {
      st.rng = new Rng(randomSeed()).state();
    }
    const turnChanged = newMatch || prev!.current !== st.current || prev!.turn !== st.turn;
    if (newMatch) {
      this.resetMatch(matchId, seq);
    } else {
      this.seq = seq;
      this.log = [];
      this.logBase = seq;
      if (turnChanged) this.turnStartedAt = Date.now();
    }
    this.state = st;
    this.hostSlot = hostSlot;
    this.localSlot = 1 - hostSlot;
    this.round = round;
    this.config = {
      size: st.settings.size,
      darkness: st.settings.darkness,
      symmetry: st.settings.symmetry,
      turnTime: st.settings.turnTime ?? 0,
    };
    if (newMatch) this.em.emit('rematch', { ...this.rematch });
    this.em.emit('state', st);
    if (turnChanged && !st.ended) this.emitTurn();
    if (st.ended) this.notifyEnd();
    else this.setStatus('playing');
    this.persist();
    this.armTimer();
  }

  // ---- remote actions

  private onAction(m: ActionMsg) {
    const st = this.state;
    if (!st || !this.matchId) {
      if (this.role === 'guest') this.send({ t: 'syncReq', matchId: this.matchId, reason: 'no state' });
      return;
    }
    if (m.seq <= this.seq) {
      const idx = m.seq - this.logBase - 1;
      if (idx >= 0 && idx < this.log.length && JSON.stringify(this.log[idx].a) !== JSON.stringify(m.a)) {
        this.conflict(`conflicting action at seq ${m.seq}`);
      }
      return; // duplicate (resent after reconnect)
    }
    if (m.seq > this.seq + 1) return this.conflict(`gap: got ${m.seq}, expected ${this.seq + 1}`);
    if (st.ended) return;
    const a = m.a;
    const r = this.remoteSlot;
    if (st.current !== r) return this.conflict(`${a.t} out of turn`);
    let fight: FightEvent | null = null;
    let power: { cell: number; amount: number } | null = null;
    switch (a.t) {
      case 'attack': {
        const refusal = E.checkAttack(st, a.from, a.to);
        if (refusal) return this.conflict(`illegal attack ${a.from}->${a.to}: ${refusal}`);
        const p = E.winChance(st.field.cells[a.from].power, st.field.cells[a.to].power);
        if ((a.win && p === 0) || (!a.win && p === 1)) return this.conflict(`impossible outcome ${a.from}->${a.to}`);
        fight = E.attack(st, a.from, a.to, { win: a.win }) as FightEvent;
        break;
      }
      case 'endAttack':
        if (st.phase !== 'attack') return this.conflict('endAttack in power phase');
        E.endAttack(st);
        break;
      case 'power': {
        if (st.phase !== 'power') return this.conflict('power in attack phase');
        const c = st.field.cells[a.cell];
        if (!c || c.owner !== r) return this.conflict(`power to foreign cell ${a.cell}`);
        if (Math.min(a.amount, st.powerLeft, c.maxPower - c.power) !== a.amount) return this.conflict('power overflow');
        E.addPower(st, a.cell, a.amount);
        power = { cell: a.cell, amount: a.amount };
        break;
      }
      case 'endTurn':
        if (st.phase !== 'power') return this.conflict('endTurn in attack phase');
        E.finishTurn(st);
        break;
    }
    this.seq = m.seq;
    this.pushLog(m);
    if (fight) this.em.emit('remoteFight', fight);
    if (power) this.em.emit('remotePower', { player: r, ...power });
    this.em.emit('remoteAction', a);
    if (a.t === 'endTurn') {
      this.turnStartedAt = Date.now();
      this.canClaimTimeout = false;
    }
    if (a.t === 'endTurn' || st.ended) this.sendGame({ t: 'ack', seq: this.seq, hash: stateHash(st) });
    this.afterChange();
    if (a.t === 'endTurn') this.emitTurn();
  }

  /**
   * Safety net for messages lost without a disconnect: if the peer reports the same lower seq in two
   * consecutive pongs, re-send what it is missing.
   */
  private checkPeerProgress(peerSeq: number | undefined, peerMatch: string | null | undefined) {
    if (peerSeq === undefined || !this.peerHello || peerMatch !== this.matchId || !this.state) return;
    const behind = peerSeq < this.seq;
    if (behind && this.lastPeerSeq === peerSeq) this.resendFrom(peerSeq);
    this.lastPeerSeq = behind ? peerSeq : -1;
  }

  private conflict(reason: string) {
    if (this.role === 'host') this.sendSync(reason);
    else {
      this.em.emit('resync', reason);
      this.send({ t: 'syncReq', matchId: this.matchId, reason });
    }
  }

  private onAck(seq: number, hash: string) {
    const st = this.state;
    if (!st) return;
    const mine = this.ownHashes.get(seq) ?? (seq === this.seq ? stateHash(st) : undefined);
    if (mine !== undefined && mine !== hash) this.conflict(`ack hash mismatch at seq ${seq}`);
  }

  /** apply an end reported by the peer (concede / timeout claim) */
  private adoptEnd(end: MatchEnd) {
    const st = this.state;
    if (!st) return;
    if (st.ended) {
      // already over: keep ours, unless we are the guest and the host's verdict differs
      const same = st.ended.winner === end.winner && st.ended.reason === end.reason;
      if (same || this.role === 'host') return;
    }
    st.ended = { ...end, humanWon: end.winner === this.localSlot };
    this.afterChange();
  }

  // ---- local commit

  private commit(a: DuelAction, o: { quiet?: boolean } = {}) {
    const st = this.state!;
    this.seq++;
    const msg: ActionMsg = { t: 'action', seq: this.seq, a };
    this.pushLog(msg);
    this.sendGame(msg);
    if (a.t === 'endTurn') this.turnStartedAt = Date.now();
    if (a.t === 'endTurn' || st.ended) {
      this.ownHashes.set(this.seq, stateHash(st));
      if (this.ownHashes.size > 20) this.ownHashes.delete(this.ownHashes.keys().next().value!);
    }
    if (!o.quiet) this.afterChange();
    if (a.t === 'endTurn') this.emitTurn();
  }

  private pushLog(msg: ActionMsg) {
    this.log.push(msg);
    if (this.log.length > LOG_MAX) {
      const drop = this.log.length - LOG_MAX;
      this.log.splice(0, drop);
      this.logBase += drop;
    }
  }

  private afterChange() {
    const st = this.state;
    if (!st) return;
    this.em.emit('state', st);
    this.persist();
    if (st.ended) this.notifyEnd();
    else this.armTimer();
  }

  private endKey(): string {
    const e = this.state?.ended;
    return e ? `${this.matchId}:${e.winner}:${e.reason}` : '';
  }

  private notifyEnd() {
    const st = this.state;
    if (!st?.ended) return;
    const key = this.endKey();
    if (this.endNotified === key) return;
    this.endNotified = key;
    this.clearTimer();
    this.canClaimTimeout = false;
    if (this.status !== 'error') this.setStatus('ended');
    this.em.emit('end', { ...st.ended, won: st.ended.winner === this.localSlot });
  }

  private emitTurn() {
    const st = this.state;
    if (!st || st.ended) return;
    this.em.emit('turn', { current: st.current, mine: st.current === this.localSlot, deadline: this.turnDeadline });
  }

  private setStatus(s: DuelStatus) {
    if (this.status === s) return;
    this.status = s;
    this.em.emit('status', s);
  }

  // ------------------------------------------------------------------ timers

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private armTimer() {
    this.clearTimer();
    const st = this.state;
    const deadline = this.turnDeadline;
    if (this.closed || !st || deadline === null || this.status === 'error') return;
    const now = Date.now();
    if (st.current === this.localSlot) {
      this.timer = setTimeout(() => this.onOwnTimeUp(), Math.max(0, deadline - now));
    } else {
      const startedAt = this.turnStartedAt;
      const at = deadline + (this.opts.timeoutGraceMs ?? 30_000);
      this.timer = setTimeout(() => this.onRemoteSilent(startedAt), Math.max(0, at - now));
    }
  }

  private onOwnTimeUp() {
    this.timer = null;
    if (this.canAct) this.endTurn();
  }

  private onRemoteSilent(startedAt: number) {
    this.timer = null;
    const st = this.state;
    if (!st || st.ended || st.current !== this.remoteSlot || this.turnStartedAt !== startedAt) return;
    this.canClaimTimeout = true;
    this.em.emit('timeoutClaimable');
    if (this.opts.autoClaimTimeout !== false) this.claimTimeout();
  }

  private startPing() {
    this.stopPing();
    const ms = this.opts.pingMs ?? 5000;
    if (ms > 0) this.pingTimer = setInterval(() => this.send({ t: 'ping', ts: Date.now() }), ms);
  }

  private stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private stopTimers() {
    this.clearTimer();
    this.stopPing();
  }

  // ------------------------------------------------------------------ persistence

  private persist() {
    if (this.closed || !this.storage || !this.code) return;
    const saved: SavedDuel = {
      v: 1,
      role: this.role,
      code: this.code,
      clientId: this.clientId,
      peerClientId: this.peerClientId,
      name: this.name,
      opponentName: this.opponentName,
      config: this.config,
      matchId: this.matchId,
      state: this.state,
      seq: this.seq,
      log: this.log,
      logBase: this.logBase,
      hostSlot: this.hostSlot,
      round: this.round,
      turnStartedAt: this.turnStartedAt,
      rematchLocal: this.rematch.local,
      savedAt: Date.now(),
    };
    writeJson(this.storage, DUEL_SESSION_KEY, saved);
  }
}
