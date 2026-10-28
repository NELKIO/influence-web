import { expect, test } from '@playwright/test';
import { fresh, waitGame } from './helpers';

// the project config blocks service workers (page.route() in WebKit); this spec needs the real one
test.use({ serviceWorkers: 'allow' });

test('after the first visit the whole game works offline, bots (web workers) included', async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'service worker check runs in Chromium only');
  await fresh(page, { confirmEnd: false });
  await expect(page.locator('.menu-screen')).toBeVisible();

  // first visit only: the worker installs the shell and takes over this very page
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15_000 });
  const cached = await page.evaluate(async () => {
    const out: string[] = [];
    for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(new URL(r.url).pathname);
    return out;
  });
  expect(cached.some((p) => /\/assets\/master\.worker-.*\.js$/.test(p))).toBe(true);
  expect(cached.some((p) => /\/assets\/god\.worker-.*\.js$/.test(p))).toBe(true);
  expect(cached.some((p) => /\.css$/.test(p))).toBe(true);
  expect(cached.some((p) => /\.woff2$/.test(p))).toBe(true);
  expect(cached).toContain('/influence-web/manifest.webmanifest');

  // a short duel with Master, so the first bot move needs its worker
  await page.evaluate(() => localStorage.setItem('infweb.setup', JSON.stringify({ size: 'S', players: ['human', 'master'], shuffle: false, rev: 2 })));
  const failed: string[] = [];
  const fromWorker: string[] = [];
  page.on('requestfailed', (r) => {
    if (!r.isNavigationRequest()) failed.push(r.url());
  });
  page.on('response', (r) => {
    if (r.fromServiceWorker()) fromWorker.push(new URL(r.url()).pathname);
  });

  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.menu-screen')).toBeVisible();
  await page.locator('.mode-card').first().click();
  await expect(page.locator('canvas')).toBeVisible();
  await waitGame(page);

  // end the human turn (attack, then power), and the bot answers from the cached worker
  await page.evaluate(() => (window as unknown as { __infweb: { ctrl: { endButton(f?: boolean): void } } }).__infweb.ctrl.endButton(true));
  await page.evaluate(() => (window as unknown as { __infweb: { ctrl: { endButton(f?: boolean): void } } }).__infweb.ctrl.endButton(true));
  await page.waitForFunction(
    () => {
      const s = (window as unknown as { __infweb: { ctrl: { state: { turn: number; current: number } } } }).__infweb.ctrl.state;
      return s.turn >= 1 && s.current === 0;
    },
    null,
    { timeout: 30_000 },
  );
  expect(fromWorker.some((p) => /\/assets\/master\.worker-.*\.js$/.test(p))).toBe(true);
  expect(failed).toEqual([]);
});
