/**
 * Online battle rooms: a match of 2-6 seats where some seats are played on other devices.
 *
 * Host-authoritative. The HOST owns the authoritative MatchState (`host.state`), rolls every die and
 * runs the bots. Guests only send REQUESTS for their own seat; the host validates them (right seat,
 * right turn, legal per engine), applies them to `host.state` itself and BROADCASTS every applied action
 * with its resolved outcome. Actions the host UI applies itself (its own moves, bot moves) are reported
 * with `host.publish(...)` and broadcast the same way. Guests replay the stream strictly in `seq` order
 * through the engine with forced fight outcomes; every broadcast carries a state hash, and on a gap or
 * mismatch the guest asks for a resend / full `sync`.
 *
 * Guest requests are applied by BattleHost (not by the host UI): validation and application live in one
 * tested place, and the UI just animates `onApplied` and lets its controller re-evaluate (bots move next).
 *
 * Internally the host keeps a "shadow" copy that is advanced only by published actions (exactly like a
 * guest). Hashes are taken from it, so the UI may apply a bot's whole power phase and publish its actions
 * afterwards. If the shadow and `host.state` disagree at a turn end (something changed `state` without
 * being published) or for two heartbeats in a row, the host re-sends the full state to everybody.
 *
 * Seat kinds: on the host, guest seats are 'online'; on a guest its own seat is 'human', every other
 * person seat 'remote', bots keep their type (guests never run bots).
 *
 * Disconnects: a guest's seat stays reserved for its clientId (same seat back after reconnect / reload).
 * The match never waits for anybody except the seat whose turn it is; with `settings.turnTime` > 0 the
 * host ends an online seat's turn when its time is up (auto power). `fillWithBots(type)` turns online
 * seats without a connected guest into bots (lobby or mid-match), so a match continues if a guest leaves
 * for good (`fillWithBots(type, [seat])`: just that seat); a guest whose seat was replaced is told so
 * ('replaced') when it comes back. `awaySince(seat)` tells how long a guest has been offline; an away
 * guest's turn is skipped automatically once it has been offline for `awaySkipMs` (default 90 s), so a
 * match never hangs on a guest who vanished on its turn (a skip, not a bot: the guest may come back).
 * Concede: see battleRules.concedeSeat (the seat's cells turn neutral; the match goes on). A guest's
 * concede is never dropped: offline it waits for the link (and survives a reload) and it never times out.
 */
import * as E from '../core/engine';
import { randomSeed } from '../core/rng';
import { startMatch } from '../core/scenarios';
import type { BotType, FightEvent, MatchEnd, MatchSettings, MatchState, PlayerType } from '../core/types';
import { BroadcastBattleGuest, BroadcastBattleHost } from './broadcastBattle';
import { useBroadcastTransport } from './broadcast';
import {
  BATTLE_PROTOCOL_VERSION,
  battleHash,
  parseBattleMessage,
  type AppliedAction,
  type BActMsg,
  type BattleAction,
  type BattleMessage,
  type BattleRejectReason,
  type BattleRequest,
  type BHelloMsg,
  type BResMsg,
  type RequestRefusal,
  type RoomStatus,
  type WireSeat,
} from './battleProtocol';
import { applyBattleAction, concedeSeat, localizeBattleState, localizePlayers, shuffledSeatOrder } from './battleRules';
import { Emitter, type Unsubscribe } from './emitter';
import type { MultiHostTransport } from './hub';
import { createBattleGuestTransport, createBattleHostTransport, type LinkMode, type NetLinkOptions } from './composite';
import type { RelayOptions } from './mqttRelay';
import { defaultStorage, getClientId, readJson, writeJson, type KVStorage } from './persist';
import {
  generateBattleCode,
  isValidBattleCode,
  normalizeCode,
  randomId,
} from './room';
import type { LinkKind, PeerTransportOptions, Transport, TransportError, TransportErrorCode } from './transport';
import { onVisibility, pageHidden } from './visibility';

export type BattleStatus = 'connecting' | 'lobby' | 'playing' | 'ended' | 'error';

export const BATTLE_HOST_KEY = 'infweb.battleHost';
export const BATTLE_GUEST_KEY = 'infweb.battleGuest';

/** One seat of the room as seen by the local device. */
export interface RosterEntry {
  seat: number;
  /** from the viewer's perspective: host: 'human' / 'online' / bot; guest: 'human' (own) / 'remote' / bot */
  kind: PlayerType;
  name: string | null;
  /** bots and host-device seats: true; guest seats: the guest's link is up */
  connected: boolean;
  /** online seat: a guest holds it */
  taken: boolean;
  /** played on this device */
  you: boolean;
  /** played on the host's device (host 'human' seats) */
  onHost: boolean;
  /** online seat: how that guest's link is carried ('direct' WebRTC / 'relay'); guest view: own link for `you` */
  link?: LinkKind | null;
  /** round trip of that link in ms (host view: per guest; guest view: own link), null if unknown */
  rtt?: number | null;
  /** online seat: the guest's page is hidden (minimised) */
  hidden?: boolean;
}

export interface BattleError {
  code: TransportErrorCode | BattleRejectReason | 'closed' | 'protocol';
  message: string;
  fatal: boolean;
}

export type RequestResult = { ok: true; seq: number } | { ok: false; reason: RequestRefusal | string };

/** Result of `BattleHost.act` (the host applied a request itself). */
export type ActResult =
  | { ok: true; actions: AppliedAction[]; fight: FightEvent | null }
  | { ok: false; reason: RequestRefusal | string };

const LOG_MAX = 500;
const REQ_CACHE = 64;
const SAVED_ANSWERS = 16;
const NAME_MAX = 40;

function resolveStorage(s: KVStorage | null | undefined): KVStorage | null {
  return s === undefined ? defaultStorage() : s;
}

// ====================================================================================== host

export interface BattleHostOptions {
  /** match settings; seats typed 'online' are taken by guests, 'human' seats are played on this device */
  settings: MatchSettings;
  /** map seed (random if omitted) */
  seed?: number;
  /** display name of this device's player(s) */
  name?: string;
  /** optional per-seat names (local humans, bots) */
  names?: (string | null)[];
  /** persistence (default localStorage, null disables) */
  storage?: KVStorage | null;
  clientId?: string;
  /** fixed room code (5 chars); random otherwise */
  code?: string;
  /**
   * Custom transport (tests: a LoopbackHub host; e2e: BroadcastBattleHost) or a factory receiving the
   * proposed room code and whether this is a resume. Default: BroadcastChannel with `?transport=bc`,
   * PeerJS (MultiPeerHost) otherwise.
   */
  transport?: MultiHostTransport | ((code: string, resume: boolean) => MultiHostTransport);
  /** PeerJS tuning (broker, ICE, logging) */
  peer?: Omit<PeerTransportOptions, 'clientId'>;
  /** MQTT relay tuning; false disables it */
  relay?: RelayOptions | false;
  /** PeerJS signalling relay tuning; false disables it */
  peerRelay?: NetLinkOptions['peerRelay'];
  /** Nostr relay tuning; false disables it */
  nostr?: NetLinkOptions['nostr'];
  /** multipath tuning */
  mp?: NetLinkOptions['mp'];
  /** 'auto' (all paths), 'direct', 'relay', 'peerrelay', 'nostr', 'mqtt'; default from `?transport=` or 'auto' */
  linkMode?: LinkMode;
  /** heartbeat interval (ms, default 3000, 0 = only manual `heartbeat()` calls) */
  heartbeatMs?: number;
  /**
   * an online seat whose guest has been away this long is skipped automatically on its turn (ms,
   * default 90 s, 0 = never): a lone host who does not notice the "no link" controls is not stuck
   */
  awaySkipMs?: number;
}

export interface BattleResumeOptions {
  transport?: BattleHostOptions['transport'];
  peer?: Omit<PeerTransportOptions, 'clientId'>;
  /** MQTT relay tuning; false disables it */
  relay?: RelayOptions | false;
  /** PeerJS signalling relay tuning; false disables it */
  peerRelay?: NetLinkOptions['peerRelay'];
  /** Nostr relay tuning; false disables it */
  nostr?: NetLinkOptions['nostr'];
  /** multipath tuning */
  mp?: NetLinkOptions['mp'];
  /** 'auto' (all paths), 'direct', 'relay', 'peerrelay', 'nostr', 'mqtt'; default from `?transport=` or 'auto' */
  linkMode?: LinkMode;
  heartbeatMs?: number;
  awaySkipMs?: number;
  /** ignore saves older than this (default 7 days) */
  maxAgeMs?: number;
}

