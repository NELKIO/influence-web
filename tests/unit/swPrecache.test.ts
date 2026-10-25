import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fillServiceWorker, precacheList, precacheVersion } from '../../scripts/swPrecache';

const BUILD = [
  'index.html',
  'sw.js',
  'sitemap.xml',
  'og.png',
  'manifest.webmanifest',
  'icon-192.png',
  'icon.svg',
  'assets/index-abc.js',
  'assets/index-abc.css',
  'assets/master.worker-x1.js',
  'assets/god.worker-y2.js',
  'assets/manrope-latin-400-normal-q.woff2',
  'assets/manrope-latin-400-normal-q.woff',
  'assets/index-abc.js.map',
];

describe('service worker precache', () => {
  it('lists the page and the whole shell: scripts, worker chunks, styles, woff2 fonts, manifest, icons', () => {
    const list = precacheList(BUILD);
    expect(list[0]).toBe('./');
    for (const f of [
      './assets/index-abc.js',
      './assets/index-abc.css',
      './assets/master.worker-x1.js',
      './assets/god.worker-y2.js',
      './assets/manrope-latin-400-normal-q.woff2',
      './manifest.webmanifest',
      './icon-192.png',
      './icon.svg',
    ])
      expect(list).toContain(f);
    for (const f of ['./sw.js', './index.html', './sitemap.xml', './og.png', './assets/manrope-latin-400-normal-q.woff', './assets/index-abc.js.map'])
      expect(list).not.toContain(f);
  });

  it('versions the cache by the build: another asset or another page gives another cache', () => {
    const list = precacheList(BUILD);
    const v = precacheVersion(list, '<html>');
    expect(precacheVersion(list, '<html>')).toBe(v);
    expect(precacheVersion(precacheList([...BUILD, 'assets/index-def.js']), '<html>')).not.toBe(v);
    expect(precacheVersion(list, '<html >')).not.toBe(v);
  });

  it('fills the placeholders of public/sw.js and refuses a worker without them', () => {
    const src = readFileSync('public/sw.js', 'utf8');
    const out = fillServiceWorker(src, 'abc123', ['./', './assets/a.js']);
    expect(out).toContain('const VERSION = "abc123";');
    expect(out).toContain('const PRECACHE = ["./","./assets/a.js"];');
    expect(out).not.toContain("const VERSION = 'dev';");
    expect(() => fillServiceWorker('self.addEventListener("fetch", () => {});', 'x', [])).toThrow();
  });
});
