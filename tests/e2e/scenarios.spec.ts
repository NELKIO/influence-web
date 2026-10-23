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
  // the designed level is marked; switch seat 2 from it to Hunter
  await expect(page.locator('.type-pick').first().locator('button.rec')).toHaveText('Мастер');
  await page.locator('.type-pick').first().getByRole('button', { name: 'Охотник' }).click();

  // the choice is remembered
  await page.getByRole('button', { name: 'back' }).click();
  await openSetup(page);
  await expect(page.getByTestId('scenario-pick')).toContainText('Олимп');
  await page.locator('.steps button').nth(1).click();
  await expect(page.locator('.type-pick').first().locator('button.on')).toHaveText('Охотник');

  await page.getByRole('button', { name: /^В бой/ }).first().click();
  await waitGame(page);
  const info = await gameInfo(page);
  expect(info.puzzle).toBe('olympus');
  expect(info.players).toEqual(['human', 'hunter', 'hunter', 'god', 'hunter', 'master']);
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
  expect(info).toMatchObject({ puzzle: 'titans', unions: true, darkness: false, players: ['human', 'master', 'master'] });
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

/** Seen cells of a seat (exploration fog) and how many cells the board drew in its last frame. */
const fogInfo = (page: Page, seat: number) =>
  page.evaluate((seat) => {
    const { ctrl, renderer } = (window as any).__infweb;
    const s = ctrl.state;
    const row: string = s.explored?.[seat] ?? '';
    const seen = [...row].flatMap((ch, i) => (ch === '1' ? [i] : []));
    return { seen, drawn: renderer.drawnCells, total: s.field.cells.length, viewer: s.viewer };
  }, seat);

test('night drop: the board draws only the land you have seen', async ({ page }) => {
  const errors = await fresh(page, { confirmEnd: false });
  await openSetup(page);
  await page.locator('[data-scenario="landing"]').click();
  // neither the preview nor the card shows the shape of the map
  await expect(page.getByTestId('scenario-pick').locator('[data-unknown-map]')).toHaveCount(1);
  await expect(page.locator('[data-scenario="landing"] [data-unknown-map]')).toHaveCount(1);
  await expect(page.getByTestId('scenario-pick')).toContainText('Неизведанная карта');
  await page.getByRole('button', { name: /^В бой/ }).first().click();
  await waitGame(page);
  const start = await fogInfo(page, 0);
  expect(start.seen.length).toBeGreaterThan(3);
  expect(start.seen.length).toBeLessThan(start.total / 4);
  await expect.poll(async () => (await fogInfo(page, 0)).drawn).toBe(start.seen.length);
  // a cell far from anything seen is not drawn, so a tap there hits nothing
  const far = await page.evaluate(() => {
    const { ctrl, renderer } = (window as any).__infweb;
    const s = ctrl.state;
    const row: string = s.explored[0];
    const unseen = s.field.cells.findIndex((_: unknown, i: number) => row[i] !== '1');
    const p = renderer.cellScreenPos(unseen);
    return renderer.cellAt(p[0], p[1]);
  });
  expect(far).toBe(-1);
  // capture a neighbour: more land becomes known and is drawn, the camera does not jump
  const cam0 = await page.evaluate(() => {
    const r = (window as any).__infweb.renderer;
    return [r.camX, r.camY, r.scale];
  });
  await page.evaluate(() => {
    const { ctrl } = (window as any).__infweb;
    const s = ctrl.state;
    const row: string = s.explored[0];
    // an empty neighbour that borders unknown land, so taking it must reveal something new
    const good = (j: number) => s.field.cells[j].owner === -1 && s.field.cells[j].power === 0 && s.field.adj[j].some((k: number) => row[k] !== '1');
    const a = s.field.cells.findIndex((c: any, i: number) => c.owner === 0 && c.power >= 2 && s.field.adj[i].some(good));
    const t = s.field.adj[a].find(good);
    ctrl.tap(a);
    ctrl.tap(t);
  });
  await expect.poll(async () => (await fogInfo(page, 0)).seen.length).toBeGreaterThan(start.seen.length);
  const grown = await fogInfo(page, 0);
  await expect.poll(async () => (await fogInfo(page, 0)).drawn).toBe(grown.seen.length);
  const cam1 = await page.evaluate(() => {
    const r = (window as any).__infweb.renderer;
    return [r.camX, r.camY, r.scale];
  });
  expect(cam1).toEqual(cam0);
  await expectNoErrors(errors);
});

