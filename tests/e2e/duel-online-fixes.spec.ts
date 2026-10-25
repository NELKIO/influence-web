import { expect, test, type Page } from '@playwright/test';

// Online duels over BroadcastChannel tabs (?transport=bc): names, no "your turn" notice over the
// match that is open, remembered panel options, dead codes, and removing a running match while the
// opponent is offline (a loss at once, the win reaches the opponent when it is back).

async function setup(page: Page, url: string) {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text());
  });
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
  return errors;
}

async function toPanel(p: Page, base: string) {
  await p.bringToFront();
  await p.goto(base);
  await p.getByRole('button', { name: /Дуэли/ }).click();
  await p.getByText('Онлайн с другом').click();
}

const duelRecords = (p: Page) =>
  p.evaluate(() =>
    (JSON.parse(localStorage.getItem('infweb.stats') || '{"records":[]}').records as any[]).filter((r) => r.kind === 'duelOnline').map((r) => r.win),
  );

test('online duel: names, no notice over the open match, the panel remembers its options, dead codes go away', async ({ context, baseURL }) => {
  test.setTimeout(120_000);
  const base = `${baseURL}?transport=bc`;
  const host = await context.newPage();
  const guest = await context.newPage();
  const hostErrors = await setup(host, base);
  const guestErrors = await setup(guest, base);
  // tabs of one browser share localStorage: each side sets its name just before it opens its session
  const setName = (p: Page, n: string) =>
    p.evaluate((name) => localStorage.setItem('infweb.settings', JSON.stringify({ ...JSON.parse(localStorage.getItem('infweb.settings') || '{}'), playerName: name })), n);
  await setName(host, 'Аня');
  await toPanel(host, base);
  await host.getByRole('radio', { name: 'Огромная' }).click();
  await host.getByRole('button', { name: 'Создать комнату' }).click();
  const codeEl = host.getByTestId('room-code');
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}$/, { timeout: 30_000 });
  const code = (await codeEl.textContent())!.trim();
  await guest.bringToFront();
  await setName(guest, 'Борис');
  await guest.goto(`${base}#/duel/${code}`);
  await expect(guest.locator('canvas')).toBeVisible({ timeout: 30_000 });
  await expect(host.locator('canvas')).toBeVisible({ timeout: 30_000 });
  // each side sees the other's name; whoever moves first gets no notice over its own open match
  await expect(host.locator('body')).toContainText('Борис');
  await expect(guest.locator('body')).toContainText('Аня');
  await host.waitForTimeout(800);
  await expect(host.locator('.notice')).toHaveCount(0);
  await expect(guest.locator('.notice')).toHaveCount(0);
  // vibration is not attempted before the first tap (no console error about it)
  expect([...hostErrors, ...guestErrors].filter((e) => /vibrate/i.test(e))).toEqual([]);

  // the panel remembers the size; the list shows the opponent's name
  await toPanel(host, base);
  await expect(host.getByRole('radio', { name: 'Огромная' })).toHaveAttribute('aria-checked', 'true');
  await expect(host.getByTestId('duel-row')).toHaveCount(1);
  await expect(host.getByTestId('duel-row')).toContainText('Борис');
  // a code nobody hosts: back from the waiting view drops it; waiting it out says the room is not found
  await host.getByRole('textbox').fill('ZZZZ');
  await host.getByRole('button', { name: 'Подключиться' }).click();
  await host.locator('.topbar button').first().click();
  await expect(host.getByTestId('duel-row')).toHaveCount(1);
  await host.getByRole('textbox').fill('ZZZY');
  await host.getByRole('button', { name: 'Подключиться' }).click();
  await expect(host.getByText('Комната не найдена')).toBeVisible({ timeout: 15_000 });
  await host.getByRole('button', { name: 'Понятно' }).click();
  await expect(host.getByTestId('duel-row')).toHaveCount(1);
});

test('removing a running duel while the opponent is offline: a loss now, the win reaches the opponent later', async ({ context, baseURL }) => {
  test.setTimeout(120_000);
  const base = `${baseURL}?transport=bc`;
  const host = await context.newPage();
  const guest = await context.newPage();
  await setup(host, base);
  await setup(guest, base);
  await toPanel(host, base);
  await host.getByRole('button', { name: 'Создать комнату' }).click();
  const codeEl = host.getByTestId('room-code');
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}$/, { timeout: 30_000 });
  const code = (await codeEl.textContent())!.trim();
  await guest.bringToFront();
  await guest.goto(`${base}#/duel/${code}`);
  await expect(guest.locator('canvas')).toBeVisible({ timeout: 30_000 });
  await expect(host.locator('canvas')).toBeVisible({ timeout: 30_000 });

  // the guest's page goes away; the host removes the match from its list
  await guest.goto('about:blank');
  await toPanel(host, base);
  const row = host.getByTestId('duel-row').filter({ hasText: code });
  await row.getByRole('button', { name: 'Убрать матч' }).click();
  await expect(host.locator('.modal')).toContainText('когда вы оба будете в сети');
  await host.locator('.modal').getByRole('button', { name: 'Убрать' }).click();
  await expect(host.getByTestId('duel-row')).toHaveCount(0);
  expect(await duelRecords(host)).toEqual([false]);

  // the guest comes back: its match is over, won by concede (recorded once)
  await toPanel(guest, base);
  const grow = guest.getByTestId('duel-row').filter({ hasText: code });
  await expect(grow).toContainText('Победа', { timeout: 20_000 });
  await expect.poll(() => duelRecords(guest), { timeout: 10_000 }).toEqual([false, true]);
  await grow.click();
  await expect(guest.locator('.result-title')).toHaveText(/Победа/, { timeout: 20_000 });
  await guest.waitForTimeout(500);
  expect(await duelRecords(guest)).toEqual([false, true]);
});
