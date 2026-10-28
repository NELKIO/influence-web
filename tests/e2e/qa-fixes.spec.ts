import { expect, test, type Page } from '@playwright/test';
import { autoplay, expectNoErrors, fresh, waitGame } from './helpers';

const records = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('infweb.stats') ?? '{}').records ?? []);

test('a local duel finished early with both people level is a draw, not "the bots won"', async ({ page }) => {
  const errors = await fresh(page, { confirmEnd: false });
  await page.getByRole('button', { name: /Дуэли/ }).click();
  await page.getByText('Вдвоём на одном устройстве').click();
  await waitGame(page);
  // a saturated board split evenly between the two people, late in the match
  await page.evaluate(() => {
    const c = (window as any).__infweb.ctrl;
    const s = c.state;
    if (c.overlay.kind === 'handover') c.dismissHandover();
    const n = s.field.cells.length;
    s.field.cells.forEach((cell: any, i: number) => {
      cell.owner = i < Math.floor(n / 2) ? 0 : i < 2 * Math.floor(n / 2) ? 1 : -1;
      cell.power = cell.owner >= 0 ? cell.maxPower : 0;
    });
    s.turn = 200;
    s.lastStuck = -100;
    s.current = 0;
    s.phase = 'attack';
    c.stuckChecked = -1;
    c.overlay = { kind: 'none' };
    c.start();
  });
  const modal = page.locator('.modal');
  await expect(modal).toContainText('ничья');
  await expect(modal).not.toContainText('поражени');
  await modal.getByRole('button', { name: 'Закончить' }).click();
  await expect(page.locator('.result-title')).toHaveText('Ничья');
  await expect(page.getByTestId('draw-note')).toBeVisible();
  await expect(page.locator('.modal')).not.toContainText('Победили боты');
  // a duel result: the new match button says what it starts
  await expect(page.locator('.modal').getByRole('button', { name: 'Новая дуэль' })).toBeVisible();
  const rec = await records(page);
  expect(rec).toHaveLength(1);
  expect(rec[0].win).toBe(false);
  await expectNoErrors(errors);
});

test('map of the day: an unfinished attempt is continued; another attempt keeps the map with fresh dice; one retry action', async ({ page }) => {
  const errors = await fresh(page, { confirmEnd: false });
  await page.locator('.mode-card', { hasText: 'Карта дня' }).click();
  await page.getByRole('button', { name: 'Играть' }).click();
  await waitGame(page);
  const first = await page.evaluate(() => {
    const s = (window as any).__infweb.ctrl.state;
    return { adj: JSON.stringify(s.field.adj), rng: JSON.stringify(s.rng), startedAt: s.startedAt };
  });
  await page.getByRole('button', { name: 'Пауза' }).click();
  await page.getByRole('button', { name: /В меню/ }).click();
  await page.locator('.mode-card', { hasText: 'Карта дня' }).click();
  // the saved attempt is resumed by the button, and the button says so
  await page.getByRole('button', { name: 'Продолжить' }).click();
  await waitGame(page);
  expect(await page.evaluate(() => (window as any).__infweb.ctrl.state.startedAt)).toBe(first.startedAt);
  await autoplay(page);
  await expect(page.locator('.result-title')).toBeVisible({ timeout: 15_000 });
  const modal = page.locator('.modal');
  await expect(modal.getByRole('button', { name: /Ещё попытка/ })).toBeVisible();
  await expect(modal.getByRole('button', { name: /Заново/ })).toHaveCount(0);
  await modal.getByRole('button', { name: /Ещё попытка/ }).click();
  await page.waitForFunction((t) => {
    const s = (window as any).__infweb?.ctrl?.state;
    return s && !s.ended && s.startedAt !== t;
  }, first.startedAt);
  const second = await page.evaluate(() => {
    const s = (window as any).__infweb.ctrl.state;
    return { adj: JSON.stringify(s.field.adj), rng: JSON.stringify(s.rng) };
  });
  expect(second.adj).toBe(first.adj);
  expect(second.rng).not.toBe(first.rng);
  await expectNoErrors(errors);
});

