import type { BotType } from '../core/types';
import { DummyBot } from './dummy';
import { DuelHunterBot } from './duelHunter';
import { FreakBot } from './freak';
import { GodBot, type GodBotOptions } from './godBot';
import { HunterBot } from './hunter';
import { MasterBot, type MasterBotOptions } from './masterBot';
import type { Bot } from './types';

export interface CreateBotOptions {
  /** bot RNG seed (random when omitted) */
  seed?: number;
  /** Master search options (budget, sync mode...) */
  master?: MasterBotOptions;
  /** GOD search options (budget, sync mode...) */
  god?: GodBotOptions;
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
    case 'god':
      return new GodBot({ seed: opts.seed, ...opts.god });
  }
}

export type { Bot, BotContext, AttackMove } from './types';
export { FreakBot, DummyBot, HunterBot, DuelHunterBot, MasterBot, GodBot };
export { GodBrain, type GodOptions } from './god';
export { MasterBrain, type MasterOptions } from './master';
