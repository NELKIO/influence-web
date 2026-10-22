/**
 * Dev-only page that drives a battle room (BattleHost / BattleGuest) over the real PeerJS transport,
 * or over BroadcastChannel with `?transport=bc` (several tabs of one browser). Not part of the
 * production build. Used by scripts/battle-smoke.mjs and usable by hand: Host in one browser, Join with
 * the 5-letter code in others, Start when every online seat is taken. With "autoplay" the host runs the
 * bots and its own seats, guests play greedy scripted turns.
 */
import { createBot, type Bot } from '../src/ai';
import * as E from '../src/core/engine';
import type { BotType, MatchSettings, PlayerType } from '../src/core/types';
import { BattleGuest, BattleHost, battleHash, type KVStorage } from '../src/net';
import { useBroadcastTransport } from '../src/net/broadcast';

const params = new URLSearchParams(location.search);
const peerDebug = Number(params.get('debug') ?? 1) as 0 | 1 | 2 | 3;
const peer = { log: true, peer: { debug: peerDebug } };
// tabs of one browser share localStorage: in bc mode every tab needs its own client id / save
const storage: KVStorage = useBroadcastTransport() ? sessionStorage : localStorage;

let host: BattleHost | null = null;
let guest: BattleGuest | null = null;
let busy = false;
const errors: string[] = [];
const resyncs: string[] = [];
let applied = 0;
const bots = new Map<number, Bot>();
const logEl = document.getElementById('log')!;
const infoEl = document.getElementById('info')!;

function log(...a: unknown[]) {
  const line = `${new Date().toISOString().slice(11, 23)} ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`;
  logEl.textContent = `${line}\n${logEl.textContent}`.slice(0, 20000);
  console.log('[battle]', ...a);
}

function settingsOf(seats: PlayerType[], size: MatchSettings['size'] = 'M'): MatchSettings {
  return { kind: 'single', size, players: seats, darkness: false, symmetry: true, crowded: false, unions: false, shuffle: false, duelRules: false };
}

function wireHost(h: BattleHost) {
  host = h;
  h.onStatus((s) => log('status', s, h.code));
  h.onRoster((r) => log('roster', r.map((x) => `${x.seat}:${x.kind}${x.connected ? '' : '(off)'}:${x.name ?? ''}`).join(' ')));
  h.onError((e) => {
    errors.push(e.code);
    log('error', e);
  });
  h.on('resync', (r) => {
    resyncs.push(r);
    log('resync', r);
  });
  h.onApplied(() => applied++);
  h.onEnd((e) => log('end', e));
  return info();
}

function wireGuest(g: BattleGuest) {
  guest = g;
  g.onStatus((s) => log('status', s, g.code, 'seat', g.seat));
  g.onRoster((r) => log('roster', r.map((x) => `${x.seat}:${x.kind}${x.connected ? '' : '(off)'}:${x.name ?? ''}`).join(' ')));
  g.onError((e) => {
    errors.push(e.code);
    log('error', e);
  });
  g.on('resync', (r) => {
    resyncs.push(r);
    log('resync', r);
  });
  g.on('connection', (c) => log('connection', c));
  g.onApplied(() => applied++);
  g.onEnd((e) => log('end', e));
  return info();
}

function info() {
  const s = host ?? guest;
  const st = s?.state ?? null;
  return {
    role: host ? 'host' : guest ? 'guest' : null,
    status: s?.status ?? 'none',
    code: s?.code ?? null,
    seat: guest?.seat ?? -1,
    connected: guest ? guest.connected : !!host?.ready,
    canStart: host?.canStart ?? false,
    seq: s?.seq ?? 0,
    hash: st ? battleHash(st) : '',
    turn: st?.turn ?? -1,
    current: st?.current ?? -1,
    ended: st?.ended ?? null,
    roster: s?.roster ?? [],
    applied,
    errors: [...errors],
    resyncs: [...resyncs],
  };
}

function render() {
  infoEl.textContent = JSON.stringify(info(), null, 1).slice(0, 3000);
}

function greedy(st: import('../src/core/types').MatchState) {
  let best: { from: number; to: number; score: number } | null = null;
  for (const from of E.cellsOf(st, st.current))
    for (const to of E.targetsFrom(st, from)) {
      const p = E.winChance(st.field.cells[from].power, st.field.cells[to].power);
      if (p < 0.5) continue;
      const score = p * 100 + st.field.cells[from].power - st.field.cells[to].power;
      if (!best || score > best.score) best = { from, to, score };
    }
  return best;
}

