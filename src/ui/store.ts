import { useEffect, useState } from 'preact/hooks';
import { loadSettings, saveSettings, type Settings } from '../storage';
import { setLang, detectLang } from '../i18n';
import { setPalette } from './theme';
import { setSoundEnabled, setVibration } from '../audio/sfx';
import type { MatchState } from '../core/types';
import { parseHash, routeHash } from './routes';

export { parseHash, routeHash, type HashTarget } from './routes';

let settings = loadSettings();
const listeners = new Set<() => void>();

function applySettings(s: Settings) {
  setLang(s.lang ?? detectLang());
  setPalette(s.palette);
  setSoundEnabled(s.sound);
  setVibration(s.vibration);
}
applySettings(settings);

export function getSettings(): Settings {
  return settings;
}

export function updateSettings(patch: Partial<Settings>) {
  settings = { ...settings, ...patch };
  saveSettings(settings);
  applySettings(settings);
  listeners.forEach((f) => f());
}

export function useSettings(): Settings {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    listeners.add(f);
    return () => {
      listeners.delete(f);
    };
  }, []);
  return settings;
}

// ---------------------------------------------------------------- routing

export interface Launch {
  state: MatchState;
  initial: MatchState;
  /** online duel session (opaque to the router) */
  online?: unknown;
}

export type Route =
  | { name: 'menu' }
  | { name: 'setup' }
  | { name: 'game'; launch: Launch }
  | { name: 'daily' }
  | { name: 'duels'; join?: string; online?: boolean }
  | { name: 'join'; code?: string }
  /** battle room: `join` = guest joining by code, otherwise the host's lobby for the current setup */
  | { name: 'battleRoom'; join?: string }
  | { name: 'settings' }
  | { name: 'stats' }
  | { name: 'rules' };

let route: Route = { name: 'menu' };
const routeListeners = new Set<() => void>();

function setRoute(r: Route) {
  route = r;
  routeListeners.forEach((f) => f());
}

// ---------------------------------------------------------------- browser history
//
// Every screen but the menu has a history entry (#/setup, #/daily, ...), stacked over the menu's, so the
// browser's (or Android's) back button walks back through the screens and ends at the menu. The entry
// carries its depth over the menu (the menu is 0). A match and a battle room cannot be rebuilt from a
// URL: a reload there lands on the menu (which offers to continue).

interface Entry {
  infweb: number;
}
const hasHistory = typeof window !== 'undefined' && typeof history !== 'undefined';
/** depth of the current entry over the menu's */
let depth = 0;
/** the address the router last settled on (popstate and hashchange both report one change) */
let handledHref = '';
/** a jump back to the menu's entry is under way; `queued`: where the app went meanwhile */
let traversing = 0;
let queued: Route | null = null;

const urlOf = (r: Route) => location.pathname + location.search + routeHash(r);

function writeEntry(r: Route, d: number, push: boolean) {
  depth = d;
  const st: Entry = { infweb: d };
  if (push) history.pushState(st, '', urlOf(r));
  else history.replaceState(st, '', urlOf(r));
  handledHref = location.href;
}

/** The history entry of a screen the app moves to from the current one. */
function enter(r: Route, from: Route) {
  if (r.name === 'menu') return writeEntry(r, 0, false);
  // a match replaces the screen it was started from (and a match after a match replaces it):
  // back from a match leaves it, like its «menu» button
  const replace = from.name === r.name || from.name === 'game' || (r.name === 'game' && from.name !== 'menu');
  if (replace) writeEntry(r, Math.max(depth, 1), false);
  else writeEntry(r, depth + 1, true);
}

/** Back to the menu's entry (the screens over it stay as forward entries). */
function backToMenu() {
  setRoute({ name: 'menu' });
  if (depth <= 0) return writeEntry({ name: 'menu' }, 0, false);
  const d = depth;
  depth = 0;
  queued = null;
  const id = ++traversing;
  history.go(-d);
  // the jump lands with a popstate; should it never come (no entries under this one), settle here
  window.setTimeout(() => {
    if (traversing === id) landed();
  }, 600);
}

/** The jump back to the menu's entry is over: write the screen the app went to meanwhile. */
function landed() {
  traversing = 0;
  depth = 0;
  const q = queued;
  queued = null;
  if (q && q.name !== 'menu') enter(q, { name: 'menu' });
  else writeEntry({ name: 'menu' }, 0, false);
}

/** Leaving a match: what its own «menu» button does (an online match knows where it returns to). */
function leaveMatch(r: Extract<Route, { name: 'game' }>): Route {
  const online = r.launch.online as { exitTo?: Route; onLeaveEnded?: () => void } | undefined;
  if (r.launch.state.ended) online?.onLeaveEnded?.();
  return online?.exitTo ?? { name: 'menu' };
}

export function navigate(r: Route) {
  if (!hasHistory) return setRoute(r);
  const from = route;
  if (traversing) {
    // the history is still on its way back to the menu: write this screen when it gets there
    queued = r;
    return setRoute(r);
  }
  if (r.name === 'menu') return backToMenu();
  enter(r, from);
  setRoute(r);
}

/** The address changed under the app: back/forward, a typed or clicked link. */
function onAddress() {
  if (traversing) return landed();
  if (location.href === handledHref) return;
  handledHref = location.href;
  const st = history.state as Partial<Entry> | null;
  const ours = typeof st?.infweb === 'number';
  // a link followed inside the app makes a new entry without our state: one over the current one
  depth = ours ? st!.infweb! : depth + 1;
  const from = route;
  const target = parseHash(location.hash);
  if (from.name === 'game') {
    // back from a match is its «menu» button
    const exit = leaveMatch(from);
    if (exit.name === 'menu') return backToMenu();
    enter(exit, from);
    return setRoute(exit);
  }
  if (target.kind === 'screen' || target.kind === 'invite') {
    // an invite is consumed: its entry becomes the screen it opens
    if (!ours || target.kind === 'invite' || location.hash !== routeHash(target.route)) writeEntry(target.route, Math.max(depth, 1), false);
    return setRoute(target.route);
  }
  // the menu, a match or a room left behind, or an address that means nothing: the menu
  backToMenu();
}

/** Read the address once at start: restore its screen, open an invite, or settle on the menu. */
export function initRouter() {
  if (!hasHistory) return;
  const st = history.state as Partial<Entry> | null;
  const saved = typeof st?.infweb === 'number' ? st.infweb : null;
  const target = parseHash(location.hash);
  if (target.kind === 'screen' && saved !== null && saved > 0) {
    // a reload: the entries under this one are still there
    depth = saved;
    writeEntry(target.route, saved, false);
    setRoute(target.route);
  } else if (target.kind === 'screen' || target.kind === 'invite') {
    // opened from outside: put the menu under it, so back ends at the menu
    writeEntry({ name: 'menu' }, 0, false);
    writeEntry(target.route, 1, true);
    setRoute(target.route);
  } else {
    // the menu; a match or a room cannot be rebuilt from the address; nonsense is cleared
    depth = saved ?? 0;
    backToMenu();
  }
  window.addEventListener('popstate', onAddress);
  window.addEventListener('hashchange', onAddress);
}

/** For tests: forget the router's state. */
export function resetRouterForTests() {
  route = { name: 'menu' };
  depth = 0;
  handledHref = '';
  traversing = 0;
  queued = null;
}

export function useRoute(): Route {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    routeListeners.add(f);
    return () => {
      routeListeners.delete(f);
    };
  }, []);
  return route;
}
