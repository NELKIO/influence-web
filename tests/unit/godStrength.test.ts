import { describe, expect, it, vi } from 'vitest';
import { createBot } from '../../src/ai';
import { runMatch } from '../../src/ai/arena';
import type { BotType, FieldSize, MatchSettings } from '../../src/core/types';

// slow CI runners: these tests run real searches and whole matches
vi.setConfig({ testTimeout: 60_000 });

/**
 * Fast deterministic strength checks for GOD (fixed seeds, fixed budgets on both sides).
 * Bigger measurements: `npx vite-node scripts/god-strength.ts -- games=300 ...` (see the script header).
 */
const DUEL_GAMES = 30;
const THRESHOLD_DUEL = 17; // measured: 19 of 30
const FFA_GAMES = 12;
const THRESHOLD_FFA = 6; // measured: 9 of 12 (25% share would be 3)

const settingsFor = (players: BotType[], size: FieldSize, g: number): MatchSettings => ({
  kind: 'single',
  size,
  players,
  darkness: false,
  symmetry: g % 4 >= 2,
  crowded: false,
  unions: false,
  shuffle: false,
  duelRules: false,
});

async function duel(a: BotType, b: BotType, games: number, sizes: FieldSize[], budget: number): Promise<number> {
  let wins = 0;
  for (let g = 0; g < games; g++) {
    const swap = g % 2 === 1;
    const types: BotType[] = swap ? [b, a] : [a, b];
    const bots = types.map((t, i) =>
      createBot(t, { seed: 300 + g * 7 + i, master: { sync: true, playouts: budget }, god: { sync: true, rollouts: budget } }),
    );
    const r = await runMatch(settingsFor(types, sizes[g % sizes.length], g), { seed: 700 + g, bots, maxRounds: 150 });
    if (r.winner >= 0 && (r.winner === 0) !== swap) wins++;
  }
  return wins;
}

describe('GOD strength (deterministic, small samples)', () => {
  it('beats Hunter in every 1v1 game', async () => {
    expect(await duel('god', 'hunter', 8, ['S', 'M', 'L'], 60)).toBe(8);
  }, 30_000);

  it('beats Master 1v1 at an equal per-decision budget', async () => {
    const wins = await duel('god', 'master', DUEL_GAMES, ['M', 'L'], 200);
    if (process.env.GOD_STRENGTH_LOG) console.log('duel wins', wins, '/', DUEL_GAMES);
    expect(wins).toBeGreaterThanOrEqual(THRESHOLD_DUEL);
  }, 60_000);

  it('wins a four-player free-for-all against three Masters more often than its 25% share', async () => {
    let wins = 0;
    const games = FFA_GAMES;
    for (let g = 0; g < games; g++) {
      const seat = g % 4;
      const types: BotType[] = ['master', 'master', 'master', 'master'];
      types[seat] = 'god';
      const bots = types.map((t, i) => createBot(t, { seed: 50 + g * 5 + i, master: { sync: true, playouts: 100 }, god: { sync: true, rollouts: 100 } }));
      const r = await runMatch(settingsFor(types, 'M', g), { seed: 900 + g, bots, maxRounds: 150 });
      if (r.winner === seat) wins++;
    }
    if (process.env.GOD_STRENGTH_LOG) console.log('ffa wins', wins, '/', FFA_GAMES);
    expect(wins).toBeGreaterThanOrEqual(THRESHOLD_FFA);
  }, 40_000);
});

