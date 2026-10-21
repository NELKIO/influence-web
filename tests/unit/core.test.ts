import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { generateField, isConnected, mirror, rowWidth } from '../../src/core/field';
import {
  addPower,
  attack,
  autoPower,
  checkAttack,
  createMatch,
  endAttack,
  finishTurn,
  incomeFor,
  visibleCells,
  winChance,
} from '../../src/core/engine';
import { SIZES, SIZE_ORDER, type MatchSettings, type MatchState } from '../../src/core/types';

const base: MatchSettings = {
  kind: 'single',
  size: 'M',
  players: ['human', 'dummy'],
  darkness: false,
  symmetry: true,
  crowded: false,
  unions: false,
  shuffle: false,
  duelRules: false,
};

/** Build a tiny hand-made match: cells in a row 0-1-2-3. */
function lineMatch(powers: number[], owners: number[], opts: Partial<MatchSettings> = {}): MatchState {
  const m = createMatch({ ...base, ...opts }, { seed: 1 });
  m.field = {
    size: 'S',
    w: 5,
    h: 7,
    cells: powers.map((p, i) => ({ id: i, x: i, y: 0, power: p, maxPower: 8, owner: owners[i] })),
    adj: powers.map((_, i) => [i - 1, i + 1].filter((j) => j >= 0 && j < powers.length)),
    walls: [],
    starts: [0, 1, 2, 3, 0],
  };
  return m;
}

describe('rng', () => {
  it('is deterministic and serialisable', () => {
    const a = new Rng(42);
    const seq = [a.nextU32(), a.nextU32()];
    const b = new Rng(42);
    expect([b.nextU32(), b.nextU32()]).toEqual(seq);
    const c = new Rng(a.state());
    expect(c.nextU32()).toBe(a.nextU32());
  });
});

describe('win chance table', () => {
  it('matches the original odds', () => {
    expect(winChance(1, 0)).toBe(0);
    expect(winChance(2, 0)).toBe(1);
    expect(winChance(3, 5)).toBe(0);
    expect(winChance(4, 5)).toBe(0.25);
    expect(winChance(5, 5)).toBe(0.5);
    expect(winChance(6, 5)).toBe(0.75);
    expect(winChance(7, 5)).toBe(1);
  });
});

describe('field generation', () => {
  for (const size of SIZE_ORDER) {
    for (const symmetry of [false, true]) {
      it(`${size} symmetry=${symmetry}: connected, valid starts`, () => {
        for (let seed = 1; seed <= 8; seed++) {
          const f = generateField({ size, symmetry }, new Rng(seed * 7919));
          expect(isConnected(f)).toBe(true);
          expect(f.starts).toHaveLength(5);
          expect(new Set(f.starts).size).toBe(5);
          for (const s of f.starts) for (const t of f.starts) if (s !== t) expect(f.adj[s]).not.toContain(t);
          for (const c of f.cells) {
            expect([8, 12]).toContain(c.maxPower);
            expect(c.x).toBeLessThan(rowWidth(f.w, c.y));
          }
          if (!symmetry) expect(f.cells.length).toBe(SIZES[size].cells + 1);
          // adjacency symmetric
          f.adj.forEach((ns, i) => ns.forEach((j) => expect(f.adj[j]).toContain(i)));
        }
      });
    }
  }

  it('symmetric maps are 4-way symmetric', () => {
    for (let seed = 1; seed < 10; seed++) {
      const f = generateField({ size: 'L', symmetry: true }, new Rng(seed));
      const byId = new Map(f.cells.map((c) => [c.id, c]));
      for (const c of f.cells) {
        const [mx, my] = mirror(f.w, f.h, c.x, c.y);
        const m = byId.get(my * f.w + mx);
        expect(m?.maxPower).toBe(c.maxPower);
        expect(f.walls).toHaveLength(0);
      }
    }
  });
});

