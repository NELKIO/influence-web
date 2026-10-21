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

export function setLang(l: Lang) {
  lang = l;
  if (typeof document !== 'undefined') document.documentElement.lang = l;
}

export function getLang(): Lang {
  return lang;
}

export function t(key: Key, params?: Record<string, string | number>): string {
  let s: string = dicts[lang][key] ?? dicts.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/** Russian-style plural: forms for 1, 2-4, 5+ */
export function plural(n: number, one: string, few: string, many: string): string {
  if (lang === 'en') return n === 1 ? one : few;
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