export interface BattleHostEvents {
  status: (s: BattleStatus) => void;
  roster: (r: RosterEntry[]) => void;
  /** `state` was changed by BattleHost (guest request, act(), fillWithBots, turn timer) */
  state: (s: MatchState) => void;
  /** an action BattleHost applied itself (not those passed to publish()); fired before `state` */
  applied: (a: AppliedAction, fight: FightEvent | null) => void;
  /** a guest request was handled (informational) */
  guestRequest: (seat: number, req: BattleRequest, result: { ok: boolean; reason?: string }) => void;
  /** the guests were re-sent the full state */
  resync: (reason: string) => void;
  end: (end: MatchEnd) => void;
  error: (err: BattleError) => void;
}

interface HostSeat {
  name: string | null;
  clientId: string | null;
}

interface SavedHost {
  v: 1;
  code: string;
  clientId: string;
  name: string;
  lobby: MatchSettings;
  seed: number | null;
  seats: HostSeat[];
  replaced: string[];
  room: RoomStatus;
  matchId: string | null;
  state: MatchState | null;
  seq: number;
  log: BActMsg[];
  logBase: number;
  logBaseHash: string;
  /** recent answers per guest (a request re-sent after a host reload must not be applied twice) */
  answers?: [string, BResMsg[]][];
  savedAt: number;
}

export interface SavedBattleInfo {
  role: 'host' | 'guest';
  code: string;
  inMatch: boolean;
  ended: boolean;
  /** in a running match the saved person's own seat is out (conceded or knocked out): only watching */
  out: boolean;
  savedAt: number;
}

/** the seat has no cells left in a match that is still running */
function seatOut(state: MatchState | null | undefined, seat: number): boolean {
  return !!state && !state.ended && seat >= 0 && !E.isAlive(state, seat);
}

export class BattleHost {
  readonly clientId: string;
  readonly name: string;
  code: string;
  status: BattleStatus = 'connecting';
  /** the room is registered on the broker (guests can reach it) */
  ready = false;
  /** authoritative state (null until start). The host UI's controller works on this very object. */
  state: MatchState | null = null;
  matchId: string | null = null;
  /** number of actions applied in the match */
  seq = 0;
  lastError: BattleError | null = null;

  private lobby: MatchSettings;
  private seed: number | null;
  private seats: HostSeat[];
  private replaced = new Set<string>();
  private shadow: MatchState | null = null;
  private log: BActMsg[] = [];
  private logBase = 0;
  private logBaseHash = '';
  private helloed = new Set<string>();
  private reqCache = new Map<string, Map<string, BResMsg>>();
  private divergentAt = -1;
  private transport: MultiHostTransport;
  private storage: KVStorage | null;
  private em = new Emitter<BattleHostEvents>();
  private unsubs: Unsubscribe[] = [];
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private turnTimer: ReturnType<typeof setTimeout> | null = null;
  private turnKey = '';
  private turnStartedAt = 0;
  /** online seats held by a guest whose link is down: since when (local epoch ms) */
  private away = new Map<number, number>();
  private awaySkipMs = 90_000;
  private awayTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  /** guests whose page is hidden */
  private hiddenCids = new Set<string>();
  private ticks = 0;
  /** our own page is hidden */
  private hidden = pageHidden();

  /** Create a battle room in the lobby phase. */
  static create(opts: BattleHostOptions): BattleHost {
    const storage = resolveStorage(opts.storage);
    const clientId = opts.clientId ?? getClientId(storage);
    const n = opts.settings.players.length;
    if (n < 2 || n > 6) throw new Error(`BattleHost: ${n} seats (2..6 supported)`);
    const name = (opts.name ?? '').slice(0, NAME_MAX);
    const seats: HostSeat[] = opts.settings.players.map((p, i) => ({
      name: opts.names?.[i] ?? (p === 'human' ? name : null),
      clientId: null,
    }));
    const code = opts.code ? normalizeCode(opts.code) : generateBattleCode();
    const transport = makeHostTransport(opts.transport, code, false, clientId, netOf(opts), !!opts.code);
    const host = new BattleHost(transport, storage, clientId, name, code, { ...opts.settings, players: [...opts.settings.players] }, opts.seed ?? null, seats);
    host.awaySkipMs = opts.awaySkipMs ?? host.awaySkipMs;
    host.startHeartbeat(opts.heartbeatMs);
    return host;
  }

  /** Resume the room saved in `storage` (host page reload): same code, seats, state and seq. */
  static resume(storage: KVStorage | null = defaultStorage(), opts: BattleResumeOptions = {}): BattleHost | null {
    const saved = readJson<SavedHost>(storage, BATTLE_HOST_KEY);
    if (!saved || saved.v !== 1 || Date.now() - saved.savedAt > (opts.maxAgeMs ?? 7 * 24 * 3600_000)) return null;
    const transport = makeHostTransport(opts.transport, saved.code, true, saved.clientId, netOf(opts));
    const host = new BattleHost(transport, storage, saved.clientId, saved.name, saved.code, saved.lobby, saved.seed, saved.seats, saved);
    host.awaySkipMs = opts.awaySkipMs ?? host.awaySkipMs;
    host.startHeartbeat(opts.heartbeatMs);
    // after a reload nobody is connected yet: the guests count as away from now
    host.trackAway();
    return host;
  }

  /** Summary of a saved room (for a "resume?" prompt), or null. */
  static saved(storage: KVStorage | null = defaultStorage()): SavedBattleInfo | null {
    const s = readJson<SavedHost>(storage, BATTLE_HOST_KEY);
    if (!s || s.v !== 1) return null;
    const seat = s.state ? s.state.settings.players.indexOf('human') : -1;
    return { role: 'host', code: s.code, inMatch: !!s.state, ended: !!s.state?.ended, out: seatOut(s.state, seat), savedAt: s.savedAt };
  }

  static clearSaved(storage: KVStorage | null = defaultStorage()): void {
    try {
      storage?.removeItem(BATTLE_HOST_KEY);
    } catch {
      /* ignore */
    }
  }

  private constructor(
    transport: MultiHostTransport,
    storage: KVStorage | null,
    clientId: string,
    name: string,
    code: string,
    lobby: MatchSettings,
    seed: number | null,
    seats: HostSeat[],
    saved?: SavedHost,
  ) {
    this.transport = transport;
    this.storage = storage;
    this.clientId = clientId;
    this.name = name;
    this.code = code;
    this.lobby = lobby;
    this.seed = seed;
    this.seats = seats.map((s) => ({ ...s }));
    if (saved) {
      this.replaced = new Set(saved.replaced);
      this.matchId = saved.matchId;
      this.seq = saved.seq;
      this.log = saved.log ?? [];
      this.logBase = saved.logBase ?? saved.seq;
      this.logBaseHash = saved.logBaseHash ?? '';
      for (const [cid, list] of saved.answers ?? []) this.reqCache.set(cid, new Map(list.map((r) => [r.id, r])));
      if (saved.state) {
        this.state = saved.state;
        this.shadow = structuredClone(saved.state);
        if (!this.logBaseHash || this.log.length === 0) {
          this.logBase = this.seq;
          this.logBaseHash = battleHash(this.shadow);
          this.log = [];
        }
        this.status = this.state.ended ? 'ended' : 'playing';
      }
    }
    this.unsubs.push(
      transport.onReady((c) => {
        this.code = c;
        this.ready = true;
        if (this.status === 'connecting') this.setStatus('lobby');
        this.persist();
        this.emitRoster();
      }),
      transport.onJoin(() => {
        /* wait for the guest's hello */
      }),
      transport.onLeave((cid) => this.onLeave(cid)),
      transport.onMessage((cid, m) => this.onMessage(cid, m)),
      transport.onError((e) => this.onTransportError(e)),
      onVisibility((h) => this.setPageHidden(h)),
    );
    if (transport.code && transport.code !== this.code) this.code = transport.code;
    this.armTurnTimer();
  }

