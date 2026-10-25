import { expect, test, type Page } from '@playwright/test';
import { expectNoErrors, fresh, waitGame } from './helpers';

// Battle setup, step 2: every seat type can be picked, and the match starts with exactly those seats.

async function openSeats(page: Page) {
  await page.locator('.play-btn', { hasText: 'Новая битва' }).click();
  await expect(page.locator('.topbar h1')).toHaveText('Настройка битвы');
  await page.locator('.steps button').nth(1).click();
}

const rows = (page: Page) => page.locator('.player-row');

/** Add or remove seats until there are `n`. */
async function seatCount(page: Page, n: number) {
  for (let i = 0; i < 6 && (await rows(page).count()) < n; i++) await page.locator('.add-row').click();
  for (let i = 0; i < 6 && (await rows(page).count()) > n; i++) await page.getByRole('button', { name: 'Убрать' }).click();
  await expect(rows(page)).toHaveCount(n);
}

async function pick(page: Page, slot: number, type: string) {
  // seat 0 is you and has no picker: the pickers start at seat 1
  const picker = page.locator('.type-pick').nth(slot - 1);
  await picker.locator(`button.${type}`).click();
  await expect(picker.locator(`button.${type}`)).toHaveClass(/\bon\b/);
  await expect(picker.locator('button.on')).toHaveCount(1);
}

test('every bot and local seat type: the match gets exactly those seats', async ({ page }) => {
  const errors = await fresh(page, { confirmEnd: false });
  await openSeats(page);
  await seatCount(page, 6);
  await expect(page.locator('.add-row')).toHaveCount(0); // six seats at most
  // every picker offers the same six types
  await expect(page.locator('.type-pick').first().locator('button')).toHaveText(['Тупица', 'Охотник', 'Мастер', 'БОГ', 'Игрок', 'Онлайн']);

  const types = ['dummy', 'hunter', 'master', 'god', 'human'];
  for (let i = 0; i < types.length; i++) await pick(page, i + 1, types[i]);
  // seat names follow the choice
  await expect(rows(page).nth(1).locator('.title').first()).toContainText('Тупица');
  await expect(rows(page).nth(4).locator('.title').first()).toContainText('БОГ');
  await expect(page.getByText(/устройств/i).first()).toBeVisible(); // the hot-seat note for two people

  // the choice is saved
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('infweb.setup')!).players);
  expect(saved).toEqual(['human', ...types]);

  await page.locator('.footer-actions .btn.ghost').click(); // start
  await waitGame(page);
  const players = await page.evaluate(() => (window as any).__infweb.ctrl.state.settings.players);
  expect(players).toEqual(['human', ...types]);
  await expectNoErrors(errors);
});

test('a smaller line-up with repeated types, and the setup is remembered', async ({ page }) => {
  const errors = await fresh(page);
  await openSeats(page);
  await seatCount(page, 3);
  await pick(page, 1, 'master');
  await pick(page, 2, 'master');
  await page.reload();
  await openSeats(page);
  await expect(rows(page)).toHaveCount(3);
  for (const slot of [1, 2]) await expect(page.locator('.type-pick').nth(slot - 1).locator('button.master')).toHaveClass(/\bon\b/);
  await page.locator('.footer-actions .btn.ghost').click();
  await waitGame(page);
  expect(await page.evaluate(() => (window as any).__infweb.ctrl.state.settings.players)).toEqual(['human', 'master', 'master']);
  // two seats is the minimum: no remove button then (leaving the started match behind)
  await page.goto('./');
  await page.locator('.play-btn', { hasText: 'Новая битва' }).click();
  await page.locator('.modal').getByRole('button', { name: 'Начать новую' }).click();
  await expect(page.locator('.topbar h1')).toHaveText('Настройка битвы');
  await page.locator('.steps button').nth(1).click();
  await seatCount(page, 2);
  await expect(page.getByRole('button', { name: 'Убрать' })).toHaveCount(0);
  await expectNoErrors(errors);
});

test('an online seat turns the start into a battle room with those seats', async ({ page }) => {
  const errors = await fresh(page, {}, './?transport=bc');
  await openSeats(page);
  await seatCount(page, 4);
  await pick(page, 1, 'online');
  await pick(page, 2, 'dummy');
  await pick(page, 3, 'online');
  await expect(page.locator('.footer-actions .btn.ghost')).toHaveText('Создать комнату');
  await page.locator('.footer-actions .btn.ghost').click();
  await expect(page.locator('.topbar h1')).toHaveText('Онлайн-битва');
  await expect(page.getByTestId('room-code')).toHaveText(/^[A-Z0-9]{5}$/, { timeout: 30_000 });
  const roster = page.getByTestId('roster');
  await expect(roster).toBeVisible();
  await expect(roster).toContainText('Тупица');
  await expectNoErrors(errors);
});
