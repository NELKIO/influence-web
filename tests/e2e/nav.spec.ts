import { expect, test, type Page } from '@playwright/test';
import { expectNoErrors, fresh } from './helpers';

// Navigation smoke: every destination of the main menu opens and its back button returns to the menu.

const title = (page: Page) => page.locator('.topbar h1');
const menu = (page: Page) => page.locator('.menu-screen');

async function back(page: Page) {
  await page.locator('.topbar').getByRole('button', { name: 'Назад' }).click();
  await expect(menu(page)).toBeVisible();
}

test('every main-menu destination opens and back returns to the menu', async ({ page }) => {
  // the BroadcastChannel transport keeps the online screens off the network
  const errors = await fresh(page, {}, './?transport=bc');
  await expect(menu(page)).toBeVisible();

  const destinations: { open: () => Promise<void>; heading: string; content: RegExp | string }[] = [
    { open: () => page.locator('.play-btn', { hasText: 'Новая битва' }).click(), heading: 'Настройка битвы', content: 'Карта' },
    { open: () => page.locator('.mode-card', { hasText: 'Дуэли' }).click(), heading: 'Дуэли', content: 'Онлайн с другом' },
    { open: () => page.locator('.mode-card', { hasText: 'Карта дня' }).click(), heading: 'Карта дня', content: /^#\d+$/ },
    { open: () => page.locator('.mode-card', { hasText: 'Правила' }).click(), heading: 'Как играть', content: 'Усиление' },
    { open: () => page.locator('.join-btn').click(), heading: 'Подключиться', content: '' },
    { open: () => page.locator('.menu-links button', { hasText: 'Статистика' }).click(), heading: 'Статистика', content: 'Сыграйте первую партию' },
    { open: () => page.locator('.menu-links button', { hasText: 'Настройки' }).click(), heading: 'Настройки', content: 'Язык' },
  ];
  for (const d of destinations) {
    await d.open();
    await expect(title(page)).toHaveText(d.heading);
    if (d.content instanceof RegExp) await expect(page.locator('.daily-num')).toHaveText(d.content);
    else if (d.content) await expect(page.getByText(d.content, { exact: false }).first()).toBeVisible();
    await back(page);
  }
  await expectNoErrors(errors);
});

test('rules screen shows every rule section', async ({ page }) => {
  const errors = await fresh(page);
  await page.locator('.mode-card', { hasText: 'Правила' }).click();
  await expect(title(page)).toHaveText('Как играть');
  const cards = page.locator('.rule-card');
  await expect(cards).toHaveCount(7);
  // six rules with a heading, a diagram and text; then the duel rules (text only)
  await expect(page.locator('.rule-card h3')).toHaveCount(6);
  for (let i = 0; i < 7; i++) {
    await expect(cards.nth(i).locator('svg').first()).toBeVisible();
    await expect(cards.nth(i).locator('p').first()).not.toBeEmpty();
  }
  await expect(page.locator('.rule-card h3')).toHaveText(['Цель', /./, /./, /./, 'Усиление', 'Режимы']);
  // nothing is left as a raw translation key
  await expect(page.locator('.screen')).not.toContainText(/\brule\d|duelRule\d/);
  await back(page);
  await expectNoErrors(errors);
});

test.describe('invite links', () => {
  test('#/duel/CODE opens the online duel panel and joins the room', async ({ page }) => {
    const errors = await fresh(page, {}, './?transport=bc');
    await page.goto('./?transport=bc#/duel/abcd');
    await expect(title(page)).toHaveText('Онлайн с другом');
    // the invite is consumed: the address is the duels screen now, so a reload does not join again
    await expect.poll(() => new URL(page.url()).hash).toBe('#/duels');
    // a match slot was opened for the room (the code is upper-cased)
    await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('infweb.duelSlots') || '[]').length)).toBe(1);
    await page.reload();
    await expect(title(page)).toHaveText('Дуэли');
    // back ends at the menu
    await page.goBack();
    await expect(menu(page)).toBeVisible();
    await expectNoErrors(errors);
  });

  test('#/join/CODE opens the battle room as a guest (also on a hash change)', async ({ page }) => {
    const errors = await fresh(page, {}, './?transport=bc');
    await expect(menu(page)).toBeVisible();
    await page.evaluate(() => (location.hash = '#/join/abcde'));
    await expect(title(page)).toHaveText('Онлайн-битва');
    // the code leaves the address: a room cannot be rebuilt from it, a reload lands on the menu
    await expect.poll(() => new URL(page.url()).hash).toBe('#/room');
    await page.reload();
    await expect(menu(page)).toBeVisible();
    await expectNoErrors(errors);
  });

  test('unknown or malformed hashes go to the menu and are cleared from the address', async ({ page }) => {
    const errors = await fresh(page, {}, './?transport=bc');
    for (const h of ['#/nothing', '#/duel/ABC', '#/duel/ABCDE', '#/join/ABCD', '#/join/AB-CDE', '#/game']) {
      await page.evaluate((x) => (location.hash = x), h);
      await expect(menu(page)).toBeVisible();
      await expect(title(page)).toHaveCount(0);
      await expect.poll(() => new URL(page.url()).hash).toBe('');
    }
    await page.goto('./?transport=bc#/whatever');
    await expect(menu(page)).toBeVisible();
    await expect.poll(() => new URL(page.url()).hash).toBe('');
    await expectNoErrors(errors);
  });

  test('a screen address opens that screen; a trailing slash is fine', async ({ page }) => {
    const errors = await fresh(page, {}, './?transport=bc');
    await page.evaluate(() => (location.hash = '#/settings'));
    await expect(title(page)).toHaveText('Настройки');
    await page.goto('./?transport=bc#/rules/');
    await expect(title(page)).toHaveText('Как играть');
    await expect.poll(() => new URL(page.url()).hash).toBe('#/rules');
    await expectNoErrors(errors);
  });
});
