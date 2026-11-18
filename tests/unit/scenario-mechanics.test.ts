import { describe, expect, it } from 'vitest';
import { buildDailyScenario, buildScenario, DAILY_LEGACY_DESC, SCENARIO_META, SCENARIOS, seatsFit, type ScenarioId } from '../../src/core/scenarios';
import { canAttackFrom, endAttack, finishTurn } from '../../src/core/engine';
import { articulationPoints } from '../../src/core/connectivity';
import { OBJECTIVE_PUZZLES } from '../../src/core/objectivePuzzles';
import { isMatchState } from '../../src/storage';
import { createBot } from '../../src/ai';
import { seatsMedal } from '../../src/medals';
import { ru } from '../../src/i18n/ru';
import { en } from '../../src/i18n/en';
import type { Field, MatchState, PlayerType } from '../../src/core/types';

const seeds = [1, 19, 42, 87, 131, 977];
const owned = (f: Field, p: number) => f.cells.flatMap((c, i) => c.owner === p ? [i] : []);
const pass = (s: MatchState) => { endAttack(s); finishTurn(s); };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

function distances(f: Field, starts: number[]) {
  const dist = f.cells.map(() => Infinity);
  const queue = [...starts];
  for (const i of starts) dist[i] = 0;
  for (let n = 0; n < queue.length; n++) for (const j of f.adj[queue[n]]) if (dist[j] === Infinity) {
    dist[j] = dist[queue[n]] + 1;
    queue.push(j);
  }
  return dist;
}

/** The cell's offset from the middle of the map in axial coordinates, as a sortable signature. */
function centred(f: Field) {
  const ax = f.cells.map(c => [c.x - Math.floor(c.y / 2), c.y] as const);
  const mq = (Math.min(...ax.map(a => a[0])) + Math.max(...ax.map(a => a[0]))) / 2;
  const mr = (Math.min(...ax.map(a => a[1])) + Math.max(...ax.map(a => a[1]))) / 2;
  return (i: number) => [ax[i][0] - mq, ax[i][1] - mr] as const;
}

/** Axial position around the mean of all cells, the centre of any turn that maps the land onto itself. */
function centroid(f: Field) {
  const ax = f.cells.map(c => [c.x - Math.floor(c.y / 2), c.y] as const);
  const mq = ax.reduce((s, a) => s + a[0], 0) / ax.length;
  const mr = ax.reduce((s, a) => s + a[1], 0) / ax.length;
  return (i: number) => [ax[i][0] - mq, ax[i][1] - mr] as const;
}

const lineup = (id: ScenarioId, n: number): PlayerType[] => Array.from({ length: n }, (_, p) => p ? SCENARIO_META[id].players[1 + (p - 1) % (SCENARIO_META[id].players.length - 1)] : 'human');

describe('objective puzzles', () => {
  it('the meta flag, the rule set and the built maps agree', () => {
    for (const id of SCENARIOS) {
      expect(!!SCENARIO_META[id].objectives, id).toBe(OBJECTIVE_PUZZLES.has(id));
      expect(!!buildScenario(id, 5).objectives, id).toBe(OBJECTIVE_PUZZLES.has(id));
    }
  });

  it('a gallery game saved before a scenario gained points still loads; the maps of the day keep their rules', () => {
    const st = clone(buildScenario('sparks', 7));
    expect(isMatchState(st)).toBe(true);
    expect(isMatchState({ ...st, objectives: undefined })).toBe(true);
    expect(isMatchState({ ...st, objectives: st.objectives!.slice(0, 2) })).toBe(false);
    const daily = { ...clone(buildDailyScenario('sparks', 7)), settings: { ...st.settings, kind: 'daily' } };
    expect(daily.objectives).toBeUndefined();
    expect(isMatchState(daily)).toBe(true);
    expect(isMatchState({ ...daily, objectives: st.objectives })).toBe(false);
    // the published control-point puzzles always had their points
    const cross = clone(buildScenario('crossroads', 7));
    expect(isMatchState({ ...cross, objectives: undefined })).toBe(false);
  });
});

