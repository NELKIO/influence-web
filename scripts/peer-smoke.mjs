#!/usr/bin/env node
/**
 * Real-network smoke test of online duels: starts the Vite dev server, opens dev/peer-harness.html
 * in two isolated Chromium contexts and plays a duel over WebRTC (PeerJS broker), falling back to the
 * MQTT relay when WebRTC cannot connect (LINK=relay|direct forces one path).
 * Also checks a bad room code, a guest page reload and a host page reload (resume from localStorage).
 *
 *   node scripts/peer-smoke.mjs            # headless
 *   HEADED=1 node scripts/peer-smoke.mjs
 *
 * Needs internet access (0.peerjs.com, STUN). Not part of the unit tests.
 */
import { createServer } from 'vite';
import { chromium } from '@playwright/test';

const PORT = Number(process.env.PORT ?? 5199);
const MAX_TURNS = Number(process.env.TURNS ?? 60);
const t0 = Date.now();
const say = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  say(ok ? 'PASS' : 'FAIL', name, extra);
};

async function waitFor(page, pred, arg, timeout, label) {
  try {
    await page.waitForFunction(pred, arg, { timeout, polling: 200 });
    return true;
  } catch {
    say(`timeout waiting for ${label}`, JSON.stringify(await page.evaluate(() => window.H?.info())));
    return false;
  }
}
const info = (p) => p.evaluate(() => window.H.info());

const server = await createServer({
  server: { port: PORT, strictPort: true, host: '127.0.0.1' },
  // pre-bundle peerjs so the dev server does not reload the page when it is first imported
  optimizeDeps: { include: ['peerjs', 'preact'] },
  logLevel: 'warn',
});
await server.listen();
const url = `http://127.0.0.1:${PORT}/influence-web/dev/peer-harness.html?debug=${process.env.PEER_DEBUG ?? 1}${process.env.LINK ? `&transport=${process.env.LINK}` : ''}`;
say('dev server at', url);

// Chromium hides local IPs behind mDNS names; resolving those between two headless contexts is
// unreliable on some hosts, so expose real host candidates (STUN/TURN candidates are unaffected).
const browser = await chromium.launch({
  headless: !process.env.HEADED,
  args: process.env.KEEP_MDNS ? [] : ['--disable-features=WebRtcHideLocalIpsWithMdns'],
});
const ctxA = await browser.newContext();
const ctxB = await browser.newContext();
const ctxC = await browser.newContext();
const A = await ctxA.newPage();
const B = await ctxB.newPage();
const C = await ctxC.newPage();
for (const [n, p] of [
  ['A', A],
  ['B', B],
  ['C', C],
])
  p.on('console', (m) => {
    const t = m.text();
    if (process.env.VERBOSE || /error|fatal|status|resync|end /i.test(t)) say(`${n}>`, t.slice(0, 200));
  });

