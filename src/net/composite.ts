/**
 * Link factories for duels and battle rooms: every path (direct WebRTC via PeerJS, the PeerJS
 * signalling relay, Nostr relays, MQTT brokers) is started at once and combined by multipath.ts, so
 * the game uses the direct link when it works and the relays otherwise, switching without a stall.
 *
 * Link mode (`?transport=` in the page URL, or `mode`): 'auto' (all paths, default), 'direct' (WebRTC
 * only), 'relay' (all relays, no WebRTC), 'peerrelay', 'nostr' or 'mqtt' (that relay only);
 * `?transport=bc` selects the BroadcastChannel test transport elsewhere.
 */
import type { MultiHostTransport } from './hub';
import { Emitter, type Unsubscribe } from './emitter';
import { MultiPeerHost } from './multiPeer';
import { RelayGuest, RelayHost, type RelayKind, type RelayOptions } from './mqttRelay';
import { MultiPathGuest, MultiPathHost, type GuestPathSpec, type HostPathSpec, type MpOptions, type PathKind } from './multipath';
import { createPeerRelayGuest, createPeerRelayHost, type PeerRelayOptions } from './peerSignalRelay';
import { createNostrGuest, createNostrHost, type NostrOptions } from './nostrRelay';
import { PROTOCOL_VERSION } from './protocol';
import { BATTLE_PROTOCOL_VERSION } from './battleProtocol';
import {
  BATTLE_CODE_LENGTH,
  BATTLE_PEER_ID_PREFIX,
  CODE_LENGTH,
  generateBattleCode,
  generateCode,
  PEER_ID_PREFIX,
} from './room';
import {
  PeerTransport,
  type LinkKind,
  type PeerTransportOptions,
  type Transport,
  type TransportError,
  type TransportEvents,
  type TransportRole,
} from './transport';

export type LinkMode = 'auto' | 'direct' | 'relay' | 'peerrelay' | 'nostr' | 'mqtt';

const MODE_PATHS: Record<LinkMode, PathKind[]> = {
  auto: ['direct', 'peerrelay', 'nostr', 'mqtt'],
  direct: ['direct'],
  relay: ['peerrelay', 'nostr', 'mqtt'],
  peerrelay: ['peerrelay'],
  nostr: ['nostr'],
  mqtt: ['mqtt'],
};

/** Link mode from the page URL (`?transport=...`), 'auto' otherwise. */
export function linkModeFromUrl(): LinkMode {
  if (typeof location === 'undefined') return 'auto';
  const v = new URLSearchParams(location.search).get('transport');
  return v && v in MODE_PATHS ? (v as LinkMode) : 'auto';
}

export interface NetLinkOptions {
  /** PeerJS (WebRTC) tuning */
  peer?: Omit<PeerTransportOptions, 'clientId'>;
  /** MQTT relay tuning (brokers, client factory, timings); false disables it */
  relay?: RelayOptions | false;
  /** PeerJS signalling relay tuning; false disables it */
  peerRelay?: PeerRelayOptions | false;
  /** Nostr relay tuning; false disables it */
  nostr?: NostrOptions | false;
  /** multipath tuning */
  mp?: MpOptions & { readyWaitMs?: number; restartMs?: number; maxRestartMs?: number; badCodeGraceMs?: number };
  /** default: from the URL, else 'auto' */
  mode?: LinkMode;
  /** no longer used: all paths start together */
  fallbackMs?: number;
}

// ====================================================================== host (one guest, duels)

/**
 * 1:1 host Transport over a MultiHostTransport: the first guest (or `expectClientId`) is bound,
 * everybody else is refused ('room-full' on their side).
 */
export class SingleHost implements Transport {
  readonly role: TransportRole = 'host';
  isOpen = false;
  remoteClientId: string | null;
  private em = new Emitter<TransportEvents>();
  private offs: Unsubscribe[];

  constructor(
    readonly multi: MultiHostTransport,
    expectClientId: string | null = null,
  ) {
    this.remoteClientId = expectClientId;
    this.offs = [
      multi.onReady((c) => this.em.emit('ready', c)),
      multi.onJoin((cid) => {
        if (this.remoteClientId && cid !== this.remoteClientId) {
          if (multi.refuse) multi.refuse(cid);
          else multi.kick(cid);
          return;
        }
        this.remoteClientId = cid;
        if (this.isOpen) this.em.emit('close');
        this.isOpen = true;
        this.em.emit('open');
      }),
      multi.onLeave((cid) => {
        if (cid !== this.remoteClientId || !this.isOpen) return;
        this.isOpen = false;
        this.em.emit('close');
      }),
      multi.onMessage((cid, m) => {
        if (cid === this.remoteClientId && this.isOpen) this.em.emit('message', m);
      }),
      multi.onError((e) => this.em.emit('error', e)),
    ];
  }

  get code(): string | null {
    return this.multi.code;
  }

  get linkKind(): LinkKind | null {
    return this.isOpen && this.remoteClientId ? (this.multi.linkOf?.(this.remoteClientId) ?? null) : null;
  }

  /** ping round trip of the path in use (ms), when the host transport measures it */
  get linkRtt(): number | null {
    const m = this.multi as MultiHostTransport & { rttOf?: (cid: string) => number | null };
    return this.isOpen && this.remoteClientId && m.rttOf ? m.rttOf(this.remoteClientId) : null;
  }