  // ------------------------------------------------------------------ queries

  /** current seat kinds (lobby settings before start, match settings after) */
  get players(): PlayerType[] {
    return this.state ? this.state.settings.players : this.lobby.players;
  }

  /** settings of the room (lobby) / match */
  get settings(): MatchSettings {
    return this.state ? this.state.settings : this.lobby;
  }

  get roster(): RosterEntry[] {
    return this.wireRoster().map((w) => ({
      ...w,
      you: w.kind === 'human',
      onHost: w.kind === 'human',
      link: w.kind === 'online' ? this.linkOf(w.seat) : null,
      rtt: w.kind === 'online' ? this.rttOf(w.seat) : null,
    }));
  }

  /** Our page was hidden / shown (automatic from the document's visibility; tests call it directly). */
  setPageHidden(hidden: boolean): void {
    if (hidden === this.hidden || this.closed) return;
    this.hidden = hidden;
    for (const cid of this.helloed) this.transport.send(cid, { t: 'bPresence', hidden, seat: -1 });
  }

  /** every online seat is held by a connected guest */
  get canStart(): boolean {
    if (this.status !== 'lobby' || !this.ready || this.closed) return false;
    return this.lobby.players.every((p, i) => p !== 'online' || this.seatConnected(i));
  }

  /** seat of a guest clientId, -1 if none */
  seatOf(clientId: string): number {
    return this.seats.findIndex((s) => s.clientId === clientId);
  }

  /** local epoch ms since which the guest of online seat `seat` has been offline (null: connected / not a held guest seat) */
  awaySince(seat: number): number | null {
    return this.away.get(seat) ?? null;
  }

  /** local epoch ms when an away guest's current turn is skipped automatically (null: not pending) */
  get awaySkipAt(): number | null {
    const st = this.shadow;
    if (!this.awaySkipMs || !st || st.ended || this.status !== 'playing' || this.players[st.current] !== 'online') return null;
    const since = this.away.get(st.current);
    return since === undefined ? null : since + this.awaySkipMs;
  }

  /** local epoch ms when the current online seat's turn times out (null: no timer) */
  get turnDeadline(): number | null {
    const tt = this.settings.turnTime ?? 0;
    if (!tt || !this.state || this.state.ended || this.players[this.state.current] !== 'online') return null;
    return this.turnStartedAt + tt * 1000;
  }

  // ------------------------------------------------------------------ events

  on<K extends keyof BattleHostEvents>(type: K, cb: BattleHostEvents[K]): Unsubscribe {
    return this.em.on(type, cb);
  }
  onStatus(cb: BattleHostEvents['status']) {
    return this.on('status', cb);
  }
  onRoster(cb: BattleHostEvents['roster']) {
    return this.on('roster', cb);
  }
  onState(cb: BattleHostEvents['state']) {
    return this.on('state', cb);
  }
  onApplied(cb: BattleHostEvents['applied']) {
    return this.on('applied', cb);
  }
  onGuestRequest(cb: BattleHostEvents['guestRequest']) {
    return this.on('guestRequest', cb);
  }
  onEnd(cb: BattleHostEvents['end']) {
    return this.on('end', cb);
  }
  onError(cb: BattleHostEvents['error']) {
    return this.on('error', cb);
  }

  // ------------------------------------------------------------------ lobby

  /** Start the match (needs `canStart`). Creates it with the settings and seed and sends it to every guest. */
  start(): boolean {
    if (!this.canStart) return false;
    const seed = this.seed ?? randomSeed();
    const order = shuffledSeatOrder(this.lobby, seed);
    const players = order.map((i) => this.lobby.players[i]);
    this.seats = order.map((i) => this.seats[i]);
    // a scenario room builds the scenario's map with these seats; an ordinary one generates a map
    const st = startMatch({ ...this.lobby, players, shuffle: false }, seed);
    st.settings.shuffle = this.lobby.shuffle;
    this.state = st;
    this.shadow = structuredClone(st);
    this.matchId = randomId(6);
    this.seq = 0;
    this.log = [];
    this.logBase = 0;
    this.logBaseHash = battleHash(this.shadow);
    this.reqCache.clear();
    this.setStatus('playing');
    this.persist();
    const roster = this.wireRoster();
    for (const cid of this.helloed) {
      const seat = this.seatOf(cid);
      this.transport.send(cid, { t: 'bStart', matchId: this.matchId, seat, seq: 0, state: this.shadow, roster });
    }
    this.armTurnTimer();
    this.emitRoster(false);
    this.em.emit('state', st);
    return true;
  }

  /**
   * Turn online seats that have no connected guest into bots of `type` (lobby: before start; in a
   * match: the seat continues as a bot, broadcast as a 'settings' action). `only`: just these seats.
   * Returns the seats changed.
   */
  fillWithBots(type: BotType, only?: number[]): number[] {
    if (this.closed || this.status === 'error') return [];
    const players = this.players;
    const changed: number[] = [];
    players.forEach((p, i) => {
      if (p === 'online' && !this.seatConnected(i) && (!only || only.includes(i))) changed.push(i);
    });
    if (!changed.length) return [];
    for (const i of changed) {
      const cid = this.seats[i].clientId;
      if (cid) {
        this.replaced.add(cid);
        this.helloed.delete(cid);
      }
      this.seats[i] = { name: null, clientId: null };
    }
    if (!this.state) {
      for (const i of changed) this.lobby.players[i] = type;
      this.persist();
      this.emitRoster();
      return changed;
    }
    for (const i of changed) this.state.settings.players[i] = type;
    const a: BattleAction = { t: 'settings', players: [...this.state.settings.players] };
    const applied = this.commit(-1, a);
    if (applied) this.em.emit('applied', applied, null);
    this.emitRoster();
    this.em.emit('state', this.state);
    return changed;
  }

  /** Lobby: free a seat taken by a guest (e.g. someone who left); the guest may take another free seat. */
  releaseSeat(seat: number): boolean {
    if (this.state || !this.seats[seat]?.clientId) return false;
    const cid = this.seats[seat].clientId!;
    this.seats[seat] = { name: null, clientId: null };
    this.helloed.delete(cid);
    this.transport.send(cid, { t: 'bReject', reason: 'full', v: BATTLE_PROTOCOL_VERSION });
    this.transport.kick(cid);
    this.persist();
    this.emitRoster();
    return true;
  }

  // ------------------------------------------------------------------ in match

  /**
   * Report an action the host UI already applied to `state` (its own moves, bot moves). Actions must be
   * published in the order they were applied; a whole bot turn may be applied first and published after.
   * Returns the action with its seq, or null when it did not fit (the guests then get a full sync).
   */
  publish(action: { seat: number; a: BattleAction; seq?: number }): AppliedAction | null {
    if (!this.state || !this.shadow || this.closed) return null;
    const out = this.commit(action.seat, action.a);
    if (!out) {
      this.resyncFromState(`published ${action.a.t} did not apply`);
      return null;
    }
    if (action.a.t === 'endTurn' || this.state.ended) this.checkpoint();
    return out;
  }

  /** publish a fight event returned by engine.attack */
  publishFight(ev: FightEvent): AppliedAction | null {
    return this.publish({ seat: ev.player, a: { t: 'attack', from: ev.from, to: ev.to, win: ev.win } });
  }

