import { describe, expect, it } from 'vitest';
import { createBot } from '../../src/ai';
import { runMatch, type ArenaResult } from '../../src/ai/arena';
import { createMatch } from '../../src/core/engine';
import { Rng } from '../../src/core/rng';
import { SIZE_ORDER, type BotType, type FieldSize, type MatchSettings, type PlayerType } from '../../src/core/types';

/** Master with a tiny deterministic budget so the whole suite stays fast. */
const MASTER = { sync: true, playouts: 6 } as const;

interface Scenario {
  name: string;
  settings: MatchSettings;
  /** bot driving each seat ('human' seats are driven by these too) */
  drivers: BotType[];
  seed: number;
}

const ALL: BotType[] = ['freak', 'dummy', 'hunter', 'master'];

function scenarios(): Scenario[] {
  const out: Scenario[] = [];
  const rng = new Rng(2024);
  let seed = 1;
  for (const size of SIZE_ORDER) {
    const variants: Partial<MatchSettings>[] = [
      {},
      { symmetry: true },
      { darkness: true },
      { crowded: true },
      { unions: true },
      { symmetry: true, crowded: true, darkness: true },
      { shuffle: true },
    ];
    for (const v of variants.flatMap((x) => [x, x, x])) {
      const n = 2 + rng.int(4); // 2..5
      // Master only in smaller line-ups on the biggest maps (keeps the suite fast)
      const pool = (size === 'XXL' || size === 'XL') && n > 3 ? ALL.filter((t) => t !== 'master') : ALL;
      const drivers = Array.from({ length: n }, () => pool[rng.int(pool.length)]);
      // unions need exactly one human: seat 0 is a "human" driven by a bot
      const humanSeat = v.unions || rng.bool();
      const players: PlayerType[] = drivers.map((d, i) => (humanSeat && i === 0 ? 'human' : d));
      out.push({
        name: `${size} ${JSON.stringify(v)} ${players.join('/')}${humanSeat ? ` (human=${drivers[0]})` : ''}`,
        settings: {
          kind: 'single',
          size,
          players,
          darkness: false,
          symmetry: false,
          crowded: false,
          unions: false,
          shuffle: false,
          duelRules: false,
          ...v,
        },
        drivers,
        seed: seed++,
      });
    }
    // duel rules: Duel Hunter vs a human seat driven by Duel Hunter / Hunter / Master
    for (const [i, d] of (['duelHunter', 'hunter', size === 'XXL' ? 'dummy' : 'master'] as BotType[]).entries()) {
      out.push({
        name: `${size} duel human=${d} vs duelHunter`,
        settings: {
          kind: 'duelTraining',
          size,
          players: ['human', 'duelHunter'],
          darkness: false,
          symmetry: i % 2 === 0,
          crowded: false,
          unions: false,
          shuffle: false,
          duelRules: true,
        },
        drivers: [d, 'duelHunter'],
        seed: seed++,
      });
    }
  }
  // Master-only and 5-bot free-for-alls on mid-size maps
  out.push({
    name: 'M master x3',
    settings: { kind: 'single', size: 'M', players: ['master', 'master', 'master'], darkness: false, symmetry: false, crowded: false, unions: false, shuffle: false, duelRules: false },
    drivers: ['master', 'master', 'master'],
    seed: seed++,
  });
  out.push({
    name: 'L 5 bots',
    settings: { kind: 'single', size: 'L', players: ['freak', 'dummy', 'hunter', 'master', 'hunter'], darkness: true, symmetry: true, crowded: false, unions: false, shuffle: true, duelRules: false },
    drivers: ['freak', 'dummy', 'hunter', 'master', 'hunter'],
    seed: seed++,
  });
  return out;
}

describe('headless bot-vs-bot simulation', () => {
  const all = scenarios();
  const results: { name: string; r: ArenaResult }[] = [];

  for (const size of SIZE_ORDER as FieldSize[]) {
    it(`plays every scenario on ${size} with invariants checked at every step`, async () => {
      for (const sc of all.filter((s) => s.settings.size === size)) {
        // resolve the final seat order (shuffle) to pick the right driver per seat
        const probe = createMatch(sc.settings, { seed: sc.seed });
        const seatTypes = probe.settings.players;
        const drivers = seatTypes.map((t) => (t === 'human' ? sc.drivers[0] : (t as BotType)));
        const bots = drivers.map((d, i) => createBot(d, { seed: sc.seed * 10 + i, master: MASTER }));
        const r = await runMatch(sc.settings, { seed: sc.seed, bots, maxRounds: 300, checkInvariants: true });
        results.push({ name: sc.name, r });
        expect(r.rounds).toBeLessThanOrEqual(300);
        if (!r.capped) expect(r.state.ended).not.toBeNull();
      }
    });
  }

  it('most matches finish before the round cap', () => {
    const capped = results.filter((x) => x.r.capped);
    expect(results.length).toBe(all.length);
    expect(capped.length).toBeLessThanOrEqual(Math.ceil(results.length * 0.1));
  });

  it('runs many more quick matches (Freak/Dummy/Hunter, random settings)', { timeout: 60_000 }, async () => {
    const rng = new Rng(99);
    let finished = 0;
    const N = 2000;
    for (let g = 0; g < N; g++) {
      const size = SIZE_ORDER[rng.int(rng.bool() ? 5 : 3)]; // biased to S..L
      const n = 2 + rng.int(4);
      const duel = n === 2 && rng.int(4) === 0;
      const pool: BotType[] = duel ? ['duelHunter', 'hunter', 'dummy', 'freak'] : ['freak', 'dummy', 'hunter'];
      const drivers = Array.from({ length: n }, () => pool[rng.int(pool.length)]);
      const human = rng.bool();
      const settings: MatchSettings = {
        kind: duel ? 'duelTraining' : 'single',
        size,
        players: drivers.map((d, i) => (human && i === 0 ? 'human' : d)),
        darkness: rng.bool(),
        symmetry: rng.bool(),
        crowded: !duel && rng.int(4) === 0,
        unions: !duel && rng.bool(),
        shuffle: false,
        duelRules: duel,
      };
      const bots = drivers.map((d, i) => createBot(d, { seed: g * 10 + i }));
      const r = await runMatch(settings, { seed: 10_000 + g, bots, maxRounds: 300, checkInvariants: true });
      if (!r.capped) finished++;
    }
    expect(finished).toBeGreaterThanOrEqual(N * 0.9);
  });
});
