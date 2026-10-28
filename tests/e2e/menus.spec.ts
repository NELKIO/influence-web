import { expect, test, type Page } from '@playwright/test';
import { expectNoErrors, fresh, waitGame } from './helpers';

// The screens around the game: broken saved data, browser history, the overwrite question, the duel
// training dialog, the medal box, plurals and the calendar heading.

const title = (page: Page) => page.locator('.topbar h1');
const menu = (page: Page) => page.locator('.menu-screen');
const crash = (page: Page) => page.getByTestId('crash');

const SCREENS: [string, string][] = [
  ['#/setup', 'Настройка битвы'],
  ['#/daily', 'Карта дня'],
  ['#/duels', 'Дуэли'],
  ['#/rules', 'Как играть'],
  ['#/stats', 'Статистика'],
  ['#/settings', 'Настройки'],
  ['#/join', 'Подключиться'],
];

/** Garbage a corrupted or hand-edited key might hold. */
const GARBAGE: Record<string, string[]> = {
  settings: ['null', '"str"', '[]', '{"lang":"de"}', '{"speed":"turbo","palette":"x","cellLines":7}', '{bad'],
  setup: ['null', '{"players":"abc"}', '{"players":["human"]}', '{"players":["human","banana","remote"]}', '{"size":"Q"}', '{"scenarioSeats":null,"scenarioConfig":null}'],
  game: ['{"state":{"v":1}}', '{"state":{"v":1,"settings":{"kind":"single","size":"M"},"turn":2}}', '[]', '5'],
  stats: ['{}', 'null', '{"records":null}', '{"records":[{"kind":"single"},null]}'],
  daily2: ['null', '[]', '{"2026-10-25":null}', '"x"'],
  medals: ['null', '{"v":1,"medals":null}'],
  duelopts: ['{"size":"Q"}', 'null', '[]'],
};

test.describe('broken saved data', () => {
  for (const [key, values] of Object.entries(GARBAGE)) {
    test(`garbage in infweb.${key}: the menu and every screen render`, async ({ page }) => {
      test.setTimeout(120_000);
      const errors = await fresh(page, {}, './?transport=bc');
      for (const v of values) {
        await page.evaluate(([k, x]) => localStorage.setItem('infweb.' + k, x), [key, v]);
        await page.goto('./?transport=bc');
        await expect(menu(page), `${key}=${v}`).toBeVisible();
        await expect(page.locator('.play-btn').first()).toBeVisible();
        for (const [hash, heading] of SCREENS) {
          await page.goto('./?transport=bc' + hash);
          // (broken settings may lose the language: then the headings follow the browser's)
          await expect(title(page), `${key}=${v} ${hash}`).toHaveText(key === 'settings' ? /\S/ : heading);
          await expect(crash(page)).toHaveCount(0);
        }
      }
      await expectNoErrors(errors);
    });
  }

  test('a screen that fails to render offers the menu and a data reset', async ({ page }) => {
    const errors = await fresh(page, {}, './?transport=bc');
    // break the calendar of the map of the day
    await page.evaluate(() => {
      localStorage.setItem('infweb.stats', JSON.stringify({ records: [], streak: 3, bestStreak: 3 }));
      Date.prototype.toLocaleDateString = () => {
        throw new Error('boom');
      };
    });
    await page.locator('.mode-card', { hasText: 'Карта дня' }).click();
    await expect(crash(page)).toBeVisible();
    await expect(crash(page)).toContainText('Что-то пошло не так');
    expect(errors.some((e) => /boom|failed to render/.test(e))).toBe(true);
    // back to the menu
    await crash(page).getByRole('button', { name: 'В меню' }).click();
    await expect(menu(page)).toBeVisible();
    // and the reset (after a confirmation) clears the game's data
    await page.locator('.mode-card', { hasText: 'Карта дня' }).click();
    await crash(page).getByRole('button', { name: 'Сбросить данные игры' }).click();
    await page.locator('.modal').getByRole('button', { name: 'Отмена' }).click();
    expect(await page.evaluate(() => localStorage.getItem('infweb.stats'))).not.toBeNull();
    await crash(page).getByRole('button', { name: 'Сбросить данные игры' }).click();
    await page.locator('.modal').getByRole('button', { name: 'Удалить' }).click();
    await expect(menu(page)).toBeVisible();
    expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('infweb.')))).toEqual([]);
  });
});