  /**
   * Apply a move for `seat` to `state` and broadcast it (used for guest requests; the host UI may use it
   * for its own seats too, and e.g. `act(seat, {t:'endTurn'})` skips a stalled guest's turn).
   */
  act(seat: number, req: BattleRequest): ActResult {
    const st = this.state;
    if (!st || this.status !== 'playing' || st.ended) return { ok: false, reason: 'notPlaying' };
    const done: AppliedAction[] = [];
    let fight: FightEvent | null = null;
    const push = (a: BattleAction) => {
      const x = this.commit(seat, a);
      if (x) done.push(x);
    };
    if (req.t === 'concede') {
      if (!concedeSeat(st, seat)) return { ok: false, reason: 'notAlive' };
      push({ t: 'concede' });
    } else {
      if (st.current !== seat) return { ok: false, reason: 'notYourTurn' };
      switch (req.t) {
        case 'attack': {
          const ev = E.attack(st, req.from, req.to);
          if (typeof ev === 'string') return { ok: false, reason: ev };
          fight = ev;
          push({ t: 'attack', from: req.from, to: req.to, win: ev.win });
          break;
        }
        case 'endAttack':
          if (st.phase !== 'attack') return { ok: false, reason: 'wrongPhase' };
          E.endAttack(st);
          push({ t: 'endAttack' });
          break;
        case 'addPower': {
          if (st.phase !== 'power') return { ok: false, reason: 'wrongPhase' };
          if (st.field.cells[req.cell]?.owner !== seat) return { ok: false, reason: 'notOwn' };
          const added = E.addPower(st, req.cell, req.amount);
          if (!added) return { ok: false, reason: 'noPower' };
          push({ t: 'power', cell: req.cell, amount: added });
          break;
        }
        case 'autoPower':
          if (st.phase !== 'power') return { ok: false, reason: 'wrongPhase' };
          for (const [cell, amount] of E.autoPower(st)) push({ t: 'power', cell, amount });
          break;
        case 'endTurn':
          if (st.phase === 'attack') {
            E.endAttack(st);
            push({ t: 'endAttack' });
          }
          if (st.powerLeft > 0) for (const [cell, amount] of E.autoPower(st)) push({ t: 'power', cell, amount });
          E.finishTurn(st);
          push({ t: 'endTurn' });
          break;
      }
    }
    for (const a of done) this.em.emit('applied', a, a.a.t === 'attack' ? fight : null);
    if (done.length) this.em.emit('state', st);
    this.checkpoint();
    return { ok: true, actions: done, fight };
  }

  /** End the match by a host decision (e.g. the local player accepted an early-finish offer). */
  finish(end: MatchEnd): boolean {
    if (!this.state || !this.shadow || this.shadow.ended) return false;
    if (!this.state.ended) this.state.ended = end;
    return !!this.publish({ seat: -1, a: { t: 'end', end: this.state.ended } });
  }

  /** Compare `state` with what the guests were told; on a difference send everybody the full state. */
  checkpoint(): boolean {
    if (!this.state || !this.shadow) return true;
    if (battleHash(this.state) === battleHash(this.shadow)) return true;
    this.resyncFromState('state changed without publish');
    return false;
  }

  /** Send everybody the full state now. */
  sync(): void {
    if (this.state) this.resyncFromState('manual');
  }

  /**
   * Heartbeat (automatic every `heartbeatMs`): tells every guest the current seq + hash so lost
   * messages are noticed, and re-syncs if `state` stayed different from the published stream.
   */
  heartbeat(): void {
    if (this.closed) return;
    if (this.state && this.shadow) {
      const diverged = battleHash(this.state) !== battleHash(this.shadow);
      if (diverged && this.divergentAt === this.seq) this.resyncFromState('state diverged from published actions');
      this.divergentAt = diverged ? this.seq : -1;
    }
    const h = this.shadow ? battleHash(this.shadow) : '';
    // also to links that have not said hello yet: a guest whose hello got lost says it again;
    // a guest on a relay gets every third tick only (each one is a message on a public service)
    const tick = ++this.ticks;
    for (const cid of new Set([...this.helloed, ...this.transport.clients])) {
      if (this.transport.linkOf?.(cid) === 'relay' && tick % 3 !== 0) continue;
      this.transport.send(cid, { t: 'bTick', matchId: this.matchId, seq: this.seq, h });
    }
  }

  /** Close the connection, keep the saved room (it can be resumed). */
  dispose(): void {
    if (this.closed) return;
    this.persist();
    this.shutdown(true);
  }

  /** Close the room for good: tell the guests, forget the saved room. */
  close(): void {
    if (this.closed) return;
    for (const cid of this.helloed) this.transport.send(cid, { t: 'bClosed' });
    this.shutdown(false);
    BattleHost.clearSaved(this.storage);
  }

  private shutdown(keepRoom: boolean) {
    this.closed = true;
    if (this.hbTimer) clearInterval(this.hbTimer);
    if (this.turnTimer) clearTimeout(this.turnTimer);
    if (this.awayTimer) clearTimeout(this.awayTimer);
    this.hbTimer = this.turnTimer = this.awayTimer = null;
    for (const u of this.unsubs) u();
    this.unsubs = [];
    // let queued messages (bClosed) leave before the links go down; keepRoom: the relay presence
    // stays so the room can be resumed
    const t = this.transport as MultiHostTransport & { detach?: () => void };
    queueMicrotask(() => (keepRoom && t.detach ? t.detach() : t.close()));
    this.em.clear();
  }

  /** round trip to the guest in `seat` in ms, null if offline / unknown */
  rttOf(seat: number): number | null {
    const cid = this.seats[seat]?.clientId;
    const t = this.transport as MultiHostTransport & { rttOf?: (cid: string) => number | null };
    return cid && this.seatConnected(seat) && t.rttOf ? t.rttOf(cid) : null;
  }

  /** link kind of the guest in `seat` ('direct' / 'relay'), null if offline or not a guest seat */
  linkOf(seat: number): LinkKind | null {
    const cid = this.seats[seat]?.clientId;
    return cid && this.seatConnected(seat) ? (this.transport.linkOf?.(cid) ?? null) : null;
  }

  // ------------------------------------------------------------------ internals

  private startHeartbeat(ms = 3000) {
    if (ms > 0) this.hbTimer = setInterval(() => this.heartbeat(), ms);
  }

  private seatConnected(i: number): boolean {
    const cid = this.seats[i]?.clientId;
    return !!cid && this.helloed.has(cid) && this.transport.isOpen(cid);
  }

  private wireRoster(): WireSeat[] {
    return this.players.map((kind, seat) => {
      const cid = this.seats[seat]?.clientId;
      return {
        seat,
        kind,
        name: this.seats[seat]?.name ?? null,
        connected: kind === 'online' ? this.seatConnected(seat) : true,
        taken: kind === 'online' ? !!cid : false,
        hidden: kind === 'online' && !!cid && this.hiddenCids.has(cid),
      };
    });
  }

  /** note when held guest seats went offline / came back, and (re)arm the automatic skip */
  private trackAway() {
    const now = Date.now();
    this.players.forEach((p, i) => {
      const held = p === 'online' && !!this.seats[i]?.clientId;
      if (!held || this.seatConnected(i)) this.away.delete(i);
      else if (!this.away.has(i)) this.away.set(i, now);
    });
    for (const i of [...this.away.keys()]) if (i >= this.players.length) this.away.delete(i);
    this.armAwayTimer();
  }

  private armAwayTimer() {
    if (this.awayTimer) clearTimeout(this.awayTimer);
    this.awayTimer = null;
    const at = this.awaySkipAt;
    if (at === null || this.closed) return;
    const seat = this.shadow!.current;
    const key = this.turnKey;
    this.awayTimer = setTimeout(() => {
      this.awayTimer = null;
      if (this.closed || this.turnKey !== key || this.awaySkipAt === null || this.awaySkipAt > Date.now()) return this.armAwayTimer();
      this.act(seat, { t: 'endTurn' });
    }, Math.max(0, at - Date.now()));
  }

  private emitRoster(broadcast = true) {
    this.trackAway();
    if (broadcast) {
      const msg = { t: 'bRoster', roster: this.wireRoster(), players: [...this.players] };
      for (const cid of this.helloed) this.transport.send(cid, msg);
    }
    this.em.emit('roster', this.roster);
  }

  private setStatus(s: BattleStatus) {
    if (this.status === s) return;
    this.status = s;
    this.em.emit('status', s);
  }

  private onTransportError(e: TransportError) {
    this.lastError = e;
    this.em.emit('error', e);
    if (e.fatal && !this.closed) {
      this.setStatus('error');
    }
  }

  private onLeave(cid: string) {
    if (!this.helloed.delete(cid)) return;
    this.emitRoster();
  }

