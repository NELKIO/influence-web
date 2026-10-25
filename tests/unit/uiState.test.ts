import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { playerName, setOnlineNames } from '../../src/ui/names';
import { NEUTRAL_COLOR, PALETTES, playerColor, setPalette, shade, withAlpha } from '../../src/ui/theme';
import { getLang, setLang } from '../../src/i18n';
import { en } from '../../src/i18n/en';
import { ru } from '../../src/i18n/ru';
import type { MatchKind, MatchSettings, PlayerType } from '../../src/core/types';
import { inviteBattleUrl, parseBattleInvite, parseInvite, routeJoinCode } from '../../src/net/room';
import { DEFAULT_SETTINGS } from '../../src/storage';

// a minimal document: the palette goes into CSS variables, the language into <html lang>
const cssVars = new Map<string, string>();
const docEl = { lang: '', style: { setProperty: (k: string, v: string) => void cssVars.set(k, v) } };
const mem = new Map<string, string>();
const g = globalThis as Record<string, unknown>;
beforeAll(() => {
  g.document = { documentElement: docEl };
  g.localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
});
afterAll(() => {
  delete g.document;
  delete g.localStorage;
});

const match = (players: PlayerType[], kind: MatchKind = 'single'): MatchSettings => ({
  kind,
  size: 'M',
  players,
  darkness: false,
  symmetry: false,
  crowded: false,
  unions: false,
  shuffle: false,
  duelRules: false,
});

describe('playerName', () => {
  it('a single person is "You"; bots by kind', () => {
    setLang('en');
    const s = match(['human', 'dummy', 'hunter', 'master', 'god', 'freak']);
    expect([0, 1, 2, 3, 4, 5].map((i) => playerName(s, i))).toEqual(['You', 'Dummy', 'Hunter', 'Master', 'GOD', 'Psycho']);
    setLang('ru');
    expect(playerName(s, 0)).toBe(ru.you);
    expect(playerName(s, 1)).toBe(ru.player_dummy);
  });

  it('hot seat: people are numbered by seat', () => {
    setLang('en');
    const s = match(['human', 'hunter', 'human']);
    expect(playerName(s, 0)).toBe('Player 1');
    expect(playerName(s, 2)).toBe('Player 3');
    expect(playerName(s, 1)).toBe('Hunter');
  });

  it('battle rooms: online seats by their names, else numbered; elsewhere the generic label', () => {
    setLang('en');
    const s = match(['human', 'online', 'remote', 'master'], 'battleOnline');
    setOnlineNames([null, 'Masha', '', null]);
    expect(playerName(s, 1)).toBe('Masha');
    expect(playerName(s, 2)).toBe('Player 3');
    expect(playerName(s, 3)).toBe('Master');
    expect(playerName(s, 0)).toBe('You');
    setOnlineNames([]);
    expect(playerName(s, 1)).toBe('Player 2');
    // an online duel: the other side is "Opponent"
    expect(playerName(match(['human', 'remote'], 'duelOnline'), 1)).toBe(en.player_remote);
    expect(playerName(match(['human', 'online']), 1)).toBe(en.player_online);
  });
});