/** host: play one turn of a bot / host-device seat (applied to host.state, published) */
async function hostTurn(h: BattleHost) {
  const st = h.state!;
  const seat = st.current;
  const kind = st.settings.players[seat];
  if (kind === 'online' || st.ended) return;
  if (kind === 'human') {
    for (let i = 0; i < 30 && !st.ended; i++) {
      const mv = greedy(st);
      if (!mv) break;
      h.act(seat, { t: 'attack', from: mv.from, to: mv.to });
    }
    if (!st.ended) h.act(seat, { t: 'endTurn' });
    return;
  }
  let bot = bots.get(seat);
  if (!bot || bot.type !== kind) bots.set(seat, (bot = createBot(kind as BotType, { seed: seat + 1 })));
  const ctx = { speedMs: 0 };
  for (let i = 0; i < 300 && !st.ended && st.current === seat; i++) {
    const mv = await bot.nextAttack(st, ctx);
    if (!mv) break;
    const ev = E.attack(st, mv.from, mv.to);
    if (typeof ev === 'string') break;
    h.publishFight(ev);
  }
  if (st.ended || st.current !== seat) return;
  E.endAttack(st);
  h.publish({ seat, a: { t: 'endAttack' } });
  const placement = await bot.placePower(st, ctx);
  for (const [cell, n] of placement) {
    const added = E.addPower(st, cell, n);
    if (added) h.publish({ seat, a: { t: 'power', cell, amount: added } });
  }
  for (const [cell, amount] of E.autoPower(st)) h.publish({ seat, a: { t: 'power', cell, amount } });
  E.finishTurn(st);
  h.publish({ seat, a: { t: 'endTurn' } });
}

/** guest: one scripted turn through requests */
async function guestTurn(g: BattleGuest): Promise<boolean> {
  if (!g.canAct) return false;
  for (let i = 0; i < 30; i++) {
    const st = g.state!;
    if (!g.canAct || st.phase !== 'attack') break;
    const mv = greedy(st);
    if (!mv) break;
    const r = await g.request({ t: 'attack', from: mv.from, to: mv.to });
    if (!r.ok) break;
  }
  if (g.canAct) await g.request({ t: 'endTurn' });
  return true;
}

async function tick() {
  if (busy || !(document.getElementById('auto') as HTMLInputElement).checked) return;
  busy = true;
  try {
    if (host?.state && host.status === 'playing') await hostTurn(host);
    else if (guest?.state && guest.status === 'playing') await guestTurn(guest);
  } catch (e) {
    log('autoplay error', String(e));
  } finally {
    busy = false;
  }
}

const api = {
  host: (seats: string = 'human,online,online,hunter', size: MatchSettings['size'] = 'M') =>
    wireHost(BattleHost.create({ settings: settingsOf(seats.split(',') as PlayerType[], size), name: 'HarnessHost', storage, peer })),
  start: () => host?.start() ?? false,
  fill: (type: BotType = 'dummy') => host?.fillWithBots(type) ?? [],
  join: (code: string, name = 'HarnessGuest') => wireGuest(BattleGuest.join(code, { name, storage, peer })),
  resume: () => {
    const h = BattleHost.resume(storage, { peer });
    if (h) return wireHost(h);
    const g = BattleGuest.resume(storage, { peer });
    return g ? wireGuest(g) : null;
  },
  saved: () => BattleHost.saved(storage) ?? BattleGuest.saved(storage),
  autoplay: (on: boolean) => ((document.getElementById('auto') as HTMLInputElement).checked = on),
  info,
  leave: () => {
    host?.close();
    guest?.leave();
    host = guest = null;
    render();
  },
  clear: () => {
    BattleHost.clearSaved(storage);
    BattleGuest.clearSaved(storage);
  },
};
(window as unknown as { B: typeof api }).B = api;

const val = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
document.getElementById('host')!.onclick = () => api.host(val('seats'));
document.getElementById('start')!.onclick = () => api.start();
document.getElementById('fill')!.onclick = () => api.fill();
document.getElementById('join')!.onclick = () => api.join(val('code'));
document.getElementById('resume')!.onclick = () => api.resume();
document.getElementById('leave')!.onclick = () => api.leave();
setInterval(() => void tick(), 150);
setInterval(render, 500);
log('battle harness ready', useBroadcastTransport() ? '(BroadcastChannel)' : '(PeerJS)');
