import type { MatchState } from '../core/types';
import type { MasterOptions } from './master';
import type { AttackMove, BotContext } from './types';

export type MasterRequest =
  | { id: number; kind: 'init'; seed: number; options: MasterOptions }
  | { id: number; kind: 'attack'; state: MatchState; ctx: BotContext }
  | { id: number; kind: 'power'; state: MatchState; ctx: BotContext };

export type MasterResponse =
  | { id: number; kind: 'init' }
  | { id: number; kind: 'attack'; move: AttackMove | null; runs: number; ms: number }
  | { id: number; kind: 'power'; placement: [number, number][]; runs: number; ms: number }
  | { id: number; kind: 'error'; message: string };
