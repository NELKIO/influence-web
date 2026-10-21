/**
 * Dev-only page that drives DuelSession over the real PeerJS transport.
 * Not part of the production build (Vite only builds index.html). Used by scripts/peer-smoke.mjs,
 * and usable by hand: open it in two browsers, Host in one, Join with the code in the other.
 */
import * as E from '../src/core/engine';
import { DuelSession, stateHash, type HostOptions } from '../src/net';

let session: DuelSession | null = null;
const params = new URLSearchParams(location.search);
const peerDebug = Number(params.get('debug') ?? 1) as 0 | 1 | 2 | 3;
const peerOpts = { log: true, peer: { debug: peerDebug } };
const errors: string[] = [];
const fights: number[] = [];
const logEl = document.getElementById('log')!;
const infoEl = document.getElementById('info')!;

function log(...a: unknown[]) {
  const line = `${new Date().toISOString().slice(11, 23)} ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`;
  logEl.textContent = `${line}\n${logEl.textContent}`.slice(0, 20000);
  console.log('[harness]', ...a);
}

function wire(s: DuelSession) {
  session = s;
  (window as unknown as { session: DuelSession }).session = s;
  s.onStatus((st) => log('status', st, s.code ?? ''));
  s.onError((e) => {
    errors.push(e.code);
    log('error', e);
  });
  s.onOpponent((n) => log('opponent', n));
  s.onRemoteFight((f) => fights.push(f.win ? 1 : 0));
  s.onEnd((e) => log('end', e));
  s.on('connection', (c) => log('connection', c));
  s.on('resync', (r) => log('resync', r));
  s.onState(() => render());
  render();
  return info();
}

function info() {
  const s = session;
  return {
    role: s?.role ?? null,
    status: s?.status ?? 'none',
    code: s?.code ?? null,
    connected: s?.connected ?? false,
    seq: s?.seq ?? 0,
    hash: s?.state ? stateHash(s.state) : '',
    localSlot: s?.localSlot ?? -1,
    isMyTurn: s?.isMyTurn ?? false,
    turn: s?.state?.turn ?? -1,
    ended: s?.state?.ended ?? null,
    matchId: s?.matchId ?? null,
    rtt: s?.rtt ?? null,
    opponent: s?.opponentName ?? null,
    remoteFights: fights.length,
    errors: [...errors],
  };
}

function render() {
  infoEl.textContent = JSON.stringify(info());
}

function playTurn(maxAttacks = 25): boolean {
  const s = session;
  if (!s?.canAct) return false;
  for (let i = 0; i < maxAttacks && s.state && !s.state.ended; i++) {
    const st = s.state;
    let best: { from: number; to: number; score: number } | null = null;
    for (const from of E.cellsOf(st, st.current))
      for (const to of E.targetsFrom(st, from)) {
        const p = E.winChance(st.field.cells[from].power, st.field.cells[to].power);
        if (p < 0.5) continue;
        const score = p * 100 + st.field.cells[from].power - st.field.cells[to].power;
        if (!best || score > best.score) best = { from, to, score };
      }
    if (!best) break;
    s.attack(best.from, best.to);
  }
  if (s.state && !s.state.ended) s.endTurn();
  return true;
}

/** Same-page RTCPeerConnection pair: tells whether WebRTC works at all on this machine. */
async function loopbackProbe(timeoutMs = 10000): Promise<string> {
  const a = new RTCPeerConnection();
  const b = new RTCPeerConnection();
  a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
  b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
  const dc = a.createDataChannel('probe');
  const res = new Promise<string>((r) => {
    dc.onopen = () => r('open');
    setTimeout(() => r(`timeout (ice ${a.iceConnectionState})`), timeoutMs);
  });
  await a.setLocalDescription(await a.createOffer());
  await b.setRemoteDescription(a.localDescription!);
  await b.setLocalDescription(await b.createAnswer());
  await a.setRemoteDescription(b.localDescription!);
  const out = await res;
  a.close();
  b.close();
  return out;
}

const api = {
  loopbackProbe,
  host: (opts: Partial<HostOptions> = {}) => wire(DuelSession.host({ name: 'HarnessHost', peer: peerOpts, ...opts })),
  join: (code: string) => wire(DuelSession.join(code, { name: 'HarnessGuest', peer: peerOpts })),
  resume: () => {
    const s = DuelSession.resume({ peer: peerOpts });
    return s ? wire(s) : null;
  },
  saved: () => DuelSession.saved(),
  playTurn,
  info,
  leave: () => {
    session?.leave();
    session = null;
    render();
  },
  clear: () => {
    DuelSession.clearSaved();
    localStorage.clear();
  },
};
(window as unknown as { H: typeof api }).H = api;

document.getElementById('host')!.onclick = () => api.host({ size: 'M' });
document.getElementById('join')!.onclick = () => api.join((document.getElementById('code') as HTMLInputElement).value);
document.getElementById('resume')!.onclick = () => api.resume();
document.getElementById('turn')!.onclick = () => playTurn();
document.getElementById('leave')!.onclick = () => api.leave();
setInterval(render, 1000);
log('harness ready');
