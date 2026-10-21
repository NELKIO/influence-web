/** Tiny storage abstraction so the session works with localStorage, an in-memory map (tests) or nothing. */
import { randomId } from './room';

export interface KVStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const CLIENT_ID_KEY = 'infweb.clientId';
export const DUEL_SESSION_KEY = 'infweb.duel';

/** localStorage if usable, otherwise null. */
export function defaultStorage(): KVStorage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const k = '__infweb_probe';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return localStorage;
  } catch {
    return null;
  }
}

export class MemoryStorage implements KVStorage {
  private m = new Map<string, string>();
  getItem(key: string) {
    return this.m.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.m.set(key, value);
  }
  removeItem(key: string) {
    this.m.delete(key);
  }
}

export function readJson<T>(storage: KVStorage | null, key: string): T | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writeJson(storage: KVStorage | null, key: string, value: unknown): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota / private mode: ignore */
  }
}

/** Random id of this browser, persisted so the host recognises a reconnecting guest. */
export function getClientId(storage: KVStorage | null = defaultStorage()): string {
  try {
    const existing = storage?.getItem(CLIENT_ID_KEY);
    if (existing) return existing;
  } catch {
    /* ignore */
  }
  const id = randomId(8);
  try {
    storage?.setItem(CLIENT_ID_KEY, id);
  } catch {
    /* ignore */
  }
  return id;
}
