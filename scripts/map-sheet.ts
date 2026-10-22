/**
 * Contact sheets of generated maps (PNG via headless Chromium), for eyeballing the map generator.
 * Cells: light = max power 8, dark = 12; coloured dots = start cells; red = choke points between the
 * starts; orange ring = cells holding a dead end of more than 5 cells; thick lines = walls.
 *
 * Usage: npx vite-node scripts/map-sheet.ts -- out=/tmp/maps [seed=1] [prefix=after]
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { Rng } from '../src/core/rng';
import { generateField, ROT_LAYOUTS, type GenerateOptions } from '../src/core/field';
import { articulationPoints, chokePoints } from '../src/core/connectivity';
import { SIZE_ORDER, type Field, type FieldSize } from '../src/core/types';

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const i = a.indexOf('=');
  if (i > 0) args.set(a.slice(0, i), a.slice(i + 1));
}
const out = args.get('out') ?? '/tmp/maps';
const seed0 = Number(args.get('seed') ?? '1');
const prefix = args.get('prefix') ?? 'after';
mkdirSync(out, { recursive: true });

const START_COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4'];

/** cells that cut off a dead end of more than 5 cells */
function pocketHolders(adj: number[][]): Set<number> {
  const res = new Set<number>();
  const n = adj.length;
  for (const v of articulationPoints(adj)) {
    const comp = new Int32Array(n).fill(-1);
    comp[v] = -2;
    const sizes: number[] = [];
    for (let s = 0; s < n; s++) {
      if (comp[s] !== -1) continue;
      let cnt = 0;
      const st = [s];
      comp[s] = sizes.length;
      while (st.length) {
        const u = st.pop()!;
        cnt++;
        for (const w of adj[u]) if (comp[w] === -1) (comp[w] = sizes.length), st.push(w);
      }
      sizes.push(cnt);
    }
    sizes.sort((a, b) => b - a);
    if (sizes.slice(1).some((x) => x > 5)) res.add(v);
  }
  return res;
}

function svgMap(f: Field, label: string, W: number, H: number): string {
  const r = 1;
  const pos = (x: number, y: number) => [x * Math.sqrt(3) * r + (y % 2 ? (Math.sqrt(3) / 2) * r : 0), y * 1.5 * r];
  const pts = f.cells.map((c) => pos(c.x, c.y));
  const minX = Math.min(...pts.map((p) => p[0])) - r;
  const maxX = Math.max(...pts.map((p) => p[0])) + r;
  const minY = Math.min(...pts.map((p) => p[1])) - r;
  const maxY = Math.max(...pts.map((p) => p[1])) + r;
  const scale = Math.min((W - 10) / (maxX - minX), (H - 30) / (maxY - minY));
  const tx = (x: number) => 5 + (x - minX) * scale + ((W - 10) - (maxX - minX) * scale) / 2;
  const ty = (y: number) => 25 + (y - minY) * scale;
  const starts = [...new Set(f.starts)];
  const chokes = new Set(chokePoints(f.adj, starts));
  const pockets = pocketHolders(f.adj);
  let s = '';
  f.cells.forEach((c, i) => {
    const [cx, cy] = pts[i];
    const poly = Array.from({ length: 6 }, (_, k) => {
      const a = (Math.PI / 3) * k + Math.PI / 6;
      return `${tx(cx + r * 0.97 * Math.cos(a)).toFixed(1)},${ty(cy + r * 0.97 * Math.sin(a)).toFixed(1)}`;
    }).join(' ');
    const fill = chokes.has(i) ? '#ff3b30' : c.maxPower === 12 ? '#7d8597' : '#c9ced8';
    const stroke = pockets.has(i) ? 'stroke="#ff9500" stroke-width="2.5"' : 'stroke="#fff" stroke-width="0.5"';
    s += `<polygon points="${poly}" fill="${fill}" ${stroke}/>`;
  });
  for (const [a, b] of f.walls) {
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    const dx = (by - ay) * 0.5;
    const dy = -(bx - ax) * 0.5;
    s += `<line x1="${tx(mx - dx)}" y1="${ty(my - dy)}" x2="${tx(mx + dx)}" y2="${ty(my + dy)}" stroke="#111" stroke-width="3"/>`;
  }
  starts.forEach((st, k) => {
    const [cx, cy] = pts[st];
    s += `<circle cx="${tx(cx)}" cy="${ty(cy)}" r="${Math.max(2.5, scale * 0.45)}" fill="${START_COLORS[k % 6]}" stroke="#000" stroke-width="0.8"/>`;
  });
  const info = `${label} · ${f.cells.length} cells${chokes.size ? ` · ${chokes.size} chokes` : ''}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" style="background:#fff;border:1px solid #ddd"><text x="5" y="16" font-family="sans-serif" font-size="12" fill="${chokes.size ? '#c00' : '#222'}">${info}</text>${s}</svg>`;
}

interface Item {
  label: string;
  opts: GenerateOptions;
  seed: number;
}

async function sheet(name: string, items: Item[], cols: number, W = 260, H = 240) {
  const html = `<html><body style="margin:0;background:#f4f4f4"><div style="display:grid;grid-template-columns:repeat(${cols},${W}px);gap:4px;padding:4px">${items
    .map((it) => svgMap(generateField(it.opts, new Rng(it.seed)), it.label, W, H))
    .join('')}</div></body></html>`;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: cols * (W + 4) + 8, height: 400 } });
  await page.setContent(html);
  const path = `${out}/${prefix}-${name}.png`;
  await page.screenshot({ path, fullPage: true });
  await browser.close();
  console.log(path);
}

const rot3: Item[] = [];
for (const size of SIZE_ORDER)
  for (const layout of ROT_LAYOUTS[3]) rot3.push({ label: `3p ${layout} ${size}`, opts: { size, symmetry: true, players: 3, layout }, seed: seed0 });
await sheet('rot3', rot3, 6);

const rot6: Item[] = [];
for (const size of SIZE_ORDER)
  for (const layout of ROT_LAYOUTS[6]) rot6.push({ label: `5/6p ${layout} ${size}`, opts: { size, symmetry: true, players: 5, layout }, seed: seed0 });
await sheet('rot6', rot6, 5);

const sizes: FieldSize[] = ['M', 'L', 'XL', 'XXL'];
const mirrorItems: Item[] = [];
for (const size of sizes)
  for (let k = 0; k < 5; k++) mirrorItems.push({ label: `mirror ${size} #${seed0 + k}`, opts: { size, symmetry: true, players: 2 }, seed: seed0 + k });
await sheet('mirror', mirrorItems, 5);

const randItems: Item[] = [];
for (const size of sizes)
  for (let k = 0; k < 5; k++) randItems.push({ label: `random ${size} #${seed0 + k}`, opts: { size, symmetry: false, players: 6 }, seed: seed0 + k });
await sheet('random', randItems, 5);
