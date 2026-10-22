import type { RngState } from './rng';

export type FieldSize = 'S' | 'M' | 'L' | 'XL' | 'XXL';

export interface SizeInfo {
  w: number;
  h: number;
  /** cells to grow (target) */
  cells: number;
  /** stuck check may fire after this many rounds */
  stuckAfter: number;
  /** generator edge criterion */
  edgeK: number;
}

export const SIZES: Record<FieldSize, SizeInfo> = {
  S: { w: 5, h: 7, cells: 25, stuckAfter: 10, edgeK: 1 },
  M: { w: 7, h: 11, cells: 52, stuckAfter: 15, edgeK: 3 },
  L: { w: 10, h: 15, cells: 84, stuckAfter: 17, edgeK: 4 },
  XL: { w: 15, h: 19, cells: 160, stuckAfter: 20, edgeK: 4 },
  XXL: { w: 20, h: 25, cells: 320, stuckAfter: 25, edgeK: 5 },
};

export const SIZE_ORDER: FieldSize[] = ['S', 'M', 'L', 'XL', 'XXL'];

export type BotType = 'freak' | 'dummy' | 'hunter' | 'master' | 'god' | 'duelHunter';
/**
 * 'remote' = another person playing on a different device (as seen by a guest),
 * 'online' = a seat taken by a guest in a battle room (as seen by the host).
 */
export type PlayerType = 'human' | 'remote' | 'online' | BotType;

/** Used for unions ordering (lower tries first). */
export const DIFFICULTY: Record<PlayerType, number> = {
  freak: 1,
  dummy: 3,
  hunter: 6,
  duelHunter: 6,
  master: 9,
  god: 9.5,
  human: 10,
  remote: 10,
  online: 10,
};

export const MAX_PLAYERS = 6;
export const NEUTRAL = -1;

export interface Cell {
  /** grid id = y * w + x */
  id: number;
  x: number;
  y: number;
  power: number;
  maxPower: number;
  /** player slot or NEUTRAL */
  owner: number;
}

export interface Field {
  size: FieldSize;
  w: number;
  h: number;
  /** generator order (x, then y). Index into this array is the "cell index" used everywhere. */
  cells: Cell[];
  /** enabled adjacency, by cell index */
  adj: number[][];
  /** pairs of cell indices that are hex-adjacent but separated by a wall */
  walls: [number, number][];
  /** 5 start positions (cell indices) */
  starts: number[];
  /** special symmetric layout (rotational maps for 3 / 5 players) */
  layout?: 'triangle' | 'star' | 'ring' | 'flower' | 'pinwheel' | 'islands' | 'honeycomb';
}

export type MatchKind = 'single' | 'daily' | 'duelTraining' | 'duelLocal' | 'duelOnline' | 'battleOnline';

export interface MatchSettings {
  kind: MatchKind;
  size: FieldSize;
  /** slot -> type, length = number of players (2..5) */
  players: PlayerType[];
  darkness: boolean;
  symmetry: boolean;
  crowded: boolean;
  unions: boolean;
  shuffle: boolean;
  /** duel rules: income = biggest group, greys first, no unions */
  duelRules: boolean;
  /** online duel turn limit in seconds, 0 = none */
  turnTime?: number;
  /** daily map id (yyyy-mm-dd) */
  dailyId?: string;
  /** puzzle scenario id (preset position) */
  puzzle?: string;
}

export type Phase = 'attack' | 'power';

export interface Chronicle {
  damage: number;
  damageTaken: number;
  conquered: number;
  lost: number;
  attacks: number;
  attacksWon: number;
}

export interface MatchState {
  v: 1;
  settings: MatchSettings;
  field: Field;
  seed: number;
  rng: RngState;
  /** completed rounds */
  turn: number;
  current: number;
  phase: Phase;
  powerLeft: number;
  /** streak-breaker counters for 25/50/75% fights */
  luck: [number, number, number];
  lastStuck: number;
  /** last human who acted (darkness viewer) */
  viewer: number;
  /** cell index of the currently selected cell (UI convenience, kept in state for bots/continuation) */
  selected: number;
  chronicle: Chronicle;
  /** per slot: eliminated at round (or -1) */
  outAt: number[];
  /** order of elimination, for placing */
  ended: null | MatchEnd;
  startedAt: number;
}

export interface MatchEnd {
  /** winner slot, or -1 if decided as "humans lost" without a single winner */
  winner: number;
  /** true if a human won */
  humanWon: boolean;
  reason: 'elimination' | 'early' | 'concede' | 'timeout';
  turn: number;
}

/** Outcome of one attack, enough to replay it remotely. */
export interface FightEvent {
  type: 'fight';
  player: number;
  from: number;
  to: number;
  atkBefore: number;
  defBefore: number;
  atkAfter: number;
  defAfter: number;
  defOwnerBefore: number;
  chance: number;
  win: boolean;
  /** slot eliminated by this fight */
  eliminated: number | null;
}

export interface UnionEvent {
  type: 'union';
  absorber: number;
  absorbed: number;
}

export type AttackRefusal = 'notOwn' | 'weak' | 'notAdjacent' | 'ownTarget' | 'greysFirst' | 'wrongPhase' | 'ended';
