import { ru } from './ru';
import { en } from './en';

export type Lang = 'ru' | 'en';
export type Dict = typeof ru;
export type Key = keyof Dict;

const dicts: Record<Lang, Dict> = { ru, en };
let lang: Lang = detectLang();

export function detectLang(): Lang {
  const nav = typeof navigator !== 'undefined' ? navigator.language || '' : '';
  return /^(ru|uk|be|kk)/i.test(nav) ? 'ru' : 'en';
}

export function isLang(l: unknown): l is Lang {
  return l === 'ru' || l === 'en';
}

/** Switch the language (anything but ru/en is ignored); the page title follows. */
export function setLang(l: Lang) {
  if (!isLang(l)) return;
  lang = l;
  if (typeof document !== 'undefined') {
    document.documentElement.lang = l;
    document.title = dicts[l].docTitle;
  }
}

export function getLang(): Lang {
  return lang;
}

/**
 * The text of `key` with its {params} filled in. `{n|one|few|many}` picks the plural form for the
 * number `n` (English needs two forms: `{n|one|other}`).
 */
export function t(key: Key, params?: Record<string, string | number>): string {
  let s: string = dicts[lang][key] ?? dicts.en[key] ?? key;
  if (params) {
    s = s.replace(/\{(\w+)((?:\|[^{}|]*)+)\}/g, (all, k: string, forms: string) => {
      const n = Number(params[k]);
      if (!(k in params) || !Number.isFinite(n)) return all;
      const [one, few, many = few] = forms.slice(1).split('|');
      return plural(n, one, few, many);
    });
    for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
  }
  return s;
}

/** Russian-style plural: forms for 1, 2-4, 5+ */
export function plural(n: number, one: string, few: string, many: string): string {
  if (lang === 'en') return Math.abs(n) === 1 ? one : few;
  n = Math.abs(Math.trunc(n));
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
