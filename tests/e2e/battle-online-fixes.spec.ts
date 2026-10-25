import { expect, test, type Page } from '@playwright/test';

// Online battles over BroadcastChannel tabs (?transport=bc): names in the lobby, the host's seat, a
// host who is gone, a late joiner, a guest who vanishes on its turn (the host's controls), a concede
// made while offline, and the stats of people who leave after conceding.

async function setup(page: Page, url: string, o: { setupPrefs?: unknown; name?: string } = {}) {
  await page.route('**/abacus.jasoncameron.dev/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"value":0}' }),
  );
  await page.addInitScript(
    ([prefs, name]) => {
      if (!sessionStorage.getItem('init')) {
        localStorage.setItem('infweb.settings', JSON.stringify({ v: 2, lang: 'ru', speed: 'instant', confirmEnd: false, playerName: name ?? '' }));
        if (prefs) localStorage.setItem('infweb.setup', JSON.stringify(prefs));
        sessionStorage.setItem('init', '1');
      }
    },
    [o.setupPrefs ?? null, o.name ?? null] as const,
  );
  await page.goto(url);
}

const SETUP = { size: 'S', players: ['human', 'online', 'dummy'], darkness: false, symmetry: true, crowded: false, unions: false, shuffle: false };

async function openRoom(host: Page): Promise<string> {
  await host.bringToFront();
  await host.getByText('Новая битва').click();
  await host.getByRole('button', { name: /Создать комнату/ }).first().click();
  const codeEl = host.getByTestId('room-code');
  await expect(codeEl).toHaveText(/^[A-Z0-9]{5}$/, { timeout: 30_000 });
  return (await codeEl.textContent())!.trim();
}

async function join(guest: Page, base: string, code: string) {
  await guest.bringToFront();
  await guest.goto(`${base}#/join/${code}`);
  await expect(guest.getByTestId('roster')).toBeVisible({ timeout: 30_000 });
}

async function start(host: Page, pages: Page[]) {
  await host.bringToFront();
  await expect(host.getByRole('button', { name: 'Начать битву' })).toBeEnabled({ timeout: 30_000 });
  await host.getByRole('button', { name: 'Начать битву' }).click();
  for (const p of pages) await expect(p.locator('canvas')).toBeVisible({ timeout: 30_000 });
}

const info = (p: Page) =>
  p.evaluate(() => {
    const c = (window as any).__infweb?.ctrl;
    const s = c?.state;
    if (!s) return null;
    return { cur: s.current, turn: s.turn, players: s.settings.players as string[], local: !!c.isLocalTurn, alive: s.settings.players.map((_: unknown, i: number) => s.field.cells.some((x: any) => x.owner === i)) };
  });

async function endTurnIfMine(p: Page) {
  return p.evaluate(() => {
    const c = (window as any).__infweb?.ctrl;
    if (!c || !c.isLocalTurn || c.busy || c.state.ended) return false;
    c.endButton(true);
    c.endButton(true);
    return true;
  });
}

async function concede(p: Page) {
  await p.bringToFront();
  await p.getByRole('button', { name: 'Пауза' }).click();
  await p.getByRole('button', { name: /Сдаться/ }).click();
  await p.locator('.modal').getByRole('button', { name: 'Сдаться' }).click();
}

/** the battle records in the shared localStorage, as "opponents/win/place" */
const records = (p: Page) =>
  p.evaluate(() =>
    (JSON.parse(localStorage.getItem('infweb.stats') || '{"records":[]}').records as any[])
      .filter((r) => r.kind === 'battleOnline')
      .map((r) => `${r.opponents.join(',')}/${r.win}/${r.place ?? '-'}`),
  );

test('lobby: names, the host seat is not "waiting", a late joiner is told the battle started', async ({ context, baseURL }) => {
  test.setTimeout(120_000);
  const base = `${baseURL}?transport=bc`;
  const host = await context.newPage();
  const guest = await context.newPage();
  await setup(host, base, { setupPrefs: SETUP, name: 'Хозяин' });
  await setup(guest, base, { name: 'Гостья' });
  const code = await openRoom(host);
  await join(guest, base, code);

  const hostSeat = guest.getByTestId('roster').locator('.list-item').first();
  await expect(hostSeat).toContainText('Хозяин');
  await expect(hostSeat).toContainText('хост');
  await expect(hostSeat.locator('.spinner')).toHaveCount(0);
  await expect(hostSeat).toHaveCSS('opacity', '1');
  await host.bringToFront();
  await expect(host.getByTestId('roster')).toContainText('Гостья');

  await start(host, [host, guest]);
  // the HUD shows the names too
  await expect(host.locator('body')).toContainText('Гостья');
  await guest.bringToFront();
  await expect(guest.locator('body')).toContainText('Хозяин');

  const late = await context.newPage();
  await setup(late, `${base}#/join/${code}`);
  await expect(late.getByTestId('room-error')).toHaveText(/Битва уже началась/, { timeout: 30_000 });
  await late.close();
  // the rejected tab did not cut the real guest off
  await host.bringToFront();
  await expect(host.getByText(/Нет связи/)).toHaveCount(0);
});

test('lobby: a guest notices that the host is gone', async ({ context, baseURL }) => {
  test.setTimeout(90_000);
  const base = `${baseURL}?transport=bc`;
  const host = await context.newPage();
  const guest = await context.newPage();
  await setup(host, base, { setupPrefs: SETUP });
  await setup(guest, base);
  const code = await openRoom(host);
  await join(guest, base, code);
  await expect(guest.getByTestId('host-lost')).toHaveCount(0);
  // the host's page goes away (with or without a goodbye: a silent host is noticed too)
  await host.close();
  await guest.bringToFront();
  await expect(guest.getByTestId('host-lost')).toHaveText(/Нет связи с хостом/, { timeout: 20_000 });
});

