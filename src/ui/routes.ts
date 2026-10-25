import type { Route } from './store';

/** Screens a URL restores, by hash. */
const SCREENS: Record<string, Route> = {
  setup: { name: 'setup' },
  daily: { name: 'daily' },
  duels: { name: 'duels' },
  rules: { name: 'rules' },
  stats: { name: 'stats' },
  settings: { name: 'settings' },
  join: { name: 'join' },
};

export type HashTarget =
  | { kind: 'menu' }
  | { kind: 'screen'; route: Route }
  /** an invite link: open it, then drop it from the address (a reload does not join again) */
  | { kind: 'invite'; route: Route }
  /** a screen that cannot be rebuilt from the address (match, battle room) */
  | { kind: 'transient' }
  | { kind: 'unknown' };

/** What an address hash points to. A trailing slash and the letter case of a code do not matter. */
export function parseHash(hash: string): HashTarget {
  const h = hash.replace(/^#/, '').replace(/\/+$/, '');
  if (h === '') return { kind: 'menu' };
  const m = /^\/([a-z]+)(?:\/([A-Za-z0-9]+))?$/.exec(h);
  if (!m) return { kind: 'unknown' };
  const [, name, code] = m;
  if (code !== undefined) {
    if (name === 'duel' && code.length === 4) return { kind: 'invite', route: { name: 'duels', join: code.toUpperCase() } };
    if (name === 'join' && code.length === 5) return { kind: 'invite', route: { name: 'battleRoom', join: code.toUpperCase() } };
    return { kind: 'unknown' };
  }
  if (SCREENS[name]) return { kind: 'screen', route: SCREENS[name] };
  if (name === 'game' || name === 'room') return { kind: 'transient' };
  return { kind: 'unknown' };
}

/** The address hash of a screen ('' for the menu). */
export function routeHash(r: Route): string {
  if (r.name === 'menu') return '';
  if (r.name === 'game') return '#/game';
  if (r.name === 'battleRoom') return '#/room';
  return `#/${r.name}`;
}
