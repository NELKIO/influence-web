// Renders public/icon.svg to PNG icons using Playwright's Chromium.
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const svg = readFileSync(new URL('../public/icon.svg', import.meta.url), 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [size, name, pad] of [
  [180, 'apple-touch-icon.png', 0],
  [192, 'icon-192.png', 0],
  [512, 'icon-512.png', 0],
  [512, 'icon-maskable-512.png', 56],
]) {
  await page.setViewportSize({ width: size, height: size });
  const inner = size - pad * 2;
  await page.setContent(
    `<html><body style="margin:0;background:#05070f;width:${size}px;height:${size}px;display:grid;place-items:center">` +
      svg.replace('<svg ', `<svg width="${inner}" height="${inner}" `) +
      '</body></html>',
  );
  await page.screenshot({ path: new URL(`../public/${name}`, import.meta.url).pathname });
}
await browser.close();
console.log('icons rendered');
