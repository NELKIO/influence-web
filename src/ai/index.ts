import type { BotType } from '../core/types';
import { DummyBot } from './dummy';
import { DuelHunterBot } from './duelHunter';
import { FreakBot } from './freak';
import { HunterBot } from './hunter';
import { MasterBot, type MasterBotOptions } from './masterBot';
import type { Bot } from './types';

export interface CreateBotOptions {
  /** bot RNG seed (random when omitted) */
  seed?: number;
  /** Master search options (budget, sync mode...) */
  master?: MasterBotOptions;
}

export function createBot(type: BotType, opts: CreateBotOptions = {}): Bot {
  switch (type) {
    case 'freak':
      return new FreakBot(opts.seed);
    case 'dummy':
      return new DummyBot();
    case 'hunter':
      return new HunterBot(opts.seed);
    case 'duelHunter':
      return new DuelHunterBot(opts.seed);
    case 'master':
      return new MasterBot({ seed: opts.seed, ...opts.master });
  }
}

export type { Bot, BotContext, AttackMove } from './types';
export { FreakBot, DummyBot, HunterBot, DuelHunterBot, MasterBot };
export { MasterBrain, type MasterOptions } from './master';
