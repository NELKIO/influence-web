import { expect, test, type Page } from '@playwright/test';
import { expectNoErrors, fresh } from './helpers';

// The join screen: one box for both kinds of online games, over the BroadcastChannel transport
// (tabs of one browser) so nothing reaches the network.

const BC = './?transport=bc';

async function openJoin(page: Page) {
  await page.locator('.join-btn').click();
  await expect(page.locator('.topbar h1')).toHaveText('Подключиться');
}

const input = (page: Page) => page.getByRole('textbox');
const joinBtn = (page: Page) => page.locator('.screen').getByRole('button', { name: 'Подключиться' });

test('codes of the wrong length are refused with a message', async ({ page }) => {
  const errors = await fresh(page, {}, BC);
  await openJoin(page);
  await expect(joinBtn(page)).toBeDisabled();
  await expect(page.getByText('Код из 4 символов — дуэль, из 5 — битва')).toBeVisible();

  await input(page).fill('ab');
  await expect(joinBtn(page)).toBeEnabled();
  await joinBtn(page).click();
  await expect(page.getByText('Код должен быть из 4 или 5 символов')).toBeVisible();
  await input(page).fill('ab');
  await input(page).press('Enter');
  await expect(page.getByText('Код должен быть из 4 или 5 символов')).toBeVisible();
  await expect(page.locator('.topbar h1')).toHaveText('Подключиться');

  // typing again clears the message
  await input(page).fill('abc');
  await expect(page.getByText('Код должен быть из 4 или 5 символов')).toHaveCount(0);
  await input(page).press('Enter');
  await expect(page.getByText('Код должен быть из 4 или 5 символов')).toBeVisible();

  // separators and lower case are cleaned up; the box takes at most five characters
  await input(page).fill('');
  await input(page).pressSequentially('a-b c');
  await expect(input(page)).toHaveValue('ABC');
  await input(page).fill('');
  await input(page).pressSequentially('abcdefgh');
  await expect(input(page)).toHaveValue('ABCDE');
  await expectNoErrors(errors);
});

test('a four-character code opens the duel room', async ({ page }) => {
  const errors = await fresh(page, {}, BC);
  await openJoin(page);
  await input(page).fill('kx7m');
  await expect(joinBtn(page)).toBeEnabled();
  await joinBtn(page).click();
  await expect(page.locator('.topbar h1')).toHaveText('Онлайн с другом');
  // the guest keeps this room in its list of matches
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('infweb.duelSlots') || '[]').length)).toBe(1);
  await expectNoErrors(errors);
});

test('a five-character code opens the battle room as a guest', async ({ page }) => {
  const errors = await fresh(page, {}, BC);
  await openJoin(page);
  await input(page).fill('kx7mq');
  await joinBtn(page).click();
  await expect(page.locator('.topbar h1')).toHaveText('Онлайн-битва');
  await expectNoErrors(errors);
});

test('a battle code with letters that codes never use is refused', async ({ page }) => {
  const errors = await fresh(page, {}, BC);
  await openJoin(page);
  await input(page).fill('O0I1Q');
  await joinBtn(page).click();
  await expect(page.getByText('Неверный код: используются буквы A–Z (без I, O) и цифры 2–9')).toBeVisible();
  await expect(page.locator('.topbar h1')).toHaveText('Подключиться');
  await expectNoErrors(errors);
});

// the bug: a 4-character code with letters codes never contain (0/O, 1/I) went to the duel lobby and
// silently did nothing there
test('a duel code with letters that codes never use is refused', async ({ page }) => {
  const errors = await fresh(page, {}, BC);
  await openJoin(page);
  await input(page).fill('O0I1');
  await joinBtn(page).click();
  await expect(page.getByText('Неверный код: используются буквы A–Z (без I, O) и цифры 2–9')).toBeVisible();
  await expect(page.locator('.topbar h1')).toHaveText('Подключиться');
  await expectNoErrors(errors);
});