describe('sparks: hold two sparks on a fully taken map', () => {
  it('each seat owns one buried spark; the three are rotations of each other', () => {
    for (const seed of seeds) {
      const st = buildScenario('sparks', seed);
      const f = st.field;
      expect(SCENARIO_META.sparks).toMatchObject({ objectives: true, varied: true });
      expect(SCENARIO_META.sparks.crowded).toBeFalsy();
      expect(f.cells.every(c => c.owner >= 0)).toBe(true);
      const sparks = st.objectives!;
      expect(sparks).toHaveLength(3);
      expect(sparks.map(i => f.cells[i].owner).sort()).toEqual([0, 1, 2]);
      const cuts = articulationPoints(f.adj);
      for (const i of sparks) {
        const c = f.cells[i];
        expect(cuts).not.toContain(i);
        expect(f.adj[i]).toHaveLength(6);
        // inside its own land: no rival touches it on turn one
        expect(f.adj[i].every(j => f.cells[j].owner === c.owner)).toBe(true);
        expect(`${c.power}/${c.maxPower}`).toBe(`${f.cells[sparks[0]].power}/${f.cells[sparks[0]].maxPower}`);
      }
      const at = centroid(f);
      const radius = (i: number) => { const [q, r] = at(i); return Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)).toFixed(6); };
      expect(new Set(sparks.map(radius)).size).toBe(1);
      // every seat is as far from each rival spark as the others are
      const reach = sparks.map(i => distances(f, [i]));
      const gaps = (p: number) => sparks.filter(i => f.cells[i].owner !== p).map(i => Math.min(...owned(f, p).map(j => reach[sparks.indexOf(i)][j]))).sort();
      for (const p of [1, 2]) expect(gaps(p)).toEqual(gaps(0));
      expect(buildScenario('sparks', seed).objectives).toEqual(sparks);
    }
  });

  it('sparks move between launches', () => {
    const spots = new Set<string>();
    for (let seed = 1; seed <= 16; seed++) {
      const st = buildScenario('sparks', seed * 37);
      const at = centred(st.field);
      const [q, r] = at(st.objectives![0]);
      spots.add(`${Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r))}:${st.field.adj[st.objectives![0]].map(j => st.field.cells[j].power).sort().join('')}`);
    }
    expect(spots.size).toBeGreaterThanOrEqual(5);
  });

  it('holding your spark and a rival one until your next turn wins', () => {
    const st = buildScenario('sparks', 42);
    const [mine, theirs] = [0, 1].map(p => st.objectives!.find(i => st.field.cells[i].owner === p)!);
    st.field.cells[theirs].owner = 0;
    pass(st);
    expect(st.ended).toBeNull();
    pass(st); pass(st);
    expect(st.ended).toMatchObject({ reason: 'objective', winner: 0 });
    expect(st.field.cells[mine].owner).toBe(0);
  });

  it('bots storm an adjacent rival spark and reinforce their own threatened spark', async () => {
    const st = buildScenario('sparks', 42, undefined, ['human', 'hunter', 'master']);
    const f = st.field;
    const target = st.objectives!.find(i => f.cells[i].owner === 0)!;
    const from = f.adj[target][0];
    f.cells[from].owner = 1;
    f.cells[from].power = 12;
    f.cells[from].maxPower = 12;
    st.current = 1;
    const bot = createBot('hunter');
    expect(await bot.nextAttack(st, { speedMs: 0 })).toEqual({ from, to: target });
    // seat 0's spark is now under threat: its income goes to the spark first
    st.current = 0;
    st.phase = 'power';
    st.powerLeft = 3;
    st.field.cells[target].power = 2;
    const adds = await createBot('hunter').placePower(st, { speedMs: 0 });
    expect(adds.get(target)).toBe(3);
    bot.dispose?.();
  });
});

/** Sorted distances from each seat's land to every marked point (walls respected). */
function approach(st: MatchState, p: number) {
  const d = distances(st.field, owned(st.field, p));
  return st.objectives!.map(i => d[i]).sort((a, b) => a - b);
}