test('night drop hot-seat: each person keeps their own explored land, the hand-over shows none of it', async ({ page }) => {
  const errors = await fresh(page, { confirmEnd: false });
  await page.evaluate(() =>
    localStorage.setItem(
      'infweb.setup',
      JSON.stringify({ size: 'M', players: ['human', 'hunter'], darkness: false, symmetry: true, crowded: false, unions: false, shuffle: false, scenario: 'landing', scenarioSeats: { landing: ['human', 'human', 'dummy', 'dummy', 'dummy', 'dummy'] } }),
    ),
  );
  await page.reload();
  await page.locator('.mode-card', { hasText: 'Быстрый старт' }).click();
  await waitGame(page);
  await expect(page.getByTestId('handover')).toBeVisible();
  const a0 = await fogInfo(page, 0);
  const b0 = await fogInfo(page, 1);
  expect(a0.seen.length).toBeGreaterThan(0);
  expect(b0.seen.length).toBeGreaterThan(0);
  expect(a0.seen.filter((i) => b0.seen.includes(i))).toEqual([]);
  await page.getByTestId('handover').click();
  await expect(page.getByTestId('handover')).toHaveCount(0);
  await expect.poll(async () => (await fogInfo(page, 0)).drawn).toBe(a0.seen.length);
  // player 1 ends the turn: the hand-over covers the board, then player 2 sees only their own land
  await page.evaluate(() => {
    const c = (window as any).__infweb.ctrl;
    c.endButton(true);
    c.endButton(true);
  });
  await expect(page.getByTestId('handover')).toContainText('Игрок 2');
  await expect(page.getByTestId('handover')).toHaveClass(/solid/);
  await page.getByTestId('handover').click();
  await expect(page.getByTestId('handover')).toHaveCount(0);
  const b1 = await fogInfo(page, 1);
  expect(b1.viewer).toBe(1);
  await expect.poll(async () => (await fogInfo(page, 1)).drawn).toBe(b1.seen.length);
  // the sets stay apart after reload (saved with the match)
  await page.reload();
  await page.locator('.play-btn.cont').click();
  await waitGame(page);
  const a2 = await fogInfo(page, 0);
  expect(a2.seen.length).toBeGreaterThanOrEqual(a0.seen.length);
  expect((await fogInfo(page, 1)).seen).toEqual(b1.seen);
  await expectNoErrors(errors);
});

test('map of the day: a night drop day shows no map, old results and the streak stay', async ({ page }) => {
  // the browser lives on October 30th, 2026: the night drop of the 29th is in the past
  await page.clock.install({ time: new Date(2026, 9, 30, 12) });
  const errors = await fresh(page);
  const today = await page.evaluate(() => {
    const d = new Date();
    const id = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
    const y = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1);
    // results stored before the schedule changed stay the results of their dates
    localStorage.setItem(
      'infweb.daily2',
      JSON.stringify({ [id(d)]: { attempts: 2, bestRounds: 9 }, [id(y)]: { attempts: 1, bestRounds: 14 }, '2026-10-29': { attempts: 3, bestRounds: 12 } }),
    );
    return id(d);
  });
  expect(today).toBe('2026-10-30');
  await page.reload();
  await page.locator('.mode-card', { hasText: 'Карта дня' }).click();
  await expect(page.getByText('Лучший результат: победа за 9 р.')).toBeVisible();
  await expect(page.locator('.big-stats b').first()).toHaveText('2');
  // October 29th, 2026 is a night drop
  await page.locator('.calendar button', { hasText: /^29$/ }).click();
  await expect(page.locator('.puzzle-brief')).toContainText('Десант во тьме');
  await expect(page.locator('[data-unknown-map]')).toHaveCount(1);
  await expect(page.getByText('Неизведанная карта')).toBeVisible();
  await expect(page.getByText(/Попыток: 3/)).toBeVisible();
  await expect(page.getByText('Лучший результат: победа за 12 р.')).toBeVisible();
  await page.getByRole('button', { name: 'Ещё попытка' }).click();
  await waitGame(page);
  const info = await page.evaluate(() => {
    const s = (window as any).__infweb.ctrl.state;
    return { kind: s.settings.kind, puzzle: s.settings.puzzle, blind: s.settings.blind, players: s.settings.players };
  });
  expect(info).toEqual({ kind: 'daily', puzzle: 'landing', blind: true, players: ['human', 'god', 'master', 'hunter', 'master', 'hunter'] });
  await expectNoErrors(errors);
});
