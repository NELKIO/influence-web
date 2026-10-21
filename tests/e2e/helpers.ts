import { expect, type Page } from '@playwright/test';

export async function fresh(page: Page, settings: Record<string, unknown> = {}) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  await page.addInitScript((s) => {
    if (!sessionStorage.getItem('init')) {
      localStorage.clear();
      localStorage.setItem('infweb.settings', JSON.stringify({ lang: 'ru', speed: 'instant', ...s }));
      sessionStorage.setItem('init', '1');
    }
  }, settings);
  await page.goto('./');
  return errors;
}

/** Plays the local human's turns with a simple greedy strategy until the match ends. */
export async function autoplay(page: Page, maxSteps = 20000) {
  for (let i = 0; i < maxSteps; i++) {
    const res = await page.evaluate(() => {
      const w = window as unknown as { __infweb?: { ctrl: any } };
      const c = w.__infweb?.ctrl;
      if (!c) return 'noctrl';
      const s = c.state;
      if (s.ended) return 'ended';
      if (c.overlay.kind === 'handover') {
        c.dismissHandover();
        return 'handover';
      }
      if (c.overlay.kind === 'stuck') {
        c.acceptStuck(true);
        return 'stuck';
      }
      if (c.overlay.kind !== 'none') {
        c.closeOverlay();
        return 'overlay';
      }
      if (!c.isLocalTurn || c.busy) return 'wait';
      const cells = s.field.cells;
      const adj = s.field.adj;
      if (s.phase === 'attack') {
        for (let a = 0; a < cells.length; a++) {
          const A = cells[a];
          if (A.owner !== s.current || A.power < 2) continue;
          const greys = s.settings.duelRules && adj[a].some((d: number) => cells[d].owner === -1);
          for (const d of adj[a]) {
            const D = cells[d];
            if (D.owner === s.current) continue;
            if (greys && D.owner !== -1) continue;
            if (A.power - D.power >= 1 || D.power === 0) {
              c.tap(a);
              c.tap(d);
              return 'attack';
            }
          }
        }
        c.endButton(true);
        return 'endAttack';
      }
      // power: put everything into border cells by tapping
      for (let a = 0; a < cells.length; a++) {
        const A = cells[a];
        if (A.owner === s.current && A.power < A.maxPower && adj[a].some((d: number) => cells[d].owner !== s.current)) {
          c.tap(a);
          return 'power';
        }
      }
      c.endButton(true);
      return 'auto';
    });
    if (res === 'ended') return;
    if (res === 'noctrl') throw new Error('no game controller');
    if (res === 'wait') await page.waitForTimeout(30);
  }
  throw new Error('match did not finish');
}

export async function expectNoErrors(errors: string[]) {
  expect(errors, errors.join('\n')).toEqual([]);
}

/** Wait until a game screen is mounted (debug hook available). */
export async function waitGame(page: Page) {
  await page.waitForFunction(() => !!(window as unknown as { __infweb?: unknown }).__infweb);
}
