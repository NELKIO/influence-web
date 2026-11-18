import { describe, expect, it } from 'vitest';
import { buildScenario, isScenarioId, SCENARIOS } from '../../src/core/scenarios';
import { canAttackFrom, exploredCells, visibleCells } from '../../src/core/engine';
import { hexNeighbours } from '../../src/core/field';
import type { Field } from '../../src/core/types';

const additions = ['moonvale', 'fireflies', 'crossroads', 'highlands', 'colonies', 'farshore', 'sparks', 'pinwheel'] as const;
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

function normalizedShape(f: Field) {
  const axial = f.cells.map(c => [c.x - Math.floor(c.y / 2), c.y] as const);
  const shapes = Array.from({ length: 6 }, (_, turn) => {
    const points = axial.map(([q, r]) => {
      for (let i = 0; i < turn; i++) [q, r] = [-r, q + r];
      return [q, r];
    });
    const minQ = Math.min(...points.map(([q]) => q));
    const minR = Math.min(...points.map(([, r]) => r));
    return JSON.stringify(points.map(([q, r]) => `${q - minQ},${r - minR}`).sort());
  });
  return shapes.sort()[0];
}

function components(f: Field, p: number): number[][] {
  const remaining = new Set(owned(f, p));
  const groups: number[][] = [];
  while (remaining.size) {
    const group = [remaining.values().next().value!];
    remaining.delete(group[0]);
    for (let i = 0; i < group.length; i++) for (const j of f.adj[group[i]]) if (remaining.delete(j)) group.push(j);
    groups.push(group);
  }
  return groups.sort((a, b) => b.length - a.length);
}

describe('new scenario designs', () => {
  it('keeps Night Drop first and the entire frontier batch together, while only hiding Thermopylae from the gallery', () => {
    expect(SCENARIOS.slice(0, additions.length + 1)).toEqual(['landing', ...additions]);
    expect(SCENARIOS).not.toContain('thermopylae');
    expect(isScenarioId('thermopylae')).toBe(false); // no longer selectable in the gallery
    expect(buildScenario('thermopylae', 1).settings.puzzle).toBe('thermopylae');
    expect(SCENARIOS).toContain('olympus');
  });

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
      expect(st.settings.blind).toBe(true);
      const known = exploredCells(st, 0);
      expect(known).not.toBeNull();
      expect(known!.filter(Boolean).length).toBeLessThan(f.cells.length / 2);
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

  it('colonies: balanced neighboring cores face an intermingled off-axis patch of small holdings', () => {
    for (const seed of seeds) {
      const { field: f, settings } = buildScenario('colonies', seed);
      expect(settings.players).toHaveLength(2);
      const [ours, theirs] = [components(f, 0), components(f, 1)];
      expect(owned(f, 0).length).toBe(owned(f, 1).length);
      const power = (p: number) => owned(f, p).reduce((sum, i) => sum + f.cells[i].power, 0);
      expect(Math.abs(power(0) - power(1))).toBeLessThanOrEqual(8);
      expect(ours[0].length).toBeGreaterThanOrEqual(7);
      expect(theirs[0].length).toBeGreaterThanOrEqual(7);
      expect(Math.min(...ours[0].map(i => distances(f, theirs[0])[i]))).toBeLessThanOrEqual(3);
      for (const groups of [ours, theirs]) {
        expect(groups.slice(1).length).toBeGreaterThanOrEqual(4);
        expect(groups.slice(1).every(g => g.length <= 2)).toBe(true);
        const far = distances(f, groups[0]);
        expect(groups.slice(1).every(g => g.every(i => far[i] >= 3))).toBe(true);
      }
      const flank = [...ours.slice(1).flat(), ...theirs.slice(1).flat()];
      expect(flank.filter(i => f.adj[i].some(j => f.cells[j].owner >= 0 && f.cells[j].owner !== f.cells[i].owner)).length)
        .toBeGreaterThanOrEqual(4);
    }
  });

  it('crossroads and highlands: distinct terrain shapes, not just rotated objective markers', () => {
    for (const id of ['crossroads', 'highlands'] as const) {
      const shapes = new Set(Array.from({ length: 18 }, (_, seed) => normalizedShape(buildScenario(id, seed * 37 + 1).field)));
      expect(shapes.size, id).toBeGreaterThanOrEqual(8);
    }
  });

  it('crossroads changes its inner banks, not just the perimeter', () => {
    const bankProfiles = new Set(Array.from({ length: 24 }, (_, seed) => {
      const f = buildScenario('crossroads', seed * 37 + 1).field;
      const midX = Math.floor((f.w - 2) / 2);
      const occupiedRows = new Set(f.cells.filter(c => c.x === midX).map(c => c.y));
      const first = Math.min(...occupiedRows), last = Math.max(...occupiedRows);
      const midY = (first + last) / 2;
      return Array.from({ length: last - first + 1 }, (_, i) => first + i)
        .filter(y => !occupiedRows.has(y)).map(y => y - midY).join(',');
    }));
    expect(bankProfiles.size).toBeGreaterThanOrEqual(3);
  });

  it('highlands rolls both a single basin and additional inland sinkholes', () => {
    const basins = Array.from({ length: 24 }, (_, seed) => {
      const f = buildScenario('highlands', seed * 37 + 1).field;
      const key = (x: number, y: number) => `${x},${y}`;
      const land = new Set(f.cells.map(c => key(c.x, c.y)));
      const empty = new Map<string, [number, number]>();
      for (let x = -1; x <= f.w; x++) for (let y = -1; y <= f.h; y++) {
        if (!land.has(key(x, y))) empty.set(key(x, y), [x, y]);
      }
      let inland = 0;
      while (empty.size) {
        const first = empty.values().next().value!;
        const queue = [first];
        empty.delete(key(...first));
        let reachesEdge = false;
        for (const [x, y] of queue) {
          if (x === -1 || y === -1 || x === f.w || y === f.h) reachesEdge = true;
          for (const n of hexNeighbours(x, y)) if (empty.delete(key(...n))) queue.push(n);
        }
        if (!reachesEdge) inland++;
      }
      return inland;
    });
    expect(basins).toContain(1);
    expect(basins.some(n => n > 1)).toBe(true);
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