  private onMessage(cid: string, raw: unknown) {
    if (this.closed) return;
    const m = parseBattleMessage(raw);
    if (!m) return;
    if (m.t === 'bHello') return this.onHello(cid, m);
    if (!this.helloed.has(cid)) return;
    switch (m.t) {
      case 'bReq':
        return this.onRequest(cid, m.id, m.r);
      case 'bSyncReq':
        if (!this.state) return;
        if (!m.full && m.matchId === this.matchId && m.seq >= this.logBase && m.seq <= this.seq) this.resend(cid, m.seq);
        else this.sendSync(cid);
        return;
      case 'bBye':
        this.helloed.delete(cid);
        if (!this.state) {
          const seat = this.seatOf(cid);
          if (seat >= 0) this.seats[seat] = { name: null, clientId: null };
          this.persist();
        }
        this.emitRoster();
        return;
      case 'bPing':
        this.transport.send(cid, { t: 'bPong', ts: m.ts });
        return;
      case 'bPresence':
        if (m.hidden === this.hiddenCids.has(cid)) return;
        if (m.hidden) this.hiddenCids.add(cid);
        else this.hiddenCids.delete(cid);
        this.emitRoster();
        return;
      default:
        return;
    }
  }

  private reject(cid: string, reason: BattleRejectReason) {
    this.transport.send(cid, { t: 'bReject', reason, v: BATTLE_PROTOCOL_VERSION });
  }

  private onHello(cid: string, m: BHelloMsg) {
    if (m.v !== BATTLE_PROTOCOL_VERSION) return this.reject(cid, 'version');
    const players = this.players;
    let seat = this.seatOf(cid);
    if (seat < 0) {
      if (this.replaced.has(cid)) return this.reject(cid, 'replaced');
      seat = players.findIndex((p, i) => p === 'online' && !this.seats[i].clientId);
      if (seat < 0) return this.reject(cid, this.state ? 'started' : 'full');
    }
    this.seats[seat] = { clientId: cid, name: m.name.slice(0, NAME_MAX) || this.seats[seat].name };
    this.helloed.add(cid);
    // a fresh hello: the guest is here (it says so again if its page is hidden)
    this.hiddenCids.delete(cid);
    this.transport.send(cid, {
      t: 'bWelcome',
      v: BATTLE_PROTOCOL_VERSION,
      seat,
      status: this.state ? (this.state.ended ? 'ended' : 'playing') : 'lobby',
      settings: this.settings,
      roster: this.wireRoster(),
      matchId: this.matchId,
    });
    if (this.hidden) this.transport.send(cid, { t: 'bPresence', hidden: true, seat: -1 });
    if (this.state) this.catchUp(cid, m);
    this.persist();
    this.emitRoster();
  }

  private catchUp(cid: string, m: BHelloMsg) {
    if (m.matchId === this.matchId && m.seq >= this.logBase && m.seq <= this.seq) {
      const expected = m.seq === this.logBase ? this.logBaseHash : this.log[m.seq - this.logBase - 1]?.h;
      if (expected === m.hash) return this.resend(cid, m.seq);
    }
    this.sendSync(cid);
  }

  private resend(cid: string, fromSeq: number) {
    for (const msg of this.log.slice(fromSeq - this.logBase)) this.transport.send(cid, msg);
  }

  private sendSync(cid: string) {
    if (!this.shadow || !this.matchId) return;
    this.transport.send(cid, {
      t: 'bSync',
      matchId: this.matchId,
      seat: this.seatOf(cid),
      seq: this.seq,
      state: this.shadow,
      roster: this.wireRoster(),
    });
  }

  private onRequest(cid: string, id: string, r: BattleRequest) {
    let cache = this.reqCache.get(cid);
    const cached = cache?.get(id);
    if (cached) {
      this.transport.send(cid, cached);
      return;
    }
    const seat = this.seatOf(cid);
    const res = seat < 0 || this.players[seat] !== 'online' ? ({ ok: false, reason: 'notYourSeat' } as const) : this.act(seat, r);
    const msg: BResMsg = res.ok ? { t: 'bRes', id, ok: true, seq: this.seq } : { t: 'bRes', id, ok: false, reason: res.reason, seq: this.seq };
    if (!cache) this.reqCache.set(cid, (cache = new Map()));
    cache.set(id, msg);
    if (cache.size > REQ_CACHE) cache.delete(cache.keys().next().value!);
    this.persist();
    this.transport.send(cid, msg);
    this.em.emit('guestRequest', seat, r, res.ok ? { ok: true } : { ok: false, reason: res.reason });
  }

  /** apply to the shadow, number, log, broadcast, persist */
  private commit(seat: number, a: BattleAction): AppliedAction | null {
    const sh = this.shadow;
    if (!sh || !this.matchId) return null;
    const r = applyBattleAction(sh, seat, a);
    if (!r.ok) return null;
    this.seq++;
    const msg: BActMsg = { t: 'bAct', matchId: this.matchId, seq: this.seq, seat, a, h: battleHash(sh) };
    this.log.push(msg);
    if (this.log.length > LOG_MAX) {
      const drop = this.log.length - LOG_MAX;
      this.logBaseHash = this.log[drop - 1].h;
      this.log.splice(0, drop);
      this.logBase += drop;
    }
    for (const cid of this.helloed) this.transport.send(cid, msg);
    this.persist();
    this.afterProgress();
    return { seq: msg.seq, seat, a };
  }

  private afterProgress() {
    const sh = this.shadow;
    if (sh?.ended && this.status !== 'ended') {
      if (this.turnTimer) clearTimeout(this.turnTimer);
      if (this.awayTimer) clearTimeout(this.awayTimer);
      this.turnTimer = this.awayTimer = null;
      this.setStatus('ended');
      this.em.emit('end', { ...(this.state?.ended ?? sh.ended) });
      return;
    }
    if (sh && !sh.ended && this.status === 'ended') this.setStatus('playing');
    const key = this.turnKey;
    this.armTurnTimer();
    if (key !== this.turnKey) this.armAwayTimer();
  }

  private resyncFromState(reason: string) {
    const st = this.state;
    if (!st || !this.matchId) return;
    this.shadow = structuredClone(st);
    this.log = [];
    this.logBase = this.seq;
    this.logBaseHash = battleHash(this.shadow);
    this.divergentAt = -1;
    this.em.emit('resync', reason);
    for (const cid of this.helloed) this.sendSync(cid);
    this.persist();
    this.afterProgress();
  }

  private armTurnTimer() {
    const st = this.shadow;
    const key = st && !st.ended ? `${st.turn}:${st.current}` : '';
    if (key === this.turnKey) return;
    this.turnKey = key;
    this.turnStartedAt = Date.now();
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = null;
    const deadline = this.turnDeadline;
    if (deadline === null || this.closed) return;
    const seat = st!.current;
    this.turnTimer = setTimeout(() => {
      this.turnTimer = null;
      if (this.turnKey === key && this.state?.current === seat) this.act(seat, { t: 'endTurn' });
    }, Math.max(0, deadline - Date.now()));
  }

  private persist() {
    if (this.closed || !this.storage) return;
    let state: MatchState | null = null;
    if (this.shadow) {
      state = structuredClone(this.shadow);
      if (this.state) {
        state.rng = this.state.rng;
        state.luck = [...this.state.luck];
        state.chronicle = { ...this.state.chronicle };
      }
    }
    const saved: SavedHost = {
      v: 1,
      code: this.code,
      clientId: this.clientId,
      name: this.name,
      lobby: this.lobby,
      seed: this.seed,
      seats: this.seats,
      replaced: [...this.replaced],
      room: this.state ? (this.state.ended ? 'ended' : 'playing') : 'lobby',
      matchId: this.matchId,
      state,
      seq: this.seq,
      log: this.log,
      logBase: this.logBase,
      logBaseHash: this.logBaseHash,
      answers: [...this.reqCache].map(([cid, m]) => [cid, [...m.values()].slice(-SAVED_ANSWERS)]),
      savedAt: Date.now(),
    };
    writeJson(this.storage, BATTLE_HOST_KEY, saved);
  }
}

function makeHostTransport(
  t: BattleHostOptions['transport'],
  code: string,
  resume: boolean,
  clientId: string,
  net: NetLinkOptions,
  fixed = resume,
): MultiHostTransport {
  if (typeof t === 'function') return t(code, resume);
  if (t) return t;
  if (useBroadcastTransport()) return BroadcastBattleHost.create(clientId, code);
  return createBattleHostTransport({ ...net, clientId, code, fixed });
}

