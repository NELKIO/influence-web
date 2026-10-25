import { describe, expect, it } from 'vitest';
import { attack, checkStuck, concede, createMatch, finishEarly, withFreshDice } from '../../src/core/engine';
import type { MatchSettings, MatchState, PlayerType } from '../../src/core/types';
import { createDailyAttempt, createDailyMatch } from '../../src/daily';
import { playerName } from '../../src/ui/names';
import { setLang } from '../../src/i18n';
import { ru } from '../../src/i18n/ru';
import { en } from '../../src/i18n/en';

function settings(players: PlayerType[], over: Partial<MatchSettings> = {}): MatchSettings {
  return { kind: 'single', size: 'M', players, darkness: false, symmetry: false, crowded: false, unions: false, shuffle: false, duelRules: false, ...over };
}

/** Hand the cells to the owners by count, at full power (a saturated board of 53 cells). */
function saturate(s: MatchState, counts: [owner: number, n: number][]) {
  let i = 0;
  for (const [o, n] of counts)
    for (let j = 0; j < n; j++, i++) {
      s.field.cells[i].owner = o;
      s.field.cells[i].power = s.field.cells[i].maxPower;
    }
  // whatever is left stays neutral and empty
  for (; i < s.field.cells.length; i++) {
    s.field.cells[i].owner = -1;
    s.field.cells[i].power = 0;
  }
}

function stuck(players: PlayerType[], counts: [number, number][], over: Partial<MatchSettings> = {}) {
  const s = createMatch(settings(players, over), { seed: 5 });
  saturate(s, counts);
  s.turn = 200;
  s.lastStuck = -100;
  s.current = 0;
  return s;
}

describe('early finish with the first place shared by people', () => {
  it('a local duel level at the top: the offer is a draw, finishing ends in a draw (not "the bots won")', () => {
    const s = createMatch(settings(['human', 'human'], { kind: 'duelLocal', duelRules: true }), { seed: 5 });
    const half = s.field.cells.length / 2;
    s.field.cells.forEach((c, i) => {
      c.owner = i < Math.floor(half) ? 0 : 1;
      c.power = c.maxPower;
    });
    // an odd number of cells: give one to nobody so the two are level
    if (s.field.cells.length % 2) s.field.cells[s.field.cells.length - 1].owner = -1;
    s.turn = 200;
    s.lastStuck = -100;
    const offer = checkStuck(s)!;
    expect(offer).toMatchObject({ enough: false, draw: true });
    finishEarly(s, offer);
    expect(s.ended).toMatchObject({ winner: -1, humanWon: false, draw: true, reason: 'early' });
  });

  it('hot-seat: two people level at the top and a small bot: a draw', () => {
    const s = stuck(['human', 'human', 'dummy'], [
      [0, 20],
      [1, 20],
      [2, 12],
    ]);
    expect(s.field.cells.length).toBe(53);
    const offer = checkStuck(s)!;
    expect(offer).toMatchObject({ enough: false, draw: true });
    finishEarly(s, offer);
    expect(s.ended).toMatchObject({ winner: -1, draw: true });
  });

  it('the person behind two level people: a draw for everyone too', () => {
    const s = stuck(['human', 'human', 'human'], [
      [0, 10],
      [1, 21],
      [2, 21],
    ]);
    expect(checkStuck(s)).toMatchObject({ enough: false, draw: true });
  });

  it('a single leader still takes the match; a bot leading alone wins it', () => {
    const lead = stuck(['human', 'human', 'dummy'], [
      [0, 30],
      [1, 12],
      [2, 10],
    ]);
    const o1 = checkStuck(lead)!;
    expect(o1).toMatchObject({ enough: true });
    expect(o1.draw).toBeFalsy();
    const bot = stuck(['human', 'human', 'dummy'], [
      [0, 12],
      [1, 10],
      [2, 30],
    ]);
    const o2 = checkStuck(bot)!;
    expect(o2.draw).toBeFalsy();
    finishEarly(bot, o2);
    expect(bot.ended).toMatchObject({ winner: 2, humanWon: false });
    expect(bot.ended!.draw).toBeFalsy();
  });

  it('alone against bots the original rule stays: a fair share wins, less loses (a tie with a bot is no draw)', () => {
    const win = stuck(['human', 'hunter'], [
      [0, 27],
      [1, 26],
    ]);
    const o = checkStuck(win)!;
    expect(o).toMatchObject({ enough: true });
    expect(o.draw).toBeFalsy();
    const lose = stuck(['human', 'hunter', 'master'], [
      [0, 10],
      [1, 21],
      [2, 21],
    ]);
    const o2 = checkStuck(lose)!;
    expect(o2).toMatchObject({ enough: false });
    expect(o2.draw).toBeFalsy();
    finishEarly(lose, o2);
    expect(lose.ended).toMatchObject({ winner: -1, humanWon: false });
    expect(lose.ended!.draw).toBeFalsy();
  });

  it('the offer texts: a draw has its own text that does not speak of a defeat', () => {
    expect(ru.earlyDraw).toMatch(/ничья/);
    expect(ru.earlyDraw).not.toMatch(/поражени/);
    expect(en.earlyDraw).not.toMatch(/defeat/i);
    expect(ru.draw).toBe('Ничья');
  });
});

