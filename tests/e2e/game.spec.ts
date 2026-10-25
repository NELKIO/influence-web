import { expect, test } from '@playwright/test';
import { autoplay, expectNoErrors, fresh, waitGame } from './helpers';

test('quick start plays a full match to the result screen', async ({ page }) => {
  const errors = await fresh(page, { confirmEnd: false });
  await page.getByRole('button', { name: /Быстрый старт/ }).click();
  await expect(page.locator('canvas')).toBeVisible();
  await waitGame(page);
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
  await waitGame(page);
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
  await expect.poll(() => page.evaluate((t) => (window as any).__infweb.ctrl.state.field.cells[t].owner, pts.target)).toBe(0);
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
  await waitGame(page);
  // without darkness there is no full-screen hand-over, just a hint
  await expect(page.getByTestId('handover')).toHaveCount(0);
  await expect(page.locator('.hint')).toContainText('Ходит: Игрок 1');
  await autoplay(page);
  await expect(page.locator('.result-title')).toBeVisible({ timeout: 10_000 });
  await expectNoErrors(errors);
});

test('settings: language switch and persistence', async ({ page }) => {
  const errors = await fresh(page);
  await page.getByText('Настройки').click();
  await page.getByRole('radio', { name: 'EN' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  // a reload keeps the screen (its address) and the language
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await page.goto('./');
  await expect(page.getByRole('button', { name: 'New battle' })).toBeVisible();
  await expectNoErrors(errors);
});

test('end-turn button: real taps, confirmation only when attacks remain', async ({ page }, testInfo) => {
  const errors = await fresh(page, { confirmEnd: true });
  await page.evaluate(() =>
    localStorage.setItem(
      'infweb.setup',
      JSON.stringify({ size: 'S', players: ['human', 'dummy'], darkness: false, symmetry: true, crowded: false, unions: false, shuffle: false }),
    ),
  );
  await page.reload();
  await page.locator('.mode-card', { hasText: 'Быстрый старт' }).click();
  await waitGame(page);
  const press = async () => {
    const btn = page.locator('.end-btn');
    if (testInfo.project.name === 'desktop') await btn.click();
    else await btn.tap();
  };
  const phase = () => page.evaluate(() => (window as any).__infweb.ctrl.state.phase);

  // 1) attacks still possible -> confirmation dialog
  await press();
  await expect(page.locator('.modal h2')).toHaveText('Закончить атаку?');
  await page.locator('.modal').getByRole('button', { name: 'Отмена' }).click();
  expect(await phase()).toBe('attack');

  // 2) nothing can attack -> the tap ends the attack right away, no dialog
  await page.evaluate(() => {
    const c = (window as any).__infweb.ctrl;
    for (const cell of c.state.field.cells) if (cell.owner === 0) cell.power = 1;
    c.replaceState(c.state);
  });
  await expect(page.locator('.end-btn.pulse')).toBeVisible();
  await press();
  await expect.poll(phase).toBe('power');
  await expect(page.locator('.modal')).toHaveCount(0);

  // 3) "+N" -> confirmation -> power spread evenly and the turn passes
  await press();
  await expect(page.locator('.modal h2')).toContainText('Распределить');
  await page.locator('.modal').getByRole('button', { name: 'Завершить ход' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__infweb.ctrl.state.turn)).toBeGreaterThanOrEqual(1);
  await expectNoErrors(errors);
});

test('hot-seat in darkness: hand-over appears after power is placed by tapping cells', async ({ page }, testInfo) => {
  const errors = await fresh(page, { confirmEnd: false });
  await page.evaluate(() =>
    localStorage.setItem(
      'infweb.setup',
      JSON.stringify({ size: 'S', players: ['human', 'human'], darkness: true, symmetry: true, crowded: false, unions: false, shuffle: false }),
    ),
  );
  await page.reload();
  await page.locator('.mode-card', { hasText: 'Быстрый старт' }).click();
  await waitGame(page);
  const tapAt = async (x: number, y: number) => {
    if (testInfo.project.name === 'desktop') await page.mouse.click(x, y);
    else await page.touchscreen.tap(x, y);
  };
  // first hand-over: dismiss with a real tap
  await expect(page.getByTestId('handover')).toBeVisible();
  await tapAt(200, 400);
  await expect(page.getByTestId('handover')).toHaveCount(0);
  // end the attack, then place every power point by tapping own cells
  await page.locator('.end-btn').click();
  await expect.poll(() => page.evaluate(() => (window as any).__infweb.ctrl.state.phase)).toBe('power');
  for (let i = 0; i < 40; i++) {
    const p = await page.evaluate(() => {
      const { ctrl, renderer } = (window as any).__infweb;
      const s = ctrl.state;
      if (s.phase !== 'power' || s.current !== 0) return null;
      const cell = s.field.cells.findIndex((c: any) => c.owner === 0 && c.power < c.maxPower);
      const rect = renderer.canvas.getBoundingClientRect();
      const [x, y] = renderer.cellScreenPos(cell);
      return [x + rect.left, y + rect.top];
    });
    if (!p) break;
    await tapAt(p[0], p[1]);
  }
  // the hand-over for player 2 must appear and stay until a separate tap
  await expect(page.getByTestId('handover')).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.getByTestId('handover')).toBeVisible();
  await expect(page.getByTestId('handover')).toContainText('Игрок 2');
  await expectNoErrors(errors);
});

test('camera stays put while selecting cells, hovering and confirming', async ({ page }) => {
  const errors = await fresh(page, { confirmEnd: true });
  await page.evaluate(() =>
    localStorage.setItem(
      'infweb.setup',
      JSON.stringify({ size: 'M', players: ['human', 'hunter', 'dummy', 'freak'], darkness: false, symmetry: true, crowded: false, unions: false, shuffle: false }),
    ),
  );
  await page.reload();
  await page.locator('.mode-card', { hasText: 'Быстрый старт' }).click();
  await waitGame(page);
  await page.waitForTimeout(500);
  const cam = () =>
    page.evaluate(() => {
      const r = (window as any).__infweb.renderer;
      return [r.scale, r.camX, r.camY].map((v: number) => v.toFixed(3)).join(',');
    });
  const before = await cam();
  const pos = (sel: string) =>
    page.evaluate((which) => {
      const { ctrl, renderer } = (window as any).__infweb;
      const s = ctrl.state;
      const mine = s.field.cells.findIndex((c: any) => c.owner === 0);
      const target = s.field.adj[mine][0];
      const rect = renderer.canvas.getBoundingClientRect();
      const [x, y] = renderer.cellScreenPos(which === 'mine' ? mine : target);
      return [x + rect.left, y + rect.top];
    }, sel);
  const [mx, my] = await pos('mine');
  const [tx, ty] = await pos('target');
  for (let k = 0; k < 3; k++) {
    await page.mouse.click(mx, my); // select
    await page.mouse.move(tx, ty); // hover a target -> chance hint
    await page.waitForTimeout(250);
    await page.mouse.move(mx + 200, my + 200);
    await page.locator('.end-btn').click(); // confirmation dialog
    await page.locator('.modal').getByRole('button', { name: 'Отмена' }).click();
    await page.waitForTimeout(250);
    expect(await cam()).toBe(before);
  }
  await expectNoErrors(errors);
});

test('settings show anonymous site counters; nothing is counted outside the real site', async ({ page }) => {
  const hits: string[] = [];
  const errors = await fresh(page);
  // registered after the default stub, so this handler wins
  await page.route('**/abacus.jasoncameron.dev/**', (r) => {
    const url = r.request().url();
    if (url.includes('/hit/')) hits.push(url);
    const value = url.endsWith('/opens') ? 12345 : url.endsWith('/visitors') ? 678 : 9012;
    return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ value }) });
  });
  await page.reload();
  await page.locator('.menu-links button', { hasText: 'Настройки' }).click();
  const block = page.getByTestId('site-stats');
  await expect(block).toContainText(/12\s?345/);
  await expect(block).toContainText('678');
  await expect(block).toContainText(/9\s?012/);
  expect(hits).toEqual([]);
  await expectNoErrors(errors);
});
