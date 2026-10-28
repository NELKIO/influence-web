import { expect, test } from '@playwright/test';
import { autoplay, expectNoErrors, fresh, waitGame } from './helpers';

test('statistics show a played match', async ({ page }) => {
  const errors = await fresh(page, { confirmEnd: false });
  await page.evaluate(() =>
    localStorage.setItem(
      'infweb.setup',
      JSON.stringify({ size: 'S', players: ['human', 'dummy'], darkness: false, symmetry: true, crowded: false, unions: false, shuffle: false, rev: 2 }),
    ),
  );
  await page.reload();

  // nothing played yet
  await page.locator('.menu-links button', { hasText: 'Статистика' }).click();
  await expect(page.getByText('Сыграйте первую партию')).toBeVisible();
  await page.locator('.topbar').getByRole('button', { name: 'Назад' }).click();

  await page.locator('.mode-card', { hasText: 'Быстрый старт' }).click();
  await waitGame(page);
  await autoplay(page);
  await expect(page.locator('.result-title')).toBeVisible({ timeout: 10_000 });
  const ended = await page.evaluate(() => {
    const s = (window as any).__infweb.ctrl.state;
    return { won: s.ended.humanWon as boolean };
  });
  await page.locator('.modal').getByRole('button', { name: /В меню/ }).click();

  const stats = await page.evaluate(() => JSON.parse(localStorage.getItem('infweb.stats') || 'null'));
  expect(stats.records).toHaveLength(1);
  expect(stats.records[0]).toMatchObject({ kind: 'single', size: 'S', opponents: ['dummy'], humans: 1, win: ended.won });
  expect(stats.streak).toBe(ended.won ? 1 : 0);
  expect(stats.bestStreak).toBe(ended.won ? 1 : 0);

  await page.locator('.menu-links button', { hasText: 'Статистика' }).click();
  await expect(page.locator('.topbar h1')).toHaveText('Статистика');
  await expect(page.getByText('Сыграйте первую партию')).toHaveCount(0);
  const top = page.locator('.big-stats').first().locator('b');
  await expect(top.nth(0)).toHaveText('1');
  await expect(top.nth(1)).toHaveText(ended.won ? '100%' : '0%');
  await expect(top.nth(2)).toHaveText(ended.won ? '1' : '0');
  await expect(page.getByText('Последние партии')).toBeVisible();
  const recent = page.locator('.list .list-item');
  await expect(recent).toHaveCount(1);
  await expect(recent.first()).toContainText('Крошечная · Тупица');
  await expect(recent.first()).toContainText(ended.won ? '✓' : '✕');
  await expect(recent.first()).toContainText(`Раунд ${stats.records[0].rounds}`);
  await expect(top.nth(1).locator('xpath=..')).toContainText(`Побед: ${ended.won ? 1 : 0}`);
  await expectNoErrors(errors);
});
