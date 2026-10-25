import { expect, test } from '@playwright/test';
import { expectNoErrors, fresh, waitGame } from './helpers';

test('night drop alone against bots: give up, see the whole map, watch the bots play on', async ({ page }) => {
  const errors = await fresh(page, { confirmEnd: false });
  await page.evaluate(() =>
    localStorage.setItem(
      'infweb.setup',
      JSON.stringify({ size: 'M', players: ['human', 'hunter'], darkness: false, symmetry: true, crowded: false, unions: false, shuffle: false, scenario: 'landing', scenarioSeats: { landing: ['human', 'hunter', 'hunter', 'hunter'] } }),
    ),
  );
  await page.reload();
  await page.getByRole('button', { name: /Быстрый старт/ }).click();
  await waitGame(page);
  const hidden = () => page.evaluate(() => [...(window as any).__infweb.ctrl.view().visible].filter((v: number) => !v).length);
  expect(await hidden()).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Пауза' }).click();
  await page.getByRole('button', { name: /Сдаться/ }).click();
  await expect(page.getByText(/откроется вся карта/)).toBeVisible();
  await page.locator('.modal').getByRole('button', { name: 'Сдаться' }).click();
  await expect(page.locator('.result-title')).toHaveText('Поражение', { timeout: 10_000 });
  expect(await hidden()).toBe(0);
  await page.getByRole('button', { name: 'Открыть всю карту' }).click();
  // the explored-land fog is gone too: every cell is drawn
  await expect
    .poll(() => page.evaluate(() => (window as any).__infweb.renderer.drawnCells === (window as any).__infweb.ctrl.state.field.cells.length))
    .toBe(true);
  await page.getByRole('button', { name: 'К итогам' }).click();
  await expect(page.getByTestId('watch-bots')).toBeVisible();
  await expectNoErrors(errors);
});

test('an ordinary battle against one bot can be given up too', async ({ page }) => {
  const errors = await fresh(page, { confirmEnd: false });
  await page.getByRole('button', { name: /Быстрый старт/ }).click();
  await waitGame(page);
  await page.getByRole('button', { name: 'Пауза' }).click();
  await page.getByRole('button', { name: /Сдаться/ }).click();
  await page.locator('.modal').getByRole('button', { name: 'Сдаться' }).click();
  await expect(page.locator('.result-title')).toHaveText('Поражение', { timeout: 10_000 });
  await expectNoErrors(errors);
});
