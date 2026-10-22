/** Room codes and invite links for online duels. */

/** Uppercase letters and digits without the ambiguous 0/O/1/I. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 4;
/** Namespace for PeerJS ids on the shared public broker. */
export const PEER_ID_PREFIX = 'infweb-';

export function generateCode(random: () => number = secureRandom, length = CODE_LENGTH): string {
  let s = '';
  for (let i = 0; i < length; i++) s += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  return s;
}

/** Uppercase, drop spaces/dashes and anything outside A-Z0-9. Does not validate. */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function isValidCode(code: string, length = CODE_LENGTH): boolean {
  if (code.length !== length) return false;
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return false;
  return true;
}

/** PeerJS id of the host of room `code`. */
export function hostPeerId(code: string, prefix = PEER_ID_PREFIX): string {
  return `${prefix}${code}`;
}

/** `${origin}${BASE_URL}#/duel/CODE` — the link a host shares. */
export function inviteUrl(code: string, origin?: string): string {
  const o = origin ?? (typeof location !== 'undefined' ? location.origin : '');
  const base = import.meta.env?.BASE_URL ?? '/';
  return `${o}${base}#/duel/${code}`;
}

/**
 * Extract a room code from a location hash (`#/duel/ABCD`), a path fragment (`/duel/ABCD`)
 * or a full invite URL. Returns null when there is no valid code.
 */
export function parseInvite(hashOrUrl: string): string | null {
  const m = /(?:^|#|\/)duel\/([A-Za-z0-9-]+)\/?(?:[?#].*)?$/.exec(hashOrUrl.trim());
  if (!m) return null;
  const code = normalizeCode(m[1]);
  return isValidCode(code) ? code : null;
}

export function randomId(bytes = 8): string {
  const a = new Uint8Array(bytes);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(a);
  else for (let i = 0; i < bytes; i++) a[i] = Math.floor(Math.random() * 256);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function secureRandom(): number {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    return crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
  }
  return Math.random();
}

// ---------------------------------------------------------------- battle rooms (2-6 players)

/** Battle rooms use 5-character codes, so one "join" box can route a code by its length. */
export const BATTLE_CODE_LENGTH = 5;
/** PeerJS id namespace of battle rooms (distinct from duels: `infweb-b-ABCDE`). */
export const BATTLE_PEER_ID_PREFIX = 'infweb-b-';

export function generateBattleCode(random: () => number = secureRandom): string {
  return generateCode(random, BATTLE_CODE_LENGTH);
}

export function isValidBattleCode(code: string): boolean {
  return isValidCode(code, BATTLE_CODE_LENGTH);
}

/** `${origin}${BASE_URL}#/join/CODE` — the link a battle host shares. */
export function inviteBattleUrl(code: string, origin?: string): string {
  const o = origin ?? (typeof location !== 'undefined' ? location.origin : '');
  const base = import.meta.env?.BASE_URL ?? '/';
  return `${o}${base}#/join/${code}`;
}

/** Battle room code from `#/join/ABCDE`, `/join/ABCDE` or a full invite URL; null if none / invalid. */
export function parseBattleInvite(hashOrUrl: string): string | null {
  const m = /(?:^|#|\/)join\/([A-Za-z0-9-]+)\/?(?:[?#].*)?$/.exec(hashOrUrl.trim());
  if (!m) return null;
  const code = normalizeCode(m[1]);
  return isValidBattleCode(code) ? code : null;
}

/**
 * Route whatever was typed / pasted into a single "join" box: a 4-character code (or duel link) is a duel,
 * a 5-character code (or `#/join/` link) is a battle room. Returns null when it is neither.
 */
export function routeJoinCode(input: string): { kind: 'duel' | 'battle'; code: string } | null {
  const battle = parseBattleInvite(input);
  if (battle) return { kind: 'battle', code: battle };
  const duel = parseInvite(input);
  if (duel) return { kind: 'duel', code: duel };
  const code = normalizeCode(input);
  if (isValidCode(code)) return { kind: 'duel', code };
  if (isValidBattleCode(code)) return { kind: 'battle', code };
  return null;
}
