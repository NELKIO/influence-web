import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BATTLE_SCENARIOS, buildDailyScenario, buildScenario, isScenarioId, RETIRED_SCENARIOS, SCENARIO_META, SCENARIOS, startMatch } from '../../src/core/scenarios';
import { isConnected } from '../../src/core/field';
import { articulationPoints, chokePoints } from '../../src/core/connectivity';
import { createDailyMatch, dailyKind, dailyLevel, dailySeed, dayId, FRONTIERS_ROTATION_START, parseDay, ROTATION } from '../../src/daily';
import { runMatch } from '../../src/ai/arena';
import { createBot } from '../../src/ai';
import type { BotType } from '../../src/core/types';

function frontierDay(offset: number) {
  const d = parseDay(FRONTIERS_ROTATION_START);
  d.setDate(d.getDate() + offset);
  return dayId(d);
}

// Browser-independent fingerprints captured from the published calendar at a5540e2.
// Include the whole serialized map, rules and explored mask, not merely the seed.
const dailyFingerprints: Record<string, [string, string]> = {
  '2026-10-22': ['thermopylae', 'da0346e39ac35dba4831c9e31f191191aec93178bef1db3a682d16c78c382d27'],
  '2026-11-05': ['battle', '4661a367d288e609fc2a303101fd4027aad2094c370fc42dac844e59285166f3'],
  '2026-11-19': ['trojan', 'ba42ebc6e131567e0db4b89c3e133ee9a2ee07a043fe0798bdda4744dbcef8f7'],
  '2026-11-26': ['moonvale', '0444017fdec93f0e5e867c0f95d1f062b2f9a5544f8c2715df1262d96c1e74a9'],
  '2026-11-27': ['fireflies', '86c2a7fe299c5d05879a18c97599d899a269b0319328e7116650df90f671379a'],
  '2026-12-06': ['crossroads', '57483846934db8bb75d63c8d85006292133d5a54ed7ebb55ccdc73cf08d912af'],
  '2026-12-10': ['thermopylae', '767c4b495125c0616dc06696f2450a4f6d498c01114d030af5d56949b868a237'],
  '2026-12-13': ['highlands', 'de33dd2c0712b8b98c316a4d65bc9fe2dc6a05ab66ed0890bb23d9c23514db7a'],
  '2027-01-01': ['crossroads', 'ea91e630d59e1c723528bfeb12f53a0ab0737bed97593f1a8abc8c58e05e5443'],
  '2027-01-02': ['highlands', '47a5387697980b76bb91837f785f98eef08b18a92ace4e962cf9a68e4db117b4'],
  '2027-01-07': ['moonvale', '154b0ff8b3c33908eab5eb8b394da0a690e71b44817940859789b81a6be95722'],
  '2027-01-14': ['thermopylae', '4cde212904ad11410f0bc1106e66cd37a5dfbb3248e2d884c3905bcf52556a85'],
  '2027-01-19': ['fireflies', '0d95ba3203a20d22652fd34af05dca9772905394a0d49e96534a9870ec2af50c'],
  '2027-02-19': ['crossroads', '749520fa72402876656ba9dbb24b22fd84c9702dd726ece8eba3d4b49c3950ac'],
  '2027-02-24': ['highlands', '7d5e44e762b874557456361ac7f262ff0e36904281f8401f297d56c38a895304'],
  '2027-02-27': ['fireflies', '449ed64c28b2e6895eef3daf5e581dcd34e14deac6731b525f9b8456ee7f88dd'],
  '2027-03-07': ['moonvale', 'fc3b63e6e126754d720002896c706d932bc9ed0a0503b97e27854849c83a498f'],
};

it('preserves the published daily calendar, including already-defined future days', () => {
  const calendar = Array.from({ length: 190 }, (_, d) => {
    const kind = dailyKind(frontierDay(d));
    return kind.kind === 'puzzle' ? kind.scenario : 'battle';
  });
  expect(createHash('sha256').update(JSON.stringify(calendar)).digest('hex'))
    .toBe('3b2b17459e97d674c28bf52d5fc8fb3945850f57dd423593ee5aa78c8e1072f9');
});

