import { beforeEach, describe, expect, it } from 'vitest';
import { buildScenario, SCENARIO_META, scenarioKnob, startMatch, TUNING } from '../../src/core/scenarios';
import { createMatch } from '../../src/core/engine';
import { articulationPoints } from '../../src/core/connectivity';
import { seatsMedal } from '../../src/medals';
import { DEFAULT_SETUP, loadSetup, saveSetup, setupPlayers, setupToSettings } from '../../src/storage';
import { createDailyMatch, dailyKind, dayId } from '../../src/daily';
import type { FieldSize, MatchState, PlayerType } from '../../src/core/types';

/**
 * Room of a seat at the start: the empty grey cells (power 0) next to its land, the armed grey ones
 * next to it, and the empty cells it can reach within two steps through empty cells.
 */
function room(st: MatchState, seat: number) {
  const { cells, adj } = st.field;
  const own = cells.flatMap((c, i) => (c.owner === seat ? [i] : []));
  const empty = (i: number) => cells[i].owner < 0 && cells[i].power === 0;
  const free = new Set<number>();
  const armed = new Set<number>();
  for (const i of own)
    for (const n of adj[i]) {
      if (empty(n)) free.add(n);
      else if (cells[n].owner < 0) armed.add(n);
    }
  const dist = new Map(own.map((i) => [i, 0]));
  const queue = [...own];
  while (queue.length) {
    const v = queue.shift()!;
    if (dist.get(v)! >= 2) continue;
    for (const n of adj[v])
      if (!dist.has(n) && empty(n)) {
        dist.set(n, dist.get(v)! + 1);
        queue.push(n);
      }
  }
  return { free: free.size, armed: armed.size, room2: dist.size - own.length };
}

const lineUp = (n: number): PlayerType[] => SCENARIO_META.landing.players.slice(0, n);

describe('night drop: fair drops', () => {
  it('every squad has the same open ground around it: empty cells to spread into, no ruin or wall in the way', () => {
    for (const size of ['L', 'XL', 'XXL'] as FieldSize[])
      for (const n of [3, 4, 5, 6])
        for (let seed = 1; seed <= 12; seed++) {
          const st = buildScenario('landing', seed * 7919 + n, undefined, lineUp(n), { size });
          const rooms = st.settings.players.map((_, p) => room(st, p));
          const tag = `${size} ${n} seats, seed ${seed}`;
          for (const r of rooms) {
            expect(r.free, tag).toBeGreaterThanOrEqual(6);
            expect(r.armed, tag).toBe(0);
          }
          // the same number of empty neighbours for everybody, and comparable room two steps out
          expect(new Set(rooms.map((r) => r.free)).size, tag).toBe(1);
          const two = rooms.map((r) => r.room2);
          expect(Math.max(...two) / Math.min(...two), tag).toBeLessThanOrEqual(1.5);
          // three cells each, nobody touching anybody
          for (let p = 0; p < n; p++) expect(st.field.cells.filter((c) => c.owner === p), tag).toHaveLength(3);
          st.field.cells.forEach((c, i) => {
            if (c.owner >= 0) for (const j of st.field.adj[i]) expect([-1, c.owner], tag).toContain(st.field.cells[j].owner);
          });
        }
  }, 60_000);

  it('the size picks the land: L < XL < XXL, still with ruins, lakes and walls and no cut cells', () => {
    const avg = (size: FieldSize) => {
      let cells = 0;
      for (let seed = 1; seed <= 8; seed++) {
        const st = buildScenario('landing', seed * 31, undefined, undefined, { size });
        expect(st.settings.size).toBe(size);
        expect(articulationPoints(st.field.adj)).toEqual([]);
        expect(st.field.walls.length).toBeGreaterThan(5);
        expect(st.field.cells.filter((c) => c.owner < 0 && c.power > 0).length).toBeGreaterThan(5);
        cells += st.field.cells.length;
      }
      return cells / 8;
    };
    const [l, xl, xxl] = [avg('L'), avg('XL'), avg('XXL')];
    expect(l).toBeGreaterThan(120);
    expect(xl).toBeGreaterThan(l + 25);
    expect(xxl).toBeGreaterThan(xl + 60);
    // a size the scenario does not offer falls back to its own
    expect(buildScenario('landing', 3, undefined, undefined, { size: 'S' }).settings.size).toBe('XL');
  }, 30_000);

  it('the default is the recommended night drop; seats, size and unions come from the settings', () => {
    expect(buildScenario('landing', 9).settings).toMatchObject({ size: 'XL', unions: false, darkness: true, blind: true });
    expect(scenarioKnob('landing')).toBe(TUNING.landing);
    const st = startMatch({ ...buildScenario('landing', 9).settings, size: 'XXL', unions: true, players: lineUp(4) }, 9);
    expect(st.settings).toMatchObject({ size: 'XXL', unions: true, darkness: true, blind: true, puzzle: 'landing' });
    expect(st.settings.players).toEqual(lineUp(4));
    expect(() => buildScenario('landing', 9, undefined, lineUp(2))).toThrow();
    // a fixed scenario ignores both
    const titans = startMatch({ ...buildScenario('titans', 4).settings, size: 'XXL', unions: false }, 4);
    expect(titans.settings).toMatchObject({ size: 'L', unions: true });
  });

  it('the night drop of the day plays the default set-up', () => {
    for (let d = 0, found = 0; found < 3 && d < 400; d++) {
      const id = dayId(new Date(2026, 9, 25 + d));
      const k = dailyKind(id);
      if (k.kind !== 'puzzle' || k.scenario !== 'landing') continue;
      found++;
      const st = createDailyMatch(id);
      expect(st.settings).toMatchObject({ size: 'XL', unions: false, players: SCENARIO_META.landing.players });
    }
  });
});

