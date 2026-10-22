import type { MatchState } from '../core/types';
import type { GodOptions } from './god';
import type { AttackMove, BotContext } from './types';

export type GodRequest =
  | { id: number; kind: 'init'; seed: number; options: GodOptions }
  | { id: number; kind: 'attack'; state: MatchState; ctx: BotContext }
  | { id: number; kind: 'power'; state: MatchState; ctx: BotContext };

export type GodResponse =
  | { id: number; kind: 'init' }
  | { id: number; kind: 'attack'; move: AttackMove | null; rollouts: number; ms: number }
  | { id: number; kind: 'power'; placement: [number, number][]; rollouts: number; ms: number }
  | { id: number; kind: 'error'; message: string };
