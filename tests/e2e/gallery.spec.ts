import { expect, test, type Page } from '@playwright/test';
import { expectNoErrors, fresh, waitGame } from './helpers';
import { SCENARIO_META, SCENARIOS, type ScenarioId } from '../../src/core/scenarios';

async function openSetup(page: Page) {
  await page.getByRole('button', { name: 'Новая битва' }).click();
  await expect(page.locator('.puzzle-grid')).toBeVisible();
}

const flexible = (id: ScenarioId) => !!SCENARIO_META[id].varied;

/** The tags a card should show for its scenario, in the card's order. */
function expectedTags(id: ScenarioId): string[] {
  const m = SCENARIO_META[id];
  // "changes every time" is the gallery section itself, not a card icon
  const tags: string[] = [];
  if (m.blind) tags.push('blind');
  else if (m.darkness) tags.push('darkness');
  if (m.objectives) tags.push('objectives');
  if (m.crowded) tags.push('crowded');
  if (m.unions) tags.push('unions');
  return tags;
}

const seatsOf = (id: ScenarioId) => {
  const c = SCENARIO_META[id].configurable;
  return c ? `${c.seats[0]}–${c.seats[1]}` : String(SCENARIO_META[id].players.length);
};

/** Wins the running match on the spot. */
async function forceWin(page: Page) {
  await page.waitForFunction(() => {
    const c = (window as any).__infweb?.ctrl;
    if (c?.overlay.kind === 'handover') c.dismissHandover();
    return c && c.isLocalTurn && !c.busy && c.state.current === 0 && c.state.phase === 'attack' && c.overlay.kind === 'none';
  });
  await page.evaluate(() => {
    const c = (window as any).__infweb.ctrl;
    const s = c.state;
    const cells = s.field.cells;
    const a = cells.findIndex((cell: any, i: number) => cell.maxPower >= 2 && s.field.adj[i].length > 0);
    const d = s.field.adj[a][0];
    for (const cell of cells) {
      cell.owner = 0;
      cell.power = Math.min(cell.power, cell.maxPower);
    }
    cells[a].power = cells[a].maxPower;
    cells[d].owner = 1;
    cells[d].power = 0;
    c.tap(a);
    c.tap(d);
  });
  await expect(page.locator('.result-title')).toBeVisible({ timeout: 10_000 });
}

/** After "play again": wait until the new, unfinished match is mounted. */
const waitFreshMatch = (page: Page) =>
  page.waitForFunction(() => {
    const c = (window as any).__infweb?.ctrl;
    return !!c && !c.state.ended;
  });

/** The map of the running match: its cells' positions and the control points. */
const matchMap = (page: Page) =>
  page.evaluate(() => {
    const s = (window as any).__infweb.ctrl.state;
    return {
      puzzle: s.settings.puzzle as string,
      cells: s.field.cells.map((c: any) => `${c.x},${c.y}`).join(' '),
      objectives: (s.objectives ?? []) as number[],
      players: s.settings.players as string[],
    };
  });

