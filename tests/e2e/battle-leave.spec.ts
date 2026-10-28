import { expect, test, type Page } from '@playwright/test';

// Leaving an online battle (BroadcastChannel tabs, ?transport=bc): whoever has conceded is a spectator
// who may stay or go; going to the menu and starting something else must start that, not bounce back
// into the room. The room lives on the host's page: bots keep moving while the host is elsewhere.

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

type Board = { kind: string; c: number; t: number; e: boolean; me: number; out: boolean[] } | null;

const board = (p: Page): Promise<Board> =>
  p.evaluate(() => {
    const s = (window as any).__infweb?.ctrl?.state;
    if (!s) return null;
    return {
      kind: s.settings.kind,
      c: s.current,
      t: s.turn,
      e: !!s.ended,
      me: s.settings.players.indexOf('human'),
      out: s.settings.players.map((_: unknown, i: number) => !s.field.cells.some((c: any) => c.owner === i)),
    };
  });

/** If it is this page's turn: a few greedy attacks, then end the turn. */
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

const HOST_SETUP = { size: 'S', players: ['human', 'online', 'dummy'], darkness: false, symmetry: true, crowded: false, unions: false, shuffle: false, rev: 2 };

/** Host opens a room, the guest joins by link, the host starts. Returns the room code. */
async function openBattle(host: Page, guest: Page, base: string): Promise<string> {
  await host.bringToFront();
  await host.getByText('Новая битва').click();
  await host.getByRole('button', { name: /Создать комнату/ }).first().click();
  const codeEl = host.getByTestId('room-code');
  await expect(codeEl).toHaveText(/^[A-Z0-9]{5}$/, { timeout: 30_000 });
  const code = (await codeEl.textContent())!.trim();
  await guest.bringToFront();
  await guest.goto(`${base}#/join/${code}`);
  await expect(guest.getByTestId('roster')).toBeVisible({ timeout: 30_000 });
  await host.bringToFront();
  await expect(host.getByRole('button', { name: 'Начать битву' })).toBeEnabled({ timeout: 30_000 });
  await host.getByRole('button', { name: 'Начать битву' }).click();
  for (const p of [host, guest]) await expect(p.locator('canvas')).toBeVisible({ timeout: 30_000 });
  return code;
}

async function concede(p: Page) {
  await p.bringToFront();
  await p.getByRole('button', { name: 'Пауза' }).click();
  await p.getByRole('button', { name: /Сдаться/ }).click();
  await p.locator('.modal').getByRole('button', { name: 'Сдаться' }).click();
}

async function toMenu(p: Page) {
  await p.bringToFront();
  // a finished match shows its result window with the same button
  if (!(await p.locator('.result-title').isVisible())) await p.getByRole('button', { name: 'Пауза' }).click();
  await p.locator('.modal').getByRole('button', { name: /В меню/ }).click();
  await expect(p.getByRole('button', { name: /Быстрый старт/ })).toBeVisible();
}

test('the reported bug: host concedes, goes to the menu, quick start opens a new room (not the old match)', async ({ context, baseURL }) => {
  test.setTimeout(120_000);
  const base = `${baseURL}?transport=bc`;
  const host = await context.newPage();
  const guest = await context.newPage();
  await setup(host, base, HOST_SETUP);
  await setup(guest, base);
  const code = await openBattle(host, guest, base);
  await concede(host);
  await expect.poll(async () => (await board(guest))?.out[0], { timeout: 20_000 }).toBe(true);
  await toMenu(host);
  await host.getByRole('button', { name: /Быстрый старт/ }).click();
  await expect(host.getByTestId('room-code')).toHaveText(/^[A-Z0-9]{5}$/, { timeout: 30_000 });
  expect((await host.getByTestId('room-code').textContent())!.trim()).not.toBe(code);
  await host.waitForTimeout(500);
  expect(await board(host)).toBeNull();
  await expect(host.getByRole('button', { name: 'Начать битву' })).toBeDisabled();
});