describe('olympus: summit points, three to six climbers', () => {
  it('is configurable from three to six seats and plays for the summit', () => {
    expect(SCENARIO_META.olympus).toMatchObject({ objectives: true, configurable: { sizes: ['L', 'XL', 'XXL'], seats: [3, 6], modes: [] } });
    expect([2, 3, 4, 5, 6, 7].map(n => seatsFit('olympus', n))).toEqual([false, true, true, true, true, false]);
    expect(buildDailyScenario('olympus', 5).objectives).toBeUndefined();
    expect(buildDailyScenario('olympus', 5).settings.orderComp).toBeUndefined();
  });

  for (const n of [3, 4, 5, 6]) it(`${n} seats: three neutral summit points, the same camp and the same climb for everyone`, () => {
    for (const seed of seeds) {
      const st = buildScenario('olympus', seed, 3, lineup('olympus', n));
      const f = st.field;
      expect(st.settings.players).toHaveLength(n);
      expect(st.objectives).toHaveLength(3);
      expect(articulationPoints(f.adj)).toEqual([]);
      expect(distances(f, [0]).every(Number.isFinite)).toBe(true);
      const hand = (p: number) => owned(f, p).map(i => f.cells[i].power).sort().join();
      for (let p = 0; p < n; p++) {
        expect(hand(p)).toBe(hand(0));
        expect(owned(f, p).some(i => canAttackFrom(st, i))).toBe(true);
      }
      for (const i of st.objectives!) {
        expect(f.cells[i]).toMatchObject({ owner: -1, maxPower: 12 });
        // the points are up on the walled summit, well away from every camp
        expect(Math.min(...Array.from({ length: n }, (_, p) => approach(st, p)[0]))).toBeGreaterThanOrEqual(3);
      }
      const climbs = Array.from({ length: n }, (_, p) => approach(st, p).join());
      if (n === 5) {
        // five seats cannot be placed symmetrically: no climb may be more than a step longer
        const all = Array.from({ length: n }, (_, p) => approach(st, p));
        for (let k = 0; k < 3; k++) expect(Math.max(...all.map(a => a[k])) - Math.min(...all.map(a => a[k]))).toBeLessThanOrEqual(1);
      } else expect(new Set(climbs).size, `${n} seats, seed ${seed}: ${climbs}`).toBe(1);
      // later seats get the ordinary battle's extra first income
      const bonus = (st.settings.orderComp as { bonus: number[] }).bonus;
      expect(bonus[0]).toBe(0);
      expect(bonus[n - 1]).toBeGreaterThan(0);
    }
  });

  it('fewer climbers get a smaller land; the summit points differ between launches', () => {
    expect(buildScenario('olympus', 3, undefined, lineup('olympus', 3)).field.cells.length)
      .toBeLessThan(buildScenario('olympus', 3, undefined, lineup('olympus', 6)).field.cells.length);
    const layouts = new Set<string>();
    for (let seed = 1; seed <= 12; seed++) {
      const st = buildScenario('olympus', seed * 31, undefined, lineup('olympus', 3));
      const at = centred(st.field);
      layouts.add(st.objectives!.map(i => at(i).map(Math.abs).sort().join(':')).sort().join());
    }
    expect(layouts.size).toBeGreaterThanOrEqual(2);
  });

  it('medals count the strongest opponents, wherever the person sits', () => {
    expect(seatsMedal('olympus', ['human', 'god', 'master'])).toBe('medal');
    expect(seatsMedal('olympus', ['human', 'master', 'master'])).toBe('weaker');
    expect(seatsMedal('olympus', ['god', 'human', 'god', 'god'])).toBe('gold');
  });
});

describe('maps of the day that kept an older design', () => {
  it('keep their old description, in both languages', () => {
    for (const id of DAILY_LEGACY_DESC) for (const dict of [ru, en] as Record<string, string>[]) {
      expect(dict[`puzzleDescDaily_${id}`], id).toBeTruthy();
      expect(dict[`puzzleDescDaily_${id}`]).not.toBe(dict[`puzzleDesc_${id}`]);
    }
    for (const id of ['sparks', 'olympus'] as const) expect(DAILY_LEGACY_DESC.has(id)).toBe(true);
  });
});