function netOf(o: {
  peer?: NetLinkOptions['peer'];
  relay?: RelayOptions | false;
  peerRelay?: NetLinkOptions['peerRelay'];
  nostr?: NetLinkOptions['nostr'];
  mp?: NetLinkOptions['mp'];
  linkMode?: LinkMode;
}): NetLinkOptions {
  return { peer: o.peer, relay: o.relay, peerRelay: o.peerRelay, nostr: o.nostr, mp: o.mp, mode: o.linkMode };
}

// ====================================================================================== guest

export interface BattleGuestOptions {
  name?: string;
  storage?: KVStorage | null;
  clientId?: string;
  /** custom transport (tests / e2e) or a factory receiving the room code. Default: BC with `?transport=bc`, PeerJS otherwise */
  transport?: Transport | ((code: string) => Transport);
  peer?: Omit<PeerTransportOptions, 'clientId'>;
  /** MQTT relay tuning; false disables it */
  relay?: RelayOptions | false;
  /** PeerJS signalling relay tuning; false disables it */
  peerRelay?: NetLinkOptions['peerRelay'];
  /** Nostr relay tuning; false disables it */
  nostr?: NetLinkOptions['nostr'];
  /** multipath tuning */
  mp?: NetLinkOptions['mp'];
  /** 'auto' (all paths), 'direct', 'relay', 'peerrelay', 'nostr', 'mqtt'; default from `?transport=` or 'auto' */
  linkMode?: LinkMode;
  /** ignore a saved session for the same room code */
  fresh?: boolean;
  /** a request without an answer resolves as { ok: false, reason: 'timeout' } after this long (default 20 s) */
  requestTimeoutMs?: number;
  /** re-send the hello this often until the host answers (default 4 s, 0 = only on host heartbeats) */
  helloRetryMs?: number;
  /** no longer used (all paths start together) */
  fallbackMs?: number;
  /**
   * the host counts as unreachable after this long without any message from it (ms, default 10 s; the
   * host's heartbeat comes every 3 s; 0 = rely on the link's close only): a host page that vanished
   * without closing its link (no bye) is noticed too
   */
  silenceMs?: number;
}

export interface BattleGuestEvents {
  status: (s: BattleStatus) => void;
  roster: (r: RosterEntry[]) => void;
  /** transport link up / down, or the host fell silent / was heard again (see `online`) */
  connection: (connected: boolean) => void;
  /** an action from the host was applied to `state` (animate it); fired before `state` */
  applied: (a: AppliedAction, fight: FightEvent | null) => void;
  /** state changed (applied action, start, sync — a sync replaces the object) */
  state: (s: MatchState) => void;
  /** the local state was replaced by the host's full state */
  resync: (reason: string) => void;
  end: (end: MatchEnd) => void;
  error: (err: BattleError) => void;
  /** the host's page was hidden (minimised) / shown again */
  presence: (hostHidden: boolean) => void;
}

interface SavedGuest {
  v: 1;
  code: string;
  clientId: string;
  name: string;
  seat: number;
  matchId: string | null;
  state: MatchState | null;
  seq: number;
  roster: WireSeat[];
  settings: MatchSettings | null;
  /** a concede asked for while offline, still to be delivered */
  concede?: boolean;
  savedAt: number;
}

interface PendingReq {
  id: string;
  req: BattleRequest;
  ticks: number;
  resolve: (r: RequestResult) => void;
  /** more callers waiting for the same (concede) request */
  also?: ((r: RequestResult) => void)[];
  timer: ReturnType<typeof setTimeout> | null;
}

function settle(p: PendingReq, r: RequestResult) {
  if (p.timer) clearTimeout(p.timer);
  p.resolve(r);
  for (const f of p.also ?? []) f(r);
}

export class BattleGuest {
  readonly clientId: string;
  readonly name: string;
  readonly code: string;
  status: BattleStatus = 'connecting';
  connected = false;
  /** own seat (-1 until the host assigned one) */
  seat = -1;
  /** local copy: own seat 'human', other persons 'remote', bots unchanged */
  state: MatchState | null = null;
  /** room settings from the host (lobby), localised */
  settings: MatchSettings | null = null;
  matchId: string | null = null;
  seq = 0;
  lastError: BattleError | null = null;
  /** the host's page is hidden (minimised): nothing moves until it comes back */
  hostHidden = false;

  private wire: WireSeat[] = [];
  /** our own page is hidden */
  private hidden = pageHidden();
  private transport: Transport;
  private storage: KVStorage | null;
  private em = new Emitter<BattleGuestEvents>();
  private unsubs: Unsubscribe[] = [];
  private welcomed = false;
  private syncAsked = false;
  private pending = new Map<string, PendingReq>();
  private reqTag = randomId(3);
  private reqN = 0;
  private timeoutMs: number;
  private helloRetryMs: number;
  private helloTimer: ReturnType<typeof setInterval> | null = null;
  private endNotified = '';
  private silenceMs = 10_000;
  private lastHeard = 0;
  private silent = false;
  private silenceTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  /** Join battle room `code` (5 chars, case-insensitive). Resumes a saved session for the same code unless `fresh`. */
  static join(code: string, opts: BattleGuestOptions = {}): BattleGuest {
    const storage = resolveStorage(opts.storage);
    const c = normalizeCode(code);
    const saved = opts.fresh ? null : readJson<SavedGuest>(storage, BATTLE_GUEST_KEY);
    const resume = saved && saved.v === 1 && saved.code === c ? saved : null;
    const clientId = opts.clientId ?? resume?.clientId ?? getClientId(storage);
    let transport: Transport;
    if (typeof opts.transport === 'function') transport = opts.transport(c);
    else if (opts.transport) transport = opts.transport;
    else if (useBroadcastTransport()) transport = BroadcastBattleGuest.join(c, clientId);
    else transport = createBattleGuestTransport(c, { ...netOf(opts), clientId });
    const g = new BattleGuest(transport, storage, clientId, (opts.name ?? resume?.name ?? '').slice(0, NAME_MAX), c, opts.requestTimeoutMs ?? 20_000, opts.helloRetryMs ?? 4000, resume);
    if (!isValidBattleCode(c)) queueMicrotask(() => g.fail({ code: 'bad-code', message: `Invalid room code "${code}"`, fatal: true }));
    g.silenceMs = opts.silenceMs ?? g.silenceMs;
    return g;
  }

  /** Resume the battle saved in `storage` (guest page reload). */
  static resume(storage: KVStorage | null = defaultStorage(), opts: Omit<BattleGuestOptions, 'storage' | 'fresh'> & { maxAgeMs?: number } = {}): BattleGuest | null {
    const s = readJson<SavedGuest>(storage, BATTLE_GUEST_KEY);
    if (!s || s.v !== 1 || Date.now() - s.savedAt > (opts.maxAgeMs ?? 7 * 24 * 3600_000)) return null;
    return BattleGuest.join(s.code, { ...opts, storage, clientId: opts.clientId ?? s.clientId });
  }

  static saved(storage: KVStorage | null = defaultStorage()): SavedBattleInfo | null {
    const s = readJson<SavedGuest>(storage, BATTLE_GUEST_KEY);
    if (!s || s.v !== 1) return null;
    return { role: 'guest', code: s.code, inMatch: !!s.state, ended: !!s.state?.ended, out: seatOut(s.state, s.seat), savedAt: s.savedAt };
  }

  static clearSaved(storage: KVStorage | null = defaultStorage()): void {
    try {
      storage?.removeItem(BATTLE_GUEST_KEY);
    } catch {
      /* ignore */
    }
  }

  private constructor(
    transport: Transport,
    storage: KVStorage | null,
    clientId: string,
    name: string,
    code: string,
    timeoutMs: number,
    helloRetryMs: number,
    saved: SavedGuest | null,
  ) {
    this.transport = transport;
    this.storage = storage;
    this.clientId = clientId;
    this.name = name;
    this.code = code;
    this.timeoutMs = timeoutMs;
    this.helloRetryMs = helloRetryMs;
    if (saved) {
      this.seat = saved.seat;
      this.matchId = saved.matchId;
      this.state = saved.state;
      this.seq = saved.seq;
      this.wire = saved.roster ?? [];
      this.settings = saved.settings;
      if (this.state) {
        this.status = this.state.ended ? 'ended' : 'playing';
        if (this.state.ended) this.endNotified = this.endKey();
        else if (saved.concede) this.queue({ t: 'concede' }, () => {});
      }
    }
    this.unsubs.push(
      transport.onOpen(() => this.onOpen()),
      transport.onClose(() => this.onClose()),
      transport.onMessage((m) => this.onMessage(m)),
      transport.onError((e) => {
        if (e.fatal) this.fail(e);
        else {
          this.lastError = e;
          this.em.emit('error', e);
        }
      }),
      onVisibility((h) => this.setPageHidden(h)),
    );
    if (transport.isOpen) queueMicrotask(() => this.onOpen());
  }

