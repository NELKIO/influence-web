/**
 * Battle room wire protocol (2-6 players, host-authoritative). JSON over reliable ordered links.
 *
 *   guest → host  bHello     on every (re)connect: clientId, name, current matchId / seq / hash (resume)
 *   host  → guest bWelcome   seat assignment, lobby settings, roster, room status
 *   host  → all   bRoster    roster changed (seat taken / freed, connected flags, settings players)
 *   host  → guest bStart     the match begins (full state, seq 0, the guest's seat)
 *   guest → host  bReq       request a move of the guest's own seat {id, r}
 *   host  → guest bRes       answer to a request: ok (and the seq of its last applied action) / refusal reason
 *   host  → all   bAct       an applied action with its resolved outcome {seq, seat, a, h = hash after it}
 *   guest → host  bSyncReq   gap (resend from seq) or mismatch (full: true) detected
 *   host  → guest bSync      full authoritative state
 *   host  → all   bTick      heartbeat {matchId, seq, h}: lets guests detect a lost last message
 *   host  → guest bReject    version mismatch / room full / seat replaced by a bot
 *   host  → all   bClosed    the host closed the room for good
 *   guest → host  bBye       the guest leaves for good (frees its lobby seat)
 *   guest ↔ host  bPing / bPong
 *   guest → host  bPresence  the guest's page was hidden / shown (the host shows it in the roster: `hidden`)
 *   host  → all   bPresence  {seat: -1} the host's page was hidden / shown
 *
 * `seq` numbers the applied actions of a match (1, 2, 3, ...). The host keeps a log of recent ones so a
 * guest that missed a few gets them re-sent; otherwise it gets a full `bSync`.
 */
import { isPersonType } from '../core/engine';
import type { AttackRefusal, MatchEnd, MatchSettings, MatchState, PlayerType } from '../core/types';

/**
 * 2: the engine gives later seats a first-reinforcement bonus (turn-order compensation); older clients would desync.
 * 3: multipath links (direct + relays together, own reliability layer) and presence (bPresence, WireSeat.hidden).
 */
export const BATTLE_PROTOCOL_VERSION = 3;

/** An action as applied by the host; attacks carry the resolved outcome. */
export type BattleAction =
  | { t: 'attack'; from: number; to: number; win: boolean }
  | { t: 'endAttack' }
  | { t: 'power'; cell: number; amount: number }
  | { t: 'endTurn' }
  /** the seat gives up: its cells turn neutral (see battleRules.concedeSeat) */
  | { t: 'concede' }
  /** seat kinds changed (fillWithBots); players are from the host's perspective */
  | { t: 'settings'; players: PlayerType[] }
  /** the host ended the match by other means (e.g. accepted an early-finish offer) */
  | { t: 'end'; end: MatchEnd };

/** `seat`: who acted (-1 for host-level actions: settings / end). */
export interface AppliedAction {
  seq: number;
  seat: number;
  a: BattleAction;
}

/** What a guest may ask the host to do for its own seat. */
export type BattleRequest =
  | { t: 'attack'; from: number; to: number }
  | { t: 'endAttack' }
  | { t: 'addPower'; cell: number; amount: number }
  | { t: 'autoPower' }
  /** from the attack phase this also ends the attack; leftover power is auto-distributed first */
  | { t: 'endTurn' }
  | { t: 'concede' };

export type RequestRefusal =
  | 'notYourTurn'
  | 'notYourSeat'
  | 'notPlaying'
  | 'offline'
  | 'timeout'
  | 'noPower'
  | 'closed'
  | 'bad'
  | AttackRefusal;

/** Roster entry as sent on the wire (host perspective). */
export interface WireSeat {
  seat: number;
  /** 'human' = played on the host device, 'online' = a guest seat, otherwise a bot type */
  kind: PlayerType;
  name: string | null;
  /** host-device and bot seats: always true; online seats: the guest's link is up */
  connected: boolean;
  /** online seat: a guest holds it */
  taken: boolean;
  /** online seat: the guest's page is hidden (minimised) */
  hidden?: boolean;
}

export type RoomStatus = 'lobby' | 'playing' | 'ended';
export type BattleRejectReason = 'version' | 'full' | 'replaced' | 'started';

