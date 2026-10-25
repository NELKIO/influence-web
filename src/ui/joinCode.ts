import { CODE_ALPHABET, normalizeCode } from '../net/room';

/** Cyrillic letters that look like Latin ones (a code typed on a Russian keyboard layout). */
const LOOKALIKE: Record<string, string> = {
  А: 'A',
  В: 'B',
  Е: 'E',
  К: 'K',
  М: 'M',
  Н: 'H',
  О: 'O',
  Р: 'P',
  С: 'C',
  Т: 'T',
  Х: 'X',
  У: 'Y',
};

/** Longest code there is (battle rooms; duels have 4 characters). */
export const JOIN_CODE_MAX = 5;

/**
 * What the join box keeps of a typed or pasted text: the code of an invite link (#/duel/CODE,
 * #/join/CODE), Cyrillic look-alikes as Latin letters, upper case, no separators, at most five characters.
 * Normalised first, then cut, so "ab-cd e" keeps all five characters.
 */
export function cleanJoinInput(raw: string): string {
  const latin = [...raw.toUpperCase()].map((ch) => LOOKALIKE[ch] ?? ch).join('');
  const link = /(?:^|[#/])(?:DUEL|JOIN)\/([A-Z0-9-]+)/.exec(latin);
  return normalizeCode(link ? link[1] : latin).slice(0, JOIN_CODE_MAX);
}

export type JoinCheck = { ok: true; kind: 'duel' | 'battle'; code: string } | { ok: false; error: 'length' | 'alphabet' };

/** Where a cleaned code leads: 4 characters to a duel, 5 to a battle room, made of the code alphabet. */
export function checkJoinCode(code: string): JoinCheck {
  if (code.length !== 4 && code.length !== 5) return { ok: false, error: 'length' };
  if (![...code].every((ch) => CODE_ALPHABET.includes(ch))) return { ok: false, error: 'alphabet' };
  return { ok: true, kind: code.length === 4 ? 'duel' : 'battle', code };
}