test('the gallery: changing scenarios first, then fixed puzzles; every card shows seats and its rules, no difficulty dots', async ({ page }) => {
  const errors = await fresh(page);
  await openSetup(page);
  const cards = page.locator('.puzzle-grid [data-scenario]');
  await expect(cards).toHaveCount(SCENARIOS.length);
  const shown = await cards.evaluateAll((els) =>
    els.map((e) => ({
      id: e.getAttribute('data-scenario')!,
      section: e.getAttribute('data-section'),
      seats: e.querySelector('.meta')?.textContent?.trim(),
      dots: e.querySelectorAll('.pips, [data-level]').length,
      tags: [...e.querySelectorAll('[data-tag]')].map((t) => t.getAttribute('data-tag')),
    })),
  );
  // sections in gallery order, each keeping the order of SCENARIOS
  const expectedOrder = [...SCENARIOS.filter(flexible), ...SCENARIOS.filter((id) => !flexible(id))];
  expect(shown.map((c) => c.id)).toEqual(expectedOrder);
  for (const c of shown) {
    const id = c.id as ScenarioId;
    expect(c.section, id).toBe(flexible(id) ? 'varied' : 'fixed');
    expect(c.seats, id).toBe(seatsOf(id));
    expect(c.dots, id).toBe(0);
    expect(c.tags, id).toEqual(expectedTags(id));
  }
  // two titled sections, the changing ones first
  const sections = page.locator('.puzzle-section');
  await expect(sections).toHaveCount(2);
  await expect(sections.nth(0)).toContainText('Каждый раз по-новому');
  await expect(sections.nth(1)).toContainText('Головоломки');
  // the scenarios with an unknown map keep the "?" but differ in their labels
  const blind = SCENARIOS.filter((id) => SCENARIO_META[id].blind);
  for (const id of blind) await expect(page.locator(`[data-scenario="${id}"] [data-unknown-map]`)).toHaveCount(1);
  const labels = await Promise.all(blind.map((id) => page.locator(`[data-scenario="${id}"]`).innerText()));
  expect(new Set(labels).size).toBe(blind.length);
  // the legend explains every icon a card shows
  const used = new Set(SCENARIOS.flatMap(expectedTags));
  await expect(page.getByTestId('tag-legend').locator('.rtag')).toHaveCount(used.size);
  await expectNoErrors(errors);
});

test('the chosen scenario states its goal and rules; "another map" is offered exactly for changing scenarios', async ({ page }) => {
  const errors = await fresh(page);
  await openSetup(page);
  for (const id of SCENARIOS) {
    const m = SCENARIO_META[id];
    await page.locator(`[data-scenario="${id}"]`).click();
    const pick = page.getByTestId('scenario-pick');
    await expect(pick.locator('[data-tag]')).toHaveCount(expectedTags(id).length);
    // the seats and rules chips stay on a single line, none of them clipped
    const chips = await pick.locator('.chips .chip').evaluateAll((els) => els.map((e) => ({ top: Math.round(e.getBoundingClientRect().top), clipped: e.scrollWidth > e.clientWidth + 1 })));
    expect(new Set(chips.map((c) => c.top)).size, id).toBe(1);
    expect(chips.filter((c) => c.clipped), id).toEqual([]);
    await expect(page.getByTestId('scenario-goal'), id).toContainText(m.objectives ? 'удержать 2 из 3 контрольных точек' : 'победить всех соперников');
    await expect(page.getByTestId('scenario-reroll'), id).toHaveCount(m.varied ? 1 : 0);
    if (m.varied) await expect(page.getByTestId('scenario-reroll')).toHaveText(m.blind ? 'Новая высадка' : 'Другая карта');
  }
  await expectNoErrors(errors);
});

test('"another map" changes the preview, and the match starts on the map previewed', async ({ page }) => {
  const id = SCENARIOS.find((s) => SCENARIO_META[s].varied && SCENARIO_META[s].objectives && !SCENARIO_META[s].darkness)!;
  expect(id).toBeTruthy();
  const errors = await fresh(page);
  await openSetup(page);
  await page.locator(`[data-scenario="${id}"]`).click();
  const map = page.getByTestId('scenario-pick').locator('.pick-map svg');
  const before = await map.innerHTML();
  await page.getByTestId('scenario-reroll').click();
  await expect.poll(() => map.innerHTML()).not.toBe(before);
  const points = await page.getByTestId('scenario-pick').locator('[data-objective]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-objective'))));
  const cells = await map.locator('polygon:not([data-objective])').count();
  await page.getByRole('button', { name: /^В бой/ }).first().click();
  await waitGame(page);
  const started = await matchMap(page);
  expect(started.puzzle).toBe(id);
  expect(started.objectives).toEqual(points);
  expect(started.cells.split(' ')).toHaveLength(cells);
  await expectNoErrors(errors);
});