export interface BHelloMsg {
  t: 'bHello';
  v: number;
  clientId: string;
  name: string;
  matchId: string | null;
  seq: number;
  hash: string;
}
export interface BWelcomeMsg {
  t: 'bWelcome';
  v: number;
  seat: number;
  status: RoomStatus;
  settings: MatchSettings;
  roster: WireSeat[];
  matchId: string | null;
}
export interface BRosterMsg {
  t: 'bRoster';
  roster: WireSeat[];
  players: PlayerType[];
}
export interface BStartMsg {
  t: 'bStart';
  matchId: string;
  seat: number;
  seq: number;
  state: MatchState;
  roster: WireSeat[];
}
export interface BReqMsg {
  t: 'bReq';
  id: string;
  r: BattleRequest;
}
export interface BResMsg {
  t: 'bRes';
  id: string;
  ok: boolean;
  reason?: string;
  seq?: number;
}
export interface BActMsg extends AppliedAction {
  t: 'bAct';
  matchId: string;
  /** battleHash of the state after this action */
  h: string;
}
export interface BSyncReqMsg {
  t: 'bSyncReq';
  matchId: string | null;
  seq: number;
  full: boolean;
  reason: string;
}
export interface BSyncMsg {
  t: 'bSync';
  matchId: string;
  seat: number;
  seq: number;
  state: MatchState;
  roster: WireSeat[];
}
export interface BTickMsg {
  t: 'bTick';
  matchId: string | null;
  seq: number;
  h: string;
}
export interface BRejectMsg {
  t: 'bReject';
  reason: BattleRejectReason;
  v: number;
}
export interface BClosedMsg {
  t: 'bClosed';
}
export interface BByeMsg {
  t: 'bBye';
}
export interface BPingMsg {
  t: 'bPing';
  ts: number;
}
export interface BPongMsg {
  t: 'bPong';
  ts: number;
}
/** guest → host: own page hidden / shown (`seat` ignored); host → guests: seat -1 = the host's page */
export interface BPresenceMsg {
  t: 'bPresence';
  hidden: boolean;
  seat: number;
}

export type BattleMessage =
  | BHelloMsg
  | BWelcomeMsg
  | BRosterMsg
  | BStartMsg
  | BReqMsg
  | BResMsg
  | BActMsg
  | BSyncReqMsg
  | BSyncMsg
  | BTickMsg
  | BRejectMsg
  | BClosedMsg
  | BByeMsg
  | BPingMsg
  | BPongMsg
  | BPresenceMsg;

// ---------------------------------------------------------------- validation

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);
const isStr = (x: unknown): x is string => typeof x === 'string';
const isNullableStr = (x: unknown) => x === null || isStr(x);
const PLAYER_TYPES = new Set(['human', 'remote', 'online', 'freak', 'dummy', 'hunter', 'master', 'god', 'duelHunter']);
const isPlayers = (x: unknown): x is PlayerType[] =>
  Array.isArray(x) && x.length >= 2 && x.length <= 6 && x.every((p) => isStr(p) && PLAYER_TYPES.has(p));

function isState(x: unknown): x is MatchState {
  if (!isObj(x)) return false;
  const f = x.field;
  return (
    x.v === 1 &&
    isObj(x.settings) &&
    isPlayers((x.settings as Record<string, unknown>).players) &&
    isObj(f) &&
    Array.isArray((f as Record<string, unknown>).cells) &&
    Array.isArray((f as Record<string, unknown>).adj) &&
    Array.isArray(x.outAt) &&
    isInt(x.turn) &&
    isInt(x.current) &&
    (x.phase === 'attack' || x.phase === 'power')
  );
}

const isRoster = (x: unknown): x is WireSeat[] =>
  Array.isArray(x) && x.every((s) => isObj(s) && isInt(s.seat) && isStr(s.kind) && typeof s.connected === 'boolean');

export function isBattleAction(x: unknown): x is BattleAction {
  if (!isObj(x)) return false;
  switch (x.t) {
    case 'attack':
      return isInt(x.from) && isInt(x.to) && typeof x.win === 'boolean';
    case 'power':
      return isInt(x.cell) && isInt(x.amount) && x.amount > 0;
    case 'endAttack':
    case 'endTurn':
    case 'concede':
      return true;
    case 'settings':
      return isPlayers(x.players);
    case 'end':
      return isObj(x.end) && isInt((x.end as Record<string, unknown>).winner);
    default:
      return false;
  }
}

