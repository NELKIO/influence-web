import { expect, test } from '@playwright/test';
import { expectNoErrors, fresh, waitGame } from './helpers';

test('the turn-order bonus is shown: badges for later seats, a start hint, gone after round 1', async ({ page }) => {
  const errors = await fresh(page, { confirmEnd: false, speed: 'instant' });
  await page.evaluate(() =>
    localStorage.setItem(
      'infweb.setup',
      JSON.stringify({ size: 'M', players: ['human', 'hunter', 'hunter', 'hunter'], darkness: false, symmetry: true, crowded: false, unions: false, shuffle: false }),
    ),
  );
  await page.reload();
  await page.getByRole('button', { name: /Быстрый старт/ }).click();
  await waitGame(page);
  await expect(page.getByTestId('order-bonus')).toHaveText(['+1', '+2', '+3']);
  await expect(page.getByText(/Кто ходит позже, получит больше силы/)).toBeVisible();
  // round 1 played: no bonus is left to come
  await page.evaluate(() => {
    const c = (window as any).__infweb.ctrl;
    c.endButton(true);
    c.endButton(true);
  });
  await expect.poll(() => page.evaluate(() => (window as any).__infweb.ctrl.state.turn), { timeout: 20_000 }).toBeGreaterThan(0);
  await expect(page.getByTestId('order-bonus')).toHaveCount(0);
  await expectNoErrors(errors);
});

test('two players get no bonus badge (they start with 5 and 7)', async ({ page }) => {
  const errors = await fresh(page, { confirmEnd: false });
  await page.evaluate(() =>
    localStorage.setItem(
      'infweb.setup',
      JSON.stringify({ size: 'M', players: ['human', 'hunter'], darkness: false, symmetry: true, crowded: false, unions: false, shuffle: false }),
    ),
  );
  await page.reload();
  await page.getByRole('button', { name: /Быстрый старт/ }).click();
  await waitGame(page);
  await expect(page.getByTestId('order-bonus')).toHaveCount(0);
  await expectNoErrors(errors);
});