test('a hidden map: a new drop reveals nothing in the preview', async ({ page }) => {
  const id = SCENARIOS.find((s) => SCENARIO_META[s].blind && SCENARIO_META[s].varied)!;
  const errors = await fresh(page);
  await openSetup(page);
  await page.locator(`[data-scenario="${id}"]`).click();
  const pick = page.getByTestId('scenario-pick');
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: 'Новая высадка' }).click();
    await expect(pick.locator('[data-unknown-map]')).toHaveCount(1);
    await expect(pick.locator('[data-objective]')).toHaveCount(0);
    await expect(pick.locator('polygon[fill^="var(--p"]')).toHaveCount(0);
    await expect(pick).not.toContainText(/\d+ клет/);
  }
  await expect(pick.locator('[data-tag="blind"]')).toContainText('Абсолютная тьма');
  await expectNoErrors(errors);
});

test('modes of a scenario: a read-only rules summary, real choices stay switches', async ({ page }) => {
  const errors = await fresh(page);
  await openSetup(page);
  // a scenario with fixed unions: they are a rule, nothing to switch
  const fixedUnions = SCENARIOS.find((id) => SCENARIO_META[id].unions && !SCENARIO_META[id].configurable)!;
  await page.locator(`[data-scenario="${fixedUnions}"]`).click();
  await page.locator('.steps button').nth(2).click();
  const rules = page.getByTestId('scenario-rules');
  await expect(page.getByText('Правила сценария')).toBeVisible();
  await expect(rules.locator('[data-rule="goal"]')).toContainText('Победить всех соперников');
  await expect(rules.locator('[data-rule="unions"]')).toContainText('Союзы');
  await expect(page.getByRole('switch')).toHaveCount(0);
  // a fixed scenario with no special rules says so
  const plain = SCENARIOS.find((id) => expectedTags(id).length === 0 && !SCENARIO_META[id].varied)!;
  await page.locator('.steps button').nth(0).click();
  await page.locator(`[data-scenario="${plain}"]`).click();
  await page.locator('.steps button').nth(2).click();
  await expect(rules.locator('[data-rule="plain"]')).toContainText('Без особых правил');
  // a scenario that lets you switch unions keeps that one switch
  const choice = SCENARIOS.find((id) => SCENARIO_META[id].configurable?.modes.includes('unions'))!;
  await page.locator('.steps button').nth(0).click();
  await page.locator(`[data-scenario="${choice}"]`).click();
  await page.locator('.steps button').nth(2).click();
  for (const tag of expectedTags(choice)) await expect(rules.locator(`[data-rule="${tag}"]`)).toHaveCount(1);
  await expect(rules.locator('[data-rule="unions"]')).toHaveCount(0);
  await expect(page.getByRole('switch')).toHaveCount(1);
  await expect(page.getByTestId('scenario-unions').getByRole('switch')).toBeEnabled();
  await expectNoErrors(errors);
});

test('in a match the scenario description can be reread at any time, after resuming too', async ({ page }) => {
  const id = SCENARIOS.find((s) => SCENARIO_META[s].objectives && !SCENARIO_META[s].darkness)!;
  const errors = await fresh(page, { confirmEnd: false });
  await openSetup(page);
  await page.locator(`[data-scenario="${id}"]`).click();
  await page.getByRole('button', { name: /^В бой/ }).first().click();
  await waitGame(page);
  const info = page.getByTestId('scenario-info');
  await page.getByTestId('scenario-info-btn').click();
  await expect(info).toBeVisible();
  await expect(info.locator('h2')).not.toBeEmpty();
  await expect(info.locator('[data-rule="goal"]')).toContainText('Удержать 2 из 3 контрольных точек');
  await expect(info.locator('[data-rule="objectives"]')).toBeVisible();
  const title = await info.locator('h2').innerText();
  await page.getByRole('button', { name: 'Понятно' }).click();
  await expect(info).toHaveCount(0);
  // Escape closes it without opening the pause
  await page.getByTestId('scenario-info-btn').click();
  await page.keyboard.press('Escape');
  await expect(info).toHaveCount(0);
  await expect(page.locator('.modal')).toHaveCount(0);
  // resume the saved match: the button is still there
  await page.reload();
  await page.locator('.play-btn.cont').click();
  await waitGame(page);
  await page.getByTestId('scenario-info-btn').click();
  await expect(info.locator('h2')).toHaveText(title);
  expect((await matchMap(page)).puzzle).toBe(id);
  await page.getByRole('button', { name: 'Понятно' }).click();
  await expectNoErrors(errors);
});

