import { expect, test } from '@playwright/test';
import { fresh, waitGame, expectNoErrors } from './helpers';

test('gallery leads with Night Drop and the new maps, hiding both scout maps', async ({ page }) => {
  const errors = await fresh(page);
  await page.getByRole('button', { name: 'Новая битва' }).click();
  const cards = page.locator('.puzzle-grid [data-scenario]');
  await expect(cards).toHaveCount(32);
  const order = await cards.evaluateAll(nodes => nodes.map(n => n.getAttribute('data-scenario')));
  expect(order[0]).toBe('landing');
  expect(new Set(order.slice(1, 5))).toEqual(new Set(['moonvale', 'fireflies', 'crossroads', 'highlands']));
  // the gallery has two sections: maps that change each launch first, then the fixed puzzles, which the
  // new fixed maps lead
  const fixed = await page.locator('.puzzle-grid [data-scenario][data-section="fixed"]').evaluateAll(nodes => nodes.map(n => n.getAttribute('data-scenario')));
  expect(new Set(fixed.slice(0, 2))).toEqual(new Set(['farshore', 'pinwheel']));
  for (const id of ['colonies', 'sparks']) expect(order.indexOf(id)).toBeLessThan(order.indexOf(fixed[0]!));
  expect(order).not.toContain('thermopylae');
  await expect(page.locator('[data-scenario="colonies"]')).toContainText('Колонии');
  for (const id of ['moonvale', 'fireflies']) {
    const card = page.locator(`[data-scenario="${id}"]`);
    await expect(card.locator('[data-unknown-map]')).toBeVisible();
    await card.click();
    const picked = page.getByTestId('scenario-pick');
    await expect(picked.locator('[data-unknown-map]')).toBeVisible();
    await expect(picked).not.toContainText(/\d+ клет/);
  }
  await page.getByRole('button', { name: /^В бой/ }).first().click();
  await waitGame(page);
  expect(await page.evaluate(() => {
    const { ctrl } = (window as any).__infweb;
    const known = ctrl.view().known;
    return ctrl.state.settings.blind && known.some(Boolean) && !known.every(Boolean);
  })).toBe(true);
  await expectNoErrors(errors);
});

test('a saved Thermopylae game remains named and playable after leaving the gallery', async ({ page }) => {
  const errors = await fresh(page);
  await page.getByRole('button', { name: /Быстрый старт/ }).click();
  await waitGame(page);
  await page.evaluate(() => {
    const { ctrl } = (window as any).__infweb;
    const state = structuredClone(ctrl.state);
    state.settings.puzzle = 'thermopylae';
    localStorage.setItem('infweb.game', JSON.stringify({ state, initial: state }));
  });
  await page.goto('./');
  const saved = page.locator('.play-btn.cont');
  await expect(saved).toContainText('Фермопилы');
  await saved.click();
  await waitGame(page);
  expect(await page.evaluate(() => (window as any).__infweb.ctrl.state.settings.puzzle)).toBe('thermopylae');
  await expectNoErrors(errors);
});

test('the frontier option is not offered in local or online duels', async ({ page }) => {
  const errors = await fresh(page, {}, './?transport=bc');
  await page.getByRole('button', { name: /Дуэли/ }).click();
  const option = page.getByRole('switch', { name: 'Победа по рубежам', exact: true });
  const fire = page.getByRole('switch', { name: 'Сигнальные огни', exact: true });
  await expect(fire).toBeVisible();
  await expect(option).toHaveCount(0);
  await page.getByText('Онлайн с другом').click();
  await expect(fire).toBeVisible();
  await expect(option).toHaveCount(0);
  await expectNoErrors(errors);
});

test('generated frontier mode is opt-in and starts the three points from its map preview', async ({ page }) => {
  const errors = await fresh(page);
  await page.getByRole('button', { name: 'Новая битва' }).click();
  const map = page.locator('.steps button').nth(0);
  const modes = page.locator('.steps button').nth(2);
  const preview = page.locator('.map-preview');
  const points = preview.locator('[data-objective]');
  const option = page.getByRole('switch', { name: 'Победа по рубежам', exact: true });
  await expect(points).toHaveCount(0);
  await modes.click();
  await expect(option).not.toBeChecked();
  await option.click();
  await page.reload();
  await expect(points).toHaveCount(3);
  await modes.click();
  await expect(option).toBeChecked();
  await page.getByRole('switch', { name: 'Абсолютная тьма' }).click();
  await map.click();
  await expect(preview.locator('[data-unknown-map]')).toBeVisible();
  await expect(points).toHaveCount(0);
  await modes.click();
  await page.getByRole('switch', { name: 'Тьма', exact: true }).click();
  await expect(option).toBeChecked();
  await map.click();
  await preview.getByRole('button', { name: 'Другая карта' }).click();
  await expect(points).toHaveCount(3);
  const marks = await points.evaluateAll(nodes => nodes.map(n => Number(n.getAttribute('data-objective'))));
  await page.getByRole('button', { name: /^В бой/ }).first().click();
  await waitGame(page);
  const actual = await page.evaluate(() => {
    const s = (window as any).__infweb.ctrl.state;
    return { scenario: s.settings.puzzle ?? null, marks: s.objectives };
  });
  expect(actual).toEqual({ scenario: null, marks });
  await expectNoErrors(errors);
});

