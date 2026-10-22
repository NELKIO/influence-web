import { expect, test, type Page } from '@playwright/test';
import { expectNoErrors, fresh, waitGame } from './helpers';

async function openSetup(page: Page) {
  await page.getByRole('button', { name: 'Новая битва' }).click();
  await expect(page.locator('.puzzle-grid')).toBeVisible();
}

const gameInfo = (page: Page) =>
  page.evaluate(() => {
    const s = (window as any).__infweb.ctrl.state;
    return {
      puzzle: s.settings.puzzle ?? null,
      players: s.settings.players,
      darkness: s.settings.darkness,
      unions: s.settings.unions,
      size: s.settings.size,
      cells: s.field.cells.length,
    };
  });

test('a scenario is selected, not started: seats are fixed, a bot level can be changed, start plays it', async ({ page }) => {
  const errors = await fresh(page);
  await openSetup(page);
  await page.locator('[data-scenario="olympus"]').click();
  // still on the setup screen, with the scenario shown on top and the size picker gone
  await expect(page.getByTestId('scenario-pick')).toContainText('Олимп');
  await expect(page.getByTestId('scenario-pick')).toContainText('6 игроков');
  await expect(page.locator('[data-scenario="olympus"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.size-grid')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Другая карта' })).toHaveCount(0);

  await page.locator('.steps button').nth(1).click();
  await expect(page.locator('.player-row')).toHaveCount(6);
  await expect(page.getByRole('button', { name: 'Добавить соперника' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Убрать' })).toHaveCount(0);
  // the designed level is marked; switch seat 2 from it to Master
  await expect(page.locator('.type-pick').first().locator('button.rec')).toHaveText('Охотник');
  await page.locator('.type-pick').first().getByRole('button', { name: 'Мастер' }).click();

  // the choice is remembered
  await page.getByRole('button', { name: 'back' }).click();
  await openSetup(page);
  await expect(page.getByTestId('scenario-pick')).toContainText('Олимп');
  await page.locator('.steps button').nth(1).click();
  await expect(page.locator('.type-pick').first().locator('button.on')).toHaveText('Мастер');

  await page.getByRole('button', { name: /^В бой/ }).first().click();
  await waitGame(page);
  const info = await gameInfo(page);
  expect(info.puzzle).toBe('olympus');
  expect(info.players).toEqual(['human', 'master', 'dummy', 'master', 'dummy', 'hunter']);
  expect(info.darkness).toBe(false);
  await expectNoErrors(errors);
});

test('a scenario locks the modes', async ({ page }) => {
  const errors = await fresh(page);
  await openSetup(page);
  await page.locator('[data-scenario="titans"]').click();
  await page.locator('.steps button').nth(2).click();
  await expect(page.locator('.locked-note')).toContainText('Режимы задаёт сценарий «Меж двух титанов»');
  const switches = page.getByRole('switch');
  await expect(switches).toHaveCount(4);
  for (let i = 0; i < 4; i++) await expect(switches.nth(i)).toBeDisabled();
  // darkness off, symmetry off, crowded off, unions on
  await expect(switches.nth(0)).toHaveAttribute('aria-checked', 'false');
  await expect(switches.nth(3)).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('button', { name: /В бой · 3 игрока/ }).click();
  await waitGame(page);
  const info = await gameInfo(page);
  expect(info).toMatchObject({ puzzle: 'titans', unions: true, darkness: false, players: ['human', 'hunter', 'hunter'] });
  await expectNoErrors(errors);
});

test('deselecting a scenario brings back ordinary maps', async ({ page }) => {
  const errors = await fresh(page);
  await openSetup(page);
  await page.locator('[data-scenario="laststand"]').click();
  await expect(page.getByTestId('scenario-pick')).toBeVisible();
  await page.getByRole('button', { name: 'Обычная карта' }).click();
  await expect(page.getByTestId('scenario-pick')).toHaveCount(0);
  await expect(page.locator('.size-grid')).toBeVisible();
  await expect(page.locator('.puzzle-card.on')).toHaveCount(0);
  await page.getByRole('button', { name: /^S/ }).click();
  await page.locator('.steps button').nth(1).click();
  await expect(page.getByRole('button', { name: 'Добавить соперника' })).toBeVisible();
  await page.locator('.steps button').nth(2).click();
  for (let i = 0; i < 4; i++) await expect(page.getByRole('switch').nth(i)).toBeEnabled();
  await page.getByRole('button', { name: /В бой/ }).click();
  await waitGame(page);
  const info = await gameInfo(page);
  expect(info.puzzle).toBeNull();
  expect(info.size).toBe('S');
  await expectNoErrors(errors);
});

test('night drop starts in darkness at a random spot; quick start and hot-seat hand-over work', async ({ page }) => {
  const errors = await fresh(page, { confirmEnd: false });
  await openSetup(page);
  await page.locator('[data-scenario="landing"]').click();
  // the preview gives nobody away
  await expect(page.getByTestId('scenario-pick')).toContainText('Тьма');
  await expect(page.getByTestId('scenario-pick').locator('polygon[fill^="var(--p"]')).toHaveCount(0);
  await page.getByRole('button', { name: /^В бой/ }).first().click();
  await waitGame(page);
  const first = await page.evaluate(() => {
    const { ctrl } = (window as any).__infweb;
    const s = ctrl.state;
    const own = s.field.cells.findIndex((c: any) => c.owner === 0);
    return { size: s.settings.size, darkness: s.settings.darkness, cells: s.field.cells.length, own, seats: s.settings.players.length };
  });
  expect(first).toMatchObject({ size: 'XL', darkness: true, seats: 6 });
  expect(first.cells).toBeGreaterThan(150);
  await expect(page.locator('.hint', { hasText: 'Десант во тьме' })).toBeVisible();

  // back to the menu: quick start plays the same scenario, dropped somewhere else
  await page.evaluate(() => localStorage.removeItem('infweb.game'));
  await page.goto('./');
  await expect(page.getByText('Десант во тьме')).toBeVisible();
  const spots = new Set([first.own]);
  for (let i = 0; i < 3; i++) {
    await page.locator('.mode-card', { hasText: 'Быстрый старт' }).click();
    await waitGame(page);
    const info = await page.evaluate(() => {
      const s = (window as any).__infweb.ctrl.state;
      return { puzzle: s.settings.puzzle, own: s.field.cells.findIndex((c: any) => c.owner === 0) };
    });
    expect(info.puzzle).toBe('landing');
    spots.add(info.own);
    await page.evaluate(() => {
      localStorage.removeItem('infweb.game');
      (window as any).__infweb = undefined;
    });
    await page.goto('./');
  }
  expect(spots.size).toBeGreaterThan(1);

  // a second person on this device: the hand-over screen hides the board between turns
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('infweb.setup')!);
    s.scenarioSeats = { landing: ['human', 'human', 'dummy', 'dummy', 'dummy', 'dummy'] };
    localStorage.setItem('infweb.setup', JSON.stringify(s));
  });
  await page.reload();
  await page.locator('.mode-card', { hasText: 'Быстрый старт' }).click();
  await waitGame(page);
  await expect(page.getByTestId('handover')).toBeVisible();
  await page.getByTestId('handover').click();
  await expect(page.getByTestId('handover')).toHaveCount(0);
  await page.evaluate(() => {
    const c = (window as any).__infweb.ctrl;
    c.endButton(true);
    c.endButton(true);
  });
  await expect(page.getByTestId('handover')).toContainText('Игрок 2');
  await expectNoErrors(errors);
});
