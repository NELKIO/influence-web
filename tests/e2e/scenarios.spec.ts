import { expect, test, type Page } from '@playwright/test';
import { expectNoErrors, fresh, waitGame } from './helpers';
import { dailyKind, dayId } from '../../src/daily';

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
  await page.locator('[data-scenario="laststand"]').click();
  // still on the setup screen, with the scenario shown on top and the size picker gone
  await expect(page.getByTestId('scenario-pick')).toContainText('Последний рубеж');
  await expect(page.getByTestId('scenario-pick')).toContainText('6 игроков');
  await expect(page.locator('[data-scenario="laststand"]')).toHaveAttribute('aria-pressed', 'true');
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
  await page.getByRole('button', { name: 'Назад' }).click();
  await openSetup(page);
  await expect(page.getByTestId('scenario-pick')).toContainText('Последний рубеж');
  await page.locator('.steps button').nth(1).click();
  await expect(page.locator('.type-pick').first().locator('button.on')).toHaveText('Охотник');

  await page.getByRole('button', { name: /^В бой/ }).first().click();
  await waitGame(page);
  const info = await gameInfo(page);
  expect(info.puzzle).toBe('laststand');
  expect(info.players).toEqual(['human', 'hunter', 'hunter', 'god', 'hunter', 'master']);
  expect(info.darkness).toBe(false);
  await expectNoErrors(errors);
});

