import { expect, test } from '@playwright/test';
import { expectNoErrors, fresh, waitGame } from './helpers';

test('night drop alone against bots: give up, see the whole map, watch the bots play on', async ({ page }) => {
  const errors = await fresh(page, { confirmEnd: false });
  await page.evaluate(() =>
    localStorage.setItem(
      'infweb.setup',
      JSON.stringify({ size: 'M', players: ['human', 'hunter'], darkness: false, symmetry: true, crowded: false, unions: false, shuffle: false, rev: 2, scenario: 'landing', scenarioSeats: { landing: ['human', 'hunter', 'hunter', 'hunter'] } }),
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
  const selector = page.getByRole('combobox', { name: 'Кому передать территории?' });
  await expect(selector.locator('option')).toHaveCount(3);
  await selector.selectOption('3');
  await page.locator('.modal').getByRole('button', { name: 'Сдаться' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__infweb.ctrl.state.settings.spectate)).toBeGreaterThan(0);
  expect(await hidden()).toBe(0);
  expect(await page.evaluate(() => (window as any).__infweb.ctrl.localHumanSlot())).toBe(-1);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('infweb.stats')!).records.length)).toBe(1);
  await expectNoErrors(errors);
});

test('hot-seat: cancel keeps the board; confirm hands the same cells to the chosen third seat', async ({ page }) => {
  await fresh(page);
  await page.evaluate(() => localStorage.setItem('infweb.setup', JSON.stringify({ players: ['human', 'human', 'dummy'], shuffle: false, rev: 2 })));
  await page.reload();
  await page.getByRole('button', { name: /Быстрый старт/ }).click();
  await waitGame(page);
  const cells = () => page.evaluate(() => (window as any).__infweb.ctrl.state.field.cells.map((c: {owner: number; power: number}) => [c.owner, c.power]) as number[][]);
  const before = await cells();
  await page.getByRole('button', { name: 'Пауза' }).click();
  const surrender = page.getByRole('button', { name: 'Сдаться', exact: true });
  await surrender.click();
  const selector = page.getByRole('combobox', { name: 'Кому передать территории?' });
  await expect(selector.locator('option')).toHaveCount(2);
  await selector.selectOption('2');
  await page.getByRole('button', { name: 'Отмена' }).click();
  expect(await cells()).toEqual(before);
  await surrender.click();
  await selector.selectOption('2');
  await surrender.click();
  expect(await cells()).toEqual(before.map(([owner, power]) => [owner === 0 ? 2 : owner, power]));
  expect(await page.evaluate(() => (window as any).__infweb.ctrl.state.current)).toBe(1);
});

test('an ordinary battle against one bot can be given up too', async ({ page }) => {
  const errors = await fresh(page, { confirmEnd: false });
  await page.evaluate(() => localStorage.setItem('infweb.setup', JSON.stringify({ players: ['human', 'dummy'], rev: 2, shuffle: false })));
  await page.reload();
  await page.getByRole('button', { name: /Быстрый старт/ }).click();
  await waitGame(page);
  await page.getByRole('button', { name: 'Пауза' }).click();
  await page.getByRole('button', { name: /Сдаться/ }).click();
  await page.locator('.modal').getByRole('button', { name: 'Сдаться' }).click();
  await expect(page.locator('.result-title')).toHaveText('Поражение', { timeout: 10_000 });
  await expectNoErrors(errors);
});
