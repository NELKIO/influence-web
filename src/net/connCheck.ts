/**
 * «Проверка связи» (Settings): which online paths work from this network right now.
 *
 *   peerjs     the PeerJS signalling server (needed for the direct WebRTC link): time until it accepts us
 *   stun       Google / Cloudflare STUN through a throwaway RTCPeerConnection: our public address (srflx);
 *              two servers reporting different public ports for the same local port = a symmetric NAT,
 *              where a direct link rarely works without TURN
 *   peerrelay  a message to ourselves through the PeerJS server (the PeerJS relay)
 *   nostr:URL  an ephemeral event to ourselves through each Nostr relay
 *   mqtt:URL   CONNECT → CONNACK on each MQTT broker
 *
 * Verdict: direct (signalling + STUN, not symmetric) / relay (any relay echo) / none.
 * One run opens one PeerJS socket (the broker rate-limits sockets per IP), so runs are not repeated
 * automatically.
 */
import { DEFAULT_NOSTR_RELAYS, loadNostrCrypto, NOSTR_KIND, NostrSigner } from './nostrRelay';
import { DEFAULT_RELAY_BROKERS } from './mqttRelay';
import { defaultWsFactory, peerBrokerUrl, PEER_RELAY_MARK, type WsFactory, type WsLike } from './peerSignalRelay';
import { randomId } from './room';

export type CheckGroup = 'peerjs' | 'stun' | 'peerrelay' | 'nostr' | 'mqtt';

export interface CheckResult {
  id: string;
  group: CheckGroup;
  /** host name / server shown to the user */
  target: string;
  /** null while running */
  ok: boolean | null;
  ms: number | null;
  /** extra facts: 'symmetric' (STUN), the refusal text of a relay */
  detail?: string;
}

export interface ConnVerdict {
  direct: boolean;
  relay: boolean;
}

export interface ConnCheckOptions {
  ws?: WsFactory;
  rtc?: typeof RTCPeerConnection;
  nostrRelays?: string[];
  mqttBrokers?: string[];
  stunServers?: string[];
  timeoutMs?: number;
}

const host = (url: string) => url.replace(/^wss?:\/\//, '').replace(/[:/].*$/, '');

function openWs(factory: WsFactory, url: string, timeoutMs: number): Promise<WsLike> {
  return new Promise((resolve, reject) => {
    let ws: WsLike;
    try {
      ws = factory(url);
    } catch (e) {
      reject(e);
      return;
    }
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      reject(new Error('timeout'));
    }, timeoutMs);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve(ws);
    };
    ws.onclose = () => {
      clearTimeout(timer);
      reject(new Error('closed'));
    };
  });
}

/** PeerJS server: OPEN time, then a CANDIDATE to our own id (the relay) */
async function checkPeer(o: ConnCheckOptions, set: (r: CheckResult) => void) {
  const t = o.timeoutMs ?? 8000;
  const factory = o.ws ?? defaultWsFactory;
  const id = `iwchk-${randomId(5)}`;
  const t0 = Date.now();
  const res = await new Promise<{ open: number | null; echo: number | null; why?: string }>((resolve) => {
    let ws: WsLike;
    let openAt = 0;
    let done = false;
    const finish = (r: { open: number | null; echo: number | null; why?: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ open: openAt ? openAt - t0 : null, echo: null, why: 'timeout' }), t);
    try {
      ws = factory(peerBrokerUrl({}, id));
    } catch {
      finish({ open: null, echo: null });
      return;
    }
    let sentAt = 0;
    ws.onmessage = (ev) => {
      let m: { type?: string; payload?: { connectionId?: string } };
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (m.type === 'OPEN') {
        openAt = Date.now();
        set({ id: 'peerjs', group: 'peerjs', target: '0.peerjs.com', ok: true, ms: openAt - t0 });
        sentAt = Date.now();
        ws.send(
          JSON.stringify({
            type: 'CANDIDATE',
            dst: id,
            payload: { type: 'data', connectionId: PEER_RELAY_MARK, candidate: { candidate: 'iw:AA==', sdpMid: '0', sdpMLineIndex: 0 } },
          }),
        );
      } else if (m.type === 'CANDIDATE' && m.payload?.connectionId === PEER_RELAY_MARK) {
        finish({ open: openAt - t0, echo: Date.now() - sentAt });
      } else if (m.type === 'ID-TAKEN' || m.type === 'ERROR') finish({ open: null, echo: null, why: m.type });
    };
    ws.onclose = () => finish({ open: openAt ? openAt - t0 : null, echo: null, why: 'closed' });
    ws.onerror = () => {};
  });
  set({ id: 'peerjs', group: 'peerjs', target: '0.peerjs.com', ok: res.open !== null, ms: res.open });
  set({ id: 'peerrelay', group: 'peerrelay', target: '0.peerjs.com', ok: res.echo !== null, ms: res.echo });
}

