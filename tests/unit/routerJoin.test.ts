import { describe, expect, it } from 'vitest';
import { parseHash, routeHash } from '../../src/ui/routes';
import { checkJoinCode, cleanJoinInput } from '../../src/ui/joinCode';
import { plural, setLang, t } from '../../src/i18n';

describe('address hashes', () => {
  it('each screen with an address round-trips', () => {
    for (const name of ['setup', 'daily', 'duels', 'rules', 'stats', 'settings', 'join'] as const) {
      const h = routeHash({ name } as never);
      expect(h).toBe(`#/${name}`);
      expect(parseHash(h)).toEqual({ kind: 'screen', route: { name } });
    }
    expect(routeHash({ name: 'menu' })).toBe('');
    expect(parseHash('')).toEqual({ kind: 'menu' });
    expect(parseHash('#')).toEqual({ kind: 'menu' });
    expect(parseHash('#/')).toEqual({ kind: 'menu' });
  });

  it('a trailing slash is accepted', () => {
    expect(parseHash('#/settings/')).toEqual({ kind: 'screen', route: { name: 'settings' } });
    expect(parseHash('#/duel/abcd/')).toEqual({ kind: 'invite', route: { name: 'duels', join: 'ABCD' } });
  });

  it('invite links keep working (upper-cased codes)', () => {
    expect(parseHash('#/duel/abcd')).toEqual({ kind: 'invite', route: { name: 'duels', join: 'ABCD' } });
    expect(parseHash('#/join/abcde')).toEqual({ kind: 'invite', route: { name: 'battleRoom', join: 'ABCDE' } });
  });

  it('a match and a room cannot be rebuilt from the address', () => {
    expect(parseHash('#/game')).toEqual({ kind: 'transient' });
    expect(parseHash('#/room')).toEqual({ kind: 'transient' });
  });

  it.each(['#/foo', '#/duel/AB', '#/duel/ABCDE', '#/join/ABCD', '#/join/AB-CDE', '#/setup/x', '#setup', '#/SETUP'])('%s is unknown', (h) => {
    expect(parseHash(h)).toEqual({ kind: 'unknown' });
  });
});

describe('join box', () => {
  it('normalises first, then cuts to five', () => {
    expect(cleanJoinInput('ab-cd e')).toBe('ABCDE');
    expect(cleanJoinInput(' k x 7 m ')).toBe('KX7M');
    expect(cleanJoinInput('abcdefgh')).toBe('ABCDE');
  });

  it('takes the code out of a pasted invite link', () => {
    expect(cleanJoinInput('https://nelkio.github.io/influence-web/#/duel/KX7M')).toBe('KX7M');
    expect(cleanJoinInput('Join me: https://x.org/influence-web/#/join/kx7mq ')).toBe('KX7MQ');
    expect(cleanJoinInput('#/duel/kx7m/')).toBe('KX7M');
  });

  it('Cyrillic look-alikes become Latin letters', () => {
    expect(cleanJoinInput('АВЕК')).toBe('ABEK');
    expect(cleanJoinInput('мнрст')).toBe('MHPCT');
    expect(cleanJoinInput('ХУ2О')).toBe('XY2O');
  });

  it('checks the length and the code alphabet', () => {
    expect(checkJoinCode('KX7M')).toEqual({ ok: true, kind: 'duel', code: 'KX7M' });
    expect(checkJoinCode('KX7MQ')).toEqual({ ok: true, kind: 'battle', code: 'KX7MQ' });
    expect(checkJoinCode('AB')).toEqual({ ok: false, error: 'length' });
    expect(checkJoinCode('O0I1')).toEqual({ ok: false, error: 'alphabet' });
    expect(checkJoinCode('KX7M1')).toEqual({ ok: false, error: 'alphabet' });
  });
});

describe('plural forms in texts', () => {
  it('Russian: one, few, many', () => {
    setLang('ru');
    expect([1, 2, 5, 11, 21, 22, 25, 112].map((n) => t('mapCells', { n }))).toEqual([
      '1 клетка',
      '2 клетки',
      '5 клеток',
      '11 клеток',
      '21 клетка',
      '22 клетки',
      '25 клеток',
      '112 клеток',
    ]);
    expect(t('opponentsN', { n: 1 })).toBe('1 соперник');
    expect(t('opponentsN', { n: 3 })).toBe('3 соперника');
    expect(t('opponentsN', { n: 5 })).toBe('5 соперников');
    expect(t('playersCount', { n: 2 })).toBe('2 игрока');
    expect(t('playersCountMany', { n: 6 })).toBe('6 игроков');
    expect(t('spectateDraw', { n: 21 })).toBe('За 21 раунд никто не победил');
  });

  it('English: one and other', () => {
    setLang('en');
    expect(t('opponentsN', { n: 1 })).toBe('1 opponent');
    expect(t('opponentsN', { n: 3 })).toBe('3 opponents');
    expect(t('mapCells', { n: 1 })).toBe('1 cell');
    expect(t('dailyBest', { n: 1 })).toBe('Best: won in 1 round');
    expect(plural(2, 'a', 'b', 'c')).toBe('b');
    setLang('ru');
  });

  it('a text without the number keeps its token', () => {
    setLang('ru');
    expect(t('mapCells')).toContain('{n|');
  });
});