  // ------------------------------------------------------------------ queries

  get roster(): RosterEntry[] {
    return this.wire.map((w) => ({
      seat: w.seat,
      kind: w.seat === this.seat ? 'human' : E.isPersonType(w.kind) ? 'remote' : w.kind,
      name: w.name,
      connected: w.connected,
      taken: w.taken,
      you: w.seat === this.seat,
      onHost: w.kind === 'human',
      link: w.seat === this.seat ? this.link : null,
      rtt: w.seat === this.seat ? this.linkRtt : null,
      hidden: !!w.hidden,
    }));
  }

  /** round trip to the host in ms (the path in use), null when unknown */
  get linkRtt(): number | null {
    return this.connected ? (this.transport.linkRtt ?? null) : null;
  }

  /** Our page was hidden / shown (automatic from the document's visibility; tests call it directly). */
  setPageHidden(hidden: boolean): void {
    if (hidden === this.hidden || this.closed) return;
    this.hidden = hidden;
    if (this.connected && this.welcomed) this.transport.send({ t: 'bPresence', hidden, seat: this.seat });
  }

  /** the host is reachable: the link is up and the host has not fallen silent */
  get online(): boolean {
    return this.connected && !this.silent;
  }

  /** how the link to the host is carried right now ('direct' WebRTC or 'relay'), null when offline */
  get link(): LinkKind | null {
    return this.connected ? (this.transport.linkKind ?? null) : null;
  }

  get isMyTurn(): boolean {
    return !!this.state && !this.state.ended && this.seat >= 0 && this.state.current === this.seat;
  }

  /** requests for the own seat can be sent right now */
  get canAct(): boolean {
    return this.isMyTurn && this.status === 'playing' && this.connected && this.welcomed;
  }

  /** requests sent but not answered yet */
  get pendingRequests(): number {
    return this.pending.size;
  }

  /** a concede is waiting for the host (asked for while offline, or not answered yet) */
  get concedePending(): boolean {
    for (const p of this.pending.values()) if (p.req.t === 'concede') return true;
    return false;
  }

  // ------------------------------------------------------------------ events

  on<K extends keyof BattleGuestEvents>(type: K, cb: BattleGuestEvents[K]): Unsubscribe {
    return this.em.on(type, cb);
  }
  onStatus(cb: BattleGuestEvents['status']) {
    return this.on('status', cb);
  }
  onRoster(cb: BattleGuestEvents['roster']) {
    return this.on('roster', cb);
  }
  onApplied(cb: BattleGuestEvents['applied']) {
    return this.on('applied', cb);
  }
  onState(cb: BattleGuestEvents['state']) {
    return this.on('state', cb);
  }
  onEnd(cb: BattleGuestEvents['end']) {
    return this.on('end', cb);
  }
  onError(cb: BattleGuestEvents['error']) {
    return this.on('error', cb);
  }

  // ------------------------------------------------------------------ actions

  /**
   * Ask the host to perform a move of the own seat. Resolves when the host answered (the applied
   * actions arrive via `onApplied` / `onState`, usually just before). Obviously impossible requests
   * (not our turn, illegal attack, offline) resolve immediately with ok: false.
   */
  request(req: BattleRequest): Promise<RequestResult> {
    const st = this.state;
    const no = (reason: RequestRefusal | string) => Promise.resolve<RequestResult>({ ok: false, reason });
    if (this.closed) return no('closed');
    if (!st || this.status !== 'playing' || st.ended) return no('notPlaying');
    if (req.t === 'concede') {
      // a concede is never lost: offline it waits for the link (and survives a reload), and it does
      // not time out — the host answers it when it gets it
      for (const p of this.pending.values()) if (p.req.t === 'concede') return new Promise((r) => (p.also ??= []).push(r));
      return new Promise<RequestResult>((resolve) => {
        const p = this.queue(req, resolve);
        if (this.connected && this.welcomed) this.transport.send({ t: 'bReq', id: p.id, r: req });
        this.persist();
        this.em.emit('state', st);
      });
    }
    if (!this.connected || !this.welcomed) return no('offline');
    if (st.current !== this.seat) return no('notYourTurn');
    if (req.t === 'attack') {
      const r = E.checkAttack(st, req.from, req.to);
      if (r) return no(r);
    } else if (req.t === 'addPower' || req.t === 'autoPower') {
      if (st.phase !== 'power') return no('wrongPhase');
      if (req.t === 'addPower' && st.field.cells[req.cell]?.owner !== this.seat) return no('notOwn');
    } else if (req.t === 'endAttack' && st.phase !== 'attack') return no('wrongPhase');
    return new Promise<RequestResult>((resolve) => {
      const p = this.queue(req, resolve);
      if (this.timeoutMs > 0)
        p.timer = setTimeout(() => {
          if (this.pending.delete(p.id)) resolve({ ok: false, reason: 'timeout' });
        }, this.timeoutMs);
      this.transport.send({ t: 'bReq', id: p.id, r: req });
    });
  }

  private queue(req: BattleRequest, resolve: (r: RequestResult) => void): PendingReq {
    const id = `${this.reqTag}-${++this.reqN}`;
    const p: PendingReq = { id, req, ticks: 0, resolve, timer: null };
    this.pending.set(id, p);
    return p;
  }

  /** Ask the host for the full state. */
  requestSync(reason = 'manual'): void {
    this.askSync(true, reason, true);
  }

  /** Close the connection, keep the saved session. */
  dispose(): void {
    if (this.closed) return;
    this.persist();
    this.shutdown('closed');
  }

  /** Leave the room for good (frees the lobby seat; in a match concede first if wanted). */
  leave(): void {
    if (this.closed) return;
    this.transport.send({ t: 'bBye' });
    this.shutdown('closed');
    BattleGuest.clearSaved(this.storage);
  }

  private shutdown(reason: string) {
    this.closed = true;
    if (this.helloTimer) clearInterval(this.helloTimer);
    if (this.silenceTimer) clearInterval(this.silenceTimer);
    this.helloTimer = this.silenceTimer = null;
    for (const p of this.pending.values()) settle(p, { ok: false, reason });
    this.pending.clear();
    for (const u of this.unsubs) u();
    this.unsubs = [];
    const t = this.transport;
    queueMicrotask(() => t.close());
    this.connected = false;
    this.em.clear();
  }

  // ------------------------------------------------------------------ transport

  private onOpen() {
    if (this.closed || this.status === 'error') return;
    this.connected = true;
    this.welcomed = false;
    this.syncAsked = false;
    this.silent = false;
    this.lastHeard = Date.now();
    this.watchSilence();
    this.em.emit('connection', true);
    this.sendHello();
    // the hello (or the welcome) may get lost: say it again until welcomed
    if (this.helloTimer) clearInterval(this.helloTimer);
    if (this.helloRetryMs > 0)
      this.helloTimer = setInterval(() => {
        if (this.closed || this.welcomed || !this.connected) {
          if (this.helloTimer) clearInterval(this.helloTimer);
          this.helloTimer = null;
        } else this.sendHello();
      }, this.helloRetryMs);
  }

  private sendHello() {
    this.transport.send({
      t: 'bHello',
      v: BATTLE_PROTOCOL_VERSION,
      clientId: this.clientId,
      name: this.name,
      matchId: this.matchId,
      seq: this.seq,
      hash: this.state ? battleHash(this.state) : '',
    });
  }

