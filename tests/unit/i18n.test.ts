import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ru } from '../../src/i18n/ru';
import { en } from '../../src/i18n/en';
import { t, setLang, plural } from '../../src/i18n';
import { BATTLE_SCENARIOS, CLASSIC_SCENARIOS, SCENARIOS, SCENARIO_META } from '../../src/core/scenarios';
import { SIZES } from '../../src/core/types';
import { PALETTES } from '../../src/ui/theme';
import { SPEED_MS } from '../../src/storage';

const SRC = join(__dirname, '../../src');
const dicts = { ru: ru as Record<string, string>, en: en as Record<string, string> };
const keys = Object.keys(ru);

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== 'i18n') out.push(...sources(p));
    } else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const code = sources(SRC).map((f) => ({ file: f.slice(SRC.length + 1), text: readFileSync(f, 'utf8') }));

/** {name} and the number of plural forms {n|one|few|many} (the count of forms differs by language) */
const placeholders = (s: string) => [...new Set([...s.matchAll(/\{(\w+)(?:\|[^{}]*)?\}/g)].map((m) => m[1]))].sort();

/** The first argument of every `t(` call (up to the first top-level comma or the closing paren). */
function firstArgs(text: string): string[] {
  const out: string[] = [];
  const re = /(?<![\w$])t\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let depth = 0;
    let i = m.index + 2;
    let quote: string | null = null;
    const start = i;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') quote = ch;
      else if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') {
        if (depth === 0) break;
        depth--;
      } else if (ch === ',' && depth === 0) break;
    }
    out.push(text.slice(start, i).trim());
  }
  return out;
}