test.describe('browser history', () => {
  test('back walks through the screens and ends at the menu; reload keeps the screen', async ({ page }) => {
    const errors = await fresh(page);
    const start = await page.evaluate(() => history.length);
    await page.locator('.menu-links button', { hasText: 'Статистика' }).click();
    await expect(title(page)).toHaveText('Статистика');
    expect(new URL(page.url()).hash).toBe('#/stats');
    await page.getByRole('button', { name: 'К сценариям' }).click();
    await expect(title(page)).toHaveText('Настройка битвы');
    await page.reload();
    await expect(title(page)).toHaveText('Настройка битвы');
    await page.goBack();
    await expect(title(page)).toHaveText('Статистика');
    await page.goBack();
    await expect(menu(page)).toBeVisible();
    expect(new URL(page.url()).hash).toBe('');
    // the app's back button returns to the menu entry too (no pile of entries)
    await page.locator('.mode-card', { hasText: 'Правила' }).click();
    await page.locator('.topbar').getByRole('button', { name: 'Назад' }).click();
    await expect(menu(page)).toBeVisible();
    await page.locator('.mode-card', { hasText: 'Правила' }).click();
    await expect(title(page)).toHaveText('Как играть');
    expect(await page.evaluate(() => history.length)).toBeLessThanOrEqual(start + 3);
    await expectNoErrors(errors);
  });

  test('a screen opened from a link has the menu under it', async ({ page }) => {
    const errors = await fresh(page, {}, './#/settings');
    await expect(title(page)).toHaveText('Настройки');
    await page.goBack();
    await expect(menu(page)).toBeVisible();
    await expectNoErrors(errors);
  });

  test('back from a match is its menu button: the match is saved and offered', async ({ page }) => {
    const errors = await fresh(page);
    await page.evaluate(() => localStorage.setItem('infweb.setup', JSON.stringify({ size: 'S', players: ['human', 'dummy'], shuffle: false, rev: 2 })));
    await page.reload();
    await page.locator('.play-btn', { hasText: 'Новая битва' }).click();
    await page.getByRole('button', { name: 'В бой' }).first().click();
    await waitGame(page);
    expect(new URL(page.url()).hash).toBe('#/game');
    await page.goBack();
    await expect(menu(page)).toBeVisible();
    await expect(page.locator('.play-btn.cont', { hasText: 'Продолжить' })).toBeVisible();
    // a reload in a match lands on the menu, which offers to continue
    await page.locator('.play-btn.cont', { hasText: 'Продолжить' }).click();
    await waitGame(page);
    await page.reload();
    await expect(menu(page)).toBeVisible();
    await expect(page.locator('.play-btn.cont', { hasText: 'Продолжить' })).toBeVisible();
    expect(new URL(page.url()).hash).toBe('');
    await expectNoErrors(errors);
  });
});

test.describe('the saved match is not lost silently', () => {
  async function withSavedMatch(page: Page) {
    await page.evaluate(() => localStorage.setItem('infweb.setup', JSON.stringify({ size: 'S', players: ['human', 'dummy'], shuffle: false, rev: 2 })));
    await page.reload();
    await page.locator('.mode-card', { hasText: 'Быстрый старт' }).click();
    await waitGame(page);
    const seed = await page.evaluate(() => (window as any).__infweb.ctrl.state.seed);
    await page.goBack();
    await expect(menu(page)).toBeVisible();
    return seed as number;
  }
  const savedSeed = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('infweb.game') || 'null')?.state.seed);

  test('statistics → scenarios → start asks first; opening the setup does not', async ({ page }) => {
    const errors = await fresh(page);
    const seed = await withSavedMatch(page);
    await page.locator('.play-btn', { hasText: 'Новая битва' }).click();
    await expect(title(page)).toHaveText('Настройка битвы');
    await expect(page.locator('.modal')).toHaveCount(0);
    await page.goBack();
    await page.locator('.menu-links button', { hasText: 'Статистика' }).click();
    await page.getByRole('button', { name: 'К сценариям' }).click();
    await page.getByRole('button', { name: 'В бой' }).first().click();
    await expect(page.locator('.modal')).toContainText('Есть незаконченная партия');
    await page.locator('.modal').getByRole('button', { name: 'Отмена' }).click();
    expect(await savedSeed(page)).toBe(seed);
    await page.getByRole('button', { name: 'В бой' }).first().click();
    await page.locator('.modal').getByRole('button', { name: 'Начать новую' }).click();
    await waitGame(page);
    expect(await savedSeed(page)).not.toBe(seed);
    await expectNoErrors(errors);
  });

  test('quick start asks too; with nothing saved nobody asks', async ({ page }) => {
    const errors = await fresh(page);
    await page.evaluate(() => localStorage.setItem('infweb.setup', JSON.stringify({ size: 'S', players: ['human', 'dummy'], shuffle: false, rev: 2 })));
    await page.reload();
    await page.locator('.mode-card', { hasText: 'Быстрый старт' }).click();
    await waitGame(page);
    await page.goBack();
    await page.locator('.mode-card', { hasText: 'Быстрый старт' }).click();
    await expect(page.locator('.modal')).toContainText('Есть незаконченная партия');
    await expectNoErrors(errors);
  });
});

