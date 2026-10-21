import { describe, expect, it } from 'vitest';
import { createBot } from '../../src/ai';
import { runMatch } from '../../src/ai/arena';
import type { BotType, FieldSize, MatchSettings } from '../../src/core/types';

/**
 * Strength sanity check (deterministic: fixed seeds, Master with a fixed playout budget).
 * Bigger measurements: `npx vite-node scripts/strength.ts [games] [masterPlayouts] [sizes]`.
 */
async function duel(a: BotType, b: BotType, games: number, sizes: FieldSize[], playouts: number): Promise<number> {
  let aw = 0;
  for (let g = 0; g < games; g++) {
    const swap = g % 2 === 1;
    const types: BotType[] = swap ? [b, a] : [a, b];
    const settings: MatchSettings = {
      kind: 'single',
      size: sizes[g % sizes.length],
      players: types,
      darkness: false,
      symmetry: g % 4 >= 2,
      crowded: false,
      unions: false,
      shuffle: false,
      duelRules: false,
    };
    const bots = types.map((t, i) => createBot(t, { seed: 300 + g * 7 + i, master: { sync: true, playouts } }));
    const r = await runMatch(settings, { seed: 700 + g, bots, maxRounds: 200 });
    if (r.winner >= 0 && (r.winner === 0) !== swap) aw++;
  }
  return aw / games;
}

describe('bot strength ordering (1v1, seats alternated)', () => {
  it('Master beats Hunter clearly', async () => {
    expect(await duel('master', 'hunter', 8, ['S', 'M', 'L'], 60)).toBeGreaterThanOrEqual(0.75);
  }, 30_000);

  it('Hunter beats Dummy', async () => {
    expect(await duel('hunter', 'dummy', 60, ['S', 'M', 'L', 'XL'], 0)).toBeGreaterThanOrEqual(0.6);
  });

  it('Dummy beats Freak', async () => {
    expect(await duel('dummy', 'freak', 60, ['S', 'M', 'L', 'XL'], 0)).toBeGreaterThanOrEqual(0.75);
  });
});
