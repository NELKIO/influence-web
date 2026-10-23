import { expect, test, type Page } from '@playwright/test';
import { expectNoErrors, fresh, waitGame } from './helpers';

async function openSetup(page: Page) {
  await page.getByRole('button', { name: 'Новая битва' }).click();
  await expect(page.locator('.puzzle-grid')).toBeVisible();
}

/** Wins the running match on the spot: on your turn every cell but one weak enemy cell becomes yours, then you take it. */
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

/** A duel from the gallery, whichever the gallery offers. */
async function pickDuel(page: Page) {
  const cards = page.locator('.puzzle-card');
  const ids = await cards.evaluateAll((els) => els.map((e) => e.getAttribute('data-scenario')!));
  const seats = await cards.evaluateAll((els) => els.map((e) => Number(e.querySelector('.meta')?.textContent?.trim())));
  const id = ids[seats.indexOf(2)];
  expect(id).toBeTruthy();
  await page.locator(`[data-scenario="${id}"]`).click();
  return id;
}

async function backToSetup(page: Page) {
  await page.getByRole('button', { name: 'В меню' }).click();
  await openSetup(page);
}

test('scenario medals: placeholders on a fresh profile, a medal for the recommended line-up, gold against Gods only', async ({ page }) => {
  const errors = await fresh(page, { confirmEnd: false });
  await openSetup(page);

  // a fresh profile: every card invites to earn its medal
  const cards = page.locator('.puzzle-card');
  const total = await cards.count();
  expect(total).toBeGreaterThan(5);
  await expect(page.locator('.puzzle-card .medal-badge[data-medal="none"]')).toHaveCount(total);
  await expect(page.getByTestId('medal-count')).toHaveText(`Медали: 0 из ${total}`);

  const id = await pickDuel(page);
  const card = page.locator(`[data-scenario="${id}"]`);
  await expect(page.getByTestId('medal-status')).toContainText('Победите рекомендуемых соперников или сильнее');

  // the recommended line-up: a medal
  await page.getByRole('button', { name: /^В бой/ }).first().click();
  await waitGame(page);
  await forceWin(page);
  await expect(page.locator('.result-title')).toHaveText('Победа!');
  await expect(page.getByTestId('medal-won')).toHaveAttribute('data-medal', 'medal');
  await expect(page.getByTestId('medal-won')).toContainText('Новая медаль!');
  await backToSetup(page);
  await expect(card.locator('.medal-badge')).toHaveAttribute('data-medal', 'medal');
  await expect(page.getByTestId('medal-count')).toHaveText(`Медали: 1 из ${total}`);
  await expect(page.locator('.puzzle-card .medal-badge[data-medal="none"]')).toHaveCount(total - 1);
  await expect(page.getByTestId('medal-status')).toContainText('Медаль получена');

  // a weaker opponent: the setup says no medal is at stake
  await page.locator('.steps button').nth(1).click();
  const picks = page.locator('.type-pick');
  for (let i = 0; i < (await picks.count()); i++) await picks.nth(i).getByRole('button', { name: 'Тупица' }).click();
  await page.locator('.steps button').nth(0).click();
  await expect(page.getByTestId('medal-status')).toContainText('С этим составом медали не будет');

  // nothing but Gods: gold
  await page.locator('.steps button').nth(1).click();
  for (let i = 0; i < (await picks.count()); i++) await picks.nth(i).getByRole('button', { name: 'БОГ' }).click();
  await page.locator('.steps button').nth(0).click();
  await expect(page.getByTestId('medal-status')).toContainText('Этот состав играет на золото');
  await page.getByRole('button', { name: /^В бой/ }).first().click();
  await waitGame(page);
  await forceWin(page);
  await expect(page.getByTestId('medal-won')).toHaveAttribute('data-medal', 'gold');
  await expect(page.getByTestId('medal-won')).toContainText('Золотая медаль!');
  await backToSetup(page);
  await expect(card.locator('.medal-badge')).toHaveAttribute('data-medal', 'gold');
  await expect(page.getByTestId('medal-count')).toHaveText(`Медали: 1 из ${total}`);
  await expect(page.getByTestId('medal-status')).toContainText('Золотая медаль');

  // back to the recommended line-up: another win keeps the gold and announces nothing
  await page.locator('.steps button').nth(1).click();
  for (let i = 0; i < (await picks.count()); i++) await picks.nth(i).locator('button.rec').click();
  await page.getByRole('button', { name: /^В бой/ }).first().click();
  await waitGame(page);
  await forceWin(page);
  await expect(page.getByTestId('medal-won')).toHaveCount(0);
  await backToSetup(page);
  await expect(card.locator('.medal-badge')).toHaveAttribute('data-medal', 'gold');
  await expectNoErrors(errors);
});

test('a hot-seat win earns no medal', async ({ page }) => {
  const errors = await fresh(page, { confirmEnd: false });
  await openSetup(page);
  const id = await pickDuel(page);
  await page.locator('.steps button').nth(1).click();
  await page.locator('.type-pick').first().getByRole('button', { name: 'Игрок' }).click();
  await page.locator('.steps button').nth(0).click();
  await expect(page.getByTestId('medal-status')).toContainText('Когда играют люди, медаль не выдаётся');
  await page.getByRole('button', { name: /^В бой/ }).first().click();
  await waitGame(page);
  await forceWin(page);
  await expect(page.getByTestId('medal-won')).toHaveCount(0);
  await backToSetup(page);
  await expect(page.locator(`[data-scenario="${id}"] .medal-badge`)).toHaveAttribute('data-medal', 'none');
  await expectNoErrors(errors);
});