test('cancelling the duel training question keeps who moves first', async ({ page }) => {
  const errors = await fresh(page);
  await page.evaluate(() => localStorage.setItem('infweb.setup', JSON.stringify({ size: 'S', players: ['human', 'dummy'], shuffle: false, rev: 2 })));
  await page.reload();
  await page.locator('.mode-card', { hasText: 'Быстрый старт' }).click();
  await waitGame(page);
  await page.goBack();
  const first = () => page.evaluate(() => JSON.parse(localStorage.getItem('infweb.settings')!).trainingLocalFirst ?? false);
  const before = await first();
  await page.locator('.mode-card', { hasText: 'Дуэли' }).click();
  await page.getByText('Тренировка с ботом').click();
  await page.locator('.modal').getByRole('button', { name: 'Отмена' }).click();
  expect(await first()).toBe(before);
  await page.getByText('Тренировка с ботом').click();
  await page.locator('.modal').getByRole('button', { name: 'Начать новую' }).click();
  await waitGame(page);
  expect(await first()).toBe(!before);
  await expectNoErrors(errors);
});

test('with a person in a seat the medal box says only that no medal is given', async ({ page }) => {
  const errors = await fresh(page);
  await page.evaluate(() => localStorage.setItem('infweb.setup', JSON.stringify({ scenario: 'siege', scenarioSeats: { siege: ['human', 'human'] } })));
  await page.reload();
  await page.locator('.play-btn', { hasText: 'Новая битва' }).click();
  const box = page.getByTestId('medal-status');
  await expect(box).toContainText('Когда играют люди, медаль не выдаётся');
  await expect(box).not.toContainText('Победите');
  await expectNoErrors(errors);
});

test('English: one opponent, the page title follows the language', async ({ page }) => {
  const errors = await fresh(page, { lang: 'en' });
  await page.evaluate(() => localStorage.setItem('infweb.setup', JSON.stringify({ size: 'S', players: ['human', 'dummy'], shuffle: false, rev: 2 })));
  await page.reload();
  await expect(page.locator('.mode-card', { hasText: 'Quick start' })).toContainText('1 opponent');
  await expect(page.locator('.mode-card', { hasText: 'Quick start' })).not.toContainText('opponents');
  await expect(page).toHaveTitle(/in your browser/);
  await page.locator('.menu-links button', { hasText: 'Settings' }).click();
  await page.getByRole('radio', { name: 'RU' }).click();
  await expect(page).toHaveTitle(/«Влияния»/);
  await expectNoErrors(errors);
});

test('the calendar heading and "today" after midnight', async ({ page }) => {
  await page.clock.install({ time: new Date(2026, 9, 25, 23, 59, 50) });
  const errors = await fresh(page);
  await page.locator('.mode-card', { hasText: 'Карта дня' }).click();
  await expect(page.getByTestId('cal-month')).toHaveText('Октябрь 2026');
  await expect(page.locator('.cal-day.today')).toHaveText('25');
  const before = await page.locator('.daily-num').textContent();
  await page.clock.runFor(20_000);
  await expect(page.locator('.cal-day.today')).toHaveText('26');
  await expect(page.locator('.cal-day.sel')).toHaveText('26');
  await expect(page.getByText('Сегодня', { exact: true })).toBeVisible();
  expect(await page.locator('.daily-num').textContent()).not.toBe(before);
  await expectNoErrors(errors);
});
