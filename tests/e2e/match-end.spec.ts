import { expect, test } from '@playwright/test';
import { autoplay, expectNoErrors, fresh, waitGame } from './helpers';

test('darkness lifts at the end: the result can be put aside to look at the whole map', async ({ page }) => {
  const errors = await fresh(page, { confirmEnd: false });
  await page.evaluate(() =>
    localStorage.setItem(
      'infweb.setup',
      JSON.stringify({ size: 'S', players: ['human', 'hunter'], darkness: true, symmetry: true, crowded: false, unions: false, shuffle: false, rev: 2 }),
    ),
  );
  await page.reload();
  await page.getByRole('button', { name: /Быстрый старт/ }).click();
  await waitGame(page);
  const hiddenAtStart = await page.evaluate(() => [...(window as any).__infweb.ctrl.view().visible].filter((v: number) => !v).length);
  expect(hiddenAtStart).toBeGreaterThan(0);

  await autoplay(page);
  await expect(page.locator('.result-title')).toBeVisible({ timeout: 10_000 });
  // once the match is over nothing is hidden any more
  const hiddenAtEnd = await page.evaluate(() => [...(window as any).__infweb.ctrl.view().visible].filter((v: number) => !v).length);
  expect(hiddenAtEnd).toBe(0);

  await page.getByRole('button', { name: 'Открыть всю карту' }).click();
  await expect(page.locator('.result-title')).toBeHidden();
  await page.getByRole('button', { name: 'К итогам' }).click();
  await expect(page.locator('.result-title')).toBeVisible();
  await expectNoErrors(errors);
});
