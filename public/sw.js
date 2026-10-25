// Offline support: the whole app shell is stored at install, so the game works offline right
// after the first visit. Pages are network-first (the cached page is the fallback), files are
// cache-first (their names carry content hashes).
//
// The build (scripts/swPrecache.ts) fills in VERSION and PRECACHE: every script, worker chunk,
// style, font and icon of that build. A new build changes this file, so the browser installs the
// new worker, which takes over at once and deletes the caches of older builds.
const VERSION = 'dev';
const PRECACHE = [];
const CACHE = `infweb-${VERSION}`;
const PAGE = './';
const SHELL = [...new Set([PAGE, './manifest.webmanifest', './icon-192.png', ...PRECACHE])];

self.addEventListener('install', (e) => {
  // straight from the network: a stale HTTP cache must not end up in the new shell
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('infweb-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** The app's own page (any hash or query), as opposed to sitemap.xml and the like. */
function isAppPage(url) {
  const scope = new URL(PAGE, self.registration.scope).pathname;
  return url.pathname === scope || url.pathname === scope + 'index.html';
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && isAppPage(url)) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(PAGE, copy));
          }
          return res;
        })
        .catch(() => caches.open(CACHE).then((c) => c.match(PAGE, { ignoreVary: true })).then((hit) => hit || Response.error())),
    );
    return;
  }
  // ignoreVary: the shell is stored without an Origin header, while module scripts, styles and
  // fonts are requested with one (servers answer "Vary: Origin"); the names carry content hashes
  e.respondWith(
    caches.match(req, { ignoreVary: true }).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok && (url.pathname.includes('/assets/') || /\.(png|svg|webmanifest|woff2?)$/.test(url.pathname))) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
