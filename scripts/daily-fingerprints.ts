/**
 * Fingerprints of every map of the day in a date range: the starting state (cells, walls, objectives,
 * settings, seat order and dice seed). The published days must never change; tests/unit/daily-frozen
 * compares against the file this writes.
 *
 * Usage: npx vite-node scripts/daily-fingerprints.ts -- [from=2026-01-01] [to=2026-12-31] [out=path]
 */
import { writeFileSync } from 'node:fs';
import { dailyFingerprints } from '../tests/unit/dailyFingerprint';

const args = new Map(process.argv.slice(2).map((a) => a.split('=') as [string, string]));
const from = args.get('from') ?? '2026-01-01';
const to = args.get('to') ?? '2026-12-31';
const out = args.get('out') ?? 'tests/unit/fixtures/daily-fingerprints.json';
writeFileSync(out, JSON.stringify({ from, to, days: dailyFingerprints(from, to) }, null, 0).replace(/","/g, '",\n"') + '\n');
console.log(out);
