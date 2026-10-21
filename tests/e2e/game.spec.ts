import { expect, test } from '@playwright/test';
import { autoplay, expectNoErrors, fresh, waitGame } from './helpers';

test('quick start plays a full match to the result screen', async ({ page }) => {
  const errors = await fresh(page, { confirmEnd: false });
  await page.getByRole('button', { name: /Быстрый старт/ }).click();
  await expect(page.locator('canvas')).toBeVisible();
  await autoplay(page);
  await expect(page.locator('.result-title')).toBeVisible({ timeout: 10_000 });
  // stats were recorded
  await page.locator('.modal').getByRole('button', { name: /В меню/ }).click();
  await page.getByText('Статистика').click();
  await expect(page.getByText('Последние партии')).toBeVisible();
  await expectNoErrors(errors);
});

test('battle setup: size, players, modes and a real canvas attack', async ({ page }) => {
  const errors = await fresh(page);
  await page.getByRole('button', { name: 'Новая битва' }).click();
  await page.getByRole('button', { name: /^S/ }).click();
  await page.locator('.steps button').nth(1).click();
  // remove the last opponent, set the remaining to Hunter
  await page.getByRole('button', { name: 'Убрать' }).click();
  await page.getByRole('button', { name: 'Убрать' }).click();
  await page.locator('.type-pick').first().getByRole('button', { name: 'Охотник' }).click();
  await page.locator('.steps button').nth(2).click();
  await page.getByRole('switch').first().click(); // darkness
  await page.getByRole('button', { name: /В бой/ }).click();
  await expect(page.locator('canvas')).toBeVisible();
  const info = await page.evaluate(() => {
    const { ctrl } = (window as any).__infweb;
    const s = ctrl.state;
    return { size: s.settings.size, players: s.settings.players, darkness: s.settings.darkness };
  });
  expect(info).toEqual({ size: 'S', players: ['human', 'hunter'], darkness: true });

  // tap own cell and a neutral neighbour through the canvas
  const pts = await page.evaluate(() => {
    const { ctrl, renderer } = (window as any).__infweb;
    const s = ctrl.state;
    const mine = s.field.cells.findIndex((c: any) => c.owner === 0);
    const target = s.field.adj[mine].find((n: number) => s.field.cells[n].owner === -1);
    const rect = renderer.canvas.getBoundingClientRect();
    const a = renderer.cellScreenPos(mine);
    const b = renderer.cellScreenPos(target);
    return { a: [a[0] + rect.left, a[1] + rect.top], b: [b[0] + rect.left, b[1] + rect.top], target };
  });
  await page.mouse.click(pts.a[0], pts.a[1]);
  await page.mouse.click(pts.b[0], pts.b[1]);
  const owner = await page.evaluate((t) => (window as any).__infweb.ctrl.state.field.cells[t].owner, pts.target);
  expect(owner).toBe(0);
  await expectNoErrors(errors);
});

test('hot-seat: hand-over screen between two humans', async ({ page }) => {
  const errors = await fresh(page, { confirmEnd: false });
  await page.evaluate(() =>
    localStorage.setItem(
      'infweb.setup',
      JSON.stringify({ size: 'S', players: ['human', 'human', 'dummy'], darkness: true, symmetry: true, crowded: false, unions: false, shuffle: false }),
    ),
  );
  await page.reload();
  await page.getByRole('button', { name: /Быстрый старт/ }).click();
  await expect(page.getByText('Передайте устройство')).toBeVisible();
  await page.getByText('Нажмите, когда будете готовы').click();
  await expect(page.getByText('Передайте устройство')).toBeHidden();
  // end player 1's turn -> hand-over for player 2
  await page.evaluate(() => {
    const c = (window as any).__infweb.ctrl;
    c.endButton(true);
    c.endButton(true);
  });
  await expect(page.getByText('Ходит: Игрок 2')).toBeVisible();
  await autoplay(page);
  await expect(page.locator('.result-title')).toBeVisible({ timeout: 10_000 });
  await expectNoErrors(errors);
});

test('pause, menu and continue restore the match', async ({ page }) => {
  const errors = await fresh(page);
  await page.getByRole('button', { name: /Быстрый старт/ }).click();
  await waitGame(page);
  const seed = await page.evaluate(() => (window as any).__infweb.ctrl.state.seed);
  await page.getByRole('button', { name: 'Пауза' }).click();
  await page.getByRole('button', { name: /В меню/ }).click();
  await page.getByRole('button', { name: /Продолжить/ }).click();
  await waitGame(page);
  const seed2 = await page.evaluate(() => (window as any).__infweb.ctrl.state.seed);
  expect(seed2).toBe(seed);
  // restart on the same map keeps the field
  const field = await page.evaluate(() => JSON.stringify((window as any).__infweb.ctrl.state.field.adj));
  await page.getByRole('button', { name: 'Пауза' }).click();
  await page.getByRole('button', { name: /Заново на этой карте/ }).click();
  await waitGame(page);
  const field2 = await page.evaluate(() => JSON.stringify((window as any).__infweb.ctrl.state.field.adj));
  expect(field2).toBe(field);
  await expectNoErrors(errors);
});

test('daily map: same map on replay, result stored', async ({ page }) => {
  const errors = await fresh(page, { confirmEnd: false });
  await page.locator('.mode-card', { hasText: 'Карта дня' }).click();
  await page.getByRole('button', { name: /Играть/ }).click();
  await waitGame(page);
  const a = await page.evaluate(() => JSON.stringify((window as any).__infweb.ctrl.state.field));
  await autoplay(page);
  await expect(page.locator('.result-title')).toBeVisible({ timeout: 10_000 });
  await page.locator('.modal').getByRole('button', { name: /Ещё попытка/ }).click();
  await page.waitForFunction(() => (window as any).__infweb?.ctrl?.state && !(window as any).__infweb.ctrl.state.ended);
  const b = await page.evaluate(() => JSON.stringify((window as any).__infweb.ctrl.state.field));
  expect(JSON.parse(b).adj).toEqual(JSON.parse(a).adj);
  await page.getByRole('button', { name: 'Пауза' }).click();
  await page.getByRole('button', { name: /В меню/ }).click();
  await page.locator('.mode-card', { hasText: 'Карта дня' }).click();
  await expect(page.getByText(/Попыток: 1/)).toBeVisible();
  await expectNoErrors(errors);
});

test('duel training and local duel use duel rules', async ({ page }) => {
  const errors = await fresh(page, { confirmEnd: false });
  await page.getByRole('button', { name: /Дуэли/ }).click();
  await page.getByText('Тренировка с ботом').click();
  await waitGame(page);
  const st = await page.evaluate(() => (window as any).__infweb.ctrl.state.settings);
  expect(st.duelRules).toBe(true);
  expect(st.players).toContain('duelHunter');
  await autoplay(page);
  await expect(page.locator('.result-title')).toBeVisible({ timeout: 10_000 });
  await page.locator('.modal').getByRole('button', { name: /В меню/ }).click();
  await page.getByRole('button', { name: /Дуэли/ }).click();
  await page.getByText('Вдвоём на одном устройстве').click();
  await expect(page.getByText('Передайте устройство')).toBeVisible();
  await autoplay(page);
  await expect(page.locator('.result-title')).toBeVisible({ timeout: 10_000 });
  await expectNoErrors(errors);
});

test('settings: language switch and persistence', async ({ page }) => {
  const errors = await fresh(page);
  await page.getByText('Настройки').click();
  await page.getByRole('radio', { name: 'EN' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'New battle' })).toBeVisible();
  await expectNoErrors(errors);
});
