/**
 * Exhaustive map check: choke points between the players' starts, dead-end pockets, exact symmetry,
 * size and generation time for every (size x players x symmetry x crowded) configuration and for
 * every rotational layout.
 *
 * Usage: npx vite-node scripts/check-maps.ts -- [seeds=500] [json=1]
 *
 * For each configuration and seed (the seed of createMatch, so these are the maps of real games):
 *  - generateField is timed on the same rng the engine uses;
 *  - the match's map is checked for choke points between all of field.starts (every start subset
 *    the engine picks is covered by that) and, when not crowded, between the cells the players
 *    actually start on;
 *  - "pocket": the largest group of cells that a single cell cuts off from the rest of the map;
 *  - symmetric maps must be exactly symmetric (mirror: 4-way, rotational: 120 or 60 degrees).
 */
import { Rng } from '../src/core/rng';
import { generateField, ROT_LAYOUTS, type RotLayout } from '../src/core/field';
import { createMatch } from '../src/core/engine';
import { chokePoints } from '../src/core/connectivity';
import { SIZE_ORDER, type Field, type FieldSize, type MatchSettings, type PlayerType } from '../src/core/types';
import { largestPocket, mirrorSymmetric, rotationSymmetric } from '../tests/unit/mapChecks';

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const i = a.indexOf('=');
  if (i > 0) args.set(a.slice(0, i), a.slice(i + 1));
}
const SEEDS = Number(args.get('seeds') ?? '500');
const JSON_OUT = args.get('json') === '1';

interface Row {
  key: string;
  size: FieldSize;
  n: number;
  chokeStarts: number;
  chokeOwned: number;
  asym: number;
  times: number[];
  avgCells: number;
  avgPocket: number;
  maxPocket: number;
}

const rows: Row[] = [];

/** players: 3 on a symmetric map = rotation by 120 degrees, 5 or 6 = by 60 degrees, else mirror */
function symmetric(f: Field, players: number): boolean {
  if (players === 3) return rotationSymmetric(f, 3);
  if (players >= 5) return rotationSymmetric(f, 6);
  return mirrorSymmetric(f);
}

function run(label: string, size: FieldSize, players: number, symmetry: boolean, crowded: boolean, layout?: RotLayout) {
  const r: Row = { key: label, size, n: SEEDS, chokeStarts: 0, chokeOwned: 0, asym: 0, times: [], avgCells: 0, avgPocket: 0, maxPocket: 0 };
  for (let seed = 1; seed <= SEEDS; seed++) {
    let f: Field;
    if (layout) {
      const t0 = performance.now();
      f = generateField({ size, symmetry, players, layout }, new Rng(seed));
      r.times.push(performance.now() - t0);
    } else {
      // the engine draws the map first from Rng(seed); time that same call
      const t0 = performance.now();
      generateField({ size, symmetry, players }, new Rng(seed));
      r.times.push(performance.now() - t0);
      const types: PlayerType[] = Array.from({ length: players }, (_, i) => (i === 0 ? 'human' : 'hunter'));
      const settings: MatchSettings = { kind: 'single', size, players: types, darkness: false, symmetry, crowded, unions: false, shuffle: false, duelRules: false };
      const m = createMatch(settings, { seed });
      f = m.field;
      // crowded matches hand every cell out at random, so only the map itself can be checked
      if (!crowded) {
        const owned: number[] = [];
        for (let pl = 0; pl < players; pl++) owned.push(f.cells.findIndex((c) => c.owner === pl));
        if (chokePoints(f.adj, owned).length) r.chokeOwned++;
      }
    }
    r.avgCells += f.cells.length / SEEDS;
    if (chokePoints(f.adj, [...new Set(f.starts)]).length) r.chokeStarts++;
    if (symmetry && !symmetric(f, players)) r.asym++;
    const p = largestPocket(f.adj);
    r.avgPocket += p / SEEDS;
    r.maxPocket = Math.max(r.maxPocket, p);
  }
  rows.push(r);
}

