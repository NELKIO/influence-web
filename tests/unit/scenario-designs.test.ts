import { describe, expect, it } from 'vitest';
import { buildDailyScenario, buildScenario, isScenarioId, SCENARIO_META, SCENARIOS, seatsFit } from '../../src/core/scenarios';
import { canAttackFrom, exploredCells, visibleCells } from '../../src/core/engine';
import { hexNeighbours } from '../../src/core/field';
import { articulationPoints } from '../../src/core/connectivity';
import { OBJECTIVE_PUZZLES } from '../../src/core/objectivePuzzles';
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
      if (!OBJECTIVE_PUZZLES.has(id)) expect(st.objectives).toBeUndefined();
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
        // fireflies: one of your scouts is a little stronger
        const scouts = mine.filter(i => f.cells[i].power <= (id === 'fireflies' && p === 0 ? 3 : 2));
        expect(scouts.length).toBe(id === 'moonvale' ? 1 : mine.length);
        if (id === 'fireflies') expect(mine.filter(i => f.cells[i].power === 3).length).toBe(p === 0 ? 1 : 0);
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
      expect(settings).toMatchObject({ crowded: false, darkness: false, unions: false });
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
      // the difficulty knob only weakens your base; at the neutral knob both sides are equal
      const handicapped = buildScenario('colonies', seed).field;
      const { field: f, settings } = buildScenario('colonies', seed, 7);
      expect(settings.players).toHaveLength(2);
      expect(handicapped.cells.map(c => c.owner)).toEqual(f.cells.map(c => c.owner));
      handicapped.cells.forEach((c, i) => {
        if (c.owner === 1) expect(c.power).toBe(f.cells[i].power);
        if (c.owner === 0) expect(c.power).toBeLessThanOrEqual(f.cells[i].power);
      });
      const [ours, theirs] = [components(f, 0), components(f, 1)];
      expect(owned(f, 0).length).toBe(owned(f, 1).length);
      const power = (p: number) => owned(f, p).reduce((sum, i) => sum + f.cells[i].power, 0);
      expect(Math.abs(power(0) - power(1))).toBeLessThanOrEqual(8);
      expect(ours[0].length).toBeGreaterThanOrEqual(7);
      expect(theirs[0].length).toBeGreaterThanOrEqual(7);
      expect(Math.min(...ours[0].map(i => distances(f, theirs[0])[i]))).toBeLessThanOrEqual(3);
      for (const groups of [ours, theirs]) {
        expect(groups.slice(1).length).toBeGreaterThanOrEqual(3);
        expect(groups.slice(1).every(g => g.length < groups[0].length / 2)).toBe(true);
        const far = distances(f, groups[0]);
        expect(groups.slice(1).every(g => g.every(i => far[i] >= 3))).toBe(true);
      }
      const flank = [...ours.slice(1).flat(), ...theirs.slice(1).flat()];
      expect(flank.filter(i => f.adj[i].some(j => f.cells[j].owner >= 0 && f.cells[j].owner !== f.cells[i].owner)).length)
        .toBeGreaterThanOrEqual(4);
    }
  });

  it('rerolls give distinct terrain shapes, not just rotated objective markers', () => {
    for (const id of ['crossroads', 'highlands', 'colonies', 'olympus', 'sparks'] as const) {
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

  it('highlands rolls an open plateau, an enclosed lake basin and separate inland sinkholes', () => {
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
    expect(basins).toContain(0);
    expect(basins).toContain(1);
    expect(basins.some(n => n > 1)).toBe(true);
  });

  it('sparks rerolls into different terrain silhouettes and clustered high-power fronts', () => {
    const shapes = new Set<string>();
    for (let seed = 1; seed <= 24; seed++) {
      const st = buildScenario('sparks', seed * 37), f = st.field;
      shapes.add(normalizedShape(f));
      for (const p of [0, 1, 2]) {
        const hot = owned(f, p).filter(i => f.cells[i].power >= 6);
        expect(hot.length).toBeGreaterThanOrEqual(3);
        // power gathers in compact hotspots (no lone strong cell), and most of the land (but the spark) stays weak
        expect(hot.every(i => f.adj[i].some(j => f.cells[j].power >= 6))).toBe(true);
        expect(owned(f, p).filter(i => f.cells[i].power <= 2 || st.objectives!.includes(i)).length).toBeGreaterThanOrEqual(2 * hot.length);
      }
    }
    expect(shapes.size).toBeGreaterThanOrEqual(3);
  });

  it('colonies fills the far flank with a dense mixed deal rather than separated pairs', () => {
    for (const seed of seeds) {
      const f = buildScenario('colonies', seed).field;
      const [a, b] = [components(f, 0)[0], components(f, 1)[0]];
      const flank = f.cells.flatMap((c, i) => c.owner >= 0 && !a.includes(i) && !b.includes(i) ? [i] : []);
      expect(flank.length).toBeGreaterThanOrEqual(24);
      expect(flank.filter(i => f.adj[i].some(j => flank.includes(j) && f.cells[j].owner !== f.cells[i].owner)).length)
        .toBeGreaterThanOrEqual(16);
    }
  });

  for (const id of ['moonvale', 'fireflies'] as const) it(`${id}: L/XL/XXL and 2–6 seats scale playable scout land`, () => {
    const meta = SCENARIO_META[id];
    expect(meta.configurable).toEqual({ sizes: ['L', 'XL', 'XXL'], seats: [2, 6], modes: [] });
    expect(seatsFit(id, 2)).toBe(true);
    expect(seatsFit(id, 6)).toBe(true);
    for (const size of ['L', 'XL', 'XXL'] as const) {
      const areas: number[] = [];
      for (const n of [2, 3, 6]) {
        const players = Array.from({ length: n }, (_, p) => meta.players[p % meta.players.length]);
        // playability of the land itself, without the first round's turn-order compensation
        const st = buildScenario(id, 117, undefined, players, { size, unions: true, orderComp: 'off' });
        const f = st.field;
        expect(st.settings).toMatchObject({ size, darkness: true, blind: true, unions: false });
        expect(buildScenario(id, 117, undefined, players, { size, orderComp: 'off' }).field).toEqual(f);
        expect(distances(f, [0]).every(Number.isFinite)).toBe(true);
        for (let p = 0; p < n; p++) {
          const mine = owned(f, p);
          expect(mine.length).toBe(id === 'moonvale' ? 4 : 3);
          expect(mine.some(i => canAttackFrom(st, i))).toBe(true);
          expect(mine.some(i => f.adj[i].some(j => f.cells[j].owner === -1))).toBe(true);
        }
        areas.push(f.cells.length);
      }
      expect(areas[0]).toBeLessThan(areas[1]);
      expect(areas[1]).toBeLessThan(areas[2]);
    }
    const players = meta.players;
    const sizes = (['L', 'XL', 'XXL'] as const).map(size => buildScenario(id, 117, undefined, players, { size }).field.cells.length);
    expect(sizes[0]).toBeLessThan(sizes[1]);
    expect(sizes[1]).toBeLessThan(sizes[2]);
  });

  for (const id of ['moonvale', 'fireflies'] as const) it(`${id}: wild land of a new shape every launch, not a plain hexagon`, () => {
    for (const n of [2, 3, 6]) {
      const players = Array.from({ length: n }, (_, p) => SCENARIO_META[id].players[p % 3]);
      const shapes = new Set<string>();
      const coast: number[] = [];
      for (let seed = 1; seed <= 12; seed++) {
        const f = buildScenario(id, seed * 31, undefined, players).field;
        shapes.add(normalizedShape(f));
        // cells with fewer than six land neighbours (bays, lakes, headlands), against a plain hexagon
        // of as many cells, whose rim is its only coast
        const land = new Set(f.cells.map(c => `${c.x},${c.y}`));
        const shore = f.cells.filter(c => hexNeighbours(c.x, c.y).some(([x, y]) => !land.has(`${x},${y}`))).length;
        const r = (Math.sqrt(12 * f.cells.length - 3) - 3) / 6;
        coast.push(shore / (6 * r));
      }
      expect(shapes.size, `${id} ${n}`).toBeGreaterThanOrEqual(11);
      expect(Math.min(...coast), `${id} ${n}`).toBeGreaterThanOrEqual(1.3);
      expect(coast.reduce((a, b) => a + b) / coast.length, `${id} ${n}`).toBeGreaterThanOrEqual(1.8);
    }
  });

  it('redesigned maps never hang on a single cell', () => {
    for (const seed of seeds) {
      for (const id of ['sparks', 'highlands', 'colonies'] as const) expect(articulationPoints(buildScenario(id, seed).field.adj), id).toEqual([]);
      for (const id of ['moonvale', 'fireflies'] as const) for (const n of [2, 4, 5, 6]) for (const size of ['L', 'XXL'] as const) {
        const players = Array.from({ length: n }, (_, p) => SCENARIO_META[id].players[p % 3]);
        expect(articulationPoints(buildScenario(id, seed, undefined, players, { size }).field.adj), `${id} ${n} ${size}`).toEqual([]);
      }
    }
  });

  it('keeps published daily frontier and scout layouts exactly frozen', () => {
    const signatures = { moonvale: 'b990d1e3', fireflies: '9d29685d', sparks: 'b4535bf9', colonies: 'fb39f1f6', highlands: 'd5ef452' };
    for (const id of Object.keys(signatures) as (keyof typeof signatures)[]) {
      const st = buildDailyScenario(id, 117);
      const data = JSON.stringify([st.field, st.objectives, st.settings]);
      let hash = 2166136261;
      for (let i = 0; i < data.length; i++) hash = Math.imul(hash ^ data.charCodeAt(i), 16777619) >>> 0;
      expect.soft(hash.toString(16), id).toBe(signatures[id]);
    }
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