describe('i18n dictionaries', () => {
  it('RU and EN have exactly the same keys', () => {
    const r = Object.keys(ru).sort();
    const e = Object.keys(en).sort();
    expect(r.filter((k) => !e.includes(k)), 'missing in en').toEqual([]);
    expect(e.filter((k) => !r.includes(k)), 'missing in ru').toEqual([]);
  });

  it('no empty or whitespace-only strings', () => {
    for (const [lang, d] of Object.entries(dicts)) {
      const empty = Object.entries(d).filter(([, v]) => typeof v !== 'string' || !v.trim());
      expect(empty.map(([k]) => `${lang}.${k}`)).toEqual([]);
    }
  });

  it('the {placeholders} of each key match between languages', () => {
    const bad = keys.filter((k) => placeholders(dicts.ru[k]).join() !== placeholders(dicts.en[k]).join());
    expect(bad.map((k) => `${k}: ru {${placeholders(dicts.ru[k])}} en {${placeholders(dicts.en[k])}}`)).toEqual([]);
  });

  it('no stray braces (a typo in a placeholder)', () => {
    for (const [lang, d] of Object.entries(dicts)) {
      const bad = Object.entries(d).filter(([, v]) => /[{}]/.test(v.replace(/\{\w+(?:\|[^{}|]+){2,3}\}|\{\w+\}/g, '')));
      expect(bad.map(([k]) => `${lang}.${k}`)).toEqual([]);
    }
  });

  it('no Cyrillic in English texts', () => {
    const bad = Object.entries(en).filter(([, v]) => /[Ѐ-ӿ]/.test(v));
    expect(bad.map(([k, v]) => `${k}: ${v}`)).toEqual([]);
  });

  it('no untranslated English words in Russian texts (names and codes aside)', () => {
    const allowed = new Set(['Influence', 'Web', 'Teremok', 'Games', 'VPN', 'WebRTC', 'GOD', 'P2P', 'ID', 'OK']);
    const bad: string[] = [];
    for (const [k, v] of Object.entries(ru)) {
      const text = v.replace(/\{\w+\}/g, '');
      for (const w of text.match(/[A-Za-z][A-Za-z'’-]+/g) ?? []) if (!allowed.has(w)) bad.push(`${k}: ${w}`);
      // a Russian text should be mostly Russian
      const latin = (text.match(/[A-Za-z]/g) ?? []).length;
      const cyr = (text.match(/[Ѐ-ӿ]/g) ?? []).length;
      if (latin > cyr && !['appName'].includes(k)) bad.push(`${k}: mostly Latin`);
    }
    expect(bad).toEqual([]);
  });

  it('ru and en texts differ where they contain words (nothing copied over untranslated)', () => {
    const same = keys.filter((k) => dicts.ru[k] === dicts.en[k] && /[A-Za-zЀ-ӿ]{4,}/.test(dicts.ru[k].replace(/\{\w+\}/g, '')));
    // the app name is the same in both
    expect(same.filter((k) => !/Influence Web/.test(dicts.ru[k]))).toEqual([]);
  });
});

describe('keys used in the code', () => {
  const literal: { key: string; file: string }[] = [];
  const templates: { tpl: string; file: string }[] = [];
  for (const { file, text } of code) {
    for (const arg of firstArgs(text)) {
      if (arg.startsWith('`')) {
        templates.push({ tpl: arg, file });
        continue;
      }
      // plain literals and ternaries of literals: every quoted identifier-like string that is not
      // the other side of a comparison in the condition (kind === 'turn' ? … : …)
      for (const m of arg.matchAll(/(?<![=!]==?\s*)(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)")(?!\s*[=!]==?)/g)) literal.push({ key: m[1] ?? m[2], file });
    }
  }

  it('finds the calls (sanity)', () => {
    expect(literal.length).toBeGreaterThan(300);
    expect(templates.length).toBeGreaterThan(10);
  });

  it('every t("…") key exists (including untyped ones like the game controller’s opts.t)', () => {
    const missing = literal.filter((l) => !(l.key in ru)).map((l) => `${l.file}: ${l.key}`);
    expect([...new Set(missing)]).toEqual([]);
    // the controller's own t is a plain string function: make sure its keys were seen
    const ctrl = literal.filter((l) => l.file.endsWith('controller.ts')).map((l) => l.key);
    expect(ctrl).toEqual(expect.arrayContaining(['greysFirst', 'chance', 'youEliminated', 'eliminated', 'unitedYou', 'united', 'handoverNext']));
  });

  const typesTs = readFileSync(join(SRC, 'core/types.ts'), 'utf8');
  const union = (re: RegExp) => [...(re.exec(typesTs)?.[1] ?? '').matchAll(/'(\w+)'/g)].map((m) => m[1]);
  const playerTypes = [...union(/export type PlayerType = ([^;]+);/), ...union(/export type BotType = ([^;]+);/)];
  const layouts = union(/layout\?: ([^;]+);/);
  const setupText = readFileSync(join(SRC, 'ui/screens/SetupScreen.tsx'), 'utf8');
  const seatTypes = [...(/const TYPES: PlayerType\[\] = \[([^\]]+)\]/.exec(setupText)?.[1] ?? '').matchAll(/'(\w+)'/g)].map((m) => m[1]);
  const allScenarios = [...CLASSIC_SCENARIOS, ...BATTLE_SCENARIOS];

  /** Template-literal families: prefix -> the values the placeholder takes. */
  const families: Record<string, string[]> = {
    puzzle_: allScenarios,
    puzzleDesc_: allScenarios,
    player_: playerTypes,
    desc_: seatTypes,
    size: Object.keys(SIZES),
    dailyLevel: ['1', '2', '3', '4', '5'],
    layout_: layouts,
    palette_: Object.keys(PALETTES),
    speed_: Object.keys(SPEED_MS),
  };

  it('the families are read from the code', () => {
    expect(playerTypes).toEqual(expect.arrayContaining(['human', 'remote', 'online', 'freak', 'dummy', 'hunter', 'master', 'god', 'duelHunter']));
    expect(layouts.length).toBeGreaterThanOrEqual(7);
    expect(seatTypes).toEqual(['dummy', 'hunter', 'master', 'god', 'human', 'online']);
    expect(SCENARIOS.length).toBeGreaterThan(20);
  });

  it('every template-literal t(`prefix${…}`) belongs to a known family', () => {
    const unknown = templates
      // exactly `prefix${expr}` (optionally `as 'key'`): a known prefix and nothing after the placeholder
      .map(({ tpl, file }) => ({ m: /^`([^$`]*)\$\{[^`]*\}`(\s+as\s+'\w+')?$/.exec(tpl), file, tpl }))
      .filter((x) => !x.m || !(x.m[1] in families));
    expect(unknown.map((x) => `${x.file}: ${x.tpl}`)).toEqual([]);
  });

  it.each(Object.entries(families))('family %s: every member has a key', (prefix, values) => {
    expect(values.length).toBeGreaterThan(0);
    expect(values.map((v) => prefix + v).filter((k) => !(k in ru))).toEqual([]);
  });

  it('daily levels and scenario levels stay within the dailyLevel keys', () => {
    for (const id of allScenarios) expect(`dailyLevel${SCENARIO_META[id].level}` in ru, id).toBe(true);
  });
});

describe('t() and plural()', () => {
  it('substitutes every occurrence of a placeholder and falls back to the key', () => {
    setLang('en');
    expect(t('spectateSpeed', { n: 4 })).toBe(en.spectateSpeed.split('{n}').join('4'));
    setLang('ru');
    expect(t('spectateSpeed', { n: 4 })).toBe(ru.spectateSpeed.split('{n}').join('4'));
    expect(t('nope__' as 'play')).toBe('nope__');
  });

  it('Russian plural forms; English one/many', () => {
    setLang('ru');
    const f = (n: number) => plural(n, 'ход', 'хода', 'ходов');
    expect([1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111, 112].map(f)).toEqual([
      'ход', 'хода', 'хода', 'ходов', 'ходов', 'ходов', 'ходов', 'ход', 'хода', 'ходов', 'ход', 'ходов', 'ходов',
    ]);
    setLang('en');
    expect([0, 1, 2].map((n) => plural(n, 'move', 'moves', 'x'))).toEqual(['moves', 'move', 'moves']);
  });
});