// warm up the JIT so the first configuration's times are not inflated
for (let seed = 1; seed <= 30; seed++) for (const size of SIZE_ORDER) generateField({ size, symmetry: seed % 2 === 0, players: 2 + (seed % 5) }, new Rng(-seed));

const t0 = performance.now();
for (const symmetry of [false, true]) {
  for (let players = 2; players <= 6; players++) {
    for (const crowded of [false, true]) {
      for (const size of SIZE_ORDER) run(`${symmetry ? 'sym' : 'rand'} n=${players}${crowded ? ' crowded' : ''}`, size, players, symmetry, crowded);
    }
  }
}
for (const k of [3, 6] as const) {
  for (const layout of ROT_LAYOUTS[k]) {
    for (const size of SIZE_ORDER) run(`rot k=${k} ${layout}`, size, k === 3 ? 3 : 5, true, false, layout);
  }
}
const total = performance.now() - t0;

if (JSON_OUT) {
  console.log(JSON.stringify(rows.map(({ times, ...r }) => ({ ...r, avgMs: times.reduce((a, b) => a + b, 0) / times.length, maxMs: Math.max(...times) }))));
} else {
  const pct = (x: number, n: number) => `${((100 * x) / n).toFixed(1)}%`.padStart(6);
  const keys = [...new Set(rows.map((r) => r.key))];
  console.log(`seeds per configuration: ${SEEDS}`);
  console.log('choke rate between field.starts (in brackets: between the cells the players actually start on)');
  for (const key of keys) {
    const line = SIZE_ORDER.map((size) => {
      const r = rows.find((x) => x.key === key && x.size === size)!;
      const owned = key.startsWith('rot') || key.includes('crowded') ? '' : ` (${pct(r.chokeOwned, r.n).trim()})`;
      return `${size} ${pct(r.chokeStarts, r.n)}${owned}`;
    }).join('  ');
    console.log(`${key.padEnd(24)} ${line}`);
  }
  console.log('\ngeneration time per size over all configurations (ms): avg / p99 / max');
  for (const size of SIZE_ORDER) {
    const ts = rows.filter((r) => r.size === size && !r.key.includes('crowded')).flatMap((r) => r.times).sort((a, b) => a - b);
    const avg = ts.reduce((a, b) => a + b, 0) / ts.length;
    console.log(`${size.padEnd(4)} ${avg.toFixed(2)} / ${ts[Math.floor(ts.length * 0.99)].toFixed(1)} / ${ts[ts.length - 1].toFixed(1)}`);
  }
  const fams = ['rand', 'sym n=2', 'sym n=3', 'sym n=5', 'rot k=3', 'rot k=6'];
  const famRows = (fam: string, size: FieldSize) => rows.filter((r) => r.size === size && r.key.startsWith(fam) && !r.key.includes('crowded'));
  console.log('\navg cells per size and family (sym n=2 = mirrored maps, n=3 / n=5 = rotational)');
  for (const fam of fams) {
    const line = SIZE_ORDER.map((size) => {
      const rs = famRows(fam, size);
      return `${size} ${(rs.reduce((a, r) => a + r.avgCells, 0) / rs.length).toFixed(1).padStart(6)}`;
    }).join('  ');
    console.log(`${fam.padEnd(8)} ${line}`);
  }
  console.log('\nlargest dead-end pocket behind one cell (avg / max cells) per family');
  for (const fam of fams) {
    const line = SIZE_ORDER.map((size) => {
      const rs = famRows(fam, size);
      return `${size} ${(rs.reduce((a, r) => a + r.avgPocket, 0) / rs.length).toFixed(1)}/${Math.max(...rs.map((r) => r.maxPocket))}`;
    }).join('  ');
    console.log(`${fam.padEnd(8)} ${line}`);
  }
  const bad = rows.filter((r) => r.chokeStarts || r.chokeOwned).length;
  const asym = rows.reduce((a, r) => a + r.asym, 0);
  const maps = rows.reduce((a, r) => a + r.n, 0);
  console.log(`\nconfigurations with choke points: ${bad}/${rows.length}; symmetric maps that are not exactly symmetric: ${asym}`);
  console.log(`${maps} maps, ${(total / 1000).toFixed(1)} s`);
}