describe('generated maps in darkness', () => {
  it('every start has empty neighbours; mirrored and rotational maps give everybody the same room', () => {
    for (const size of ['S', 'M', 'L', 'XL', 'XXL'] as FieldSize[])
      for (const symmetry of [false, true])
        for (const n of [2, 3, 4, 5, 6])
          for (let seed = 1; seed <= 6; seed++) {
            const players: PlayerType[] = ['human', ...Array<PlayerType>(n - 1).fill('master')];
            const st = createMatch(
              { kind: 'single', size, players, darkness: true, symmetry, crowded: false, unions: false, shuffle: false, duelRules: false },
              { seed: seed * 104729 + n },
            );
            const rooms = players.map((_, p) => room(st, p));
            const tag = `${size} sym=${symmetry} ${n}, seed ${seed}`;
            for (const r of rooms) {
              expect(r.free, tag).toBeGreaterThanOrEqual(2);
              expect(r.armed, tag).toBe(0);
            }
            if (symmetry) {
              const two = rooms.map((r) => r.room2);
              expect(Math.max(...two) / Math.min(...two), tag).toBeLessThanOrEqual(1.25);
            }
          }
  }, 60_000);
});

describe('night drop: medals of a configurable scenario', () => {
  const rec = SCENARIO_META.landing.players;
  it('count on any size and with or without unions: only the opponents matter', () => {
    expect(seatsMedal('landing', rec)).toBe('medal');
    // seats are not places on the map: the order does not matter
    expect(seatsMedal('landing', ['human', 'hunter', 'hunter', 'master', 'master', 'god'])).toBe('medal');
    expect(seatsMedal('landing', ['human', 'god', 'god', 'god', 'god', 'god'])).toBe('gold');
    expect(seatsMedal('landing', ['human', 'god', 'master', 'hunter', 'master', 'dummy'])).toBe('weaker');
    expect(seatsMedal('landing', ['human', 'master', 'master', 'hunter', 'master', 'hunter'])).toBe('weaker');
    expect(seatsMedal('landing', ['human', 'god', 'master', 'online', 'master', 'hunter'])).toBe('people');
  });

  it('with fewer seats the opponents face the strongest recommended ones', () => {
    expect(seatsMedal('landing', ['human', 'god', 'master'])).toBe('medal');
    expect(seatsMedal('landing', ['human', 'master', 'god'])).toBe('medal');
    expect(seatsMedal('landing', ['human', 'master', 'master'])).toBe('weaker');
    expect(seatsMedal('landing', ['human', 'god', 'hunter'])).toBe('weaker');
    expect(seatsMedal('landing', ['human', 'god', 'master', 'master'])).toBe('medal');
    expect(seatsMedal('landing', ['human', 'god', 'master', 'hunter'])).toBe('weaker');
    expect(seatsMedal('landing', ['human', 'god', 'master', 'master', 'hunter'])).toBe('medal');
    expect(seatsMedal('landing', ['human', 'god', 'god'])).toBe('gold');
  });

  it('a fixed scenario still compares seat by seat and needs every seat', () => {
    const olympus = SCENARIO_META.olympus.players;
    expect(seatsMedal('olympus', olympus)).toBe('medal');
    expect(seatsMedal('olympus', olympus.slice(0, 4))).toBe('weaker');
  });
});

describe('night drop: set-up prefs', () => {
  const mem = new Map<string, string>();
  beforeEach(() => {
    mem.clear();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    };
  });

  it('size, unions and the number of seats persist and reach the match', () => {
    saveSetup({
      ...DEFAULT_SETUP,
      scenario: 'landing',
      scenarioSeats: { landing: ['human', 'god', 'master', 'hunter'] },
      scenarioConfig: { landing: { size: 'XXL', unions: true } },
    });
    const s = loadSetup();
    expect(setupPlayers(s)).toEqual(['human', 'god', 'master', 'hunter']);
    const settings = setupToSettings(s);
    expect(settings).toMatchObject({ puzzle: 'landing', size: 'XXL', unions: true, darkness: true, blind: true });
    const st = startMatch(settings, 12);
    expect(st.settings).toMatchObject({ size: 'XXL', unions: true });
    expect(st.settings.players).toHaveLength(4);
    expect(st.field.cells.length).toBeGreaterThan(240);
  });

  it('old prefs load with the defaults; choices a scenario does not offer are dropped', () => {
    mem.set('infweb.setup', JSON.stringify({ size: 'M', players: ['human', 'hunter'], scenario: 'landing', scenarioSeats: { landing: rec6() } }));
    let s = loadSetup();
    expect(s.scenarioConfig).toEqual({});
    expect(setupToSettings(s)).toMatchObject({ size: 'XL', unions: false });
    mem.set(
      'infweb.setup',
      JSON.stringify({
        ...DEFAULT_SETUP,
        scenario: 'landing',
        scenarioSeats: { landing: ['human', 'god'], olympus: ['human', 'god', 'god'] },
        scenarioConfig: { landing: { size: 'S', unions: 'yes' }, titans: { size: 'XXL', unions: false }, nope: { size: 'L' } },
      }),
    );
    s = loadSetup();
    expect(s.scenarioSeats).toEqual({});
    expect(s.scenarioConfig).toEqual({ landing: {} });
    expect(setupToSettings(s)).toMatchObject({ size: 'XL', unions: false });
    expect(setupToSettings({ ...s, scenario: 'titans' })).toMatchObject({ size: 'L', unions: true });
  });
});

function rec6(): PlayerType[] {
  return [...SCENARIO_META.landing.players];
}
