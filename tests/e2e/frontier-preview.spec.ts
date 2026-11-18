import { expect, test } from '@playwright/test';
import { fresh, waitGame, expectNoErrors } from './helpers';

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
