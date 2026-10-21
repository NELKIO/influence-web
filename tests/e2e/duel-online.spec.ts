import { chromium, expect, test, type Page } from '@playwright/test';

// Online duel end-to-end: lobby, invite link, turns, sync, concede and rematch.
// - BroadcastChannel variant (two tabs, ?transport=bc) runs everywhere and covers protocol + UI.
// - Real variant goes through the public PeerJS broker and a WebRTC data channel; it needs a network
//   where browsers can open UDP between each other (run with REAL_P2P=1).

async function setup(page: Page, url: string) {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('init')) {
      localStorage.setItem('infweb.settings', JSON.stringify({ lang: 'ru', speed: 'instant', confirmEnd: false }));
      sessionStorage.setItem('init', '1');
    }
  });
  await page.goto(url);
}

async function playDuel(host: Page, guest: Page, base: string) {
  await host.getByRole('button', { name: /Дуэли/ }).click();
  await host.getByText('Онлайн с другом').click();
  await host.getByRole('radio', { name: 'Средняя' }).click();
  await host.getByRole('button', { name: 'Создать комнату' }).click();
  const codeEl = host.getByTestId('room-code');
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}$/, { timeout: 30_000 });
  const code = (await codeEl.textContent())!.trim();

  // guest joins through the invite link
  await guest.goto(`${base}#/duel/${code}`);
  await expect(guest.locator('canvas')).toBeVisible({ timeout: 60_000 });
  await expect(host.locator('canvas')).toBeVisible({ timeout: 60_000 });

  const snap = (p: Page) =>
    p.evaluate(() => {
      const s = (window as any).__infweb?.ctrl?.state;
      if (!s) return 'none';
      return JSON.stringify({ c: s.current, t: s.turn, ph: s.phase, cells: s.field.cells.map((c: any) => [c.owner, c.power]) });
    });

  // play several turns: whoever's turn it is attacks greedily and ends the turn
  for (let k = 0; k < 6; k++) {
    for (const p of [host, guest]) {
      const mine = await p.evaluate(() => !!(window as any).__infweb?.ctrl?.isLocalTurn);
      if (!mine) continue;
      await p.evaluate(() => {
        const c = (window as any).__infweb.ctrl;
        const s = c.state;
        for (let i = 0; i < 20; i++) {
          const cells = s.field.cells;
          let done = true;
          for (let a = 0; a < cells.length && done; a++) {
            if (cells[a].owner !== s.current || cells[a].power < 2) continue;
            const greys = s.field.adj[a].some((d: number) => cells[d].owner === -1);
            for (const d of s.field.adj[a]) {
              if (cells[d].owner === s.current || (greys && cells[d].owner !== -1)) continue;
              if (cells[d].power === 0 || cells[a].power - cells[d].power >= 2) {
                c.tap(a);
                c.tap(d);
                done = false;
                break;
              }
            }
          }
          if (done) break;
        }
        c.endButton(true);
        c.endButton(true);
      });
      // wait until the other side sees the same state
      await expect.poll(async () => (await snap(host)) === (await snap(guest)), { timeout: 20_000 }).toBe(true);
    }
  }
  const turn = await host.evaluate(() => (window as any).__infweb?.ctrl?.state?.turn ?? -1);
  expect(turn).toBeGreaterThanOrEqual(3);

  // guest reloads mid-match and resumes from the duels screen
  await guest.reload();
  await guest.getByRole('button', { name: /Дуэли/ }).click();
  await guest.getByText('Онлайн с другом').click();
  await guest.getByTestId('duel-row').first().click();
  await expect(guest.locator('canvas')).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await snap(host)) === (await snap(guest)), { timeout: 30_000 }).toBe(true);

  // concede from the guest -> host wins
  await guest.getByRole('button', { name: 'Пауза' }).click();
  await guest.getByRole('button', { name: /Сдаться/ }).click();
  await guest.locator('.modal').getByRole('button', { name: 'Сдаться' }).click();
  await expect(host.locator('.result-title')).toHaveText(/Победа/, { timeout: 20_000 });
  await expect(guest.locator('.result-title')).toHaveText(/Поражение/, { timeout: 20_000 });

  // rematch
  await host.getByRole('button', { name: 'Реванш' }).click();
  await guest.getByRole('button', { name: 'Реванш' }).click();
  await expect.poll(async () => host.evaluate(() => (window as any).__infweb?.ctrl?.state?.ended === null), { timeout: 20_000 }).toBe(true);
  await expect.poll(async () => guest.evaluate(() => (window as any).__infweb?.ctrl?.state?.ended === null), { timeout: 20_000 }).toBe(true);
  await expect.poll(async () => (await snap(host)) === (await snap(guest)), { timeout: 20_000 }).toBe(true);
}

