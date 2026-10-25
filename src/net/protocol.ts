/**
 * Online duel wire protocol (JSON over a reliable, ordered data channel).
 *
 * Flow:
 *   guest → host   hello            (on every (re)connect; carries matchId/seq/hash for resume)
 *   host  → guest  hello            (reply)
 *   host  → guest  setup            (new match, rematch, or guest without a matching saved match)
 *   active → other action{seq}      (attacks carry the resolved outcome, the receiver never re-rolls)
 *   other → active ack{seq, hash}   (after each endTurn and at match end)
 *   host  → guest  sync             (full authoritative state on mismatch/gap; host's state wins)
 *   guest → host   syncReq          (guest detected a problem it cannot fix itself)
 *   any            concede / timeout / rematch / ping / pong / reject
 *   any            presence {hidden}  (the page was hidden / shown: "the opponent minimised the game")
 *
 * `seq` numbers every game action of a match (1, 2, 3...). Both sides keep a short log so that,
 * after a reconnect, the side that is ahead re-sends the actions the other side missed.
 */
import type { MatchEnd, MatchState } from '../core/types';

/** 2: multipath links (direct + relays together, own reliability layer) and presence messages */
export const PROTOCOL_VERSION = 2;

export type DuelAction =
  | { t: 'attack'; from: number; to: number; win: boolean }
  | { t: 'endAttack' }
  | { t: 'power'; cell: number; amount: number }
  | { t: 'endTurn' };

export interface HelloMsg {
  t: 'hello';
  v: number;
  clientId: string;
  name: string;
  /** current match of the sender (null if none yet) */
  matchId: string | null;
  seq: number;
  hash: string;
  /** set when the sender considers its match finished */
  ended: MatchEnd | null;
  /** sender wants a rematch */
  rematch: boolean;
}

export interface SetupMsg {
  t: 'setup';
  v: number;
  matchId: string;
  /** full state from the host's perspective (settings.kind 'duelOnline', duelRules true) */
  state: MatchState;
  /** action seq the state corresponds to (0 for a fresh match) */
  seq: number;
  /** slot of the host (the guest is the other slot). Slot 0 moves first. */
  hostSlot: number;
  seed: number;
  turnTime: number;
  /** 0 for the first match of a room, +1 per rematch */
  round: number;
}

export interface ActionMsg {
  t: 'action';
  seq: number;
  a: DuelAction;
}

export interface SyncMsg {
  t: 'sync';
  matchId: string;
  seq: number;
  state: MatchState;
  hostSlot: number;
  round: number;
}

export interface SyncReqMsg {
  t: 'syncReq';
  matchId: string | null;
  reason: string;
}

export interface AckMsg {
  t: 'ack';
  seq: number;
  hash: string;
}

export interface ConcedeMsg {
  t: 'concede';
  matchId: string;
}

/** The sender claims a win because the opponent stayed silent past turnTime + grace. */
export interface TimeoutMsg {
  t: 'timeout';
  matchId: string;
  seq: number;
}

export interface RematchMsg {
  t: 'rematch';
  accept: boolean;
}

export interface PingMsg {
  t: 'ping';
  ts: number;
}

/** `seq`: the responder's action seq (lets the pinger notice the peer is stuck behind it) */
export interface PongMsg {
  t: 'pong';
  ts: number;
  seq?: number;
  matchId?: string | null;
}

/** the sender's page was hidden (true) or shown again (false) */
export interface PresenceMsg {
  t: 'presence';
  hidden: boolean;
}

export type RejectReason = 'version' | 'busy';

export interface RejectMsg {
  t: 'reject';
  reason: RejectReason;
  /** the sender's protocol version */
  v: number;
}

export type NetMessage =
  | HelloMsg
  | SetupMsg
  | ActionMsg
  | SyncMsg
  | SyncReqMsg
  | AckMsg
  | ConcedeMsg
  | TimeoutMsg
  | RematchMsg
  | PingMsg
  | PongMsg
  | PresenceMsg
  | RejectMsg;

// ---------------------------------------------------------------- validation

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);
const isStr = (x: unknown): x is string => typeof x === 'string';
const isNullableStr = (x: unknown) => x === null || isStr(x);

function isState(x: unknown): x is MatchState {
  if (!isObj(x)) return false;
  const f = x.field;
  return (
    x.v === 1 &&
    isObj(x.settings) &&
    Array.isArray((x.settings as Record<string, unknown>).players) &&
    isObj(f) &&
    Array.isArray((f as Record<string, unknown>).cells) &&
    Array.isArray((f as Record<string, unknown>).adj) &&
    isInt(x.turn) &&
    isInt(x.current) &&
    (x.phase === 'attack' || x.phase === 'power')
  );
}

export function isDuelAction(x: unknown): x is DuelAction {
  if (!isObj(x)) return false;
  switch (x.t) {
    case 'attack':
      return isInt(x.from) && isInt(x.to) && typeof x.win === 'boolean';
    case 'power':
      return isInt(x.cell) && isInt(x.amount) && x.amount > 0;
    case 'endAttack':
    case 'endTurn':
      return true;
    default:
      return false;
  }
}

/** Structural check of an incoming message. Returns the typed message or null. */
export function parseMessage(x: unknown): NetMessage | null {
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
      case 'hello':
        return isInt(x.v) && isStr(x.clientId) && isStr(x.name) && isNullableStr(x.matchId) && isInt(x.seq) && isStr(x.hash);
      case 'setup':
        return isInt(x.v) && isStr(x.matchId) && isState(x.state) && isInt(x.seq) && isInt(x.hostSlot) && isInt(x.round);
      case 'action':
        return isInt(x.seq) && x.seq > 0 && isDuelAction(x.a);
      case 'sync':
        return isStr(x.matchId) && isInt(x.seq) && isState(x.state) && isInt(x.hostSlot);
      case 'syncReq':
        return isNullableStr(x.matchId);
      case 'ack':
        return isInt(x.seq) && isStr(x.hash);
      case 'concede':
        return isStr(x.matchId);
      case 'timeout':
        return isStr(x.matchId) && isInt(x.seq);
      case 'rematch':
        return typeof x.accept === 'boolean';
      case 'ping':
      case 'pong':
        return typeof x.ts === 'number';
      case 'reject':
        return isStr(x.reason);
      case 'presence':
        return typeof x.hidden === 'boolean';
      default:
        return false;
    }
  })();
  if (!ok) return null;
  if (x.t === 'hello') {
    x.ended = isObj(x.ended) ? x.ended : null;
    x.rematch = x.rematch === true;
  }
  return x as unknown as NetMessage;
}

// ---------------------------------------------------------------- state hash

/**
 * Cheap FNV-1a hash of the parts of the state both peers must agree on:
 * owners and powers of all cells, round, current player, phase and remaining power.
 * (rng, luck, chronicle, viewer, selection and player types legitimately differ per side.)
 */
export function stateHash(state: MatchState): string {
  let h = 0x811c9dc5;
  const mix = (n: number) => {
    h ^= n & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (n >>> 8) & 0xff;
    h = Math.imul(h, 0x01000193);
  };
  mix(state.turn);
  mix(state.current + 1);
  mix(state.phase === 'attack' ? 1 : 2);
  mix(state.powerLeft);
  for (const c of state.field.cells) {
    mix(c.owner + 1);
    mix(c.power);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