describe('fresh dice for a restart and for another attempt at the map of the day', () => {
  /** win/loss of the same 50% fight (4 against 4) repeated n times on one state, as a string */
  function rolls(s: MatchState, n = 24): string {
    const a = s.field.cells.findIndex((c) => c.owner === s.current);
    const b = s.field.adj[a][0];
    const c = s.field.cells;
    let out = '';
    for (let k = 0; k < n; k++) {
      c[a].owner = s.current;
      c[a].power = 4;
      c[b].owner = 1;
      c[b].power = 4;
      s.luck = [0, 0, 0];
      const ev = attack(s, a, b);
      out += typeof ev === 'string' ? '?' : ev.win ? 'W' : 'L';
    }
    return out;
  }

  it('withFreshDice keeps map, placement and seed and changes only the dice', () => {
    const a = createMatch(settings(['human', 'hunter']), { seed: 77 });
    const b = withFreshDice(structuredClone(a), 12345);
    expect(b.field).toEqual(a.field);
    expect(b.seed).toBe(a.seed);
    expect(b.rng).not.toEqual(a.rng);
  });

  it('two attempts at the same day: the same map for everybody, different dice', () => {
    const id = '2026-10-24';
    const base = createDailyMatch(id);
    const x = createDailyAttempt(id);
    const y = createDailyAttempt(id);
    // the map of the day is identical
    expect(x.field).toEqual(base.field);
    expect(y.field).toEqual(base.field);
    expect(x.settings).toEqual(base.settings);
    // the dice are not
    expect(x.rng).not.toEqual(y.rng);
    expect(x.rng).not.toEqual(base.rng);
  });

  it('fights rolled from fresh dice differ from the ones of the plain daily match', () => {
    const s = createMatch(settings(['human', 'hunter']), { seed: 3 });
    const same = rolls(structuredClone(s));
    expect(rolls(structuredClone(s))).toBe(same);
    const fresh = [1, 2, 3].map((k) => rolls(withFreshDice(structuredClone(s), 1000 + k)));
    expect(fresh.some((r) => r !== same)).toBe(true);
  });
});

describe('names of seats', () => {
  it('a bot type at several seats is numbered in seat order; a single one keeps its plain name', () => {
    setLang('ru');
    const st = settings(['human', 'hunter', 'master', 'hunter', 'hunter']);
    expect([0, 1, 2, 3, 4].map((i) => playerName(st, i))).toEqual(['Вы', 'Охотник 1', 'Мастер', 'Охотник 2', 'Охотник 3']);
    setLang('en');
    expect(playerName(st, 3)).toBe('Hunter 2');
    setLang('ru');
  });

  it('union, elimination and winner texts read correctly with any name (nominative only)', () => {
    for (const k of ['united', 'unitedYou', 'eliminated', 'winnerIs', 'statusWait', 'handoverNext'] as const) {
      // no preposition that would need another case right before a name
      expect(ru[k]).not.toMatch(/(?:^|\s)(?:с|к|у|для|от|о)\s+\{/);
    }
    expect(ru.united).not.toMatch(/объединился/);
    expect(ru.winnerIs).not.toMatch(/Победил /);
  });

  it('a person who leaves while another is looking: the view goes to the next person in seat order', () => {
    const s = createMatch(settings(['human', 'hunter', 'human', 'human']), { seed: 4 });
    s.current = 1;
    s.viewer = 2;
    concede(s, 2);
    expect(s.viewer).toBe(3);
  });
});