describe('highlands: two to six camps, summits and passes in new places every launch', () => {
  it('is configurable from two to six seats', () => {
    expect(SCENARIO_META.highlands).toMatchObject({ objectives: true, varied: true, configurable: { sizes: ['L', 'XL', 'XXL'], seats: [2, 6], modes: [] } });
    expect([1, 2, 6, 7].map(n => seatsFit('highlands', n))).toEqual([false, true, true, false]);
    expect(seatsMedal('highlands', ['human', 'master'])).toBe('medal');
    expect(seatsMedal('highlands', ['human', 'hunter'])).toBe('weaker');
    expect(DAILY_LEGACY_DESC.has('highlands')).toBe(true);
  });

  for (const n of [2, 3, 4, 5, 6]) it(`${n} seats: three separated summits, the same climb and camp for every seat`, () => {
    const layouts = new Set<string>();
    for (const seed of [...seeds, 5, 6, 7, 8, 9, 10]) {
      const st = buildScenario('highlands', seed, 5, lineup('highlands', n));
      const f = st.field;
      expect(st.settings.players).toHaveLength(n);
      expect(articulationPoints(f.adj)).toEqual([]);
      expect(distances(f, [0]).every(Number.isFinite)).toBe(true);
      const marks = st.objectives!;
      expect(marks).toHaveLength(3);
      for (const i of marks) {
        expect(f.cells[i].owner).toBe(-1);
        expect(f.adj[i].length).toBeGreaterThanOrEqual(4);
        const d = distances(f, [i]);
        expect(marks.filter(j => j !== i).every(j => d[j] >= 4)).toBe(true);
      }
      const hand = (p: number) => owned(f, p).map(i => f.cells[i].power).sort().join();
      for (let p = 0; p < n; p++) {
        expect(hand(p)).toBe(hand(0));
        expect(approach(st, p)[0]).toBeGreaterThanOrEqual(3);
      }
      const climbs = Array.from({ length: n }, (_, p) => approach(st, p));
      if (n === 5) for (let k = 0; k < 3; k++) expect(Math.max(...climbs.map(a => a[k])) - Math.min(...climbs.map(a => a[k]))).toBeLessThanOrEqual(1);
      else expect(new Set(climbs.map(String)).size, `${n} seats, seed ${seed}`).toBe(1);
      const at = centred(f);
      layouts.add(marks.map(i => { const [q, r] = at(i); return Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)); }).sort().join() +
        `|${f.walls.length > 0}|${f.cells.filter(c => c.owner < 0 && c.power >= 2).length}`);
      expect(buildScenario('highlands', seed, 5, lineup('highlands', n)).field).toEqual(f);
    }
    expect(layouts.size, `${n} seats`).toBeGreaterThanOrEqual(4);
  });

  it('more camps get more land; later seats get the extra first income', () => {
    const area = (n: number) => buildScenario('highlands', 11, undefined, lineup('highlands', n)).field.cells.length;
    expect(area(2)).toBeLessThan(area(6));
    const bonus = (buildScenario('highlands', 11, undefined, lineup('highlands', 4)).settings.orderComp as { bonus: number[] }).bonus;
    expect(bonus).toEqual([0, 1, 2, 3]);
  });

  it('some maps raise ridges with passes, others a central lake or a garrisoned plateau', () => {
    const kinds = new Set<string>();
    for (let seed = 1; seed <= 30; seed++) {
      const f = buildScenario('highlands', seed * 13).field;
      kinds.add(f.walls.length ? 'ridges' : f.cells.length < 3 * 37 ? 'small' : 'open');
    }
    expect(kinds.has('ridges')).toBe(true);
    expect(kinds.size).toBeGreaterThanOrEqual(2);
  });
});