it('keeps the original daily maps, rules, objectives and explored fog across eras', () => {
  for (const [day, [scenario, fingerprint]] of Object.entries(dailyFingerprints)) {
    const kind = dailyKind(day);
    expect(kind.kind === 'puzzle' ? kind.scenario : 'battle', day).toBe(scenario);
    const state = createDailyMatch(day);
    const actual = createHash('sha256').update(JSON.stringify({ field: state.field, settings: state.settings, objectives: state.objectives, explored: state.explored })).digest('hex');
    expect(actual, day).toBe(fingerprint);
  }
});

describe('puzzle scenarios', () => {
  for (const id of SCENARIOS) {
    it(`${id}: valid, reproducible positions`, () => {
      for (let seed = 1; seed <= 20; seed++) {
        const st = buildScenario(id, seed * 131);
        const f = st.field;
        expect(isConnected(f)).toBe(true);
        expect(f.cells.length).toBeGreaterThan(30);
        st.settings.players.forEach((_, slot) => expect(f.cells.some((c) => c.owner === slot)).toBe(true));
        for (const c of f.cells) {
          expect(c.power).toBeGreaterThanOrEqual(0);
          expect(c.power).toBeLessThanOrEqual(c.maxPower);
        }
        // adjacency is symmetric and walls only separate neighbours
        f.adj.forEach((ns, i) => ns.forEach((j) => expect(f.adj[j]).toContain(i)));
        expect(st.settings.puzzle).toBe(id);
        expect(st.settings.players).toEqual(SCENARIO_META[id].players);
        expect(st.settings.darkness).toBe(!!SCENARIO_META[id].darkness);
        expect(st.settings.unions).toBe(!!SCENARIO_META[id].unions);
        expect(st.ended).toBeNull();
        expect(JSON.stringify(buildScenario(id, seed * 131).field)).toBe(JSON.stringify(f));
      }
    });

    it(`${id}: no single cell cuts the players apart`, () => {
      for (let seed = 1; seed <= 30; seed++) {
        const f = buildScenario(id, seed * 977).field;
        // every owned cell counts as a start, so the check does not depend on which cell stands for a player
        const owned = f.cells.flatMap((c, i) => (c.owner >= 0 ? [i] : []));
        expect(chokePoints(f.adj, owned), `seed ${seed * 977}`).toEqual([]);
      }
    });

    it(`${id}: can be won by a strong player`, async () => {
      let wins = 0;
      for (let i = 0; i < 4 && wins === 0; i++) {
        const seed = 500 + i * 37;
        const state = buildScenario(id, seed);
        const bots = state.settings.players.map((p, slot) =>
          createBot(slot === 0 ? 'master' : (p as BotType), { seed: seed + slot, master: { playouts: 60 }, god: { sync: true, rollouts: 40 } }),
        );
        const res = await runMatch(state.settings, { seed, bots, state, maxRounds: 120 });
        if (res.winner === 0 || res.state.ended?.humanWon) wins++;
      }
      expect(wins).toBeGreaterThan(0);
    }, 60_000);
  }
});

