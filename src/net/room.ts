/** Room codes and invite links for online duels. */

/** Uppercase letters and digits without the ambiguous 0/O/1/I. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 4;
/** Namespace for PeerJS ids on the shared public broker. */
export const PEER_ID_PREFIX = 'infweb-';

export function generateCode(random: () => number = secureRandom): string {
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  return s;
}

/** Uppercase, drop spaces/dashes and anything outside A-Z0-9. Does not validate. */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function isValidCode(code: string): boolean {
  if (code.length !== CODE_LENGTH) return false;
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