  send(msg: unknown): boolean {
    return this.isOpen && !!this.remoteClientId && this.multi.send(this.remoteClientId, msg);
  }

  close(): void {
    this.offs.forEach((f) => f());
    this.multi.close();
    if (this.isOpen) {
      this.isOpen = false;
      this.em.emit('close');
    }
  }

  /** close but keep the relay presence (resume later) */
  detach(): void {
    this.offs.forEach((f) => f());
    const m = this.multi as MultiHostTransport & { detach?: () => void };
    if (m.detach) m.detach();
    else m.close();
    this.isOpen = false;
  }

  onReady(cb: (code: string) => void) {
    return this.em.on('ready', cb);
  }
  onOpen(cb: () => void) {
    return this.em.on('open', cb);
  }
  onClose(cb: () => void) {
    return this.em.on('close', cb);
  }
  onMessage(cb: (msg: unknown) => void) {
    return this.em.on('message', cb);
  }
  onError(cb: (err: TransportError) => void) {
    return this.em.on('error', cb);
  }
}

// ====================================================================== factories

interface HostFactoryOptions extends NetLinkOptions {
  clientId: string;
  /** room code (generated when omitted) */
  code?: string;
  /** kept for callers; the code is always kept as given */
  fixed?: boolean;
}

function pathKinds(o: NetLinkOptions): PathKind[] {
  const kinds = MODE_PATHS[o.mode ?? linkModeFromUrl()];
  return kinds.filter((k) => !((k === 'mqtt' && o.relay === false) || (k === 'peerrelay' && o.peerRelay === false) || (k === 'nostr' && o.nostr === false)));
}

/** a hello older pages understand: they answer it with their version error («обновите страницу») */
function probe(kind: RelayKind, clientId: string, role: 'host' | 'guest'): (() => Record<string, unknown>) | undefined {
  if (kind === 'duel') return () => ({ t: 'hello', v: PROTOCOL_VERSION, clientId, name: '', matchId: null, seq: 0, hash: '', ended: null, rematch: false });
  if (role === 'guest') return () => ({ t: 'bHello', v: BATTLE_PROTOCOL_VERSION, clientId, name: '', matchId: null, seq: 0, hash: '' });
  return undefined;
}

function hostTransport(kind: RelayKind, o: HostFactoryOptions): MultiPathHost {
  const code = o.code ?? (kind === 'duel' ? generateCode() : generateBattleCode());
  const specs: HostPathSpec[] = [];
  for (const k of pathKinds(o)) {
    if (k === 'direct')
      specs.push({
        kind: k,
        create: (c) =>
          new MultiPeerHost({
            ...o.peer,
            clientId: o.clientId,
            code: c,
            fixedCode: true,
            idPrefix: kind === 'duel' ? PEER_ID_PREFIX : BATTLE_PEER_ID_PREFIX,
            maxGuests: kind === 'duel' ? 2 : 5,
          }),
      });
    else if (k === 'peerrelay') specs.push({ kind: k, create: (c) => createPeerRelayHost(kind, c, o.clientId, o.peerRelay || {}) });
    else if (k === 'nostr') specs.push({ kind: k, create: (c) => createNostrHost(kind, c, o.clientId, o.nostr || {}) });
    else specs.push({ kind: k, create: (c) => new RelayHost(kind, c, { ...(o.relay || {}), clientId: o.clientId, fixed: true }) });
  }
  return new MultiPathHost(specs, { ...o.mp, code, helloProbe: probe(kind, o.clientId, 'host') });
}

/** Battle room host over every path. */
export function createBattleHostTransport(o: HostFactoryOptions): MultiPathHost {
  return hostTransport('battle', o);
}

/** Duel host (1:1) over every path. */
export function createDuelHostTransport(o: HostFactoryOptions & { expectClientId?: string | null }): SingleHost {
  return new SingleHost(hostTransport('duel', o), o.expectClientId ?? null);
}

function guestTransport(kind: RelayKind, code: string, o: NetLinkOptions & { clientId: string }): MultiPathGuest {
  const specs: GuestPathSpec[] = [];
  for (const k of pathKinds(o)) {
    if (k === 'direct')
      specs.push({
        kind: k,
        create: () =>
          PeerTransport.join(code, {
            ...o.peer,
            clientId: o.clientId,
            idPrefix: kind === 'duel' ? PEER_ID_PREFIX : BATTLE_PEER_ID_PREFIX,
            codeLength: kind === 'duel' ? CODE_LENGTH : BATTLE_CODE_LENGTH,
          }),
      });
    else if (k === 'peerrelay') specs.push({ kind: k, create: () => createPeerRelayGuest(kind, code, o.clientId, o.peerRelay || {}) });
    else if (k === 'nostr') specs.push({ kind: k, create: () => createNostrGuest(kind, code, o.clientId, o.nostr || {}) });
    else specs.push({ kind: k, create: () => new RelayGuest(kind, code, o.clientId, o.relay || {}) });
  }
  return new MultiPathGuest(code, specs, { ...o.mp, helloProbe: probe(kind, o.clientId, 'guest') });
}

export function createDuelGuestTransport(code: string, o: NetLinkOptions & { clientId: string }): MultiPathGuest {
  return guestTransport('duel', code, o);
}

export function createBattleGuestTransport(code: string, o: NetLinkOptions & { clientId: string }): MultiPathGuest {
  return guestTransport('battle', code, o);
}
