#!/usr/bin/env node
/**
 * Cross-network online test: one side runs somewhere (e.g. a GitHub runner, see
 * .github/workflows/cross-network.yml), the other one on your machine (e.g. behind a VPN).
 * Each side is a headless Chromium page of the app that drives DuelSession / BattleHost / BattleGuest
 * directly (window.__infwebNet) and auto-plays its seat with a greedy script.
 *
 *   ROLE=host  KIND=duel   CODE=AB2C  MINUTES=15 node scripts/cross-network.mjs
 *   ROLE=guest KIND=duel   CODE=AB2C             node scripts/cross-network.mjs
 *   ROLE=host  KIND=battle CODE=AB2CD GUESTS=2   node scripts/cross-network.mjs   # host seat + 2 online seats
 *   ROLE=guest KIND=battle CODE=AB2CD            node scripts/cross-network.mjs   # run once per guest
 *
 * Env:
 *   ROLE      host | guest
 *   KIND      duel (4-character code) | battle (5-character code)
 *   CODE      room code; the host creates the room with exactly this code (random if omitted)
 *   BASE_URL  site to load (e.g. https://<user>.github.io/influence-web/); default: a local Vite dev server
 *   LINK      auto (WebRTC, relay fallback) | relay | direct   (default auto)
 *   MINUTES   host: keep the room open this long (new match after each end); guest: give up after this long
 *   ROUNDS    guest: rounds to play before finishing successfully (default 12)
 *   GUESTS    battle host: number of online seats (default 1)
 *   THINK_MS  duel: one move per this many ms (human pace); default 0 = whole turns at once
 *   HEADED=1  show the browser
 *   PROXY     e.g. socks5://127.0.0.1:1081: route the page's TCP traffic through a proxy
 *
 * The page runs with ?netdebug=1; the end of the run prints how often each net log event happened
 * (path switches, Nostr socket hops / freezes, re-sends) and the latencies.
 *
 * Every turn both sides log the round, current seat, action seq and state hash. The protocol itself
 * compares hashes (duel acks / battle per-action hashes) and re-syncs on a difference; the guest exits
 * non-zero on any re-sync (= mismatch), a fatal error or a timeout.
 */
import { chromium } from '@playwright/test';

const ROLE = process.env.ROLE ?? 'guest';
const KIND = process.env.KIND ?? 'duel';
const LINK = process.env.LINK ?? 'auto';
const MINUTES = Number(process.env.MINUTES ?? (ROLE === 'host' ? 15 : 10));
const ROUNDS = Number(process.env.ROUNDS ?? 12);
const GUESTS = Number(process.env.GUESTS ?? 1);
let CODE = (process.env.CODE ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const t0 = Date.now();
const say = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] [${ROLE}]`, ...a);

if (!['host', 'guest'].includes(ROLE) || !['duel', 'battle'].includes(KIND)) {
  console.error('ROLE must be host|guest, KIND duel|battle');
  process.exit(2);
}
if (ROLE === 'guest' && !CODE) {
  console.error('CODE is required for the guest');
  process.exit(2);
}
const len = KIND === 'duel' ? 4 : 5;
if (CODE && (CODE.length !== len || /[01IO]/.test(CODE))) {
  console.error(`${KIND} codes have ${len} characters from A-Z / 2-9 without I, O`);
  process.exit(2);
}
if (!CODE) {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  CODE = Array.from({ length: len }, () => A[Math.floor(Math.random() * A.length)]).join('');
}

let server = null;
let base = process.env.BASE_URL;
if (!base) {
  const { createServer } = await import('vite');
  const port = Number(process.env.PORT ?? 5197);
  server = await createServer({
    server: { port, strictPort: true, host: '127.0.0.1' },
    optimizeDeps: { include: ['peerjs', 'preact', 'mqtt'] },
    logLevel: 'warn',
  });
  await server.listen();
  base = `http://127.0.0.1:${port}/influence-web/`;
}
const url = `${base}${base.includes('?') ? '&' : '?'}${LINK !== 'auto' ? `transport=${LINK}` : 'x=1'}&netdebug=1`;
say(`${KIND} room ${CODE}, link ${LINK}, page ${url}`);

