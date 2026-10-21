import { useEffect, useState } from 'preact/hooks';
import { loadSettings, saveSettings, type Settings } from '../storage';
import { setLang, detectLang } from '../i18n';
import { setPalette } from './theme';
import { setSoundEnabled, setVibration } from '../audio/sfx';
import type { MatchState } from '../core/types';

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
  | { name: 'duels'; join?: string }
  | { name: 'settings' }
  | { name: 'stats' }
  | { name: 'rules' };

let route: Route = { name: 'menu' };
const routeListeners = new Set<() => void>();

export function navigate(r: Route) {
  route = r;
  routeListeners.forEach((f) => f());
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