test('"restart on this map" keeps the map and the starts and rolls new dice', async ({ page }) => {
  const errors = await fresh(page);
  await page.getByRole('button', { name: /Быстрый старт/ }).click();
  await waitGame(page);
  const snap = () =>
    page.evaluate(() => {
      const s = (window as any).__infweb.ctrl.state;
      return { field: JSON.stringify(s.field), rng: JSON.stringify(s.rng) };
    });
  const a = await snap();
  const rngs = new Set([a.rng]);
  for (let k = 0; k < 2; k++) {
    await page.getByRole('button', { name: 'Пауза' }).click();
    await page.getByRole('button', { name: /Заново на этой карте/ }).click();
    await page.waitForTimeout(200);
    await waitGame(page);
    const b = await snap();
    expect(b.field).toBe(a.field);
    rngs.add(b.rng);
  }
  expect(rngs.size).toBe(3);
  await expectNoErrors(errors);
});

test('"don\'t ask again" ticked and then cancelled is forgotten', async ({ page }) => {
  const errors = await fresh(page, { confirmEnd: true });
  await page.getByRole('button', { name: /Быстрый старт/ }).click();
  await waitGame(page);
  await page.locator('.end-btn').click();
  const box = page.locator('.modal input[type=checkbox]');
  await box.check();
  await page.locator('.modal').getByRole('button', { name: 'Отмена' }).click();
  await page.locator('.end-btn').click();
  await expect(box).not.toBeChecked();
  await page.locator('.modal').getByRole('button', { name: 'Завершить атаку' }).click();
  const confirm = await page.evaluate(() => JSON.parse(localStorage.getItem('infweb.settings') ?? '{}').confirmEnd);
  expect(confirm).not.toBe(false);
  await expectNoErrors(errors);
});

test('the settings name the confirmation for what it does', async ({ page }) => {
  const errors = await fresh(page);
  await page.locator('.menu-links button').nth(1).click();
  await expect(page.locator('.topbar h1')).toHaveText('Настройки');
  await expect(page.getByText('Подтверждать завершение хода')).toBeVisible();
  await expect(page.getByText('Подтверждать досрочное завершение')).toHaveCount(0);
  await expectNoErrors(errors);
});

test('watching the bots at instant speed has no speed button (it would do nothing)', async ({ page }) => {
  const errors = await fresh(page, { confirmEnd: false, speed: 'instant' });
  await page.evaluate(() =>
    localStorage.setItem(
      'infweb.setup',
      JSON.stringify({ size: 'S', players: ['human', 'hunter', 'hunter'], darkness: false, symmetry: true, crowded: false, unions: false, shuffle: false, rev: 2 }),
    ),
  );
  await page.reload();
  await page.getByRole('button', { name: /Быстрый старт/ }).click();
  await waitGame(page);
  await page.evaluate(() => (window as any).__infweb.ctrl.concedeMatch());
  // at instant speed the whole fight runs in one go: hold it the moment the watching screen hands out its controller
  await page.evaluate(() => {
    let v: any;
    Object.defineProperty(Window.prototype, '__infweb', {
      configurable: true,
      get: () => v,
      set: (x: any) => {
        v = x;
        if (x?.ctrl?.state?.settings?.spectate) x.ctrl.pause();
      },
    });
  });
  await page.getByTestId('watch-bots').click();
  await page.waitForFunction(() => (window as any).__infweb?.ctrl?.state?.settings?.spectate > 0);
  expect(await page.evaluate(() => (window as any).__infweb.ctrl.state.ended)).toBeNull();
  await expect(page.locator('.hud-bottom .status .text')).toBeVisible();
  await expect(page.locator('.speed-btn')).toHaveCount(0);
  // two hunters: each one has its own name
  await expect(page.locator('.pchip .nm')).toHaveText(['Вы', 'Охотник 1', 'Охотник 2']);
  await expectNoErrors(errors);
});