export function isBattleRequest(x: unknown): x is BattleRequest {
  if (!isObj(x)) return false;
  switch (x.t) {
    case 'attack':
      return isInt(x.from) && isInt(x.to);
    case 'addPower':
      return isInt(x.cell) && isInt(x.amount) && x.amount > 0;
    case 'endAttack':
    case 'autoPower':
    case 'endTurn':
    case 'concede':
      return true;
    default:
      return false;
  }
}

/** Structural check of an incoming battle message. Returns the typed message or null. */
export function parseBattleMessage(x: unknown): BattleMessage | null {
  if (typeof x === 'string') {
    try {
      x = JSON.parse(x);
    } catch {
      return null;
    }
  }
  if (!isObj(x) || !isStr(x.t)) return null;
  const ok = (() => {
    switch (x.t) {
      case 'bHello':
        return isInt(x.v) && isStr(x.clientId) && isStr(x.name) && isNullableStr(x.matchId) && isInt(x.seq) && isStr(x.hash);
      case 'bWelcome':
        return (
          isInt(x.v) &&
          isInt(x.seat) &&
          isStr(x.status) &&
          isObj(x.settings) &&
          isPlayers((x.settings as Record<string, unknown>).players) &&
          isRoster(x.roster) &&
          isNullableStr(x.matchId)
        );
      case 'bRoster':
        return isRoster(x.roster) && isPlayers(x.players);
      case 'bStart':
        return isStr(x.matchId) && isInt(x.seat) && isInt(x.seq) && isState(x.state) && isRoster(x.roster);
      case 'bReq':
        return isStr(x.id) && isBattleRequest(x.r);
      case 'bRes':
        return isStr(x.id) && typeof x.ok === 'boolean';
      case 'bAct':
        return isStr(x.matchId) && isInt(x.seq) && x.seq > 0 && isInt(x.seat) && isBattleAction(x.a) && isStr(x.h);
      case 'bSyncReq':
        return isNullableStr(x.matchId) && isInt(x.seq) && typeof x.full === 'boolean';
      case 'bSync':
        return isStr(x.matchId) && isInt(x.seat) && isInt(x.seq) && isState(x.state) && isRoster(x.roster);
      case 'bTick':
        return isNullableStr(x.matchId) && isInt(x.seq) && isStr(x.h);
      case 'bReject':
        return isStr(x.reason);
      case 'bClosed':
      case 'bBye':
        return true;
      case 'bPing':
      case 'bPong':
        return typeof x.ts === 'number';
      case 'bPresence':
        return typeof x.hidden === 'boolean' && isInt(x.seat);
      default:
        return false;
    }
  })();
  return ok ? (x as unknown as BattleMessage) : null;
}

// ---------------------------------------------------------------- state hash

/**
 * FNV-1a hash of everything all peers must agree on: cells (owner, power), round, current seat, phase,
 * power left, eliminations, the end of the match and the seat kinds (persons collapsed to one kind, since
 * each device sees them as 'human' / 'remote' / 'online'). rng, luck, chronicle, viewer and selection
 * legitimately differ per device.
 */
export function battleHash(state: MatchState): string {
  let h = 0x811c9dc5;
  const mix = (n: number) => {
    h ^= n & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (n >>> 8) & 0xff;
    h = Math.imul(h, 0x01000193);
  };
  const mixStr = (s: string) => {
    for (let i = 0; i < s.length; i++) mix(s.charCodeAt(i));
    mix(0);
  };
  mix(state.turn);
  mix(state.current + 1);
  mix(state.phase === 'attack' ? 1 : 2);
  mix(state.powerLeft);
  for (const p of state.settings.players) mixStr(isPersonType(p) ? 'P' : p);
  for (const o of state.outAt) mix(o + 1);
  const e = state.ended;
  mix(e ? 1 : 0);
  if (e) {
    mix(e.winner + 1);
    mixStr(e.reason);
  }
  for (const c of state.field.cells) {
    mix(c.owner + 1);
    mix(c.power);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
