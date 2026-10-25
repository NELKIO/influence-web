import { expect, test, type Page } from '@playwright/test';
import { expectNoErrors, fresh } from './helpers';

// The archive calendar of the map of the day, with the clock fixed to 15 March 2026 (the archive
// starts on 1 January 2026).

const monthLabel = (page: Page) => page.locator('.calendar').locator('xpath=preceding-sibling::div[1]/div');
const prev = (page: Page) => page.locator('.calendar').locator('xpath=preceding-sibling::div[1]/button[1]');
const next = (page: Page) => page.locator('.calendar').locator('xpath=preceding-sibling::div[1]/button[2]');
const day = (page: Page, n: number) => page.locator('.calendar .cal-day').getByText(String(n), { exact: true });

test('past months of the daily archive', async ({ page }) => {
  await page.clock.setFixedTime(new Date(2026, 2, 15, 12, 0, 0));
  const errors = await fresh(page);
  // a solved day and a tried day in February
  await page.evaluate(() =>
    localStorage.setItem(
      'infweb.daily2',
      JSON.stringify({ '2026-02-10': { attempts: 2, bestRounds: 7 }, '2026-02-11': { attempts: 1, bestRounds: null } }),
    ),
  );
  await page.reload();
  await page.locator('.mode-card', { hasText: 'Карта дня' }).click();
  await expect(page.locator('.topbar h1')).toHaveText('Карта дня');

  // the current month: today is marked and selected, later days are locked, no next month
  await expect(monthLabel(page)).toHaveText(/март 2026/i);
  await expect(page.locator('.calendar .cal-day')).toHaveCount(31);
  await expect(page.locator('.cal-day.today')).toHaveText('15');
  await expect(page.locator('.cal-day.sel')).toHaveText('15');
  await expect(day(page, 16)).toBeDisabled();
  await expect(day(page, 31)).toBeDisabled();
  await expect(day(page, 14)).toBeEnabled();
  await expect(next(page)).toBeDisabled();
  await expect(page.getByText('Сегодня', { exact: true })).toBeVisible();
  const todayNum = await page.locator('.daily-num').textContent();
  // March 2026 starts on a Sunday: six empty cells before it (Monday first)
  const grid = await page.locator('.calendar > *').evaluateAll((els) => els.map((e) => (e.classList.contains('dow') ? 'dow' : e.textContent || '')));
  expect(grid.slice(7, 14)).toEqual(['', '', '', '', '', '', '1']);

  // February: the results are shown, a past day can be picked
  await prev(page).click();
  await expect(monthLabel(page)).toHaveText(/февраль 2026/i);
  await expect(page.locator('.calendar .cal-day')).toHaveCount(28);
  await expect(page.locator('.calendar .cal-day:disabled')).toHaveCount(0);
  await expect(page.locator('.cal-day.won')).toHaveText('10');
  await expect(page.locator('.cal-day.tried')).toHaveText('11');
  await expect(page.locator('.cal-day.today')).toHaveCount(0);
  await expect(next(page)).toBeEnabled();
  await day(page, 10).click();
  await expect(page.locator('.cal-day.sel')).toHaveText('10');
  await expect(page.getByText('10 февраля')).toBeVisible();
  const febNum = await page.locator('.daily-num').textContent();
  expect(febNum).not.toBe(todayNum);
  // day numbers count from the first day of the archive
  expect(todayNum).toBe('#74');
  expect(febNum).toBe('#41');
  await expect(page.getByText('Лучший результат: победа за 7 р.')).toBeVisible();
  await expect(page.getByText('Попыток: 2')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ещё попытка' })).toBeVisible();
  // the tried day: no win yet, one attempt
  await day(page, 11).click();
  await expect(page.getByText('Попыток: 1')).toBeVisible();
  await day(page, 10).click();

  // January is the first month of the archive
  await prev(page).click();
  await expect(monthLabel(page)).toHaveText(/январь 2026/i);
  await expect(page.locator('.calendar .cal-day')).toHaveCount(31);
  await expect(prev(page)).toBeDisabled();
  await day(page, 1).click();
  await expect(page.locator('.daily-num')).toHaveText('#1');

  // and back to the current month
  await next(page).click();
  await next(page).click();
  await expect(monthLabel(page)).toHaveText(/март 2026/i);
  await expect(next(page)).toBeDisabled();
  // the selection stays on the picked day
  await expect(page.locator('.daily-num')).toHaveText('#1');
  await expectNoErrors(errors);
});

test('the daily archive in English starts its weeks on Monday', async ({ page }) => {
  await page.clock.setFixedTime(new Date(2026, 1, 3, 9, 0, 0));
  const errors = await fresh(page, { lang: 'en' });
  await page.locator('.mode-card', { hasText: 'Map of the day' }).click();
  await expect(monthLabel(page)).toHaveText('February 2026');
  await expect(page.locator('.calendar .dow')).toHaveText(['M', 'T', 'W', 'T', 'F', 'S', 'S']);
  await expect(page.locator('.cal-day.today')).toHaveText('3');
  await expect(day(page, 4)).toBeDisabled();
  await prev(page).click();
  await expect(monthLabel(page)).toHaveText('January 2026');
  await expect(prev(page)).toBeDisabled();
  await expectNoErrors(errors);
});
