/**
 * Anonymous site counters (page opens, visitors, finished games) on the free Abacus counter service.
 * Only a "+1" is sent, nothing about the player. Counting happens on the real site only, so local
 * development and tests do not inflate the numbers. Failures are silent: the game never depends on it.
 */
const API = 'https://abacus.jasoncameron.dev';
const NS = 'nelkio-influence-web';
const SEEN_KEY = 'infweb.visitorCounted';

export type SiteCounter = 'opens' | 'visitors' | 'games';

export const LIVE = typeof location !== 'undefined' && location.hostname === 'nelkio.github.io';

const latest: Partial<Record<SiteCounter, number>> = {};

async function call(kind: 'hit' | 'get', key: SiteCounter): Promise<number | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`${API}/${kind}/${NS}/${key}`, { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(timer);
    // a counter that was never hit does not exist yet
    if (res.status === 404 && kind === 'get') return 0;
    if (!res.ok) return null;
    const data = (await res.json()) as { value?: number };
    if (typeof data.value !== 'number') return null;
    latest[key] = data.value;
    return data.value;
  } catch {
    return null;
  }
}

/** Count this page open (and the visitor, once per browser). */
export function countVisit() {
  if (!LIVE) return;
  void call('hit', 'opens');
  try {
    if (!localStorage.getItem(SEEN_KEY)) {
      localStorage.setItem(SEEN_KEY, '1');
      void call('hit', 'visitors');
    }
  } catch {
    /* storage blocked: skip the visitor count */
  }
}

/** Count a finished match. */
export function countGame() {
  if (LIVE) void call('hit', 'games');
}

/** Current values of all counters (null where unavailable). */
export async function readCounters(): Promise<Record<SiteCounter, number | null>> {
  const keys: SiteCounter[] = ['opens', 'visitors', 'games'];
  const values = await Promise.all(keys.map((k) => call('get', k)));
  return { opens: values[0], visitors: values[1], games: values[2] };
}