test('host who conceded leaves: the room plays on in the background, other games start, quick start opens a new room', async ({ context, baseURL }) => {
  test.setTimeout(180_000);
  const base = `${baseURL}?transport=bc`;
  const host = await context.newPage();
  const guest = await context.newPage();
  await setup(host, base, HOST_SETUP);
  await setup(guest, base);
  const code = await openBattle(host, guest, base);

  await concede(host);
  await expect.poll(async () => (await board(guest))?.out[0], { timeout: 20_000 }).toBe(true);
  expect((await board(guest))!.e).toBe(false);
  await toMenu(host);
  // the room is alive: the menu offers the way back
  await expect(host.getByRole('button', { name: /Вернуться в онлайн-битву/ })).toBeVisible();

  // the map of the day starts the map of the day
  await host.getByRole('button', { name: /Карта дня/ }).click();
  await host.getByRole('button', { name: /^(Играть|Ещё раз)/ }).click();
  await expect.poll(async () => (await board(host))?.kind, { timeout: 20_000 }).toBe('daily');
  await toMenu(host);

  // meanwhile the bot (run by the host's page) and the guest keep playing
  const t0 = (await board(guest))!.t;
  await expect
    .poll(
      async () => {
        await moveIfMine(guest);
        const b = await board(guest);
        return !!b && (b.e || b.t >= t0 + 2);
      },
      { timeout: 30_000, intervals: [100] },
    )
    .toBe(true);

  // back to the room through the menu card, then away again
  await host.bringToFront();
  await host.getByRole('button', { name: /Вернуться в онлайн-битву/ }).click();
  await expect.poll(async () => (await board(host))?.kind, { timeout: 20_000 }).toBe('battleOnline');
  const over = (await board(host))!.e;
  await toMenu(host);

  // quick start with an online setup opens a new room instead of the old match
  await host.getByRole('button', { name: /Быстрый старт/ }).click();
  // (an online room leaves the unfinished local match alone: nothing to confirm)
  await expect(host.locator('.modal')).toHaveCount(0);
  const codeEl = host.getByTestId('room-code');
  await expect(codeEl).toHaveText(/^[A-Z0-9]{5}$/, { timeout: 30_000 });
  expect((await codeEl.textContent())!.trim()).not.toBe(code);
  await host.waitForTimeout(500);
  await expect(host.locator('canvas')).toHaveCount(0);
  await expect(host.getByTestId('room-code')).toBeVisible();
  // the old room is gone for its guest
  if (!over) {
    await guest.bringToFront();
    await expect(guest.getByTestId('room-gone')).toHaveText('Хост закрыл комнату', { timeout: 20_000 });
  }
});

test('guest who conceded leaves: quick start plays a local game; after a reload the room is not offered again', async ({ context, baseURL }) => {
  test.setTimeout(180_000);
  const base = `${baseURL}?transport=bc`;
  const host = await context.newPage();
  const guest = await context.newPage();
  await setup(host, base, HOST_SETUP);
  await setup(guest, base);
  await openBattle(host, guest, base);

  await concede(guest);
  await expect.poll(async () => (await board(host))?.out[1], { timeout: 20_000 }).toBe(true);
  // the guest's own quick start is a game against bots (tabs of one browser share the setup)
  await guest.evaluate(() =>
    localStorage.setItem('infweb.setup', JSON.stringify({ size: 'S', players: ['human', 'hunter'], darkness: false, symmetry: true, crowded: false, unions: false, shuffle: false, rev: 2 })),
  );
  await toMenu(guest);
  await expect(guest.getByRole('button', { name: /Вернуться в онлайн-битву/ })).toBeVisible();
  await guest.getByRole('button', { name: /Быстрый старт/ }).click();
  await expect.poll(async () => (await board(guest))?.kind, { timeout: 20_000 }).toBe('single');
  await guest.waitForTimeout(500);
  expect((await board(guest))!.kind).toBe('single');

  // a reload: the session of someone who gave up does not bring them back into the room
  await guest.reload();
  await expect(guest.getByRole('button', { name: /Быстрый старт/ })).toBeVisible();
  await expect(guest.getByRole('button', { name: /Вернуться в онлайн-битву/ })).toHaveCount(0);
  // the host's match is unaffected
  expect((await board(host))!.e).toBe(false);
});