/** STUN through a throwaway RTCPeerConnection */
async function checkStun(o: ConnCheckOptions, set: (r: CheckResult) => void) {
  const servers = o.stunServers ?? ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'];
  const target = servers.map((s) => s.replace(/^stun:/, '').replace(/:\d+$/, '')).join(', ');
  const RTC = o.rtc ?? (typeof RTCPeerConnection !== 'undefined' ? RTCPeerConnection : null);
  if (!RTC) return set({ id: 'stun', group: 'stun', target, ok: false, ms: null, detail: 'no-webrtc' });
  const t0 = Date.now();
  let pc: RTCPeerConnection;
  try {
    pc = new RTC({ iceServers: servers.map((urls) => ({ urls })) });
  } catch {
    return set({ id: 'stun', group: 'stun', target, ok: false, ms: null, detail: 'no-webrtc' });
  }
  const r = await new Promise<{ ms: number | null; symmetric: boolean }>((resolve) => {
    let first: number | null = null;
    // local port → public ports seen for it
    const ports = new Map<string, Set<string>>();
    const done = () => {
      clearTimeout(timer);
      let symmetric = false;
      for (const s of ports.values()) if (s.size > 1) symmetric = true;
      resolve({ ms: first, symmetric });
    };
    const timer = setTimeout(done, Math.min(o.timeoutMs ?? 8000, 6000));
    pc.onicecandidate = (e) => {
      if (!e.candidate) return done();
      const c = e.candidate.candidate;
      const m = / typ srflx raddr (\S+) rport (\d+)/.exec(c);
      if (!m) return;
      if (first === null) first = Date.now() - t0;
      const parts = c.split(' ');
      const pub = `${parts[4]}:${parts[5]}`;
      const base = `${parts[2]}|${m[1]}:${m[2]}`;
      let s = ports.get(base);
      if (!s) ports.set(base, (s = new Set()));
      s.add(pub);
    };
    try {
      pc.createDataChannel('probe');
      void pc
        .createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .catch(() => done());
    } catch {
      done();
    }
  });
  try {
    pc.close();
  } catch {
    /* ignore */
  }
  set({ id: 'stun', group: 'stun', target, ok: r.ms !== null, ms: r.ms, detail: r.symmetric ? 'symmetric' : undefined });
}