test('ordinary battles have no scenario info button', async ({ page }) => {
  const errors = await fresh(page);
  await page.evaluate(() => localStorage.setItem('infweb.setup', JSON.stringify({ shuffle: false, rev: 2, scenario: null })));
  await page.reload();
  await openSetup(page);
  await page.getByRole('button', { name: /^В бой/ }).first().click();
  await waitGame(page);
  expect(await page.evaluate(() => (window as any).__infweb.ctrl.state.settings.puzzle ?? null)).toBeNull();
  await expect(page.getByTestId('scenario-info-btn')).toHaveCount(0);
  await expectNoErrors(errors);
});

test('end of a changing scenario: "new variation" plays the same scenario on a new map', async ({ page }) => {
  const id = SCENARIOS.find((s) => SCENARIO_META[s].varied && !SCENARIO_META[s].darkness && !SCENARIO_META[s].configurable)!;
  const errors = await fresh(page, { confirmEnd: false });
  await openSetup(page);
  await page.locator(`[data-scenario="${id}"]`).click();
  await page.getByRole('button', { name: /^В бой/ }).first().click();
  await waitGame(page);
  const first = await matchMap(page);
  await forceWin(page);
  await expect(page.getByTestId('play-again')).toHaveText('Новая вариация');
  await expect(page.getByRole('button', { name: 'Заново' })).toBeVisible();
  await page.getByTestId('play-again').click();
  await waitFreshMatch(page);
  const next = await matchMap(page);
  expect(next.cells !== first.cells || JSON.stringify(next.objectives) !== JSON.stringify(first.objectives)).toBe(true);
  expect(next.puzzle).toBe(id);
  expect(next.players).toEqual(first.players);
  await expect(page.locator('.result-title')).toHaveCount(0);
  await expectNoErrors(errors);
});

test('end of a fixed puzzle: "again" replays the same map, the other scenarios are one tap away', async ({ page }) => {
  const id = SCENARIOS.find((s) => !flexible(s) && !SCENARIO_META[s].darkness)!;
  const errors = await fresh(page, { confirmEnd: false });
  await openSetup(page);
  await page.locator(`[data-scenario="${id}"]`).click();
  await page.getByRole('button', { name: /^В бой/ }).first().click();
  await waitGame(page);
  const first = await matchMap(page);
  await forceWin(page);
  await expect(page.getByTestId('play-again')).toHaveText('Ещё раз');
  // "again" is the main action, so it is not offered twice
  await expect(page.getByRole('button', { name: 'Заново' })).toHaveCount(0);
  await page.getByTestId('play-again').click();
  await waitFreshMatch(page);
  await expect(page.locator('.result-title')).toHaveCount(0);
  const again = await matchMap(page);
  expect(again).toEqual(first);
  await forceWin(page);
  await page.getByRole('button', { name: 'К сценариям' }).click();
  await expect(page.getByTestId('scenario-pick')).toBeVisible();
  await expect(page.locator(`[data-scenario="${id}"]`)).toHaveAttribute('aria-pressed', 'true');
  await expectNoErrors(errors);
});