describe('match setup', () => {
  it('2 players get 5 and 7 start power', () => {
    const m = createMatch({ ...base, size: 'L' }, { seed: 3 });
    const owned = m.field.cells.filter((c) => c.owner >= 0);
    expect(owned).toHaveLength(2);
    expect(owned.find((c) => c.owner === 0)!.power).toBe(5);
    expect(owned.find((c) => c.owner === 1)!.power).toBe(7);
  });
  it('4 players get 2 each', () => {
    const m = createMatch({ ...base, players: ['human', 'dummy', 'freak', 'hunter'] }, { seed: 3 });
    const owned = m.field.cells.filter((c) => c.owner >= 0);
    expect(owned.map((c) => c.power)).toEqual([2, 2, 2, 2]);
  });
  it('crowded gives every cell to players', () => {
    const m = createMatch({ ...base, crowded: true, players: ['human', 'dummy', 'freak'] }, { seed: 3 });
    expect(m.field.cells.every((c) => c.owner >= 0 && c.power === 2)).toBe(true);
  });
  it('shuffle keeps slot 0', () => {
    const m = createMatch({ ...base, shuffle: true, players: ['human', 'dummy', 'freak', 'hunter', 'master'] }, { seed: 9 });
    expect(m.settings.players[0]).toBe('human');
    expect([...m.settings.players].sort()).toEqual(['dummy', 'freak', 'human', 'hunter', 'master']);
  });
});

describe('combat', () => {
  it('capture of empty cell: target a-1, attacker 1', () => {
    const m = lineMatch([5, 0], [0, -1]);
    const ev = attack(m, 0, 1);
    expect(typeof ev).toBe('object');
    expect(m.field.cells[1]).toMatchObject({ owner: 0, power: 4 });
    expect(m.field.cells[0].power).toBe(1);
  });
  it('overflow returns to attacker', () => {
    const m = lineMatch([12, 0], [0, -1]);
    m.field.cells[0].maxPower = 12;
    attack(m, 0, 1);
    expect(m.field.cells[1].power).toBe(8);
    expect(m.field.cells[0].power).toBe(4);
    const m2 = lineMatch([12, 1], [0, 1]);
    m2.field.cells[0].maxPower = 12;
    attack(m2, 0, 1);
    expect(m2.field.cells[1]).toMatchObject({ owner: 0, power: 8 });
    expect(m2.field.cells[0].power).toBe(3);
  });
  it('hopeless attack reduces defender by a', () => {
    const m = lineMatch([3, 8], [0, 1]);
    const ev = attack(m, 0, 1);
    expect(ev).toMatchObject({ win: false });
    expect(m.field.cells[1]).toMatchObject({ owner: 1, power: 5 });
    expect(m.field.cells[0].power).toBe(1);
  });
  it('sure win leaves a-d', () => {
    const m = lineMatch([7, 3], [0, 1]);
    attack(m, 0, 1);
    expect(m.field.cells[1]).toMatchObject({ owner: 0, power: 4 });
  });
  it('refuses weak / non adjacent / own', () => {
    const m = lineMatch([1, 0, 3], [0, -1, 0]);
    expect(checkAttack(m, 0, 1)).toBe('weak');
    expect(checkAttack(m, 2, 0)).toBe('notAdjacent');
    const m2 = lineMatch([3, 3], [0, 0]);
    expect(checkAttack(m2, 0, 1)).toBe('ownTarget');
  });
  it('human never loses three 50% fights in a row', () => {
    for (let seed = 0; seed < 200; seed++) {
      const m = lineMatch([4, 4], [0, 1]);
      m.rng = new Rng(seed).state();
      let streak = 0;
      for (let k = 0; k < 30; k++) {
        m.field.cells[0] = { ...m.field.cells[0], power: 4, owner: 0 };
        m.field.cells[1] = { ...m.field.cells[1], power: 4, owner: 1 };
        m.ended = null;
        const ev = attack(m, 0, 1);
        if (typeof ev === 'string') throw new Error(ev);
        streak = ev.win ? 0 : streak + 1;
        expect(streak).toBeLessThanOrEqual(2);
      }
    }
  });
  it('fight probabilities roughly match for bots', () => {
    const m = lineMatch([6, 5], [0, 1]);
    m.settings.players = ['dummy', 'freak'];
    let wins = 0;
    const N = 4000;
    for (let k = 0; k < N; k++) {
      m.field.cells[0] = { ...m.field.cells[0], power: 6, owner: 0 };
      m.field.cells[1] = { ...m.field.cells[1], power: 5, owner: 1 };
      m.ended = null;
      const ev = attack(m, 0, 1);
      if (typeof ev !== 'string' && ev.win) wins++;
    }
    // streak breaker pushes bots below the nominal 75%
    expect(wins / N).toBeGreaterThan(0.4);
    expect(wins / N).toBeLessThan(0.78);
  });
  it('elimination ends a 2-player match', () => {
    const m = lineMatch([5, 1], [0, 1]);
    const ev = attack(m, 0, 1);
    expect(ev).toMatchObject({ win: true, eliminated: 1 });
    expect(m.ended).toMatchObject({ winner: 0, humanWon: true });
  });
});

