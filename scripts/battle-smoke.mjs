#!/usr/bin/env node
/**
 * Smoke test of online battle rooms (host + 2 guests + a bot): starts the Vite dev server, opens
 * dev/battle-harness.html three times and plays a match with autoplay. Checks the lobby, a bad code,
 * identical states, a guest page reload and a host page reload (resume from storage).
 *
 *   node scripts/battle-smoke.mjs                 # real network: WebRTC, falling back to the MQTT relay
 *   LINK=relay node scripts/battle-smoke.mjs      # real network, relay only (?transport=relay)
 *   TRANSPORT=bc node scripts/battle-smoke.mjs    # three tabs of one browser over BroadcastChannel
 *   HEADED=1 SEATS=human,online,online,online,hunter node scripts/battle-smoke.mjs
 *
 * The real-network variant needs internet access (0.peerjs.com, STUN) and a network where WebRTC works
 * (it does not behind a VPN/TUN that blocks UDP). Not part of the unit tests.
 */
import { createServer } from 'vite';
import { chromium } from '@playwright/test';

const PORT = Number(process.env.PORT ?? 5198);
const BC = process.env.TRANSPORT === 'bc';
const SEATS = process.env.SEATS ?? 'human,online,online,hunter';
const ROUNDS = Number(process.env.ROUNDS ?? 12);
const GUESTS = SEATS.split(',').filter((s) => s === 'online').length;
const t0 = Date.now();
const say = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  say(ok ? 'PASS' : 'FAIL', name, extra);
};
const info = (p) => p.evaluate(() => window.B.info());

async function waitFor(page, pred, arg, timeout, label) {
  try {
    await page.waitForFunction(pred, arg, { timeout, polling: 200 });
    return true;
  } catch {
    say(`timeout waiting for ${label}`, JSON.stringify(await page.evaluate(() => window.B?.info())).slice(0, 600));
    return false;
  }
}

const server = await createServer({
  server: { port: PORT, strictPort: true, host: '127.0.0.1' },
  optimizeDeps: { include: ['peerjs', 'preact'] },
  logLevel: 'warn',
});
await server.listen();
const mode = BC ? '&transport=bc' : process.env.LINK ? `&transport=${process.env.LINK}` : '';
const url = `http://127.0.0.1:${PORT}/influence-web/dev/battle-harness.html?debug=${process.env.PEER_DEBUG ?? 1}${mode}`;
say('dev server at', url, BC ? '(BroadcastChannel)' : '(PeerJS)');

const browser = await chromium.launch({
  headless: !process.env.HEADED,
  args: process.env.KEEP_MDNS ? [] : ['--disable-features=WebRtcHideLocalIpsWithMdns'],
});
const shared = BC ? await browser.newContext() : null;
const pages = [];
for (let i = 0; i <= GUESTS + 1; i++) {
  const ctx = shared ?? (await browser.newContext());
  pages.push(await ctx.newPage());
}
const [A, ...rest] = pages;
const guests = rest.slice(0, GUESTS);
const stranger = rest[GUESTS];
pages.forEach((p, i) =>
  p.on('console', (m) => {
    const t = m.text();
    if (process.env.VERBOSE || /error|fatal|status|resync|end /i.test(t)) say(`${i ? `G${i}` : 'H'}>`, t.slice(0, 200));
  }),
);

const all = () => [A, ...guests];
const setAuto = (on) => Promise.all(all().map((p) => p.evaluate((v) => window.B.autoplay(v), on)));
/** pause autoplay, wait until everybody has the host's seq + hash */
async function same(label) {
  await setAuto(false);
  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) {
    await sleep(250);
    const xs = await Promise.all(all().map(info));
    ok = xs.every((x) => x.seq === xs[0].seq && x.hash === xs[0].hash);
    if (ok) say(label, 'seq', xs[0].seq, 'turn', xs[0].turn, 'ended', JSON.stringify(xs[0].ended));
    else if (i === 59) say(label, 'MISMATCH', JSON.stringify(xs.map((x) => [x.seq, x.hash, x.connected, x.status])));
  }
  await setAuto(true);
  return ok;
}