test('a scenario locks the modes', async ({ page }) => {
  const errors = await fresh(page);
  await openSetup(page);
  await page.locator('[data-scenario="titans"]').click();
  await page.locator('.steps button').nth(2).click();
  // the modes are the scenario's rules, listed read-only: unions on, nothing else, nothing to switch
  await expect(page.getByText('Правила сценария')).toBeVisible();
  const rules = page.getByTestId('scenario-rules');
  await expect(rules.locator('[data-rule]')).toHaveCount(2);
  await expect(rules.locator('[data-rule="goal"]')).toBeVisible();
  await expect(rules.locator('[data-rule="unions"]')).toContainText('Союзы');
  await expect(page.getByRole('switch')).toHaveCount(0);
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
  await expect(page.getByTestId('scenario-pick')).toContainText('Абсолютная тьма');
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

test('night drop can be configured: size, unions and seats persist and reach the match', async ({ page }) => {
  const errors = await fresh(page, { confirmEnd: false });
  await openSetup(page);
  await page.locator('[data-scenario="landing"]').click();
  // a compact size choice in the banner, named by its place in the scenario's own range; the default
  // is the recommended one
  const size = page.getByTestId('scenario-size').getByRole('radio');
  await expect(size).toHaveText(['Маленькая', 'Средняя', 'Большая']);
  await expect(page.getByTestId('scenario-size').getByRole('radio', { name: 'Средняя' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.size-grid')).toHaveCount(0);
  await page.getByTestId('scenario-size').getByRole('radio', { name: 'Большая' }).click();

  // seats: remove two (down to the fewest), add one back as designed
  await page.locator('.steps button').nth(1).click();
  await expect(page.locator('.player-row')).toHaveCount(6);
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Убрать' }).click();
  await expect(page.locator('.player-row')).toHaveCount(3);
  // the night drop's seats are all alike, so "shuffle players" is offered (fixed scenarios hide it)
  await expect(page.getByText('Перемешать игроков')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Убрать' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Добавить соперника' }).click();
  await expect(page.locator('.player-row')).toHaveCount(4);
  await expect(page.locator('.type-pick').nth(2).locator('button.on')).toHaveText('Охотник');

  // modes: absolute darkness is the scenario's rule (read-only); unions, frontiers and fires are choices
  await page.locator('.steps button').nth(2).click();
  await expect(page.getByTestId('scenario-rules')).toContainText('Абсолютная тьма');
  await expect(page.getByTestId('scenario-choice').getByRole('switch')).toHaveCount(3);
  const unions = page.getByRole('switch', { name: 'Союзы', exact: true });
  await unions.click();
  await expect(unions).toHaveAttribute('aria-checked', 'true');

  // the choices survive a reload (which keeps the setup screen open)
  await page.reload();
  await expect(page.locator('.puzzle-grid')).toBeVisible();
  await expect(page.getByTestId('scenario-pick')).toContainText('4 игрока');
  await expect(page.getByTestId('scenario-pick')).toContainText('Союзы');
  await expect(page.getByTestId('scenario-size').getByRole('radio', { name: 'Большая' })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('button', { name: /^В бой/ }).first().click();
  await waitGame(page);
  const info = await gameInfo(page);
  expect(info).toMatchObject({ puzzle: 'landing', size: 'XXL', unions: true, darkness: true, players: ['human', 'god', 'master', 'hunter'] });
  expect(info.cells).toBeGreaterThan(240);
  await expectNoErrors(errors);
});

for (const [id, recommended] of [['moonvale', 'Маленькая'], ['fireflies', 'Средняя']] as const) {
  test(`${id} can be sized and seated like the night drop, and both reach the match`, async ({ page }) => {
    const errors = await fresh(page, { confirmEnd: false });
    await openSetup(page);
    await page.locator(`[data-scenario="${id}"]`).click();
    const size = page.getByTestId('scenario-size');
    await expect(size.getByRole('radio')).toHaveText(['Маленькая', 'Средняя', 'Большая']);
    await expect(size.getByRole('radio', { name: recommended })).toHaveAttribute('aria-checked', 'true');
    await size.getByRole('radio', { name: 'Большая' }).click();
    // the map stays secret in the preview whatever the size
    await expect(page.getByTestId('scenario-pick').locator('[data-unknown-map]')).toBeVisible();
    await page.locator('.steps button').nth(1).click();
    await expect(page.locator('.player-row')).toHaveCount(3);
    await page.getByRole('button', { name: 'Убрать' }).first().click();
    await expect(page.locator('.player-row')).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'Убрать' })).toHaveCount(0);
    for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Добавить соперника' }).click();
    await expect(page.locator('.player-row')).toHaveCount(6);
    await expect(page.getByRole('button', { name: 'Добавить соперника' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Убрать' }).first().click();
    await page.reload();
    await expect(page.getByTestId('scenario-pick')).toContainText('5 игроков');
    await page.getByRole('button', { name: /^В бой/ }).first().click();
    await waitGame(page);
    const big = await gameInfo(page);
    expect(big).toMatchObject({ puzzle: id, size: 'XXL', darkness: true });
    expect(big.players).toHaveLength(5);
    // fewer gods on the same size get a smaller valley
    await page.goto('./');
    await openSetup(page);
    await page.locator(`[data-scenario="${id}"]`).click();
    await page.locator('.steps button').nth(1).click();
    for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Убрать' }).first().click();
    await page.getByRole('button', { name: /^В бой/ }).first().click();
    await page.locator('.modal').getByRole('button').last().click();
    await waitGame(page);
    const small = await gameInfo(page);
    expect(small.players).toHaveLength(2);
    expect(small.cells).toBeLessThan(big.cells);
    await expectNoErrors(errors);
  });
}

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
  // no cell count to give the size away; the darkness chip says the map is unknown
  await expect(page.getByTestId('scenario-pick')).not.toContainText(/\d+ клет/);
  await expect(page.getByTestId('scenario-pick').locator('[data-tag="blind"]')).toContainText('Абсолютная тьма');
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
      JSON.stringify({ size: 'M', players: ['human', 'hunter'], darkness: false, symmetry: true, crowded: false, unions: false, shuffle: false, rev: 2, scenario: 'landing', scenarioSeats: { landing: ['human', 'human', 'dummy', 'dummy', 'dummy', 'dummy'] } }),
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
  // a night drop day of autumn 2026 that is not the last of its month; the browser lives on the day after
  const drop = Array.from({ length: 90 }, (_, i) => new Date(2026, 8, 1 + i)).find((d) => {
    const k = dailyKind(dayId(d));
    return k.kind === 'puzzle' && k.scenario === 'landing' && new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getMonth() === d.getMonth();
  })!;
  const dropId = dayId(drop);
  await page.clock.install({ time: new Date(drop.getFullYear(), drop.getMonth(), drop.getDate() + 1, 12) });
  const errors = await fresh(page);
  const today = await page.evaluate((dropId) => {
    const d = new Date();
    const id = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
    // stored results stay the results of their dates
    localStorage.setItem('infweb.daily2', JSON.stringify({ [id(d)]: { attempts: 2, bestRounds: 9 }, [dropId]: { attempts: 3, bestRounds: 12 } }));
    return id(d);
  }, dropId);
  expect(today).toBe(dayId(new Date(drop.getFullYear(), drop.getMonth(), drop.getDate() + 1)));
  await page.reload();
  await page.locator('.mode-card', { hasText: 'Карта дня' }).click();
  await expect(page.getByText('Лучший результат: победа за 9 р.')).toBeVisible();
  await expect(page.locator('.big-stats b').first()).toHaveText('2');
  // the night drop of the day before
  await page.locator('.calendar button', { hasText: new RegExp(`^${drop.getDate()}$`) }).click();
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

test('two-seat moonless valley: the first mover is told it sits out its first attack, and gets +4', async ({ page }) => {
  const errors = await fresh(page, { confirmEnd: false });
  await page.evaluate(() => localStorage.setItem('infweb.setup', JSON.stringify({ shuffle: false, rev: 2, scenario: 'moonvale', scenarioSeats: { moonvale: ['human', 'master'] } })));
  await page.reload();
  await openSetup(page);
  await expect(page.getByTestId('scenario-pick')).toContainText('2 игрока');
  await page.getByRole('button', { name: /^В бой/ }).first().click();
  await waitGame(page);
  await expect(page.locator('.hint', { hasText: 'пропускает атаку в первом раунде' })).toBeVisible();
  const start = await page.evaluate(() => {
    const s = (window as any).__infweb.ctrl.state;
    return { comp: s.settings.orderComp, current: s.current, players: s.settings.players, owners: s.field.cells.map((c: { owner: number }) => c.owner).join() };
  });
  expect(start).toMatchObject({ comp: { skip: 1, bonus: [4, 0] }, current: 0, players: ['human', 'master'] });
  // no cell of yours can attack: the only way on is to end the attack, and the reinforcement carries the +4
  await page.getByRole('button', { name: 'Завершить атаку' }).first().click();
  const after = await page.evaluate(() => {
    const s = (window as any).__infweb.ctrl.state;
    const own = s.field.cells.filter((c: { owner: number }) => c.owner === 0).length;
    return { phase: s.phase, powerLeft: s.powerLeft, own, owners: s.field.cells.map((c: { owner: number }) => c.owner).join() };
  });
  expect(after.phase).toBe('power');
  expect(after.owners).toBe(start.owners);
  expect(after.powerLeft).toBe(after.own + 4);
  // the rule stays in the scenario info
  await page.getByTestId('scenario-info-btn').click();
  await expect(page.getByTestId('scenario-info')).toContainText('пропускает атаку');
  await expectNoErrors(errors);
});

test('three-seat moonless valley with frontiers: the turn goes round the table, never twice to you', async ({ page }) => {
  const errors = await fresh(page, { confirmEnd: false });
  await page.evaluate(() =>
    localStorage.setItem('infweb.setup', JSON.stringify({ shuffle: false, rev: 2, scenario: 'moonvale', scenarioConfig: { moonvale: { frontierMode: true, frontierPoints: 6, frontierWin: 4, frontierHold: 5 } } })),
  );
  await page.reload();
  await openSetup(page);
  await page.getByRole('button', { name: /^В бой/ }).first().click();
  await waitGame(page);
  // every seat that gets the turn, in order
  await page.evaluate(() => {
    const w = window as any;
    const c = w.__infweb.ctrl;
    w.__seats = [c.state.current];
    c.subscribe(() => {
      if (w.__seats[w.__seats.length - 1] !== c.state.current) w.__seats.push(c.state.current);
    });
  });
  const state = () => page.evaluate(() => { const s = (window as any).__infweb.ctrl.state; return { current: s.current, phase: s.phase, players: s.settings.players.length, objectives: s.objectives?.length }; });
  expect(await state()).toMatchObject({ current: 0, players: 3, objectives: 6 });
  for (let turn = 0; turn < 3; turn++) {
    await expect.poll(async () => (await state()).current, { timeout: 30000 }).toBe(0);
    // end the attack, then the turn (the reinforcement is spread over your cells)
    const before = await page.evaluate(() => (window as any).__seats.length);
    await page.locator('.end-btn').click();
    // with nothing to reinforce (all your cells full) the power phase is skipped and the turn moves on at once
    const left = () => page.evaluate((n) => (window as any).__seats.length > n, before);
    await expect.poll(async () => (await left()) || (await state()).phase === 'power').toBe(true);
    if (!(await left())) await page.locator('.end-btn').click();
    // the turn has left you (the bots may be done and hand it back before a poll would see them)
    await expect.poll(left).toBe(true);
  }
  await expect.poll(async () => (await state()).current, { timeout: 30000 }).toBe(0);
  expect(await page.evaluate(() => (window as any).__seats)).toEqual([0, 1, 2, 0, 1, 2, 0, 1, 2, 0]);
  await expectNoErrors(errors);
});

for (const id of ['moonvale', 'fireflies'] as const) {
  test(`${id}: frontier victory and signal fires can be switched on, and the match plays with them`, async ({ page }) => {
    const errors = await fresh(page, { confirmEnd: false });
    await openSetup(page);
    await page.locator(`[data-scenario="${id}"]`).click();
    await page.locator('.steps button').nth(2).click();
    const choice = page.getByTestId('scenario-choice');
    // off by default: the scenario as designed
    await expect(choice.getByRole('switch')).toHaveCount(2);
    for (const sw of await choice.getByRole('switch').all()) await expect(sw).toHaveAttribute('aria-checked', 'false');
    await choice.getByRole('switch', { name: 'Победа по рубежам', exact: true }).click();
    await page.getByRole('slider', { name: 'Контрольные точки' }).fill('5');
    await expect(page.getByRole('slider', { name: 'Нужно для победы' })).toHaveValue('3');
    // how long the points must be held: one round by default, longer on request
    const hold = page.getByRole('slider', { name: 'Удерживать ходов' });
    await expect(hold).toHaveValue('1');
    await hold.fill('2');
    await expect(page.getByText('ход должен 2 раза вернуться к вам')).toBeVisible();
    await choice.getByRole('switch', { name: 'Сигнальные огни', exact: true }).click();
    // the goal and the chip follow the choice
    await expect(page.getByTestId('scenario-rules')).toContainText(/удержать 3 из 5 контрольных точек/i);
    await page.reload();
    await expect(page.getByTestId('scenario-pick')).toContainText('5 точек');
    await expect(page.getByTestId('scenario-pick')).toContainText(/удержать 3 из 5/i);
    await page.getByRole('button', { name: /^В бой/ }).first().click();
    await waitGame(page);
    const st = await page.evaluate(() => {
      const c = (window as any).__infweb.ctrl;
      const s = c.state;
      const known = c.view().known;
      return {
        points: s.objectives?.length ?? 0,
        known: (s.objectives ?? []).every((i: number) => known && known[i] === 1),
        settings: { frontierMode: s.settings.frontierMode, win: s.settings.frontierWinCount, hold: s.settings.frontierHoldTurns, fires: s.settings.signalFires, blind: s.settings.blind },
      };
    });
    expect(st).toEqual({ points: 5, known: true, settings: { frontierMode: true, win: 3, hold: 2, fires: true, blind: true } });
    // your turn: the fire can be lit, the frontier goal is on screen
    await expect(page.getByRole('button', { name: 'Зажечь сигнальный огонь' })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(/0\/5 · Для победы удержите 3/)).toBeVisible();
    await expectNoErrors(errors);
  });
}

test('first-block maps with sizes: small, medium and large name their place and really grow', async ({ page }) => {
  const errors = await fresh(page, { confirmEnd: false });
  const cells: number[] = [];
  for (const label of ['Маленькая', 'Средняя', 'Большая']) {
    await page.goto('./');
    await openSetup(page);
    await page.locator('[data-scenario="olympus"]').click();
    const size = page.getByTestId('scenario-size');
    await expect(size.getByRole('radio')).toHaveText(['Маленькая', 'Средняя', 'Большая']);
    await size.getByRole('radio', { name: label }).click();
    await page.getByRole('button', { name: /^В бой/ }).first().click();
    // a match is already saved after the first start: confirm replacing it
    if (cells.length) await page.locator('.modal').getByRole('button').last().click();
    await waitGame(page);
    const info = await gameInfo(page);
    expect(info.puzzle).toBe('olympus');
    cells.push(info.cells);
  }
  // (the land varies between launches: the largest of a size and the smallest of the next differ by 12%)
  expect(cells[1]).toBeGreaterThan(cells[0] * 1.1);
  expect(cells[2]).toBeGreaterThan(cells[1] * 1.1);
  await expectNoErrors(errors);
});
