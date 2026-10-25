/**
 * Network debug log, enabled with `?netdebug=1` in the page URL (or `localStorage['infweb.netdebug'] = '1'`).
 *
 * Every entry goes to the console (`[net] ...`) and to `window.__netlog` (the last 3000 entries), so a
 * test or a user can read which path carried each message and how long it took:
 *   tx   {to, seq, paths, bytes}          a game message left on these paths (retransmissions: try > 0)
 *   ack  {from, seq, ms, path}            the peer confirmed it, `ms` after the first send
 *   rx   {from, seq, path, dup}           a game message arrived (dup: already had it via another path)
 *   path {kind, open | failed}            a path opened / closed / failed
 *   rtt  {kind, ms}                       a ping round trip on one path
 */

export interface NetLogEntry {
  /** ms since the page started */
  t: number;
  ev: string;
  [k: string]: unknown;
}

let enabled: boolean | null = null;
const LOG: NetLogEntry[] = [];
const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();

function detect(): boolean {
  try {
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('netdebug') === '1') return true;
    return typeof localStorage !== 'undefined' && localStorage.getItem('infweb.netdebug') === '1';
  } catch {
    return false;
  }
}

export function netDebugEnabled(): boolean {
  if (enabled === null) {
    enabled = detect();
    if (enabled && typeof window !== 'undefined') (window as unknown as { __netlog: NetLogEntry[] }).__netlog = LOG;
  }
  return enabled;
}

/** tests: switch the log on / off */
export function setNetDebug(on: boolean): void {
  enabled = on;
  if (!on) LOG.length = 0;
}

export function netLogEntries(): readonly NetLogEntry[] {
  return LOG;
}

export function netLog(ev: string, data: Record<string, unknown> = {}): void {
  if (!netDebugEnabled()) return;
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const e: NetLogEntry = { t: Math.round(now - t0), ev, ...data };
  LOG.push(e);
  if (LOG.length > 3000) LOG.splice(0, LOG.length - 3000);
  try {
    console.debug('[net]', ev, JSON.stringify(data));
  } catch {
    /* ignore */
  }
}