let exitCode = 0;
try {
  await Promise.all([A.goto(url), B.goto(url), C.goto(url)]);
  await Promise.all([A, B, C].map((p) => p.waitForFunction(() => !!window.H)));

  // ---- environment probe: can this machine open any WebRTC data channel (same page, no network)?
  const probe = await A.evaluate(() => window.H.loopbackProbe());
  say('local WebRTC loopback (environment probe):', probe);
  if (probe !== 'open') say('NOTE: WebRTC is blocked on this machine (VPN/TUN, firewall?): the duel has to use the MQTT relay');

  // ---- host
  await A.evaluate(() => window.H.host({ size: 'M', hostFirst: true }));
  const hosted = await waitFor(A, () => window.H.info().status === 'waiting', null, 30_000, 'host waiting');
  const { code } = await info(A);
  check('host registered room on broker', hosted && !!code, `code=${code}`);
  if (!hosted) throw new Error('broker not reachable');

  // ---- bad code
  await C.evaluate(() => window.H.join('ZZ9Z'));
  const bad = await waitFor(C, () => window.H.info().status === 'error', null, 30_000, 'bad code error');
  check('bad room code -> clear error', bad && (await info(C)).errors.includes('bad-code'), JSON.stringify((await info(C)).errors));

  // ---- guest
  const tJoin = Date.now();
  await B.evaluate((c) => window.H.join(c), code.toLowerCase());
  const joined =
    (await waitFor(B, () => window.H.info().status === 'playing', null, 45_000, 'guest playing')) &&
    (await waitFor(A, () => window.H.info().status === 'playing', null, 10_000, 'host playing'));
  check('guest connected and got the match', joined, `${Date.now() - tJoin} ms, link ${(await info(B)).link}`);
  if (!joined) throw new Error('P2P connection failed');

  const same = async () => {
    const [a, b] = [await info(A), await info(B)];
    return a.seq === b.seq && a.hash === b.hash;
  };
  const syncUp = async () => {
    for (let i = 0; i < 100; i++) {
      if (await same()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };

  let turns = 0;
  let mismatches = 0;
  const play = async (n) => {
    for (let i = 0; i < n; i++) {
      const a = await info(A);
      if (a.ended) return;
      const p = a.isMyTurn ? A : B;
      const ok = await p.evaluate(() => window.H.playTurn());
      if (!ok) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      if (!(await syncUp())) {
        mismatches++;
        say('mismatch after turn', turns, JSON.stringify(await info(A)), JSON.stringify(await info(B)));
      }
      turns++;
    }
  };

  await play(6);
  check('6 turns played, states identical after each', mismatches === 0 && turns >= 6, `turns=${turns}`);

  // ---- guest reload
  const seqBefore = (await info(B)).seq;
  await B.reload();
  await B.waitForFunction(() => !!window.H);
  const savedB = await B.evaluate(() => window.H.saved());
  await B.evaluate(() => window.H.resume());
  const tRe = Date.now();
  const resumedB =
    (await waitFor(B, () => window.H.info().status === 'playing', null, 60_000, 'guest resumed')) && (await syncUp());
  check('guest page reload -> resumed', resumedB && (await info(B)).seq >= seqBefore, `${Date.now() - tRe} ms, saved=${JSON.stringify(savedB)}`);

  await play(4);

  // ---- host reload (same room code must be re-registered)
  await A.reload();
  await A.waitForFunction(() => !!window.H);
  await A.evaluate(() => window.H.resume());
  const tHr = Date.now();
  const resumedA =
    (await waitFor(A, () => window.H.info().status === 'playing', null, 90_000, 'host resumed')) &&
    (await waitFor(B, () => window.H.info().status === 'playing', null, 60_000, 'guest back to playing')) &&
    (await syncUp());
  check('host page reload -> resumed with the same code', resumedA && (await info(A)).code === code, `${Date.now() - tHr} ms`);

  await play(MAX_TURNS);
  const [fa, fb] = [await info(A), await info(B)];
  check('states identical at the end', fa.hash === fb.hash && fa.seq === fb.seq, `turns=${turns} seq=${fa.seq} ended=${JSON.stringify(fa.ended)}`);
  check('no desyncs', mismatches === 0);
  say('rtt host/guest ms:', fa.rtt, fb.rtt, 'remote fights seen host/guest:', fa.remoteFights, fb.remoteFights);
  if (fa.ended) {
    const won = fa.ended.winner === fa.localSlot;
    check('both sides agree on the winner', fb.ended && fb.ended.winner === fa.ended.winner, won ? 'host won' : 'guest won');
  }
} catch (e) {
  say('ERROR', e?.message ?? e);
  exitCode = 1;
} finally {
  await A.evaluate(() => window.H?.leave()).catch(() => {});
  await B.evaluate(() => window.H?.leave()).catch(() => {});
  await browser.close();
  await server.close();
}
const failed = results.filter((r) => !r.ok);
say(`${results.length - failed.length}/${results.length} checks passed`);
process.exit(exitCode || failed.length ? 1 : 0);
