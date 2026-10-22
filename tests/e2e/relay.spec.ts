import { chromium, expect, test, type Browser, type Page } from '@playwright/test';

// Online play between separate browser contexts over the real network, WITHOUT ?transport=bc:
// - "auto": WebRTC first, MQTT relay fallback (behind a VPN / strict NAT this must end up on the relay);
// - "relay": ?transport=relay forces the relay (checks it on networks where WebRTC would work too).
// Needs internet access (public MQTT brokers, PeerJS broker). Run with RELAY_E2E=1.

const ENABLED = !!process.env.RELAY_E2E;

async function setup(page: Page, url: string, setupPrefs?: unknown) {
  await page.route('**/abacus.jasoncameron.dev/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"value":0}' }),
  );
  await page.addInitScript((prefs) => {
    if (!sessionStorage.getItem('init')) {
      localStorage.setItem('infweb.settings', JSON.stringify({ v: 2, lang: 'ru', speed: 'instant', confirmEnd: false }));
      if (prefs) localStorage.setItem('infweb.setup', JSON.stringify(prefs));
      sessionStorage.setItem('init', '1');
    }
  }, setupPrefs ?? null);
  page.on('console', (m) => {
    if (process.env.DBG && /relay|error|fallback/i.test(m.text())) console.log('page>', m.text().slice(0, 200));
  });
  await page.goto(url);
}

const board = (p: Page) =>
  p.evaluate(() => {
    const s = (window as any).__infweb?.ctrl?.state;
    if (!s) return 'none';
    return JSON.stringify({ c: s.current, t: s.turn, ph: s.phase, e: !!s.ended, cells: s.field.cells.map((c: any) => [c.owner, c.power]) });
  });

/** If it is this page's turn: one greedy attack or end the turn. Returns whether it moved. */
async function moveIfMine(p: Page): Promise<boolean> {
  return p.evaluate(() => {
    const c = (window as any).__infweb?.ctrl;
    if (!c || !c.isLocalTurn || c.busy || c.state.ended) return false;
    const s = c.state;
    if (s.phase === 'attack') {
      const cells = s.field.cells;
      for (let a = 0; a < cells.length; a++) {
        if (cells[a].owner !== s.current || cells[a].power < 2) continue;
        const greys = s.settings.duelRules && s.field.adj[a].some((d: number) => cells[d].owner === -1);
        for (const d of s.field.adj[a]) {
          if (cells[d].owner === s.current || (greys && cells[d].owner !== -1)) continue;
          if (cells[d].power === 0 || cells[a].power - cells[d].power >= 2) {
            c.tap(a);
            c.tap(d);
            return true;
          }
        }
      }
    }
    c.endButton(true);
    c.endButton(true);
    return true;
  });
}

async function synced(pages: Page[], timeout = 45_000) {
  await expect
    .poll(
      async () => {
        const xs = await Promise.all(pages.map(board));
        return xs[0] !== 'none' && xs.every((x) => x === xs[0]);
      },
      { timeout },
    )
    .toBe(true);
}

async function playRounds(pages: Page[], rounds: number) {
  for (let step = 0; step < 400; step++) {
    const st = JSON.parse(await board(pages[0]));
    if (st.e || st.t >= rounds) break;
    let moved = false;
    for (const p of pages) moved = (await moveIfMine(p)) || moved;
    if (!moved) await pages[0].waitForTimeout(150);
  }
  await synced(pages);
}

