/** Anonymous global counters. Only a counter name and +1 leave the browser, on the live site only. */
const API = 'https://abacus.jasoncameron.dev';
const NS = 'nelkio-influence-web';
const SEEN = 'infweb.visitorCounted';
const QUEUE = 'infweb.siteHit.';
const CACHE = 'infweb.siteCounter.';
export const counterKeys = ['opens', 'visitors', 'games'] as const;
export type SiteCounter = typeof counterKeys[number];
export type SiteValues = Record<SiteCounter, number | null>;
export const LIVE = typeof location !== 'undefined' && location.hostname === 'nelkio.github.io';
interface Sample { value: number; at: number }
const memory = new Map<string, string>();
function store(): Storage | undefined { try { return globalThis.localStorage; } catch { return undefined; } }
function read(key: string) { try { return memory.get(key) ?? store()?.getItem(key); } catch { return memory.get(key); } }
function write(key: string, value: string) {
  try { const s = store(); if (s) { s.setItem(key, value); memory.delete(key); return; } } catch { /* private browsing */ }
  memory.set(key, value);
}
function remove(key: string) { memory.delete(key); try { store()?.removeItem(key); } catch { /* no storage */ } }

export function lastKnownCounter(key: SiteCounter): Sample | null {
  try {
    const s = JSON.parse(read(CACHE + key) ?? 'null');
    return s && Number.isSafeInteger(s.value) && s.value >= 0 && Number.isFinite(s.at) ? s : null;
  } catch { return null; }
}
async function call(kind: 'hit' | 'get', key: SiteCounter): Promise<number | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(`${API}/${kind}/${NS}/${key}`, { signal: ctrl.signal, cache: 'no-store' });
    const value = res.status === 404 && kind === 'get' ? 0 : res.ok ? (await res.json()).value : null;
    if (!Number.isSafeInteger(value) || value < 0) return null;
    write(CACHE + key, JSON.stringify({ value, at: Date.now() }));
    return value as number;
  } catch { return null; } finally { clearTimeout(timer); }
}

/** Independent records avoid losing another tab's increment on a read/modify/write. */
function queue(key: SiteCounter) {
  const id = key === 'visitors' ? 'visitor' : (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);
  write(QUEUE + id, key);
}
function waiting(): string[] {
  const keys = new Set(memory.keys());
  try { const s = store(); if (s) for (let i = 0; i < s.length; i++) keys.add(s.key(i) ?? ''); } catch { /* memory only */ }
  return [...keys].filter(k => k.startsWith(QUEUE));
}
let running = false;
let retry: ReturnType<typeof setTimeout> | undefined;
let delay = 5000;
async function drain() {
  // Bounded batches: a long outage must not produce a burst of requests when the site comes back.
  for (const id of waiting().slice(0, 8)) {
    const k = read(id) as SiteCounter;
    if (!counterKeys.includes(k)) { remove(id); continue; }
    // Abacus has no idempotency keys. Keep an unacknowledged hit for the next attempt; if only the
    // response was lost (not the request), this anonymous counter can overcount by one.
    if (await call('hit', k) === null) { delay = Math.min(delay * 2, 120_000); break; }
    remove(id);
    delay = 5000;
  }
}
export async function flushCounts() {
  if (!LIVE || running || globalThis.navigator?.onLine === false) return;
  running = true;
  clearTimeout(retry);
  try {
    const locks = globalThis.navigator?.locks;
    if (locks) await locks.request('infweb.siteHit', drain);
    else await drain();
  } catch {
    // Web Locks can be denied in a restricted browser context; keep counting in this tab.
    await drain();
  } finally {
    running = false;
    if (waiting().length) retry = setTimeout(() => void flushCounts(), delay);
  }
}
export function countVisit() {
  if (!LIVE) return;
  queue('opens');
  if (!read(SEEN)) {
    queue('visitors');
    write(SEEN, '1');
  }
  void flushCounts();
}
export function countGame() {
  if (LIVE) { queue('games'); void flushCounts(); }
}
export function readCounter(key: SiteCounter) { return call('get', key); }
if (LIVE && typeof window !== 'undefined') window.addEventListener('online', () => void flushCounts());
