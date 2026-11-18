import { describe, expect, it } from 'vitest';
import { buildScenario, isScenarioId, SCENARIOS } from '../../src/core/scenarios';
import { canAttackFrom, visibleCells } from '../../src/core/engine';
import type { Field } from '../../src/core/types';

const additions = ['farshore', 'moonvale', 'sparks', 'fireflies', 'crossroads', 'highlands', 'pinwheel'] as const;
const seeds = [1, 19, 42, 87, 131, 977];
const owned = (f: Field, p: number) => f.cells.flatMap((c, i) => c.owner === p ? [i] : []);

function distances(f: Field, starts: number[]) {
  const dist = f.cells.map(() => Infinity);
  const queue = [...starts];
  for (const i of starts) dist[i] = 0;
  for (let n = 0; n < queue.length; n++) {
    const i = queue[n];
    for (const j of f.adj[i]) if (dist[j] === Infinity) {
      dist[j] = dist[i] + 1;
      queue.push(j);
    }
  }
  return dist;
}

describe('new scenario designs', () => {
  it('offers 32 different scenarios and still builds retired boards for past games', () => {
    expect(SCENARIOS).toHaveLength(32);
    expect(new Set(SCENARIOS).size).toBe(32);
    for (const id of additions) expect(isScenarioId(id)).toBe(true);
    for (const id of ['bridges', 'treasury', 'hourglass'] as const) {
      expect(isScenarioId(id)).toBe(false);
      expect(buildScenario(id, 1).settings.puzzle).toBe(id);
    }
  });

  for (const id of additions) it(`${id}: each seat has a playable opening`, () => {
    for (const seed of seeds) {
      const st = buildScenario(id, seed);
      for (const p of st.settings.players.keys()) expect(owned(st.field, p).some(i => canAttackFrom(st, i))).toBe(true);
      if (id !== 'crossroads' && id !== 'highlands') expect(st.objectives).toBeUndefined();
    }
  });

  it('farshore: a tight home base and detached strong and weak holdings for each side', () => {
    for (const seed of seeds) {
      const { field: f, settings } = buildScenario('farshore', seed);
      for (const p of settings.players.keys()) {
        const mine = owned(f, p);
        const base = mine.find(i => f.adj[i].filter(j => f.cells[j].owner === p).length === 6)!;
        expect(base).toBeDefined();
        const d = distances(f, [base]);
        const away = mine.filter(i => d[i] > 1);
        expect(away.every(i => d[i] >= 4)).toBe(true);
        expect(away.some(i => f.cells[i].power <= 2)).toBe(true);
        expect(away.some(i => f.cells[i].power >= 5)).toBe(true);
      }
    }
  });

  for (const id of ['moonvale', 'fireflies'] as const) it(`${id}: scouts light separate patches in the dark`, () => {
    for (const seed of seeds) {
      const st = buildScenario(id, seed);
      const f = st.field;
      expect(st.settings.darkness).toBe(true);
      for (const p of st.settings.players.keys()) {
        const mine = owned(f, p);
        const scouts = mine.filter(i => f.cells[i].power <= 2);
        expect(scouts.length).toBe(id === 'moonvale' ? 1 : mine.length);
        if (id === 'fireflies') expect(scouts.length).toBeGreaterThanOrEqual(3);
        for (const i of scouts) {
          const d = distances(f, [i]);
          expect(mine.every(j => i === j || d[j] >= 3)).toBe(true);
        }
        if (id === 'moonvale') {
          const squad = mine.filter(i => !scouts.includes(i));
          expect(squad.length).toBeGreaterThanOrEqual(3);
          expect(squad.every(i => f.cells[i].power >= 5 && squad.some(j => f.adj[i].includes(j)))).toBe(true);
        }
        const vision = visibleCells(st, p);
        expect(f.cells.some((c, i) => c.owner >= 0 && c.owner !== p && !vision[i])).toBe(true);
      }
    }
  });

  it('sparks: no grey land or other modes, every seat gets the same mix of power and capacity', () => {
    for (const seed of seeds) {
      const { field: f, settings } = buildScenario('sparks', seed);
      expect(settings).toMatchObject({ crowded: true, darkness: false, unions: false });
      expect(f.cells.every(c => c.owner >= 0)).toBe(true);
      const hand = (p: number) => owned(f, p).map(i => `${f.cells[i].power}/${f.cells[i].maxPower}`).sort();
      for (const p of settings.players.keys()) {
        expect(hand(p)).toEqual(hand(0));
        expect(owned(f, p).some(i => f.cells[i].power <= 2)).toBe(true);
        expect(owned(f, p).some(i => f.cells[i].power >= 6)).toBe(true);
      }
    }
  });

  for (const id of ['crossroads', 'highlands'] as const) it(`${id}: three separated, accessible, seed-varying objectives`, () => {
    const layouts = new Set<string>();
    for (const seed of seeds) {
      const st = buildScenario(id, seed);
      const f = st.field;
      const marks = st.objectives!;
      expect(marks).toHaveLength(3);
      expect(f.w).toBeGreaterThanOrEqual(12);
      expect(marks).toEqual(buildScenario(id, seed).objectives);
      layouts.add(JSON.stringify(marks.map(i => [f.cells[i].x, f.cells[i].y])));
      const routes = st.settings.players.map((_, p) => distances(f, owned(f, p)));
      for (const i of marks) {
        expect(f.cells[i].owner).toBe(-1);
        expect(f.adj[i].length).toBeGreaterThanOrEqual(4);
        const d = distances(f, [i]);
        expect(marks.filter(j => d[j] >= 4)).toHaveLength(2);
        const approach = routes.map(route => route[i]).sort((a, b) => a - b);
        expect(approach.every(n => n >= 3 && Number.isFinite(n))).toBe(true);
        expect(approach[1] - approach[0]).toBeLessThanOrEqual(2);
      }
    }
    expect(layouts.size).toBeGreaterThan(2);
  });

  it('pinwheel: every column can strike the weak rear of a different rival on turn one', () => {
    for (const seed of seeds) {
      const { field: f, settings } = buildScenario('pinwheel', seed);
      const victims = settings.players.map((_, p) => new Set(owned(f, p).filter(i => f.cells[i].power >= 5)
        .flatMap(i => f.adj[i]).map(j => f.cells[j]).filter(c => c.owner >= 0 && c.owner !== p && c.power <= 2).map(c => c.owner)));
      expect(victims.map(s => s.size)).toEqual([1, 1, 1]);
      expect(new Set(victims.flatMap(s => [...s])).size).toBe(3);
    }
  });
});
