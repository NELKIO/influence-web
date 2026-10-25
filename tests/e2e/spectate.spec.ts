import { expect, test } from '@playwright/test';
import { expectNoErrors, fresh, waitGame } from './helpers';

test('after losing, the bots left on the board can be watched to the end; the result is not recorded twice', async ({ page }) => {
  const errors = await fresh(page, { confirmEnd: false, speed: 'fast' });
  await page.evaluate(() =>
    localStorage.setItem(
      'infweb.setup',
      JSON.stringify({ size: 'S', players: ['human', 'hunter', 'hunter'], darkness: true, symmetry: true, crowded: false, unions: false, shuffle: false }),
    ),
  );
  await page.reload();
  await page.getByRole('button', { name: /Быстрый старт/ }).click();
  await waitGame(page);
  // the only person gives up while two bots are on the board
  await page.evaluate(() => (window as any).__infweb.ctrl.concedeMatch());
  await expect(page.locator('.result-title')).toHaveText('Поражение', { timeout: 10_000 });
  const records = () => page.evaluate(() => JSON.parse(localStorage.getItem('infweb.stats') ?? '{}').records?.length ?? 0);
  expect(await records()).toBe(1);

  await page.getByTestId('watch-bots').click();
  await expect(page.locator('.result-title')).toBeHidden();
  await expect.poll(() => page.evaluate(() => (window as any).__infweb.ctrl.state.settings.spectate ?? 0)).toBeGreaterThan(0);
  const st = await page.evaluate(() => {
    const s = (window as any).__infweb.ctrl.state;
    return { spectate: s.settings.spectate, ended: s.ended, hidden: [...(window as any).__infweb.ctrl.view().visible].filter((v: number) => !v).length };
  });
  expect(st.spectate).toBeGreaterThan(0);
  expect(st.ended).toBeNull();
  // the whole map is open while watching
  expect(st.hidden).toBe(0);
  await expect(page.getByText('Наблюдение')).toBeVisible();
  // the bots can be sped up
  await page.getByRole('button', { name: 'Скорость ×1' }).click();
  await expect(page.getByRole('button', { name: 'Скорость ×2' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__infweb.ctrl.spectateSpeedup)).toBe(2);
  // the rest of the fight runs at full speed for the test
  await page.evaluate(() => {
    const c = (window as any).__infweb.ctrl;
    c.settings = { ...c.settings, speed: 'instant' };
  });

  // the bots fight it out: a bot wins, or nobody within the round limit
  await expect(page.locator('.result-title')).toHaveText(/Победитель: Охотник [12]|никто не победил/, { timeout: 60_000 });
  await expect(page.getByText(/Так закончилась бы битва без вас/)).toBeVisible();
  await expect(page.getByTestId('watch-bots')).toHaveCount(0);
  expect(await records()).toBe(1);
  await expectNoErrors(errors);
});

test('nothing to watch when a single bot is left', async ({ page }) => {
  const errors = await fresh(page, { confirmEnd: false, speed: 'instant' });
  await page.evaluate(() =>
    localStorage.setItem(
      'infweb.setup',
      JSON.stringify({ size: 'S', players: ['human', 'dummy'], darkness: false, symmetry: true, crowded: false, unions: false, shuffle: false }),
    ),
  );
  await page.reload();
  await page.getByRole('button', { name: /Быстрый старт/ }).click();
  await waitGame(page);
  await page.evaluate(() => (window as any).__infweb.ctrl.concedeMatch());
  await expect(page.locator('.result-title')).toHaveText('Поражение', { timeout: 10_000 });
  await expect(page.getByTestId('watch-bots')).toHaveCount(0);
  await expectNoErrors(errors);
});
