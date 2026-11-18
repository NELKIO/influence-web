import { chromium } from 'playwright';
import { buildScenario, type ScenarioId } from '../src/core/scenarios';
import type { FieldSize, PlayerType } from '../src/core/types';
const COL = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4'];
function svg(st: ReturnType<typeof buildScenario>, label: string, W: number, H: number) {
  const f = st.field; const r = 1;
  const pos = (x: number, y: number) => [x * Math.sqrt(3) * r + (y % 2 ? Math.sqrt(3) / 2 : 0), y * 1.5];
  const pts = f.cells.map(c => pos(c.x, c.y));
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const minX = Math.min(...xs) - 1, maxX = Math.max(...xs) + 1, minY = Math.min(...ys) - 1, maxY = Math.max(...ys) + 1;
  const sc = Math.min((W - 10) / (maxX - minX), (H - 30) / (maxY - minY));
  const tx = (x: number) => 5 + (x - minX) * sc, ty = (y: number) => 25 + (y - minY) * sc;
  let s = '';
  f.cells.forEach((c, i) => {
    const [cx, cy] = pts[i];
    const poly = Array.from({ length: 6 }, (_, k) => { const a = Math.PI / 3 * k + Math.PI / 6; return `${tx(cx + .97 * Math.cos(a)).toFixed(1)},${ty(cy + .97 * Math.sin(a)).toFixed(1)}`; }).join(' ');
    const fill = c.owner >= 0 ? COL[c.owner] : c.maxPower === 12 ? '#8a90a0' : '#c9ced8';
    const obj = st.objectives?.includes(i);
    s += `<polygon points="${poly}" fill="${fill}" stroke="${obj ? '#ffb000' : '#fff'}" stroke-width="${obj ? 3 : .5}"/>`;
    if (c.power) s += `<text x="${tx(cx)}" y="${ty(cy) + sc * .3}" font-size="${sc * .8}" text-anchor="middle" font-family="sans-serif" fill="#000">${c.power}</text>`;
  });
  for (const [a, b] of f.walls) { const [ax, ay] = pts[a], [bx, by] = pts[b]; const mx = (ax + bx) / 2, my = (ay + by) / 2, dx = (by - ay) * .5, dy = -(bx - ax) * .5; s += `<line x1="${tx(mx - dx)}" y1="${ty(my - dy)}" x2="${tx(mx + dx)}" y2="${ty(my + dy)}" stroke="#111" stroke-width="3"/>`; }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" style="background:#fff"><text x="5" y="16" font-family="sans-serif" font-size="12">${label} · ${f.cells.length} cells</text>${s}</svg>`;
}
const args = Object.fromEntries(process.argv.slice(2).map(a => a.split('=')));
const ids = (args.ids ?? 'sparks,highlands,colonies').split(',') as ScenarioId[];
const seeds = Number(args.seeds ?? 6);
const seats = args.seats ? args.seats.split(',').map(Number) : [0];
const sizes = (args.sizes ?? '').split(',').filter(Boolean) as FieldSize[];
const items: string[] = [];
for (const id of ids) for (const n of seats) for (const size of sizes.length ? sizes : [undefined]) for (let k = 0; k < seeds; k++) {
  const players = n ? (['human', ...Array(n - 1).fill('hunter')] as PlayerType[]) : undefined;
  const st = buildScenario(id, 101 + k * 7919, undefined, players, size ? { size } : undefined);
  items.push(svg(st, `${id} ${n || ''}p ${size ?? ''} #${k}`, Number(args.w ?? 300), Number(args.h ?? 280)));
}
const cols = Number(args.cols ?? seeds);
const html = `<html><body style="margin:0;background:#eee"><div style="display:grid;grid-template-columns:repeat(${cols},${args.w ?? 300}px);gap:4px;padding:4px">${items.join('')}</div></body></html>`;
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: cols * (Number(args.w ?? 300) + 4) + 8, height: 400 } });
await p.setContent(html); await p.screenshot({ path: args.out ?? '/tmp/sheets/out.png', fullPage: true }); await b.close(); console.log(args.out);