let exitCode = 0;
try {
  await Promise.all(pages.map((p) => p.goto(url)));
  await Promise.all(pages.map((p) => p.waitForFunction(() => !!window.B)));
  await Promise.all(pages.map((p) => p.evaluate(() => window.B.clear())));

  // ---- host
  await A.evaluate(([s]) => window.B.host(s, 'M'), [SEATS]);
  const hosted = await waitFor(A, () => window.B.info().status === 'lobby', null, 30_000, 'host lobby');
  const { code } = await info(A);
  check('host registered the battle room', hosted && /^[A-Z0-9]{5}$/.test(code ?? ''), `code=${code}`);
  if (!hosted) throw new Error('room not registered');

  // ---- bad code
  await stranger.evaluate(() => window.B.join('ZZ9ZZ'));
  const bad = await waitFor(stranger, () => window.B.info().status === 'error', null, 30_000, 'bad code error');
  check('bad room code -> clear error', bad && (await info(stranger)).errors.includes('bad-code'));

  // ---- guests
  const tJoin = Date.now();
  for (const [i, g] of guests.entries()) await g.evaluate(([c, n]) => window.B.join(c, n), [code.toLowerCase(), `Guest${i + 1}`]);
  const lobby = await waitFor(A, () => window.B.info().canStart, null, 60_000, 'all seats taken');
  check(`${GUESTS} guests connected and took their seats`, lobby, `${Date.now() - tJoin} ms`);
  if (!lobby) throw new Error('guests could not connect');
  await A.evaluate(() => window.B.start());
  let started = true;
  for (const g of guests) started = (await waitFor(g, () => window.B.info().status === 'playing', null, 20_000, 'guest playing')) && started;
  check('match started on every device', started);

  // ---- play
  const playRounds = async (n) => {
    const target = (await info(A)).turn + n;
    await waitFor(A, (t) => window.B.info().turn >= t || !!window.B.info().ended, target, 120_000, `round ${target}`);
  };
  await playRounds(3);
  check('states identical after 3 rounds', await same('sync1'));

  // ---- guest reload
  const g0 = guests[0];
  await g0.reload();
  await g0.waitForFunction(() => !!window.B);
  await g0.evaluate(() => window.B.resume());
  const back = await waitFor(g0, () => window.B.info().status === 'playing' && window.B.info().connected, null, 60_000, 'guest resumed');
  check('guest page reload -> resumed its seat', back && (await same('after guest reload')));

  await playRounds(2);

  // ---- host reload
  await A.reload();
  await A.waitForFunction(() => !!window.B);
  await A.evaluate(() => window.B.resume());
  const hostBack = await waitFor(A, () => ['playing', 'ended'].includes(window.B.info().status) && window.B.info().connected, null, 90_000, 'host resumed');
  check('host page reload -> same room code', hostBack && (await info(A)).code === code);
  check('guests re-dialled after the host reload', await same('after host reload'));

  await playRounds(ROUNDS);
  check('states identical at the end', await same('final'));
  const fin = await info(A);
  check('no fatal transport errors on the host', fin.errors.length === 0, JSON.stringify(fin.errors));
  say('links: host sees', JSON.stringify(fin.link), 'guests:', JSON.stringify(await Promise.all(guests.map(async (g) => (await info(g)).link))));
} catch (e) {
  say('ERROR', e?.message ?? e);
  exitCode = 1;
} finally {
  await Promise.all(pages.map((p) => p.evaluate(() => window.B?.leave()).catch(() => {})));
  await browser.close();
  await server.close();
}
const failed = results.filter((r) => !r.ok);
say(`${results.length - failed.length}/${results.length} checks passed`);
process.exit(exitCode || failed.length ? 1 : 0);