describe('theme', () => {
  it('six distinct valid colours per palette; neutral for no owner', () => {
    for (const [name, list] of Object.entries(PALETTES)) {
      expect(list, name).toHaveLength(6);
      expect(new Set(list).size, name).toBe(6);
      for (const c of list) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(playerColor(-1)).toBe(NEUTRAL_COLOR);
  });

  it('setPalette switches the colours and the CSS variables; unknown names fall back to main', () => {
    setPalette('classic');
    expect(playerColor(0)).toBe(PALETTES.classic[0]);
    expect(playerColor(7)).toBe(PALETTES.classic[1]);
    expect(cssVars.get('--p3')).toBe(PALETTES.classic[3]);
    expect(cssVars.get('--accent')).toBe(PALETTES.classic[0]);
    setPalette('nope' as 'main');
    expect(playerColor(2)).toBe(PALETTES.main[2]);
    setPalette('main');
  });

  it('shade and withAlpha', () => {
    expect(shade('#808080', 0)).toBe('rgb(128,128,128)');
    expect(shade('#808080', -1)).toBe('rgb(0,0,0)');
    expect(shade('#808080', 1)).toBe('rgb(255,255,255)');
    expect(shade('#ff0000', 0.5)).toBe('rgb(255,128,128)');
    expect(shade('#ff0000', -0.5)).toBe('rgb(128,0,0)');
    expect(withAlpha('#3f8cff', 0.25)).toBe('rgba(63,140,255,0.25)');
  });
});

describe('store (settings)', () => {
  it('loads the saved settings at start, applies them, persists updates', async () => {
    mem.set('infweb.settings', JSON.stringify({ ...DEFAULT_SETTINGS, lang: 'en', palette: 'soft', v: 2 }));
    const store = await import('../../src/ui/store');
    expect(store.getSettings().lang).toBe('en');
    expect(getLang()).toBe('en');
    expect(docEl.lang).toBe('en');
    expect(cssVars.get('--p0')).toBe(PALETTES.soft[0]);
    store.updateSettings({ lang: 'ru', palette: 'classic', sound: false });
    expect(getLang()).toBe('ru');
    expect(playerColor(0)).toBe(PALETTES.classic[0]);
    expect(JSON.parse(mem.get('infweb.settings')!)).toMatchObject({ lang: 'ru', palette: 'classic', sound: false, v: 2 });
    expect(store.getSettings()).toMatchObject({ lang: 'ru', palette: 'classic', sound: false, speed: DEFAULT_SETTINGS.speed });
    // no language chosen: the browser's
    store.updateSettings({ lang: null });
    expect(getLang()).toBe(/^(ru|uk|be|kk)/i.test(navigator.language) ? 'ru' : 'en');
    store.navigate({ name: 'rules' });
    store.updateSettings({ palette: 'main' });
  });
});

describe('join codes and invite links (the routes of the join box and #/duel, #/join)', () => {
  it('4 characters are a duel, 5 a battle room; links of both kinds; anything else is rejected', () => {
    expect(routeJoinCode('abcd')).toEqual({ kind: 'duel', code: 'ABCD' });
    expect(routeJoinCode(' ab-cd ')).toEqual({ kind: 'duel', code: 'ABCD' });
    expect(routeJoinCode('abcde')).toEqual({ kind: 'battle', code: 'ABCDE' });
    expect(routeJoinCode('https://x.org/influence-web/#/duel/XY7Z')).toEqual({ kind: 'duel', code: 'XY7Z' });
    expect(routeJoinCode('https://x.org/influence-web/#/join/XY7ZQ')).toEqual({ kind: 'battle', code: 'XY7ZQ' });
    expect(routeJoinCode(inviteBattleUrl('K2M4P', 'https://x.org'))).toEqual({ kind: 'battle', code: 'K2M4P' });
    for (const bad of ['', 'ab', 'abc', 'abcdef', 'O0I1', 'OOOOO', '#/duel/ABC', '#/join/ABCD', '#/nothing']) expect(routeJoinCode(bad), bad).toBeNull();
  });

  it('invite hashes: only well-formed codes', () => {
    expect(parseInvite('#/duel/abcd')).toBe('ABCD');
    expect(parseInvite('#/duel/abcd/')).toBe('ABCD');
    expect(parseInvite('#/duel/ABCDE')).toBeNull();
    expect(parseInvite('#/join/ABCD')).toBeNull();
    expect(parseBattleInvite('#/join/abcde')).toBe('ABCDE');
    expect(parseBattleInvite('/join/AB-CDE?x=1')).toBe('ABCDE');
    expect(parseBattleInvite('#/join/ABCD')).toBeNull();
    expect(parseBattleInvite('#/duel/ABCDE')).toBeNull();
    expect(parseBattleInvite('#/settings')).toBeNull();
  });
});
