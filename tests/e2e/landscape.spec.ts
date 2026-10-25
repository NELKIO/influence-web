import { expect, test, type Page } from '@playwright/test';
import { expectNoErrors, fresh, waitGame } from './helpers';

// A phone held sideways: a short, wide screen. The board must render and the end button stay reachable.
test.use({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });

const inViewport = async (page: Page, sel: string) => {
  const box = await page.locator(sel).boundingBox();
  const vp = page.viewportSize()!;
  expect(box, sel).not.toBeNull();
  expect(box!.width).toBeGreaterThan(0);
  expect(box!.height).toBeGreaterThan(0);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width + 0.5);
  expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height + 0.5);
  return box!;
};

test('phone landscape: the board renders and the end button works by touch', async ({ page }) => {
  const errors = await fresh(page, { confirmEnd: false });
  await page.evaluate(() =>
    localStorage.setItem(
      'infweb.setup',
      JSON.stringify({ size: 'M', players: ['human', 'dummy', 'dummy'], darkness: false, symmetry: true, crowded: false, unions: false, shuffle: false }),
    ),
  );
  await page.reload();
  await page.locator('.mode-card', { hasText: 'Быстрый старт' }).tap();
  await waitGame(page);
  await expect(page.locator('canvas')).toBeVisible();

  const canvas = await inViewport(page, 'canvas');
  expect(canvas.width).toBeGreaterThan(400);
  expect(canvas.height).toBeGreaterThan(200);

  // the canvas has a real backing store and something is drawn on it
  const drawn = await page.evaluate(() => {
    const { renderer } = (window as any).__infweb;
    const c = renderer.canvas as HTMLCanvasElement;
    return { w: c.width, h: c.height };
  });
  expect(drawn.w).toBeGreaterThan(0);
  expect(drawn.h).toBeGreaterThan(0);

  // every own cell is on screen (the board fits the short screen)
  const cells = await page.evaluate(() => {
    const { ctrl, renderer } = (window as any).__infweb;
    const s = ctrl.state;
    const rect = renderer.canvas.getBoundingClientRect();
    return s.field.cells
      .map((c: any, i: number) => (c.owner === 0 ? renderer.cellScreenPos(i) : null))
      .filter(Boolean)
      .map((p: number[]) => [p[0] + rect.left, p[1] + rect.top]);
  });
  expect(cells.length).toBeGreaterThan(0);
  const vp = page.viewportSize()!;
  for (const [x, y] of cells) {
    expect(x).toBeGreaterThan(0);
    expect(x).toBeLessThan(vp.width);
    expect(y).toBeGreaterThan(0);
    expect(y).toBeLessThan(vp.height);
  }

  // the end button is on screen and not covered by anything
  const end = page.locator('.end-btn');
  await expect(end).toBeVisible();
  await expect(end).toBeEnabled();
  const box = await inViewport(page, '.end-btn');
  const onTop = await page.evaluate(
    ([x, y]) => !!document.elementFromPoint(x, y)?.closest('.end-btn'),
    [box.x + box.width / 2, box.y + box.height / 2],
  );
  expect(onTop).toBe(true);

  // a tap ends the attack, a second tap ends the turn (the bots then move and it is our turn again)
  await expect(end).toHaveAttribute('aria-label', 'Завершить атаку');
  await end.tap();
  await expect.poll(() => page.evaluate(() => (window as any).__infweb.ctrl.state.phase)).toBe('power');
  await expect(end).toHaveAttribute('aria-label', 'Завершить ход');
  await end.tap();
  await expect
    .poll(() => page.evaluate(() => {
      const s = (window as any).__infweb.ctrl.state;
      return s.turn >= 1 && s.current === 0 && s.phase === 'attack';
    }), { timeout: 20_000 })
    .toBe(true);
  await expect(end).toHaveAttribute('aria-label', 'Завершить атаку');

  // the pause button is reachable too
  await inViewport(page, '.hud-top .side-btn');
  await expectNoErrors(errors);
});