describe('moonvale: corridors in the dark and a clearing for every scout', () => {
  /** Roomy empty cells within `d` steps of the scout, in the largest group it can find. */
  function clearing(st: MatchState, scout: number, d = 3) {
    const f = st.field;
    const near = distances(f, [scout]);
    const rich = new Set(f.cells.flatMap((c, i) => c.owner < 0 && c.maxPower === 12 && c.power === 0 && near[i] <= d ? [i] : []));
    let best = 0;
    for (const i of rich) {
      const group = [i];
      const seen = new Set(group);
      for (let n = 0; n < group.length; n++) for (const j of f.adj[group[n]]) if (rich.has(j) && !seen.has(j)) { seen.add(j); group.push(j); }
      best = Math.max(best, group.length);
    }
    return best;
  }

  for (const n of [2, 3, 4, 5, 6]) it(`${n} seats: every scout lands a few steps from its own rich clearing`, () => {
    for (const size of ['L', 'XXL'] as const) for (const seed of seeds) {
      const st = buildScenario('moonvale', seed, 6, lineup('moonvale', n), { size });
      const f = st.field;
      const looks = Array.from({ length: n }, (_, p) => {
        const mine = owned(f, p);
        const scout = mine.find(i => f.cells[i].power <= 2)!;
        const camp = mine.filter(i => i !== scout);
        const fromCamp = distances(f, camp);
        return { scout, size: clearing(st, scout), toScout: fromCamp[scout], hand: mine.map(i => f.cells[i].power).sort().join() };
      });
      for (const l of looks) {
        expect(l.size, `${n} ${size} ${seed}`).toBeGreaterThanOrEqual(5);
        expect(l.hand).toBe(looks[0].hand);
      }
      if (n !== 5) {
        expect(new Set(looks.map(l => `${l.size}/${l.toScout}`)).size, `${n} ${size} ${seed}`).toBe(1);
        // the whole land is laid out alike around every seat
        const outlook = (p: number) => { const d = distances(f, owned(f, p)); return [...d].sort((a, b) => a - b).join(); };
        for (let p = 1; p < n; p++) expect(outlook(p)).toBe(outlook(0));
      }
    }
  });

  it('walls, lakes and the middle change between launches', () => {
    const looks = new Set<string>();
    let walled = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const f = buildScenario('moonvale', seed * 53).field;
      if (f.walls.length) walled++;
      looks.add(`${f.cells.length}/${f.walls.length}/${f.cells.filter(c => c.owner < 0 && c.power > 0).length}`);
    }
    expect(walled).toBeGreaterThanOrEqual(6);
    expect(looks.size).toBeGreaterThanOrEqual(8);
  });
});

describe('archipelago: one island per seat, three to six', () => {
  it('is configurable from three to six seats; three keep the classic map', () => {
    expect(SCENARIO_META.archipelago.configurable).toEqual({ sizes: ['L'], seats: [3, 6], modes: [] });
    expect(buildScenario('archipelago', 9, undefined, ['human', 'god', 'master']).field).toEqual(buildDailyScenario('archipelago', 9).field);
  });

  for (const n of [3, 4, 5, 6]) it(`${n} seats: islands of the same size, as far from the rich middle`, () => {
    for (const seed of seeds) {
      const st = buildScenario('archipelago', seed, undefined, lineup('archipelago', n));
      const f = st.field;
      expect(distances(f, [0]).every(Number.isFinite)).toBe(true);
      // the rich island: a roomy empty cell among six roomy empty cells
      const roomy = (i: number) => f.cells[i].owner < 0 && f.cells[i].maxPower === 12 && f.cells[i].power === 0;
      const middle = f.cells.findIndex((_, i) => roomy(i) && f.adj[i].length === 6 && f.adj[i].every(roomy));
      expect(middle).toBeGreaterThanOrEqual(0);
      const toMiddle = distances(f, [middle]);
      const reach = Array.from({ length: n }, (_, p) => Math.min(...owned(f, p).map(i => toMiddle[i])));
      for (let p = 0; p < n; p++) {
        expect(owned(f, p)).toHaveLength(7);
        expect(owned(f, p).some(i => canAttackFrom(st, i))).toBe(true);
      }
      expect(Math.max(...reach) - Math.min(...reach), `${n} ${seed} ${reach}`).toBeLessThanOrEqual(n === 3 || n === 6 ? 0 : 1);
      // neighbouring islands do not touch: every seat's land is its own island
      for (let p = 0; p < n; p++) for (const i of owned(f, p)) expect(f.adj[i].every(j => f.cells[j].owner < 0 || f.cells[j].owner === p)).toBe(true);
    }
  });
});
