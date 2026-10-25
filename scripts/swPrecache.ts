import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';

/** Files of the build that are not part of the app shell. */
const SKIP = /^(sw\.js|sitemap\.xml|og\.png|index\.html)$|\.(map|woff)$/;

/**
 * What the service worker stores at install: the page itself ('./') and every file it may need
 * offline (scripts and worker chunks, styles, fonts, manifest, icons). Paths are relative to the
 * worker's scope. Only woff2 fonts: every browser with service workers reads them, so the woff
 * fallbacks would never be fetched.
 */
export function precacheList(files: string[]): string[] {
  const list = files
    .map((f) => f.split(sep).join('/'))
    .filter((f) => !SKIP.test(f))
    .sort()
    .map((f) => `./${f}`);
  return ['./', ...list];
}

/** Cache version: changes whenever any precached file or the page changes. */
export function precacheVersion(list: string[], page: string): string {
  return createHash('sha256').update(list.join('\n')).update('\n').update(page).digest('hex').slice(0, 12);
}

/** Put the version and the list into a built sw.js (placeholders `VERSION = 'dev'` and `PRECACHE = []`). */
export function fillServiceWorker(source: string, version: string, list: string[]): string {
  const v = "const VERSION = 'dev';";
  const p = 'const PRECACHE = [];';
  if (!source.includes(v) || !source.includes(p)) throw new Error('sw.js: precache placeholders not found');
  return source.replace(v, `const VERSION = ${JSON.stringify(version)};`).replace(p, `const PRECACHE = ${JSON.stringify(list)};`);
}

function walk(dir: string, root = dir, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, root, out);
    else out.push(relative(root, p));
  }
  return out;
}

/** Vite plugin: after the build is written, fills public/sw.js (copied to the output) with the app shell. */
export function swPrecache(): Plugin {
  let outDir = 'dist';
  return {
    name: 'infweb-sw-precache',
    apply: 'build',
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
    },
    writeBundle: {
      order: 'post',
      handler() {
        const sw = join(outDir, 'sw.js');
        const list = precacheList(walk(outDir));
        const version = precacheVersion(list, readFileSync(join(outDir, 'index.html'), 'utf8'));
        writeFileSync(sw, fillServiceWorker(readFileSync(sw, 'utf8'), version, list));
      },
    },
  };
}