// PROXY=socks5://127.0.0.1:1081: the page's TCP traffic (signalling, relays) goes through that proxy
const browser = await chromium.launch({ headless: !process.env.HEADED, proxy: process.env.PROXY ? { server: process.env.PROXY, bypass: '127.0.0.1,localhost' } : undefined });
const page = await (await browser.newContext()).newPage();
page.on('pageerror', (e) => say('page error', String(e).slice(0, 300)));
page.on('console', (m) => {
  if (m.type() === 'error' && !/favicon|Failed to load resource|abacus/.test(m.text())) say('console', m.text().slice(0, 300));
});
await page.route('**/abacus.jasoncameron.dev/**', (r) =>
  r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"value":0}' }),
);
await page.goto(url);
await page.waitForFunction(() => !!window.__infwebNet, null, { timeout: 60_000 });

/** in-page agent: creates the session and plays */
await page.evaluate(
  ({ role, kind, code, guests, think }) => {
    const N = window.__infwebNet;
    const X = (window.__x = { events: [], resyncs: 0, fatal: null, turn: -1, ended: null, link: null, matches: 0, rounds: 0, rtts: [], reqs: [], lrtts: [], handoffs: [], endAt: 0 });
    const ev = (type, data) => X.events.push({ type, at: Date.now(), ...data });
    const chance = (a, d) => (a <= 1 ? 0 : d === 0 ? 1 : a - d <= -2 ? 0 : a - d === -1 ? 0.25 : a - d === 0 ? 0.5 : a - d === 1 ? 0.75 : 1);
    /** greedy candidate attacks for `seat`, best first */
    const moves = (st, seat) => {
      const out = [];
      const cells = st.field.cells;
      cells.forEach((c, a) => {
        if (c.owner !== seat || c.power < 2) return;
        for (const d of st.field.adj[a]) {
          if (cells[d].owner === seat) continue;
          const p = chance(c.power, cells[d].power);
          if (p >= 0.5) out.push({ from: a, to: d, s: p * 100 + c.power - cells[d].power });
        }
      });
      return out.sort((x, y) => y.s - x.s);
    };
    let busy = false;
    let lastKey = '';
    const logTurn = (st, seq, hash) => {
      const key = `${st.turn}:${st.current}`;
      if (key === lastKey) return;
      lastKey = key;
      X.turn = st.turn;
      ev('turn', { round: st.turn, current: st.current, seq, hash });
    };

    if (kind === 'duel') {
      const make = () =>
        role === 'host'
          ? N.DuelSession.host({ code, storage: null, size: 'M', name: 'xnet-host', hostFirst: true })
          : N.DuelSession.join(code, { storage: null, name: 'xnet-guest', clientId: `xnet-guest-${code}` }); // one guest id per room: runs can repeat
      const s = make();
      X.session = s;
      s.onState((st) => logTurn(st, s.seq, N.stateHash(st)));
      s.onStatus((st) => ev('status', { status: st, code: s.code, link: s.link }));
      s.on('connection', (c) => ev('connection', { connected: c, link: s.link }));
      s.on('resync', (r) => {
        X.resyncs++;
        ev('resync', { reason: r });
      });
      s.onError((e) => {
        ev('error', { code: e.code, message: e.message, fatal: e.fatal });
        if (e.fatal) X.fatal = e.code;
      });
      s.onEnd((e) => {
        X.ended = e;
        X.matches++;
        ev('end', { winner: e.winner, reason: e.reason, round: e.turn });
        // keep the room going: both sides ask for a rematch
        setTimeout(() => s.requestRematch(), 1000);
      });
      // turn handoff: our endTurn → the opponent's first move arrives (≈ round trip + its 0-400 ms tick)
      s.on('remoteAction', () => {
        if (X.endAt) X.handoffs.push(Date.now() - X.endAt);
        X.endAt = 0;
      });
      let lastRtt = null;
      let lastLrtt = null;
      setInterval(() => {
        X.link = s.link;
        if (s.rtt !== null && s.rtt !== lastRtt) X.rtts.push((lastRtt = s.rtt));
        if (s.linkRtt !== null && s.linkRtt !== lastLrtt) X.lrtts.push((lastLrtt = s.linkRtt));
        const st = s.state;
        if (!st) return;
        logTurn(st, s.seq, N.stateHash(st));
        if (!s.canAct) return;
        if (think > 0) {
          // human pace: one move per `think` ms
          if (Date.now() - (X.lastAct ?? 0) < think) return;
          X.lastAct = Date.now();
          const mv = moves(s.state, s.localSlot).find((m) => typeof s.attack(m.from, m.to) === 'object');
          if (!mv && s.endTurn()) X.endAt = Date.now();
          return;
        }
        for (let i = 0; i < 30 && s.canAct; i++) {
          const mv = moves(s.state, s.localSlot).find((m) => typeof s.attack(m.from, m.to) === 'object');
          if (!mv) break;
        }
        if (s.canAct && s.endTurn()) X.endAt = Date.now();
      }, think > 0 ? 100 : 400);
      return;
    }

    // battle
    let h = null;
    let g = null;
    const wire = (s) => {
      s.onState((st) => logTurn(st, s.seq, N.battleHash(st)));
      s.onStatus((st) => ev('status', { status: st, code: s.code }));
      s.on('resync', (r) => {
        X.resyncs++;
        ev('resync', { reason: r });
      });
      s.onError((e) => {
        ev('error', { code: e.code, message: e.message, fatal: e.fatal });
        if (e.fatal) X.fatal = e.code;
      });
      s.onEnd((e) => {
        X.ended = e;
        X.matches++;
        ev('end', { winner: e.winner, reason: e.reason, round: e.turn });
      });
    };
    const settings = {
      kind: 'battleOnline',
      size: 'M',
      players: ['human', ...Array.from({ length: guests }, () => 'online')],
      darkness: false,
      symmetry: true,
      crowded: false,
      unions: false,
      shuffle: false,
      duelRules: false,
    };
    const newHost = () => {
      h = N.BattleHost.create({ settings, code, storage: null, name: 'xnet-host' });
      X.session = h;
      wire(h);
      h.onRoster((r) => ev('roster', { seats: r.map((x) => `${x.seat}:${x.kind}:${x.connected ? 'on' : 'off'}:${x.link ?? '-'}`).join(' ') }));
    };
    if (role === 'host') newHost();
    else {
      g = N.BattleGuest.join(code, { storage: null, name: 'xnet-guest' });
      X.session = g;
      wire(g);
      g.on('connection', (c) => ev('connection', { connected: c, link: g.link }));
    }
    setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        if (h) {
          X.link = h.roster.filter((r) => r.kind === 'online').map((r) => r.link);
          if (h.status === 'lobby' && h.canStart) {
            ev('start', {});
            h.start();
          }
          if (h.status === 'ended') {
            // a new room with the same code for the next guest run
            await new Promise((r) => setTimeout(r, 5000));
            h.close();
            await new Promise((r) => setTimeout(r, 1500));
            newHost();
            return;
          }
          const st = h.state;
          if (!st || h.status !== 'playing') return;
          logTurn(st, h.seq, N.battleHash(st));
          const seat = st.current;
          if (st.settings.players[seat] !== 'human') return;
          for (let i = 0; i < 30 && !st.ended; i++) {
            const mv = moves(st, seat).find((m) => h.act(seat, { t: 'attack', from: m.from, to: m.to }).ok);
            if (!mv) break;
          }
          if (!st.ended) h.act(seat, { t: 'endTurn' });
        } else if (g) {
          X.link = g.link;
          const st = g.state;
          if (!st) return;
          logTurn(st, g.seq, N.battleHash(st));
          if (!g.canAct) return;
          for (let i = 0; i < 30 && g.canAct && g.state.phase === 'attack'; i++) {
            let ok = false;
            for (const m of moves(g.state, g.seat)) {
              const t0 = performance.now();
              const r = await g.request({ t: 'attack', from: m.from, to: m.to });
              X.reqs.push(Math.round(performance.now() - t0));
              if (r.ok) {
                ok = true;
                break;
              }
            }
            if (!ok) break;
          }
          if (g.canAct) await g.request({ t: 'endTurn' });
        }
      } catch (e) {
        ev('error', { code: 'script', message: String(e), fatal: false });
      } finally {
        busy = false;
      }
    }, 400);
  },
  { role: ROLE, kind: KIND, code: CODE, guests: GUESTS, think: Number(process.env.THINK_MS ?? 0) },
);

