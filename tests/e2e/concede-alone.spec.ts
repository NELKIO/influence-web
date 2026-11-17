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
  const selector = page.getByRole('group', { name: 'Кому передать территории?' });
  await expect(selector.getByRole('radio')).toHaveCount(6);
  await expect(selector.getByRole('radio', { name: 'Никому не передавать' })).toBeChecked();
  await selector.getByRole('radio', { name: /№4/ }).check();
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
  const selector = page.getByRole('group', { name: 'Кому передать территории?' });
  const nobody = selector.getByRole('radio', { name: 'Никому не передавать' });
  const recipient = selector.getByRole('radio', { name: /№3/ });
  await expect(selector.getByRole('radio')).toHaveCount(5);
  await expect(nobody).toBeChecked();
  await recipient.check();
  await page.getByRole('button', { name: 'Отмена' }).click();
  expect(await cells()).toEqual(before);
  await surrender.click();
  await expect(nobody).toBeChecked();
  await recipient.check();
  await surrender.click();
  expect(await cells()).toEqual(before.map(([owner, power]) => [owner === 0 ? 2 : owner, power]));
  expect(await page.evaluate(() => (window as any).__infweb.ctrl.state.current)).toBe(1);
});

test('the split choice deals crowded territories to both remaining players', async ({ page }) => {
  await fresh(page);
  await page.evaluate(() => localStorage.setItem('infweb.setup', JSON.stringify({ size: 'S', players: ['human', 'human', 'human'], crowded: true, rev: 2, shuffle: false })));
  await page.reload();
  await page.getByRole('button', { name: /Быстрый старт/ }).click();
  await waitGame(page);
  const cells = () => page.evaluate(() => (window as any).__infweb.ctrl.state.field.cells.map((c: { owner: number; power: number }) => [c.owner, c.power]) as number[][]);
  const before = await cells();
  await page.getByRole('button', { name: 'Пауза' }).click();
  const surrender = page.getByRole('button', { name: 'Сдаться', exact: true });
  await surrender.click();
  await page.getByRole('radio', { name: 'Случайно разделить между соперниками' }).check();
  await surrender.click();
  const after = await cells();
  const received = after.filter((_, i) => before[i][0] === 0);
  expect(new Set(received.map(([owner]) => owner))).toEqual(new Set([1, 2]));
  expect(Math.abs(received.filter(([owner]) => owner === 1).length * 2 - received.length)).toBeLessThanOrEqual(1);
  expect(after.map(([, power]) => power)).toEqual(before.map(([, power]) => power));
});

test('GOD takes the next move while the surrendering person watches; their loss is recorded once', async ({ page }) => {
  const errors = await fresh(page);
  await page.evaluate(() => localStorage.setItem('infweb.setup', JSON.stringify({ size: 'S', players: ['human', 'dummy'], rev: 2, shuffle: false })));
  await page.reload();
  await page.getByRole('button', { name: /Быстрый старт/ }).click();
  await waitGame(page);
  await page.getByRole('button', { name: 'Пауза' }).click();
  const surrender = page.getByRole('button', { name: 'Сдаться', exact: true });
  await surrender.click();
  await page.getByRole('radio', { name: 'Передать новому БОГУ' }).check();
  await surrender.click();
  await expect.poll(() => page.evaluate(() => {
    const c = (window as any).__infweb.ctrl;
    const s = c.state;
    return s.settings.players[0] === 'god' && c.localHumanSlot() === -1 && (s.turn > 0 || s.current !== 0 || !!s.ended);
  })).toBe(true);
  const records = await page.evaluate(() => JSON.parse(localStorage.getItem('infweb.stats')!).records);
  expect(records).toMatchObject([{ win: false }]);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('infweb.game') ?? 'null'))).toBeNull();
  await expectNoErrors(errors);
});

test('an ordinary battle against one bot can be given up too', async ({ page }) => {
  const errors = await fresh(page, { confirmEnd: false });
  await page.evaluate(() => localStorage.setItem('infweb.setup', JSON.stringify({ players: ['human', 'dummy'], rev: 2, shuffle: false })));
  await page.reload();
  await page.getByRole('button', { name: /Быстрый старт/ }).click();
  await waitGame(page);
  const cells = () => page.evaluate(() => (window as any).__infweb.ctrl.state.field.cells);
  const before = await cells();
  await page.getByRole('button', { name: 'Пауза' }).click();
  await page.getByRole('button', { name: /Сдаться/ }).click();
  await expect(page.getByRole('radio', { name: 'Никому не передавать' })).toBeChecked();
  await page.locator('.modal').getByRole('button', { name: 'Сдаться' }).click();
  await expect(page.locator('.result-title')).toHaveText('Поражение', { timeout: 10_000 });
  expect(await cells()).toEqual(before);
  await expectNoErrors(errors);
});