test('online duel over BroadcastChannel (two tabs)', async ({ context, baseURL }) => {
  test.setTimeout(180_000);
  const base = `${baseURL}?transport=bc`;
  const host = await context.newPage();
  const guest = await context.newPage();
  await setup(host, base);
  await setup(guest, base);
  await playDuel(host, guest, base);
});

test('online duel over real WebRTC (PeerJS broker)', async ({ baseURL }, testInfo) => {
  test.skip(!process.env.REAL_P2P || testInfo.project.name !== 'desktop', 'set REAL_P2P=1 on a network that allows WebRTC');
  test.setTimeout(180_000);
  const browser = await chromium.launch();
  const host = await (await browser.newContext()).newPage();
  const guest = await (await browser.newContext()).newPage();
  await setup(host, baseURL!);
  await setup(guest, baseURL!);
  await playDuel(host, guest, baseURL!);
  await browser.close();
});

test('two online duels at the same time (BroadcastChannel)', async ({ context, baseURL }) => {
  test.setTimeout(180_000);
  const base = `${baseURL}?transport=bc`;
  const host = await context.newPage();
  const g1 = await context.newPage();
  const g2 = await context.newPage();
  for (const p of [host, g1, g2]) await setup(p, base);

  const createRoom = async () => {
    await host.goto(base);
    await host.getByRole('button', { name: /Дуэли/ }).click();
    await host.getByText('Онлайн с другом').click();
    await host.getByRole('button', { name: 'Создать комнату' }).click();
    const el = host.getByTestId('room-code');
    await expect(el).toHaveText(/^[A-Z0-9]{4}$/, { timeout: 30_000 });
    const code = (await el.textContent())!.trim();
    await host.getByRole('button', { name: 'К списку матчей' }).click();
    return code;
  };
  const c1 = await createRoom();
  // second room created from the same lobby
  await host.getByRole('button', { name: 'Создать комнату' }).click();
  const el2 = host.getByTestId('room-code');
  await expect(el2).toHaveText(/^[A-Z0-9]{4}$/, { timeout: 30_000 });
  const c2 = (await el2.textContent())!.trim();
  expect(c2).not.toBe(c1);
  await host.getByRole('button', { name: 'К списку матчей' }).click();
  await expect(host.getByTestId('duel-row')).toHaveCount(2);

  await g1.goto(`${base}#/duel/${c1}`);
  await expect(g1.locator('canvas')).toBeVisible({ timeout: 30_000 });
  await g2.goto(`${base}#/duel/${c2}`);
  await expect(g2.locator('canvas')).toBeVisible({ timeout: 30_000 });

  // both matches are listed as running on the host; open each and check it is in sync with its guest
  await host.goto(base);
  await host.getByRole('button', { name: /Дуэли/ }).click();
  await host.getByText('Онлайн с другом').click();
  await expect(host.getByTestId('duel-row')).toHaveCount(2);
  for (const [code, guest] of [
    [c1, g1],
    [c2, g2],
  ] as const) {
    await host.getByTestId('duel-row').filter({ hasText: code }).click();
    await expect(host.locator('canvas')).toBeVisible({ timeout: 30_000 });
    const sig = (p: Page) => p.evaluate(() => JSON.stringify((window as any).__infweb?.ctrl?.state?.field.cells.map((c: any) => c.maxPower)));
    await expect.poll(async () => (await sig(host)) === (await sig(guest)), { timeout: 20_000 }).toBe(true);
    await host.getByRole('button', { name: 'Пауза' }).click();
    await host.getByRole('button', { name: /В меню/ }).click();
    await expect(host.getByTestId('duel-row')).toHaveCount(2);
  }
});
