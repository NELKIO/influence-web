/**
 * Frontier victory and signal fires as choices of the absolute-darkness scenarios (the night drop, the
 * moonless valley, fireflies): the same built map with generated control points and/or fires, valid
 * for saves and the network; other scenarios and the maps of the day never take them.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createBot } from '../../src/ai';
import { runMatch } from '../../src/ai/arena';
import { canLightSignalFire, exploredCells, explore } from '../../src/core/engine';
import { frontierGenerated, objectiveWinCount, validObjectiveFields } from '../../src/core/objectives';
import { FRONTIER_SCENARIOS } from '../../src/core/objectivePuzzles';
import { buildDailyScenario, buildScenario, SCENARIO_META, SCENARIOS, scenarioSetup, startMatch } from '../../src/core/scenarios';
import { NEUTRAL, type BotType, type MatchState, type PlayerType } from '../../src/core/types';
import { DEFAULT_SETUP, isMatchState, loadSetup, setupToSettings, type SetupPrefs } from '../../src/storage';

const DARK = ['landing', 'moonvale', 'fireflies'] as const;

function distances(s: MatchState, from: number): number[] {
  const d = Array<number>(s.field.cells.length).fill(Infinity);
  d[from] = 0;
  const q = [from];
  for (const i of q) for (const j of s.field.adj[i]) if (d[j] === Infinity) (d[j] = d[i] + 1), q.push(j);
  return d;
}

const seatsOf = (n: number): PlayerType[] => ['human', ...Array<PlayerType>(n - 1).fill('hunter')];

describe('frontier victory and signal fires in the dark scenarios', () => {
  it('exactly the absolute-darkness scenarios offer both modes', () => {
    const offering = SCENARIOS.filter((id) => SCENARIO_META[id].configurable?.modes.includes('frontier'));
    expect(offering.sort()).toEqual([...DARK].sort());
    expect([...FRONTIER_SCENARIOS].sort()).toEqual([...DARK].sort());
    for (const id of offering) {
      expect(SCENARIO_META[id].blind).toBe(true);
      expect(SCENARIO_META[id].configurable!.modes).toContain('signalFires');
    }
  });

  for (const id of DARK) {
    it(`${id}: the same map with 3–9 contested points, held for the chosen count`, () => {
      const [min, max] = SCENARIO_META[id].configurable!.seats;
      for (const size of ['L', 'XXL'] as const) {
        for (const n of [min, max]) {
          for (const points of [3, 5, 9]) {
            const seed = 7 + points + n;
            const players = seatsOf(n);
            const plain = buildScenario(id, seed, undefined, players, { size });
            const win = points === 5 ? 2 : undefined;
            const st = buildScenario(id, seed, undefined, players, { size, frontierMode: true, frontierPoints: points, frontierWin: win });
            // the map, the starts and the dice are untouched
            expect(st.field.cells.map((c) => [c.owner, c.power, c.maxPower])).toEqual(plain.field.cells.map((c) => [c.owner, c.power, c.maxPower]));
            expect(st.seed).toBe(plain.seed);
            const ids = st.objectives!;
            expect(ids).toHaveLength(points);
            expect(new Set(ids).size).toBe(points);
            for (const i of ids) expect(st.field.cells[i].owner).toBe(NEUTRAL);
            // every seat can reach every point
            for (let seat = 0; seat < n; seat++) {
              const from = st.field.cells.findIndex((c) => c.owner === seat);
              const d = distances(st, from);
              for (const i of ids) expect(Number.isFinite(d[i])).toBe(true);
            }
            expect(st.settings).toMatchObject({ puzzle: id, blind: true, frontierMode: true, frontierPointCount: points });
            expect(objectiveWinCount(st)).toBe(win ?? Math.floor(points / 2) + 1);
            expect(isMatchState(JSON.parse(JSON.stringify(st)))).toBe(true);
            expect(plain.objectives).toBeUndefined();
          }
        }
      }
    });

    it(`${id}: signal fires can be lit from the first turn`, () => {
      const st = buildScenario(id, 3, undefined, undefined, { signalFires: true });
      expect(st.settings).toMatchObject({ darkness: true, blind: true, signalFires: true });
      const mine = st.field.cells.findIndex((c) => c.owner === st.current);
      expect(canLightSignalFire(st, mine)).toBe(true);
      expect(isMatchState(JSON.parse(JSON.stringify(st)))).toBe(true);
      expect(buildScenario(id, 3).settings.signalFires).toBeUndefined();
    });
  }

  it('other scenarios and the maps of the day never take the modes', () => {
    for (const id of ['raid', 'olympus', 'titans', 'sparks'] as const) {
      expect(scenarioSetup(id, { frontierMode: true, signalFires: true })).toMatchObject({ frontier: null, signalFires: false });
      const st = buildScenario(id, 5, undefined, undefined, { frontierMode: true, signalFires: true });
      expect(st.settings.frontierMode).toBeUndefined();
      expect(st.settings.signalFires).toBeUndefined();
    }
    for (const id of DARK) {
      const day = buildDailyScenario(id, 11);
      expect(day.settings.frontierMode).toBeUndefined();
      expect(day.objectives).toBeUndefined();
    }
    // a forged state: generated points in a scenario that does not offer them, or on a map of the day
    expect(frontierGenerated({ frontierMode: true, puzzle: 'raid', kind: 'single' })).toBe(false);
    expect(frontierGenerated({ frontierMode: true, puzzle: 'moonvale', kind: 'daily' })).toBe(false);
    expect(frontierGenerated({ frontierMode: true, puzzle: 'moonvale', kind: 'battleOnline' })).toBe(true);
    const st = buildScenario('moonvale', 5, undefined, undefined, { frontierMode: true });
    const forged = { ...st, settings: { ...st.settings, puzzle: 'raid' } };
    expect(validObjectiveFields(forged as never, st.field.cells, 3, forged.settings as never)).toBe(false);
  });

  it('under exploration fog the points are on the map from the start, their holders are not', () => {
    const st = buildScenario('fireflies', 9, undefined, undefined, { frontierMode: true, frontierPoints: 4 });
    explore(st);
    const known = exploredCells(st, 0)!;
    for (const i of st.objectives!) expect(known[i]).toBe(1);
    // the rest of the map is still unknown
    expect(known.reduce((a, b) => a + b, 0)).toBeLessThan(st.field.cells.length / 2);
  });

  for (const id of DARK) {
    it(`${id}: bots play frontier matches with fires, and the points decide them`, async () => {
      const reasons: string[] = [];
      for (const seed of [31, 32, 33, 34]) {
        const st = buildScenario(id, seed, undefined, ['human', 'hunter', 'hunter'], { size: 'L', frontierMode: true, frontierPoints: 3, signalFires: true });
        const drivers: BotType[] = ['hunter', 'hunter', 'hunter'];
        const res = await runMatch(st.settings, { state: st, seed, bots: drivers.map((d, i) => createBot(d, { seed: seed * 10 + i })), maxRounds: 150, checkInvariants: true });
        reasons.push(res.state.ended?.reason ?? 'capped');
      }
      expect(reasons.filter((r) => r === 'objective').length).toBeGreaterThanOrEqual(2);
    }, 60000);
  }
});

describe('the setup of a dark scenario', () => {
  const mem = new Map<string, string>();
  beforeEach(() => {
    mem.clear();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    };
  });

  it('passes the chosen modes to the match, alone and online', () => {
    const s: SetupPrefs = {
      ...DEFAULT_SETUP,
      scenario: 'moonvale',
      scenarioConfig: { moonvale: { size: 'XL', frontierMode: true, frontierPoints: 5, frontierWin: 4, signalFires: true } },
    };
    const settings = setupToSettings(s);
    expect(settings).toMatchObject({ puzzle: 'moonvale', size: 'XL', signalFires: true, frontierMode: true, frontierPointCount: 5, frontierWinCount: 4 });
    for (const kind of ['single', 'battleOnline'] as const) {
      const st = startMatch({ ...settings, kind }, 77);
      expect(st.objectives).toHaveLength(5);
      expect(objectiveWinCount(st)).toBe(4);
      expect(st.settings).toMatchObject({ kind, signalFires: true, frontierMode: true });
    }
    // switched off: the scenario as designed
    const off = setupToSettings({ ...s, scenarioConfig: { moonvale: { frontierMode: false, frontierPoints: 5 } } });
    expect(off.frontierMode).toBeUndefined();
    expect(off.signalFires).toBeUndefined();
    expect(startMatch(off, 77).objectives).toBeUndefined();
  });

  it('keeps the choices over a reload, only where they are offered', () => {
    mem.set(
      'infweb.setup',
      JSON.stringify({
        ...DEFAULT_SETUP,
        rev: 99,
        scenarioConfig: {
          fireflies: { frontierMode: true, frontierPoints: 7, frontierWin: 4, signalFires: true },
          landing: { frontierMode: true, frontierPoints: 42, signalFires: 'yes' },
          olympus: { frontierMode: true, signalFires: true },
        },
      }),
    );
    const c = loadSetup().scenarioConfig;
    expect(c.fireflies).toEqual({ frontierMode: true, frontierPoints: 7, frontierWin: null, signalFires: true });
    expect(c.landing).toEqual({ frontierMode: true });
    expect(c.olympus).toEqual({});
  });
});
