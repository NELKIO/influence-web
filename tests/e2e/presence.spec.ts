import { expect, test, type Page } from '@playwright/test';

// "The opponent minimised the game" notices (BroadcastChannel transport, two tabs) and the
// «Проверка связи» panel in Settings.

async function setup(page: Page, url: string) {
  await page.route('**/abacus.jasoncameron.dev/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"value":0}' }),
  );
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('init')) {
      localStorage.setItem('infweb.settings', JSON.stringify({ lang: 'ru', speed: 'instant', confirmEnd: false }));
      sessionStorage.setItem('init', '1');
    }
  });
  await page.goto(url);
}

/** make the page look hidden / visible to the app (headless pages are always visible) */
async function setHidden(p: Page, hidden: boolean) {
  await p.evaluate((h) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

test('a duel opponent who minimises the game is shown as such; own moves still apply at once', async ({ context, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'desktop only');
  test.setTimeout(120_000);
  const base = `${baseURL}?transport=bc`;
  const host = await context.newPage();
  const guest = await context.newPage();
  await setup(host, base);
  await setup(guest, base);
  await host.getByRole('button', { name: /Дуэли/ }).click();
  await host.getByText('Онлайн с другом').click();
  await host.getByRole('button', { name: 'Создать комнату' }).click();
  const codeEl = host.getByTestId('room-code');
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}$/, { timeout: 30_000 });
  const code = (await codeEl.textContent())!.trim();
  await guest.goto(`${base}#/duel/${code}`);
  await expect(guest.locator('canvas')).toBeVisible({ timeout: 60_000 });
  await expect(host.locator('canvas')).toBeVisible({ timeout: 60_000 });

  // the player whose turn it is hides the page: the other one sees the notice
  const hostTurn = await host.evaluate(() => !!(window as any).__infweb?.ctrl?.isLocalTurn);
  const [mover, watcher] = hostTurn ? [host, guest] : [guest, host];
  await setHidden(mover, true);
  await expect(watcher.getByTestId('opponent-hidden')).toHaveText(/Соперник свернул игру — ход продолжится, когда он вернётся/, { timeout: 10_000 });
  await setHidden(mover, false);
  await expect(watcher.getByTestId('opponent-hidden')).toHaveCount(0, { timeout: 10_000 });

  // the watcher hides; the mover's own moves still show at once on its board
  await setHidden(watcher, true);
  await expect(mover.getByTestId('opponent-hidden')).toBeVisible({ timeout: 10_000 });
  const before = await mover.evaluate(() => JSON.stringify((window as any).__infweb.ctrl.state.field.cells.map((c: any) => [c.owner, c.power])));
  await mover.evaluate(() => {
    const c = (window as any).__infweb.ctrl;
    const s = c.state;
    const cells = s.field.cells;
    for (let a = 0; a < cells.length; a++) {
      if (cells[a].owner !== s.current || cells[a].power < 2) continue;
      const greys = s.field.adj[a].some((d: number) => cells[d].owner === -1);
      for (const d of s.field.adj[a]) {
        if (cells[d].owner === s.current || (greys && cells[d].owner !== -1)) continue;
        c.tap(a);
        c.tap(d);
        return;
      }
    }
  });
  await expect
    .poll(() => mover.evaluate(() => JSON.stringify((window as any).__infweb.ctrl.state.field.cells.map((c: any) => [c.owner, c.power]))), { timeout: 5_000 })
    .not.toBe(before);
  await setHidden(watcher, false);
  await expect(mover.getByTestId('opponent-hidden')).toHaveCount(0, { timeout: 10_000 });
});

test('Settings has «Проверка связи»', async ({ page }) => {
  await setup(page, './');
  await page.getByRole('button', { name: /Настройки/ }).click();
  await expect(page.getByText('Проверка связи')).toBeVisible();
  await expect(page.getByTestId('cc-run')).toHaveText('Проверить');
});