test('a pasted invite link and Cyrillic look-alikes give the code; the box shows what is used', async ({ page }) => {
  const errors = await fresh(page, {}, BC);
  await openJoin(page);
  await input(page).fill('https://nelkio.github.io/influence-web/#/join/kx7mq');
  await expect(input(page)).toHaveValue('KX7MQ');
  // Russian keyboard layout: К, Х, М are the Latin K, X, M
  await input(page).fill('');
  await input(page).pressSequentially('кх7м');
  await expect(input(page)).toHaveValue('KX7M');
  // a sixth character does not show up in the box
  await input(page).fill('');
  await input(page).pressSequentially('kx7mqz');
  await expect(input(page)).toHaveValue('KX7MQ');
  await expectNoErrors(errors);
});

test('a guest reaches a real battle room by typing its code', async ({ context, baseURL }) => {
  test.setTimeout(120_000);
  const base = `${baseURL}?transport=bc`;
  const host = await context.newPage();
  const guest = await context.newPage();
  const hostErrors = await fresh(host, {}, base);
  const guestErrors = await fresh(guest, {}, base);

  // a battle room (5 characters): the host opens it from a setup with an online seat
  await host.bringToFront();
  await host.evaluate(() =>
    localStorage.setItem(
      'infweb.setup',
      JSON.stringify({ size: 'S', players: ['human', 'online', 'dummy'], darkness: false, symmetry: true, crowded: false, unions: false, shuffle: false, rev: 2 }),
    ),
  );
  await host.reload();
  await host.locator('.mode-card', { hasText: 'Быстрый старт' }).click();
  const roomCode = host.getByTestId('room-code');
  await expect(roomCode).toHaveText(/^[A-Z0-9]{5}$/, { timeout: 30_000 });
  const battleCode = (await roomCode.textContent())!.trim();

  await guest.bringToFront();
  await openJoin(guest);
  await input(guest).fill(battleCode.toLowerCase());
  await joinBtn(guest).click();
  await expect(guest.locator('.topbar h1')).toHaveText('Онлайн-битва');
  await expect(guest.getByTestId('roster')).toBeVisible({ timeout: 30_000 });
  await expect(guest.getByTestId('room-code')).toHaveText(battleCode);
  await host.bringToFront();
  await expect(host.getByRole('button', { name: 'Начать битву' })).toBeEnabled({ timeout: 30_000 });
  for (const e of [hostErrors, guestErrors]) await expectNoErrors(e);
});

test('a guest reaches a real duel room by typing its code', async ({ context, baseURL }) => {
  test.setTimeout(120_000);
  const base = `${baseURL}?transport=bc`;
  const duelHost = await context.newPage();
  const duelGuest = await context.newPage();
  const dhErrors = await fresh(duelHost, {}, base);
  const dgErrors = await fresh(duelGuest, {}, base);
  await duelHost.bringToFront();
  await duelHost.locator('.mode-card', { hasText: 'Дуэли' }).click();
  await duelHost.getByText('Онлайн с другом').click();
  await duelHost.getByRole('button', { name: 'Создать комнату' }).click();
  const duelCodeEl = duelHost.getByTestId('room-code');
  await expect(duelCodeEl).toHaveText(/^[A-Z0-9]{4}$/, { timeout: 30_000 });
  const duelCode = (await duelCodeEl.textContent())!.trim();

  await duelGuest.bringToFront();
  await openJoin(duelGuest);
  await input(duelGuest).fill(duelCode);
  await joinBtn(duelGuest).click();
  await expect(duelGuest.locator('canvas')).toBeVisible({ timeout: 30_000 });
  await duelHost.bringToFront();
  await expect(duelHost.locator('canvas')).toBeVisible({ timeout: 30_000 });
  const kind = await duelGuest.evaluate(() => (window as any).__infweb.ctrl.state.settings.kind);
  expect(kind).toBe('duelOnline');

  for (const e of [dhErrors, dgErrors]) await expectNoErrors(e);
});