describe('scenarios as battle presets', () => {
  it('any seat types for the scenario seats; the map does not depend on them', () => {
    const base = buildScenario('olympus', 42);
    const custom = buildScenario('olympus', 42, undefined, ['human', 'god', 'human', 'online', 'master', 'dummy']);
    expect(custom.settings.players).toEqual(['human', 'god', 'human', 'online', 'master', 'dummy']);
    expect(JSON.stringify(custom.field)).toBe(JSON.stringify(base.field));
    expect(() => buildScenario('olympus', 42, undefined, ['human', 'hunter'])).toThrow();
  });

  it('startMatch builds the scenario named in the settings, keeping the kind of match', () => {
    const st = startMatch({ ...buildScenario('titans', 1).settings, kind: 'battleOnline', players: ['human', 'online', 'master'] }, 9);
    expect(st.settings.kind).toBe('battleOnline');
    expect(st.settings.puzzle).toBe('titans');
    expect(st.settings.unions).toBe(true);
    expect(JSON.stringify(st.field)).toBe(JSON.stringify(buildScenario('titans', 9).field));
  });

  it('recommended opponents are Hunters at least, mostly Masters, at most one GOD', () => {
    const all = SCENARIOS.flatMap((id) => {
      const bots = SCENARIO_META[id].players.slice(1);
      for (const b of bots) expect(['hunter', 'master', 'god']).toContain(b);
      expect(bots.filter((b) => b === 'god').length).toBeLessThanOrEqual(1);
      return bots;
    });
    expect(all.filter((b) => b === 'master' || b === 'god').length).toBeGreaterThan(all.length * 0.6);
  });

  it('the later scenarios are battles for three to six seats, and the raid duel', () => {
    for (const id of BATTLE_SCENARIOS) {
      expect(SCENARIO_META[id].players.length).toBeGreaterThanOrEqual(id === 'raid' ? 2 : 3);
      expect(SCENARIO_META[id].players[0]).toBe('human');
    }
  });

  it('night drop: a big dark map with no cut cells at all, everybody dropped somewhere new each game', () => {
    const spots = new Set<number>();
    for (let seed = 1; seed <= 12; seed++) {
      const st = buildScenario('landing', seed * 7);
      expect(st.settings.darkness).toBe(true);
      expect(st.settings.players).toHaveLength(6);
      expect(st.field.cells.length).toBeGreaterThan(150);
      expect(articulationPoints(st.field.adj)).toEqual([]);
      const mine = st.field.cells.findIndex((c) => c.owner === 0);
      const c = st.field.cells[mine];
      spots.add(c.y * 100 + c.x);
      // drops are spread out: no two players start next to each other
      for (let p = 0; p < 6; p++)
        for (const i of st.field.cells.flatMap((x, j) => (x.owner === p ? [j] : [])))
          for (const n of st.field.adj[i]) expect([-1, p]).toContain(st.field.cells[n].owner);
    }
    expect(spots.size).toBeGreaterThan(8);
  });

  it('hollow lands: four equal realms of empty cells, 1s only along the borders, nothing neutral but the centre', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const st = buildScenario('hollow', seed * 31, 0);
      const { cells, adj } = st.field;
      expect(st.settings.players).toHaveLength(4);
      const sizes = [0, 1, 2, 3].map((p) => cells.filter((c) => c.owner === p).length);
      expect(new Set(sizes).size).toBe(1);
      expect(cells.filter((c) => c.owner < 0)).toHaveLength(1);
      cells.forEach((c, i) => {
        if (c.owner < 0) return;
        const border = adj[i].some((j) => cells[j].owner >= 0 && cells[j].owner !== c.owner);
        expect(c.power).toBe(border ? 1 : 0);
      });
      for (const p of [0, 1, 2, 3]) {
        const own = cells.filter((c) => c.owner === p);
        expect(own.filter((c) => c.power === 0).length).toBeGreaterThan(own.length / 2);
      }
    }
    // the knob adds 1s to your empty land (or empties your front when below 0)
    const more = buildScenario('hollow', 31, 10).field.cells.filter((c) => c.owner === 0);
    const less = buildScenario('hollow', 31, -4).field.cells.filter((c) => c.owner === 0);
    const base = buildScenario('hollow', 31, 0).field.cells.filter((c) => c.owner === 0);
    const sum = (l: { power: number }[]) => l.reduce((n, c) => n + c.power, 0);
    expect(sum(more)).toBe(sum(base) + 10);
    expect(sum(less)).toBe(sum(base) - 4);
  });

  it('between titans: vast empires, empty behind a strong front; your realm is full', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const { cells } = buildScenario('titans', seed * 17).field;
      for (const p of [1, 2]) {
        const own = cells.filter((c) => c.owner === p);
        expect(own.length).toBeGreaterThan(35);
        expect(own.filter((c) => c.power === 0).length).toBeGreaterThan(own.length / 2);
        expect(own.some((c) => c.power >= 4)).toBe(true);
      }
      const mine = cells.filter((c) => c.owner === 0);
      expect(mine.length).toBeLessThan(10);
      for (const c of mine) expect(c.power).toBeGreaterThanOrEqual(Math.min(c.maxPower, 6));
    }
  });

  it('the map of the day rotates through every scenario, played as the setup recommends it', () => {
    // From the new rotation on, one cycle covers each curated scenario exactly once.
    for (const id of ['farshore', 'fireflies', 'crossroads', 'highlands']) expect(ROTATION).toContain(id);
    expect(ROTATION).toContain('raid');
    expect(ROTATION).not.toContain('hollow');
    const seen: string[] = [];
    for (let i = 0; seen.length < ROTATION.length; i++) {
      const id = frontierDay(i);
      const k = dailyKind(id);
      if (k.kind !== 'puzzle') continue;
      seen.push(k.scenario);
      const m = createDailyMatch(id);
      expect(m.settings.kind).toBe('daily');
      expect(m.settings.players).toEqual(SCENARIO_META[k.scenario].players);
      expect(dailyLevel(id)).toBe(SCENARIO_META[k.scenario].level);
      expect(JSON.stringify(m.field)).toBe(JSON.stringify(buildDailyScenario(k.scenario, dailySeed(id)).field));
    }
    expect(seen.sort()).toEqual([...ROTATION].sort());
    // past days keep the scenario people played (the classic rotation); the switch brings a new one
    const days: Record<string, string> = {
      '2026-09-01': 'archipelago',
      '2026-10-01': 'hydra',
      '2026-10-21': 'hydra',
      '2026-10-22': 'thermopylae',
      '2026-10-23': 'olympus',
      '2026-10-24': 'battle',
      '2026-10-25': 'treasury',
      '2026-10-29': 'landing',
      '2026-10-27': 'hourglass',
      '2026-10-31': 'raid',
      '2026-11-07': 'siege',
      '2026-11-16': 'titans',
      '2026-11-18': 'hive',
    };
    for (const [day, id] of Object.entries(days)) {
      const k = dailyKind(day);
      expect(k.kind === 'puzzle' ? k.scenario : 'battle').toBe(id);
    }
  });

  it('a scenario of the day does not come back within eight puzzle days, also across both switches and cycles', () => {
    const recent: string[] = [];
    for (let d = 0; d < 3 * 365; d++) {
      const id = dayId(new Date(2026, 9, 10 + d));
      const k = dailyKind(id);
      if (k.kind !== 'puzzle') continue;
      if (id >= '2026-10-23') expect(recent.slice(-8), id).not.toContain(k.scenario);
      recent.push(k.scenario);
    }
  });

  it('the night drop of the day is the same for everyone', () => {
    let day = '';
    for (let i = 0; !day; i++) {
      const id = dayId(new Date(2026, 9, 21 + i));
      const k = dailyKind(id);
      if (k.kind === 'puzzle' && k.scenario === 'landing') day = id;
    }
    const a = createDailyMatch(day);
    const b = createDailyMatch(day);
    expect(a.settings.blind).toBe(true);
    expect(JSON.stringify(a.field)).toBe(JSON.stringify(b.field));
    expect(a.explored).toEqual(b.explored);
  });
});

describe('retired scenarios', () => {
  it('are gone from the gallery and the coming maps of the day, but past days still open as played', () => {
    for (const id of RETIRED_SCENARIOS) {
      expect(SCENARIOS).not.toContain(id);
      expect(ROTATION).not.toContain(id);
      expect(isScenarioId(id)).toBe(false);
    }
    // the next three years of the map of the day never bring them back
    for (let d = 0; d < 3 * 365; d++) {
      const k = dailyKind(frontierDay(d));
      if (k.kind === 'puzzle') expect(RETIRED_SCENARIOS).not.toContain(k.scenario);
    }
    // a past day that had one keeps it
    for (const [day, id] of [['2026-10-02', 'hill'], ['2026-10-18', 'ringmap']] as const) {
      const k = dailyKind(day);
      expect(k.kind === 'puzzle' && k.scenario).toBe(id);
      expect(createDailyMatch(day).settings.puzzle).toBe(id);
    }
  });
});