  /** a host that stops talking (its page vanished without a bye) counts as offline until heard again */
  private watchSilence() {
    if (this.silenceTimer || !this.silenceMs || this.closed) return;
    this.silenceTimer = setInterval(() => {
      if (this.closed || this.status === 'error') {
        if (this.silenceTimer) clearInterval(this.silenceTimer);
        this.silenceTimer = null;
        return;
      }
      // the host ticks 3× less often over a relay
      const limit = this.link === 'relay' ? this.silenceMs * 3 : this.silenceMs;
      if (!this.connected || this.silent || Date.now() - this.lastHeard <= limit) return;
      this.silent = true;
      this.em.emit('connection', false);
    }, Math.min(1000, this.silenceMs));
  }

  private onClose() {
    if (this.closed) return;
    this.connected = false;
    this.welcomed = false;
    this.em.emit('connection', false);
  }

  private fail(err: BattleError) {
    if (this.closed || this.status === 'error') return;
    this.lastError = err;
    if (this.helloTimer) clearInterval(this.helloTimer);
    this.helloTimer = null;
    if (this.silenceTimer) clearInterval(this.silenceTimer);
    this.silenceTimer = null;
    this.setStatus('error');
    this.em.emit('error', err);
    for (const p of this.pending.values()) settle(p, { ok: false, reason: 'closed' });
    this.pending.clear();
    this.connected = false;
    this.transport.close();
  }

  private onMessage(raw: unknown) {
    if (this.closed || this.status === 'error') return;
    const m = parseBattleMessage(raw);
    if (!m) return;
    this.lastHeard = Date.now();
    if (this.silent) {
      this.silent = false;
      this.em.emit('connection', true);
    }
    this.handle(m);
  }

  private handle(m: BattleMessage) {
    switch (m.t) {
      case 'bWelcome': {
        this.welcomed = true;
        this.seat = m.seat;
        this.wire = m.roster;
        this.settings = { ...m.settings, players: localizePlayers(m.settings.players, m.seat) };
        if (m.status === 'lobby') {
          if (!this.state || this.matchId !== m.matchId) this.setStatus('lobby');
        } else if (this.state && this.matchId === m.matchId) {
          this.setStatus(this.state.ended ? 'ended' : 'playing');
        }
        // re-send unanswered requests (the host answers duplicates from its cache)
        for (const p of this.pending.values()) this.transport.send({ t: 'bReq', id: p.id, r: p.req });
        // a fresh welcome: the host is here (it says so again if its page is hidden)
        if (this.hostHidden) {
          this.hostHidden = false;
          this.em.emit('presence', false);
        }
        if (this.hidden) this.transport.send({ t: 'bPresence', hidden: true, seat: this.seat });
        this.persist();
        this.em.emit('roster', this.roster);
        return;
      }
      case 'bPresence':
        if (m.seat === -1 && m.hidden !== this.hostHidden) {
          this.hostHidden = m.hidden;
          this.em.emit('presence', m.hidden);
        }
        return;
      case 'bRoster':
        this.wire = m.roster;
        if (this.settings) this.settings = { ...this.settings, players: localizePlayers(m.players, this.seat) };
        this.persist();
        this.em.emit('roster', this.roster);
        return;
      case 'bStart':
        this.wire = m.roster;
        this.adopt(m.matchId, m.state, m.seq, m.seat, null);
        this.em.emit('roster', this.roster);
        return;
      case 'bSync':
        this.wire = m.roster;
        this.adopt(m.matchId, m.state, m.seq, m.seat, 'host sync');
        this.em.emit('roster', this.roster);
        return;
      case 'bAct':
        return this.onAct(m);
      case 'bTick':
        if (!this.welcomed) return this.sendHello();
        return this.onTick(m.matchId, m.seq, m.h);
      case 'bRes': {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        settle(p, m.ok ? { ok: true, seq: m.seq ?? this.seq } : { ok: false, reason: m.reason ?? 'bad' });
        if (p.req.t === 'concede') {
          this.persist();
          if (this.state) this.em.emit('state', this.state);
        }
        return;
      }
      case 'bReject':
        if (m.reason === 'replaced' || m.reason === 'full' || m.reason === 'started') BattleGuest.clearSaved(this.storage);
        this.fail({ code: m.reason, message: rejectText(m.reason), fatal: true });
        return;
      case 'bClosed': {
        const ended = !!this.state?.ended;
        BattleGuest.clearSaved(this.storage);
        if (ended) {
          this.setStatus('ended');
          this.shutdown('closed');
        } else this.fail({ code: 'closed', message: 'The host closed the room', fatal: true });
        return;
      }
      default:
        return;
    }
  }

  private adopt(matchId: string, remote: MatchState, seq: number, seat: number, resyncReason: string | null) {
    const prev = this.state;
    const st = localizeBattleState(remote, seat);
    if (prev && this.matchId === matchId) st.chronicle = prev.chronicle;
    if (this.matchId !== matchId) this.endNotified = '';
    this.state = st;
    this.matchId = matchId;
    this.seq = seq;
    this.seat = seat;
    this.syncAsked = false;
    if (resyncReason) this.em.emit('resync', resyncReason);
    this.setStatus(st.ended ? 'ended' : 'playing');
    this.persist();
    this.em.emit('state', st);
    this.notifyEnd();
  }

  private askSync(full: boolean, reason: string, force = false) {
    if (this.syncAsked && !force) return;
    this.syncAsked = true;
    if (full) this.em.emit('resync', reason);
    this.transport.send({ t: 'bSyncReq', matchId: this.matchId, seq: this.seq, full, reason });
  }

  private onAct(m: BActMsg) {
    const st = this.state;
    if (!st || m.matchId !== this.matchId) return this.askSync(true, 'action for an unknown match');
    if (m.seq <= this.seq) return;
    if (m.seq > this.seq + 1) return this.askSync(false, `gap: got ${m.seq}, expected ${this.seq + 1}`);
    const r = applyBattleAction(st, m.seat, m.a, this.seat);
    if (!r.ok) return this.askSync(true, r.reason, true);
    this.seq = m.seq;
    this.syncAsked = false;
    if (battleHash(st) !== m.h) this.askSync(true, `hash mismatch at seq ${m.seq}`, true);
    this.persist();
    this.em.emit('applied', { seq: m.seq, seat: m.seat, a: m.a }, r.fight ?? null);
    if (m.a.t === 'settings') this.em.emit('roster', this.roster);
    this.em.emit('state', st);
    if (st.ended && this.status !== 'ended') this.setStatus('ended');
    else if (!st.ended && this.status === 'ended') this.setStatus('playing');
    this.notifyEnd();
  }

  private onTick(matchId: string | null, seq: number, h: string) {
    for (const p of this.pending.values()) {
      if (++p.ticks >= 2) this.transport.send({ t: 'bReq', id: p.id, r: p.req });
    }
    if (!matchId) return;
    if (!this.state || matchId !== this.matchId) return this.askSync(true, 'missed the match start', true);
    if (seq > this.seq) return this.askSync(false, `behind: ${this.seq} < ${seq}`, true);
    if (seq === this.seq && h !== battleHash(this.state)) return this.askSync(true, 'hash mismatch on heartbeat', true);
  }

  private endKey(): string {
    const e = this.state?.ended;
    return e ? `${this.matchId}:${e.winner}:${e.reason}` : '';
  }

  private notifyEnd() {
    const e = this.state?.ended;
    if (!e) return;
    const k = this.endKey();
    if (k === this.endNotified) return;
    this.endNotified = k;
    this.em.emit('end', { ...e });
  }

  private setStatus(s: BattleStatus) {
    if (this.status === s) return;
    this.status = s;
    this.em.emit('status', s);
  }

  private persist() {
    if (this.closed || !this.storage) return;
    const saved: SavedGuest = {
      v: 1,
      code: this.code,
      clientId: this.clientId,
      name: this.name,
      seat: this.seat,
      matchId: this.matchId,
      state: this.state,
      seq: this.seq,
      roster: this.wire,
      settings: this.settings,
      concede: this.concedePending || undefined,
      savedAt: Date.now(),
    };
    writeJson(this.storage, BATTLE_GUEST_KEY, saved);
  }
}

function rejectText(r: BattleRejectReason): string {
  switch (r) {
    case 'version':
      return 'The host runs a different version of the game';
    case 'full':
      return 'No free seat in this room';
    case 'replaced':
      return 'Your seat was given to a bot';
    case 'started':
      return 'The match has already started';
  }
}