describe('duel rules', () => {
  it('greys first', () => {
    const m = lineMatch([5, 3, 0], [0, 1, -1], { duelRules: true });
    m.field.adj = [[1, 2], [0], [0]];
    expect(checkAttack(m, 0, 1)).toBe('greysFirst');
    expect(checkAttack(m, 0, 2)).toBeNull();
  });
  it('income = biggest group', () => {
    const m = lineMatch([1, 1, 0, 1, 1, 1], [0, 0, -1, 0, 0, 0], { duelRules: true });
    m.phase = 'attack';
    endAttack(m);
    expect(m.powerLeft).toBe(3);
    const n = lineMatch([1, 1, 0, 1, 1, 1], [0, 0, -1, 0, 0, 0]);
    expect(incomeFor(n, 0)).toBe(5);
  });
});

describe('power phase', () => {
  it('income capped by free capacity and auto distributes', () => {
    const m = lineMatch([7, 8, 0], [0, 0, -1]);
    endAttack(m);
    expect(m.powerLeft).toBe(1);
    const m2 = lineMatch([1, 1, 1, 0], [0, 0, 0, -1]);
    endAttack(m2);
    expect(m2.powerLeft).toBe(3);
    expect(addPower(m2, 0, 10)).toBe(3);
    const m3 = lineMatch([1, 1, 1, 0], [0, 0, 0, -1]);
    endAttack(m3);
    autoPower(m3);
    expect(m3.field.cells.slice(0, 3).map((c) => c.power)).toEqual([2, 2, 2]);
  });
  it('turn passes and rounds count', () => {
    const m = lineMatch([2, 0, 2], [0, -1, 1]);
    endAttack(m);
    autoPower(m);
    finishTurn(m);
    expect(m.current).toBe(1);
    expect(m.turn).toBe(0);
    endAttack(m);
    autoPower(m);
    finishTurn(m);
    expect(m.current).toBe(0);
    expect(m.turn).toBe(1);
  });
});

describe('darkness', () => {
  it('shows own cells and neighbours only', () => {
    const m = lineMatch([2, 0, 0, 2], [0, -1, -1, 1], { darkness: true });
    m.viewer = 0;
    expect([...visibleCells(m)]).toEqual([1, 1, 0, 0]);
  });
});

describe('daily map', () => {
  it('is the same for everyone on a date and hard from the cut-over on', async () => {
    const { createDailyMatch, dailySettings, dailyLevel, HARD_DAILY_FROM } = await import('../../src/daily');
    const a = createDailyMatch('2026-11-03');
    const b = createDailyMatch('2026-11-03');
    expect(JSON.stringify(a.field)).toBe(JSON.stringify(b.field));
    // the day before the cut-over keeps its old map
    expect(dailySettings('2026-10-21').players).toEqual(['human', 'master']);
    expect(dailySettings('2026-10-21').size).toBe('XL');
    // a whole week of hard maps: only Masters, symmetric, harder towards Sunday
    const levels: number[] = [];
    for (let d = 26; d <= 32; d++) {
      const id = `2026-10-${String(d).padStart(2, '0')}`.replace('2026-10-32', '2026-11-01');
      const s = dailySettings(id);
      expect(id >= HARD_DAILY_FROM).toBe(true);
      expect(s.players[0]).toBe('human');
      expect(s.players.slice(1).every((p) => p === 'master')).toBe(true);
      expect(s.symmetry).toBe(true);
      levels.push(dailyLevel(id));
      createDailyMatch(id); // generates without errors
    }
    expect(levels[0]).toBeLessThan(levels[6]);
  });
});
