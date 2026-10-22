import { describe, expect, it } from 'vitest';
import { runMatch } from '../../src/ai/arena';
import { createBot } from '../../src/ai';
import { SIZE_ORDER, type BotType, type MatchSettings } from '../../src/core/types';

const LINEUP: BotType[] = ['hunter', 'dummy', 'master', 'hunter', 'dummy', 'hunter'];

function settings(over: Partial<MatchSettings>): MatchSettings {
  return {
    kind: 'single',
    size: 'L',
    players: [...LINEUP],
    darkness: false,
    symmetry: true,
    crowded: false,
    unions: false,
    shuffle: false,
    duelRules: false,
    ...over,
  };
}

describe('six-player matches (bots, invariants checked every step)', () => {
  for (const size of SIZE_ORDER) {
    for (const symmetry of [true, false]) {
      it(`${size} symmetry=${symmetry}`, async () => {
        for (let seed = 1; seed <= 2; seed++) {
          const s = settings({ size, symmetry });
          const bots = s.players.map((p, i) => createBot(p as BotType, { seed: seed * 10 + i, master: { playouts: 30 } }));
          const res = await runMatch(s, { seed: seed * 4243, bots, checkInvariants: true, maxRounds: 140 });
          expect(res.state.turn).toBeGreaterThan(0);
        }
      }, 120_000);
    }
  }

  for (const mode of ['darkness', 'crowded', 'unions', 'shuffle'] as const) {
    it(`mode ${mode}`, async () => {
      for (let seed = 1; seed <= 3; seed++) {
        const s = settings({ size: 'M', [mode]: true, players: ['human', ...LINEUP.slice(1)] as MatchSettings['players'] });
        const bots = s.players.map((p, i) => createBot((p === 'human' ? 'hunter' : p) as BotType, { seed: seed + i, master: { playouts: 30 } }));
        const res = await runMatch(s, { seed: seed * 977, bots, checkInvariants: true, maxRounds: 140 });
        expect(res.state.turn).toBeGreaterThan(0);
      }
    }, 120_000);
  }
});
