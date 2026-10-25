import { expect, test, type Page } from '@playwright/test';
import { expectNoErrors, fresh } from './helpers';

async function openSettings(page: Page) {
  await page.locator('.menu-links button').nth(1).click();
  await expect(page.locator('.topbar h1')).toHaveText(/Настройки|Settings/);
}

const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('infweb.settings') || '{}'));

test('every toggle and choice persists across a reload', async ({ page }) => {
  const errors = await fresh(page);
  await openSettings(page);

  const switches = page.locator('.screen [role="switch"]');
  // sound, vibration, confirm end, chances, inactive cells, colour-blind, light effects
  await expect(switches).toHaveCount(7);
  const before: string[] = [];
  for (let i = 0; i < 7; i++) before.push((await switches.nth(i).getAttribute('aria-checked'))!);
  for (let i = 0; i < 7; i++) {
    await switches.nth(i).click();
    await expect(switches.nth(i)).toHaveAttribute('aria-checked', before[i] === 'true' ? 'false' : 'true');
  }

  // segmented choices besides the language: speed, cell lines, palette; pick the last option of each
  const groups = page.locator('.screen [role="radiogroup"]');
  await expect(groups).toHaveCount(4);
  const picked: string[] = [];
  for (let g = 1; g < 4; g++) {
    const last = groups.nth(g).getByRole('radio').last();
    await last.click();
    await expect(last).toHaveAttribute('aria-checked', 'true');
    picked.push((await last.textContent())!);
  }

  const saved = await stored(page);
  expect(saved).toMatchObject({
    sound: before[0] !== 'true',
    vibration: before[1] !== 'true',
    confirmEnd: before[2] !== 'true',
    showChance: before[3] !== 'true',
    inactiveCells: before[4] !== 'true',
    colorblind: before[5] !== 'true',
    lowFx: before[6] !== 'true',
    speed: 'slow',
    cellLines: 0,
    palette: 'soft',
    v: 2,
  });

  // a reload keeps the settings screen open
  await page.reload();
  await expect(page.locator('.topbar h1')).toHaveText(/Настройки|Settings/);
  for (let i = 0; i < 7; i++) await expect(switches.nth(i)).toHaveAttribute('aria-checked', before[i] === 'true' ? 'false' : 'true');
  for (let g = 1; g < 4; g++) {
    const on = groups.nth(g).locator('[aria-checked="true"]');
    await expect(on).toHaveCount(1);
    await expect(on).toHaveText(picked[g - 1]);
  }
  // the soft palette is applied to the page colours
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--p0').trim())).toBe('#6f9be8');
  await expectNoErrors(errors);
});

test('switching RU and EN changes the visible texts and is remembered', async ({ page }) => {
  const errors = await fresh(page);
  await expect(page.locator('.play-btn .big')).toHaveText('Новая битва');
  await openSettings(page);
  const lang = page.locator('.screen [role="radiogroup"]').first();
  await expect(lang.getByRole('radio', { name: 'RU' })).toHaveAttribute('aria-checked', 'true');

  await lang.getByRole('radio', { name: 'EN' }).click();
  await expect(page.locator('.topbar h1')).toHaveText('Settings');
  await expect(page.getByText('Language', { exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  // no Cyrillic left on the settings screen (the numbers of the site counters aside)
  expect(await page.locator('.screen').innerText()).not.toMatch(/[А-Яа-яЁё]/);

  await page.locator('.topbar').getByRole('button', { name: /^(Назад|Back)$/ }).click();
  await expect(page.locator('.play-btn .big')).toHaveText('New battle');
  await expect(page.locator('.mode-card', { hasText: 'Quick start' })).toBeVisible();
  expect(await page.locator('.menu-screen').innerText()).not.toMatch(/[А-Яа-яЁё]/);

  await page.reload();
  await expect(page.locator('.play-btn .big')).toHaveText('New battle');
  expect((await stored(page)).lang).toBe('en');

  await openSettings(page);
  await page.locator('.screen [role="radiogroup"]').first().getByRole('radio', { name: 'RU' }).click();
  await expect(page.locator('.topbar h1')).toHaveText('Настройки');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await page.locator('.topbar').getByRole('button', { name: /^(Назад|Back)$/ }).click();
  await expect(page.locator('.play-btn .big')).toHaveText('Новая битва');
  await expectNoErrors(errors);
});

test('the language follows the browser when it was never chosen', async ({ browser }) => {
  for (const [locale, text] of [
    ['en-US', 'New battle'],
    ['ru-RU', 'Новая битва'],
  ] as const) {
    const ctx = await browser.newContext({ locale });
    const page = await ctx.newPage();
    await page.route('**/abacus.jasoncameron.dev/**', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"value":0}' }),
    );
    await page.goto('./');
    await expect(page.locator('.play-btn .big')).toHaveText(text);
    await ctx.close();
  }
});