async function duel(browser: Browser, base: string, expectRelay: boolean) {
  const host = await (await browser.newContext()).newPage();
  const guest = await (await browser.newContext()).newPage();
  await setup(host, base);
  await setup(guest, base);
  await host.getByRole('button', { name: /Дуэли/ }).click();
  await host.getByText('Онлайн с другом').click();
  await host.getByRole('radio', { name: 'Средняя' }).click();
  await host.getByRole('button', { name: 'Создать комнату' }).click();
  const codeEl = host.getByTestId('room-code');
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}$/, { timeout: 45_000 });
  const code = (await codeEl.textContent())!.trim();

  await guest.goto(`${base}#/duel/${code}`);
  await expect(guest.locator('canvas')).toBeVisible({ timeout: 90_000 });
  await expect(host.locator('canvas')).toBeVisible({ timeout: 30_000 });
  await synced([host, guest]);
  await playRounds([host, guest], 3);

  // guest reloads mid-match: the duels list shows the link kind, then the match resumes
  await guest.reload();
  await guest.getByRole('button', { name: /Дуэли/ }).click();
  await guest.getByText('Онлайн с другом').click();
  const label = guest.getByTestId('duel-row').first().getByTestId('link-kind');
  await expect(label).toBeVisible({ timeout: 60_000 });
  const link = (await label.getAttribute('data-link'))!;
  console.log(`duel ${code}: link after guest reload = ${link}`);
  if (expectRelay) expect(link).toBe('relay');
  await guest.getByTestId('duel-row').first().click();
  await expect(guest.locator('canvas')).toBeVisible({ timeout: 30_000 });
  await synced([host, guest]);
  await playRounds([host, guest], 5);

  // concede from the guest -> host wins on both screens
  await guest.getByRole('button', { name: 'Пауза' }).click();
  await guest.getByRole('button', { name: /Сдаться/ }).click();
  await guest.locator('.modal').getByRole('button', { name: 'Сдаться' }).click();
  await expect(host.locator('.result-title')).toHaveText(/Победа/, { timeout: 30_000 });
  await expect(guest.locator('.result-title')).toHaveText(/Поражение/, { timeout: 30_000 });
}

const HOST_SETUP = { size: 'S', players: ['human', 'online', 'hunter', 'online'], darkness: false, symmetry: true, crowded: false, unions: false, shuffle: false };

async function battle(browser: Browser, base: string, expectRelay: boolean) {
  const [host, g1, g2] = await Promise.all([0, 1, 2].map(async () => (await browser.newContext()).newPage()));
  await setup(host, base, HOST_SETUP);
  await setup(g1, base);
  await setup(g2, base);
  await host.getByText('Новая битва').click();
  await host.getByRole('button', { name: /Создать комнату/ }).first().click();
  const codeEl = host.getByTestId('room-code');
  await expect(codeEl).toHaveText(/^[A-Z0-9]{5}$/, { timeout: 45_000 });
  const code = (await codeEl.textContent())!.trim();

  await g1.goto(`${base}#/join/${code}`);
  await expect(g1.getByTestId('roster')).toBeVisible({ timeout: 90_000 });
  await g2.getByRole('button', { name: /Подключиться к игре/ }).click();
  await g2.getByRole('textbox').fill(code);
  await g2.getByRole('button', { name: 'Подключиться' }).click();
  await expect(g2.getByTestId('roster')).toBeVisible({ timeout: 90_000 });
  await expect(host.getByRole('button', { name: 'Начать битву' })).toBeEnabled({ timeout: 60_000 });
  await host.getByRole('button', { name: 'Начать битву' }).click();
  for (const p of [host, g1, g2]) await expect(p.locator('canvas')).toBeVisible({ timeout: 45_000 });
  await synced([host, g1, g2]);

  for (const g of [g1, g2]) {
    const label = g.getByTestId('link-kind');
    await expect(label).toBeVisible({ timeout: 30_000 });
    const link = (await label.getAttribute('data-link'))!;
    console.log(`battle ${code}: guest link = ${link}`);
    if (expectRelay) expect(link).toBe('relay');
  }
  await playRounds([host, g1, g2], 3);

  // a guest reloads mid-match and comes back through the menu
  await g1.reload();
  await g1.getByRole('button', { name: /Вернуться в онлайн-битву/ }).click();
  await expect(g1.locator('canvas')).toBeVisible({ timeout: 60_000 });
  await synced([host, g1, g2]);
  await playRounds([host, g1, g2], 5);
}

for (const mode of ['auto', 'relay'] as const) {
  test.describe(`real network, ${mode} link`, () => {
    test.skip(() => !ENABLED, 'set RELAY_E2E=1 (needs internet access)');

    test(`duel between two browsers (${mode})`, async ({ baseURL }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop', 'desktop only');
      test.setTimeout(300_000);
      const browser = await chromium.launch();
      try {
        await duel(browser, mode === 'relay' ? `${baseURL}?transport=relay` : baseURL!, mode === 'relay' || !!process.env.EXPECT_RELAY);
      } finally {
        await browser.close();
      }
    });

    test(`battle: host + 2 guests + bot (${mode})`, async ({ baseURL }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop', 'desktop only');
      test.setTimeout(300_000);
      const browser = await chromium.launch();
      try {
        await battle(browser, mode === 'relay' ? `${baseURL}?transport=relay` : baseURL!, mode === 'relay' || !!process.env.EXPECT_RELAY);
      } finally {
        await browser.close();
      }
    });
  });
}