/** an ephemeral event to ourselves through one Nostr relay */
async function checkNostr(url: string, o: ConnCheckOptions, set: (r: CheckResult) => void) {
  const id = `nostr:${url}`;
  const t = o.timeoutMs ?? 8000;
  let ws: WsLike | null = null;
  try {
    const signer = new NostrSigner(await loadNostrCrypto());
    const t0 = Date.now();
    ws = await openWs(o.ws ?? defaultWsFactory, url, t);
    const topic = signer.topic(`infweb/check/${randomId(8)}`);
    const sub = `chk${randomId(3)}`;
    const w = ws;
    const res = await new Promise<{ ms: number | null; why?: string }>((resolve) => {
      let sentAt = 0;
      const timer = setTimeout(() => resolve({ ms: null, why: 'timeout' }), Math.max(1000, t - (Date.now() - t0)));
      w.onmessage = (ev) => {
        let m: unknown[];
        try {
          m = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (m[0] === 'EOSE' && m[1] === sub && !sentAt) {
          sentAt = Date.now();
          w.send(JSON.stringify(['EVENT', signer.event(NOSTR_KIND, [['t', topic]], 'check')]));
        } else if (m[0] === 'EVENT' && m[1] === sub) {
          clearTimeout(timer);
          resolve({ ms: Date.now() - sentAt });
        } else if (m[0] === 'OK' && m[2] === false) {
          clearTimeout(timer);
          resolve({ ms: null, why: String(m[3] ?? 'refused').slice(0, 80) });
        } else if (m[0] === 'CLOSED' && m[1] === sub) {
          clearTimeout(timer);
          resolve({ ms: null, why: String(m[2] ?? 'closed').slice(0, 80) });
        }
      };
      w.onclose = () => {
        clearTimeout(timer);
        resolve({ ms: null, why: 'closed' });
      };
      w.send(JSON.stringify(['REQ', sub, { kinds: [NOSTR_KIND], '#t': [topic] }]));
    });
    set({ id, group: 'nostr', target: host(url), ok: res.ms !== null, ms: res.ms, detail: res.why });
  } catch {
    set({ id, group: 'nostr', target: host(url), ok: false, ms: null });
  } finally {
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
  }
}

/** MQTT CONNECT → CONNACK over a WebSocket (MQTT 3.1.1, clean session) */
async function checkMqtt(url: string, o: ConnCheckOptions, set: (r: CheckResult) => void) {
  const id = `mqtt:${url}`;
  const t = o.timeoutMs ?? 8000;
  let ws: WsLike | null = null;
  try {
    const t0 = Date.now();
    const factory = (u: string) => {
      const s = new WebSocket(u, 'mqtt');
      s.binaryType = 'arraybuffer';
      return s as unknown as WsLike;
    };
    ws = await openWs(factory, url, t);
    const w = ws;
    const enc = new TextEncoder();
    const cid = enc.encode(`infwebchk${randomId(4)}`);
    const body = [0, 4, 77, 81, 84, 84, 4, 2, 0, 30, cid.length >> 8, cid.length & 255, ...cid];
    const ok = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), Math.max(1000, t - (Date.now() - t0)));
      w.onmessage = (ev) => {
        clearTimeout(timer);
        resolve(new Uint8Array(ev.data as ArrayBuffer)[0] === 0x20);
      };
      w.onclose = () => {
        clearTimeout(timer);
        resolve(false);
      };
      (w as unknown as WebSocket).send(new Uint8Array([0x10, body.length, ...body]));
    });
    set({ id, group: 'mqtt', target: host(url), ok, ms: ok ? Date.now() - t0 : null });
  } catch {
    set({ id, group: 'mqtt', target: host(url), ok: false, ms: null });
  } finally {
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
  }
}

export function connVerdict(results: CheckResult[]): ConnVerdict {
  const ok = (g: CheckGroup) => results.some((r) => r.group === g && r.ok);
  const stun = results.find((r) => r.group === 'stun');
  return {
    direct: ok('peerjs') && !!stun?.ok && stun.detail !== 'symmetric',
    relay: ok('peerrelay') || ok('nostr') || ok('mqtt'),
  };
}

/**
 * Run every check in parallel; `onUpdate` gets the full list after each change (pending entries have
 * ok === null). Resolves with the final list and the verdict.
 */
export async function runConnectionCheck(onUpdate: (results: CheckResult[]) => void, o: ConnCheckOptions = {}): Promise<{ results: CheckResult[]; verdict: ConnVerdict }> {
  const nostr = o.nostrRelays ?? DEFAULT_NOSTR_RELAYS;
  const mqtt = o.mqttBrokers ?? DEFAULT_RELAY_BROKERS;
  const list: CheckResult[] = [
    { id: 'peerjs', group: 'peerjs', target: '0.peerjs.com', ok: null, ms: null },
    { id: 'stun', group: 'stun', target: 'stun.l.google.com, stun.cloudflare.com', ok: null, ms: null },
    { id: 'peerrelay', group: 'peerrelay', target: '0.peerjs.com', ok: null, ms: null },
    ...nostr.map((u): CheckResult => ({ id: `nostr:${u}`, group: 'nostr', target: host(u), ok: null, ms: null })),
    ...mqtt.map((u): CheckResult => ({ id: `mqtt:${u}`, group: 'mqtt', target: host(u), ok: null, ms: null })),
  ];
  const set = (r: CheckResult) => {
    const i = list.findIndex((x) => x.id === r.id);
    if (i >= 0) list[i] = r;
    onUpdate([...list]);
  };
  onUpdate([...list]);
  await Promise.all([checkPeer(o, set), checkStun(o, set), ...nostr.map((u) => checkNostr(u, o, set)), ...mqtt.map((u) => checkMqtt(u, o, set))]);
  return { results: [...list], verdict: connVerdict(list) };
}

/** plain-text summary to paste into a chat */
export function connReport(results: CheckResult[], verdictLine: string): string {
  const lines = results.map((r) => `${r.group} ${r.target}: ${r.ok === null ? '…' : r.ok ? `ok ${r.ms ?? '?'} ms` : 'FAIL'}${r.detail ? ` (${r.detail})` : ''}`);
  return [verdictLine, ...lines].join('\n');
}
