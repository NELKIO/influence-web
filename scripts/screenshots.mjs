// Captures README screenshots from the running dev server (npm run dev).
import { chromium } from '@playwright/test';

const BASE = process.env.BASE ?? 'http://127.0.0.1:5173/influence-web/';
const OUT = new URL('../docs/screenshots/', import.meta.url).pathname;
const browser = await chromium.launch();

async function page(viewport, setup) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  await p.goto(BASE);
  await p.evaluate((s) => {
    localStorage.clear();
    localStorage.setItem('infweb.settings', JSON.stringify({ lang: 'ru', speed: 'instant', confirmEnd: false, ...s.settings }));
    if (s.setup) localStorage.setItem('infweb.setup', JSON.stringify(s.setup));
  }, setup);
  await p.reload();
  await p.waitForTimeout(600);
  return p;
}

/** Plays `turns` greedy human turns (bots answer). */
async function play(p, turns) {
  for (let k = 0; k < turns; k++) {
    await p.evaluate(() => {
      const c = window.__infweb.ctrl;
      const s = c.state;
      for (let i = 0; i < 30; i++) {
        const cells = s.field.cells;
        let moved = false;
        for (let a = 0; a < cells.length && !moved; a++) {
          if (cells[a].owner !== s.current || cells[a].power < 2) continue;
          for (const d of s.field.adj[a]) {
            if (cells[d].owner === s.current) continue;
            if (cells[d].power === 0 || cells[a].power - cells[d].power >= 2) {
              c.tap(a);
              c.tap(d);
              moved = true;
              break;
            }
          }
        }
        if (!moved) break;
      }
      c.endButton(true);
      c.endButton(true);
    });
    await p.waitForFunction(() => window.__infweb.ctrl.isLocalTurn && !window.__infweb.ctrl.busy, null, { timeout: 30000 });
  }
  // let power pop-ups and fight effects fade out
  await p.waitForTimeout(1600);
  await p.waitForFunction(() => window.__infweb.ctrl.state.current === 0 && !window.__infweb.ctrl.busy, null, { timeout: 30000 });
}

async function selectBest(p) {
  await p.evaluate(() => {
    const c = window.__infweb.ctrl;
    const s = c.state;
    let best = -1;
    let bestN = 0;
    s.field.cells.forEach((cell, i) => {
      if (cell.owner !== 0 || cell.power < 2) return;
      const n = s.field.adj[i].filter((d) => s.field.cells[d].owner > 0).length;
      if (n > bestN) (bestN = n), (best = i);
    });
    if (best >= 0) c.tap(best);
  });
  await p.waitForTimeout(400);
}

// 1. hero: desktop menu with the living board
{
  const p = await page({ width: 1440, height: 860 }, {});
  // the first background match starts crowded: wait for a few fights to happen
  await p.waitForTimeout(9000);
  await p.screenshot({ path: OUT + 'hero.png' });
}

// 2. phone: a battle in progress with attack odds on the targets
{
  const p = await page(
    { width: 390, height: 844 },
    { setup: { size: 'M', players: ['human', 'hunter', 'dummy', 'master'], darkness: false, symmetry: true, crowded: false, unions: false, shuffle: false } },
  );
  await p.locator('.mode-card', { hasText: 'Быстрый старт' }).click();
  await p.waitForFunction(() => !!window.__infweb);
  await play(p, 5);
  await selectBest(p);
  await p.screenshot({ path: OUT + 'battle.png' });
}

// 3. phone: triangle map for three players
{
  const p = await page(
    { width: 390, height: 844 },
    { setup: { size: 'M', players: ['human', 'hunter', 'master'], darkness: false, symmetry: true, crowded: false, unions: false, shuffle: false } },
  );
  await p.locator('.mode-card', { hasText: 'Быстрый старт' }).click();
  await p.waitForFunction(() => !!window.__infweb);
  await play(p, 4);
  await selectBest(p);
  await p.screenshot({ path: OUT + 'triangle.png' });
}

// 4. phone: rules
{
  const p = await page({ width: 390, height: 844 }, {});
  await p.locator('.mode-card', { hasText: 'Правила' }).click();
  await p.waitForTimeout(500);
  await p.screenshot({ path: OUT + 'rules.png' });
}

await browser.close();
console.log('screenshots saved to', OUT);