const stats = (a) => {
  if (!a?.length) return 'none';
  const s = [...a].sort((x, y) => x - y);
  const q = (f) => s[Math.min(s.length - 1, Math.floor(f * s.length))];
  return `n=${s.length} median ${q(0.5)} p90 ${q(0.9)} max ${s[s.length - 1]} ms`;
};
let shown = 0;
let exitCode = 0;
const deadline = t0 + MINUTES * 60_000;
let started = false;
let lastX = null;
let dumps = 0;
for (;;) {
  await new Promise((r) => setTimeout(r, 1500));
  const x = await page.evaluate(() => ({ ...window.__x, session: undefined, events: window.__x.events }));
  for (const e of x.events.slice(shown)) {
    const { type, at, ...rest } = e;
    say(type.padEnd(10), JSON.stringify(rest));
    if (type === 'status' && ['waiting', 'lobby', 'playing'].includes(rest.status)) started = true;
  }
  shown = x.events.length;
  lastX = x;
  if (process.env.NETDUMP && ++dumps % 6 === 0) {
    const full = await page.evaluate(() => window.__netlog ?? []).catch(() => []);
    (await import('node:fs')).writeFileSync(process.env.NETDUMP, full.map((e) => JSON.stringify(e)).join('\n'));
  }
  if (x.fatal && (ROLE === 'guest' || !started)) {
    say('FAIL fatal error', x.fatal);
    exitCode = 1;
    break;
  }
  if (ROLE === 'guest') {
    if (x.resyncs > 0) {
      say(`FAIL ${x.resyncs} re-sync(s): the states differed`);
      exitCode = 1;
      break;
    }
    if (x.turn >= ROUNDS || x.ended) {
      say(`PASS played to round ${x.turn}${x.ended ? ` (match ended: winner ${x.ended.winner}, ${x.ended.reason})` : ''}, link ${JSON.stringify(x.link)}, no mismatch`);
      break;
    }
  }
  if (Date.now() > deadline) {
    if (ROLE === 'guest') {
      say(`FAIL timeout after ${MINUTES} min at round ${x.turn}`);
      exitCode = 1;
    } else say(`done after ${MINUTES} min: ${x.matches} match(es) finished, ${x.resyncs} re-sync(s), link ${JSON.stringify(x.link)}`);
    break;
  }
}
const netlog = await page.evaluate(() => (window.__netlog ?? []).map((e) => e.ev + (e.try ? (e.fast ? '-fast' : '-retry') : ''))).catch(() => []);
if (process.env.NETDUMP) {
  const full = await page.evaluate(() => window.__netlog ?? []).catch(() => []);
  (await import('node:fs')).writeFileSync(process.env.NETDUMP, full.map((e) => JSON.stringify(e)).join('\n'));
}
const counts = {};
for (const e of netlog) counts[e] = (counts[e] ?? 0) + 1;
say(`net log: ${JSON.stringify(counts)}`);
if (lastX)
  say(
    `latency: link rtt ${stats(lastX.lrtts)}; game ping rtt ${stats(lastX.rtts)}; turn handoff ${stats(lastX.handoffs)}; battle requests ${stats(lastX.reqs)}`,
  );
await page.evaluate(() => {
  const s = window.__x?.session;
  if (!s) return;
  if (s.leave) s.leave();
  else s.close?.();
}).catch(() => {});
await new Promise((r) => setTimeout(r, 1000));
await browser.close();
if (server) await server.close();
process.exit(exitCode);