test('frontier sliders set the points and the win requirement of the match that starts', async ({ page }) => {
  const errors = await fresh(page);
  await page.getByRole('button', { name: 'Новая битва' }).click();
  const modes = page.locator('.steps button').nth(2);
  const points = page.locator('.map-preview [data-objective]');
  const count = page.getByRole('slider', { name: 'Контрольные точки' });
  const need = page.getByRole('slider', { name: 'Нужно для победы' });
  await modes.click();
  // the sliders belong to the switched-on mode only
  await expect(count).toHaveCount(0);
  await page.getByRole('switch', { name: 'Победа по рубежам', exact: true }).click();
  await expect(count).toHaveValue('3');
  await expect(need).toHaveValue('2');
  await expect(need).toHaveAttribute('max', '3');
  // the requirement follows the majority of the count
  await count.fill('6');
  await expect(need).toHaveValue('4');
  await expect(need).toHaveAttribute('max', '6');
  await count.fill('9');
  await expect(need).toHaveValue('5');
  await expect(page.getByText('Рубежей на карте: 9. Захватите 5')).toBeVisible();
  // a chosen requirement stays, and is cut when the count drops below it
  await need.fill('8');
  await count.fill('7');
  await expect(need).toHaveValue('7');
  await count.fill('5');
  await expect(need).toHaveValue('5');
  await need.fill('2');
  await count.fill('8');
  await expect(need).toHaveValue('2');
  // keyboard works like any range
  await need.focus();
  await page.keyboard.press('ArrowRight');
  await expect(need).toHaveValue('3');
  await page.reload();
  await modes.click();
  await expect(count).toHaveValue('8');
  await expect(need).toHaveValue('3');
  await page.locator('.steps button').nth(0).click();
  await expect(points).toHaveCount(8);
  const marks = await points.evaluateAll(nodes => nodes.map(n => Number(n.getAttribute('data-objective'))));
  await page.getByRole('button', { name: /^В бой/ }).first().click();
  await waitGame(page);
  const actual = await page.evaluate(() => {
    const s = (window as any).__infweb.ctrl.state;
    return { marks: s.objectives, n: s.settings.frontierPointCount, k: s.settings.frontierWinCount };
  });
  expect(actual).toEqual({ marks, n: 8, k: 3 });
  await expect(page.getByTestId('objective-hud')).toContainText('0/8');
  await expect(page.getByTestId('objective-hud')).toContainText('удержите 3');
  await expectNoErrors(errors);
});

for (const scenario of ['crossroads', 'highlands']) {
  test(`reroll ${scenario}: the selected preview is the position actually played and saved`, async ({ page }) => {
    const errors = await fresh(page);
    await page.getByRole('button', { name: 'Новая битва' }).click();
    for (const id of ['bridges', 'treasury', 'hourglass']) await expect(page.locator(`[data-scenario="${id}"]`)).toHaveCount(0);
    await expect(page.locator('[data-scenario]')).toHaveCount(32);
    await page.locator(`[data-scenario="${scenario}"]`).click();
    const card = page.getByTestId('scenario-pick');
    const svg = card.locator('svg').first();
    const before = await svg.innerHTML();
    await card.getByRole('button', { name: 'Другая карта' }).click();
    await expect.poll(() => svg.innerHTML()).not.toBe(before);
    const marks = await svg.locator('[data-objective]').evaluateAll(nodes => nodes.map(n => Number(n.getAttribute('data-objective'))));
    expect(marks).toHaveLength(3);
    const owners = await svg.locator('polygon:not([data-objective])').evaluateAll(nodes => nodes.map(n => Number(/var\(--p(\d+)\)/.exec(n.getAttribute('fill')!)?.[1] ?? -1)));
    await page.getByRole('button', { name: /^В бой/ }).first().click();
    await waitGame(page);
    const position = () => page.evaluate(() => {
      const s = (window as any).__infweb.ctrl.state;
      return { scenario: s.settings.puzzle, marks: s.objectives, owners: s.field.cells.map((c: { owner: number }) => c.owner) };
    });
    expect(await position()).toEqual({ scenario, marks, owners });
    await page.reload();
    await page.locator('.play-btn.cont').click();
    await waitGame(page);
    expect(await position()).toEqual({ scenario, marks, owners });
    await expectNoErrors(errors);
  });
}
