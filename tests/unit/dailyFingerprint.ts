import { createDailyMatch } from '../../src/daily';

/** FNV-1a over a string. */
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

/** Everything a player sees at the start of a day's map, as a stable string. */
export function dailyFingerprint(id: string): string {
  const st = createDailyMatch(id);
  const { cells, adj, walls } = st.field;
  return fnv(JSON.stringify([
    cells.map((c) => [c.x, c.y, c.owner, c.power, c.maxPower]),
    adj, walls ?? null, st.objectives ?? null, st.current, st.turn,
    Object.entries(st.settings).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)),
  ]));
}

export function dailyFingerprints(from: string, to: string): Record<string, string> {
  const out: Record<string, string> = {};
  const d = new Date(`${from}T12:00:00`);
  const end = new Date(`${to}T12:00:00`);
  for (; d <= end; d.setDate(d.getDate() + 1)) {
    const id = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    out[id] = dailyFingerprint(id);
  }
  return out;
}
