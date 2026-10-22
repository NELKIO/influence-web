import { expect, test, type Page } from '@playwright/test';

// Online battle (host + 2 guests + a bot) over BroadcastChannel: tabs of one browser, ?transport=bc.
// The real-network variant of the same flow runs on CI with REAL_P2P=1.

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
  await page.goto(url);
}

const board = (p: Page) =>
  p.evaluate(() => {
    const s = (window as any).__infweb?.ctrl?.state;
    if (!s) return 'none';
    return JSON.stringify({ c: s.current, t: s.turn, ph: s.phase, e: !!s.ended, cells: s.field.cells.map((c: any) => [c.owner, c.power]) });
  });

/** If it is this page's turn: a few greedy attacks, then end the turn. Returns whether it moved. */
async function moveIfMine(p: Page): Promise<boolean> {
  return p.evaluate(() => {
    const c = (window as any).__infweb?.ctrl;
    if (!c || !c.isLocalTurn || c.busy || c.state.ended) return false;
    const s = c.state;
    if (s.phase === 'attack') {
      const cells = s.field.cells;
      for (let a = 0; a < cells.length; a++) {
        if (cells[a].owner !== s.current || cells[a].power < 2) continue;
        for (const d of s.field.adj[a]) {
          if (cells[d].owner === s.current) continue;
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

test('online battle: host + 2 guests + bot stay in sync, guest reload, concede', async ({ context, baseURL }) => {
  test.setTimeout(300_000);
  const base = `${baseURL}?transport=bc`;
  const host = await context.newPage();
  const g1 = await context.newPage();
  const g2 = await context.newPage();
  await setup(host, base, { size: 'S', players: ['human', 'online', 'hunter', 'online'], darkness: false, symmetry: true, crowded: false, unions: false, shuffle: false });
  await setup(g1, base);
  await setup(g2, base);

  // background tabs get no animation frames, so bring a tab to the front before clicking in it
  // host creates the room from the battle setup
  await host.bringToFront();
  await host.getByText('Новая битва').click();
  await host.getByRole('button', { name: /Создать комнату/ }).first().click();
  const codeEl = host.getByTestId('room-code');
  await expect(codeEl).toHaveText(/^[A-Z0-9]{5}$/, { timeout: 30_000 });
  const code = (await codeEl.textContent())!.trim();
  await expect(host.getByRole('button', { name: 'Начать битву' })).toBeDisabled();

  // guest 1 by invite link, guest 2 through the menu's join button
  await g1.bringToFront();
  await g1.goto(`${base}#/join/${code}`);
  await expect(g1.getByTestId('roster')).toBeVisible({ timeout: 30_000 });
  await g2.bringToFront();
  await g2.getByRole('button', { name: /Подключиться к игре/ }).click();
  await g2.getByRole('textbox').fill(code);
  await g2.getByRole('button', { name: 'Подключиться' }).click();
  await expect(g2.getByTestId('roster')).toBeVisible({ timeout: 30_000 });

  await host.bringToFront();
  await expect(host.getByRole('button', { name: 'Начать битву' })).toBeEnabled({ timeout: 30_000 });
  await host.getByRole('button', { name: 'Начать битву' }).click();
  for (const p of [host, g1, g2]) await expect(p.locator('canvas')).toBeVisible({ timeout: 30_000 });

  const synced = async () => {
    await expect
      .poll(async () => {
        const [a, b, c] = await Promise.all([board(host), board(g1), board(g2)]);
        return a !== 'none' && a === b && b === c;
      }, { timeout: 30_000 })
      .toBe(true);
  };
  await synced();

  // play rounds: everyone moves on their own turn, the host's bot moves by itself
  let reloaded = false;
  for (let step = 0; step < 120; step++) {
    const st = JSON.parse(await board(host));
    if (process.env.DBG) console.log(Date.now() % 100000, 'step', step, 'turn', st.t, 'cur', st.c, st.ph);
    if (st.e || st.t >= 4) break;
    let moved = false;
    for (const p of [host, g1, g2]) moved = (await moveIfMine(p)) || moved;
    if (!moved) await host.waitForTimeout(80);
    if (st.t === 2 && !reloaded) {
      // a guest reloads mid-match and comes back through the menu
      await synced();
      await g1.bringToFront();
      await g1.reload();
      await g1.getByRole('button', { name: /Вернуться в онлайн-битву/ }).click();
      await expect(g1.locator('canvas')).toBeVisible({ timeout: 30_000 });
      reloaded = true;
    }
  }
  if (process.env.DBG) console.log(Date.now() % 100000, 'loop done');
  await synced();
  if (process.env.DBG) console.log(Date.now() % 100000, 'synced');
  const final = JSON.parse(await board(host));
  expect(final.t >= 4 || final.e).toBe(true);

  // a guest concedes: its cells leave the board on every device
  const seatOf = await g2.evaluate(() => (window as any).__infweb.ctrl.state.settings.players.indexOf('human'));
  await g2.bringToFront();
  await g2.getByRole('button', { name: 'Пауза' }).click();
  await g2.getByRole('button', { name: /Сдаться/ }).click();
  await g2.locator('.modal').getByRole('button', { name: 'Сдаться' }).click();
  await expect
    .poll(async () => host.evaluate((seat) => !(window as any).__infweb.ctrl.state.field.cells.some((c: any) => c.owner === seat), seatOf), { timeout: 20_000 })
    .toBe(true);
  await synced();
});