test('a guest vanishes on its turn: the host can skip it or give the seat to a bot; back, the guest is told', async ({ context, baseURL }) => {
  test.setTimeout(150_000);
  const base = `${baseURL}?transport=bc`;
  const host = await context.newPage();
  const guest = await context.newPage();
  await setup(host, base, { setupPrefs: SETUP });
  await setup(guest, base, { name: 'Гостья' });
  const code = await openRoom(host);
  await join(guest, base, code);
  await start(host, [host, guest]);
  // the host ends its turns until it is the guest's
  await expect
    .poll(async () => {
      await endTurnIfMine(host);
      return (await info(host))?.cur;
    }, { timeout: 30_000 })
    .toBe(1);
  // the guest's page goes away (its tab keeps its session for later)
  await guest.goto('about:blank');
  await host.bringToFront();
  await expect(host.getByText(/Нет связи: Гостья/)).toBeVisible({ timeout: 10_000 });
  const controls = host.getByTestId('away-controls');
  await expect(controls).toBeVisible({ timeout: 25_000 });
  await expect(controls).toContainText('Нет связи: Гостья');
  await expect(controls).toContainText(/Ход пропустится сам через \d+ с/);
  const turn = (await info(host))!.turn;
  await controls.getByTestId('away-skip').click();
  await expect.poll(async () => (await info(host))?.cur, { timeout: 10_000 }).not.toBe(1);
  // on its next turn the controls are there again: the seat goes to a bot, the match goes on
  await expect
    .poll(async () => {
      await endTurnIfMine(host);
      return (await info(host))?.cur;
    }, { timeout: 30_000 })
    .toBe(1);
  await host.getByTestId('away-bot').click();
  await expect.poll(async () => (await info(host))?.players[1], { timeout: 10_000 }).toBe('hunter');
  await expect(host.getByTestId('away-controls')).toHaveCount(0);
  await expect
    .poll(async () => {
      await endTurnIfMine(host);
      return (await info(host))?.turn;
    }, { timeout: 30_000 })
    .toBeGreaterThan(turn + 1);
  // the guest comes back: told plainly that its seat was given to a bot
  await guest.goto(base);
  await guest.getByRole('button', { name: /Вернуться в онлайн-битву/ }).click();
  await expect(guest.getByText('Ваше место отдали боту')).toBeVisible({ timeout: 20_000 });
});

test('a concede made while the host is away is delivered; who conceded and left has exactly one loss', async ({ context, baseURL }) => {
  test.setTimeout(150_000);
  const base = `${baseURL}?transport=bc`;
  const host = await context.newPage();
  const g1 = await context.newPage();
  const g2 = await context.newPage();
  await setup(host, base, { setupPrefs: { ...SETUP, players: ['human', 'online', 'online', 'dummy'] } });
  await setup(g1, base);
  await setup(g2, base);
  const code = await openRoom(host);
  await join(g1, base, code);
  await join(g2, base, code);
  await start(host, [host, g1, g2]);
  expect(await records(host)).toEqual([]);

  // the host's page reloads (the room waits in its menu); g1 concedes meanwhile
  await host.bringToFront();
  await host.reload();
  await expect(host.getByRole('button', { name: /Вернуться в онлайн-битву/ })).toBeVisible();
  await concede(g1);
  await expect(g1.getByTestId('guest-offline')).toHaveText(/сдача уйдёт хосту/, { timeout: 10_000 });
  // the loss counts once it is delivered, not before
  expect(await records(g1)).toEqual([]);
  await host.bringToFront();
  await host.getByRole('button', { name: /Вернуться в онлайн-битву/ }).click();
  await expect(host.locator('canvas')).toBeVisible();
  const g1Seat = await g1.evaluate(() => (window as any).__infweb.ctrl.state.settings.players.indexOf('human'));
  await expect.poll(async () => (await info(host))?.alive[g1Seat], { timeout: 20_000 }).toBe(false);
  await g1.bringToFront();
  await expect(g1.getByTestId('watching')).toBeVisible({ timeout: 20_000 });
  // g1 leaves to the menu: its loss is on record already (the 4th place of 4)
  await g1.getByRole('button', { name: 'Пауза' }).click();
  await g1.locator('.modal').getByRole('button', { name: /В меню/ }).click();
  await expect.poll(() => records(host), { timeout: 10_000 }).toEqual(['remote,remote,dummy/false/4']);

  // the host concedes and leaves too: its loss is recorded at once, while the room plays on without it
  await concede(host);
  await expect.poll(() => records(host), { timeout: 10_000 }).toEqual(['remote,remote,dummy/false/4', 'online,online,dummy/false/3']);
  await host.getByRole('button', { name: 'Пауза' }).click();
  await host.locator('.modal').getByRole('button', { name: /В меню/ }).click();
  // g2 gives up as well, so the bot wins: g2's loss is recorded once (by the room, not again by its result screen)
  await concede(g2);
  await expect(g2.locator('.result-title')).toBeVisible({ timeout: 60_000 });
  await g2.waitForTimeout(500);
  expect(await records(host)).toEqual(['remote,remote,dummy/false/4', 'online,online,dummy/false/3', 'remote,remote,dummy/false/2']);
});
