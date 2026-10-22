/**
 * Several online duels at once. Every match lives in its own "slot" with an isolated storage
 * namespace, so DuelSession persistence (one session per storage) works unchanged. Sessions stay
 * connected in the background while the player is on other screens or in another match.
 */
import * as net from '../net';
import { DuelSession, getClientId, type KVStorage } from '../net';
import { BroadcastTransport, useBroadcastTransport } from '../net/broadcast';
import { randomId } from '../net/room';

export const MAX_DUELS = 5;

// scripted cross-network tests (scripts/cross-network.mjs) drive sessions directly through this
if (typeof window !== 'undefined') (window as unknown as { __infwebNet: typeof net }).__infwebNet = net;

const BC = useBroadcastTransport();
const REGISTRY = 'infweb.duelSlots';

class PrefixedStorage implements KVStorage {
  constructor(
    private base: Storage,
    private prefix: string,
  ) {}
  getItem(k: string) {
    return this.base.getItem(this.prefix + k);
  }
  setItem(k: string, v: string) {
    this.base.setItem(this.prefix + k, v);
  }
  removeItem(k: string) {
    this.base.removeItem(this.prefix + k);
  }
  clear() {
    const keys: string[] = [];
    for (let i = 0; i < this.base.length; i++) {
      const k = this.base.key(i);
      if (k?.startsWith(this.prefix)) keys.push(k);
    }
    keys.forEach((k) => this.base.removeItem(k));
  }
}

function baseStorage(): Storage {
  return BC ? sessionStorage : localStorage;
}

function storageFor(id: string): PrefixedStorage {
  return new PrefixedStorage(baseStorage(), `infweb.duel/${id}/`);
}

interface SlotInfo {
  id: string;
  createdAt: number;
}

function readRegistry(): SlotInfo[] {
  try {
    return JSON.parse(baseStorage().getItem(REGISTRY) || '[]');
  } catch {
    return [];
  }
}

function writeRegistry(list: SlotInfo[]) {
  try {
    baseStorage().setItem(REGISTRY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

const live = new Map<string, DuelSession>();
const unsubs = new Map<string, (() => void)[]>();
const listeners = new Set<() => void>();
let viewing: string | null = null;
let notify: ((text: string, slot: string) => void) | null = null;

export function onDuelsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function changed() {
  listeners.forEach((f) => f());
}

/** Called by the app to show "your turn in room X" when the player is elsewhere. */
export function setDuelNotifier(fn: (kind: string, slot: string) => void) {
  notify = fn;
}

export function setViewing(id: string | null) {
  viewing = id;
}

function watch(id: string, s: DuelSession) {
  live.set(id, s);
  const offs = [
    s.onStatus(changed),
    s.on('connection', changed),
    s.onState(changed),
    s.onOpponent(changed),
    s.onRematch(changed),
    s.onTurn((info) => {
      changed();
      if (info.mine && viewing !== id) notify?.('turn', id);
    }),
    s.onEnd(() => {
      changed();
      if (viewing !== id) notify?.('end', id);
    }),
  ];
  unsubs.set(id, offs);
  changed();
}

export function slotSession(id: string): DuelSession | null {
  return live.get(id) ?? null;
}

export function slotIdOf(s: DuelSession): string | null {
  for (const [id, x] of live) if (x === s) return id;
  return null;
}

/** All known matches (live or restorable), newest first. */
export function listSlots(): { id: string; session: DuelSession | null; createdAt: number }[] {
  return readRegistry()
    .map((r) => ({ id: r.id, session: live.get(r.id) ?? null, createdAt: r.createdAt }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

function addSlot(): string {
  const id = randomId(5);
  writeRegistry([...readRegistry(), { id, createdAt: Date.now() }]);
  return id;
}

export function canCreate(): boolean {
  return readRegistry().length < MAX_DUELS;
}

export function hostDuel(opts: { size: 'M' | 'L' | 'XL' | 'S' | 'XXL'; darkness: boolean; turnTime: number }): { id: string; session: DuelSession } {
  const id = addSlot();
  const storage = storageFor(id);
  const s = DuelSession.host({
    ...opts,
    symmetry: true,
    storage,
    transport: BC ? BroadcastTransport.host(getClientId(storage)) : undefined,
  });
  watch(id, s);
  return { id, session: s };
}

export function joinDuel(code: string): { id: string; session: DuelSession } {
  // already in this room?
  for (const slot of listSlots()) {
    const s = slot.session;
    if (s && s.code === code) return { id: slot.id, session: s };
  }
  const id = addSlot();
  const storage = storageFor(id);
  const s = DuelSession.join(code, { storage, transport: BC ? BroadcastTransport.join(code, getClientId(storage)) : undefined });
  watch(id, s);
  return { id, session: s };
}

/** Reconnect every saved match that is not running yet (after a page reload). */
export function resumeAll() {
  for (const slot of readRegistry()) {
    if (live.has(slot.id)) continue;
    const storage = storageFor(slot.id);
    const info = DuelSession.saved(storage, 7 * 24 * 3600_000);
    if (!info) {
      writeRegistry(readRegistry().filter((r) => r.id !== slot.id));
      continue;
    }
    const s = DuelSession.resume({
      storage,
      maxAgeMs: 7 * 24 * 3600_000,
      transport: BC ? (info.role === 'host' ? BroadcastTransport.host(getClientId(storage), info.code) : BroadcastTransport.join(info.code, getClientId(storage))) : undefined,
    });
    if (s) watch(slot.id, s);
  }
  migrateLegacy();
  changed();
}

/** Duels saved by the single-session version live directly under the default storage. */
function migrateLegacy() {
  if (BC) return;
  const info = DuelSession.saved();
  if (!info || readRegistry().length >= MAX_DUELS) return;
  const s = DuelSession.resume();
  if (!s) return;
  const id = addSlot();
  watch(id, s);
}

/** Leave a match for good (the caller concedes first if the match is running). */
export function removeSlot(id: string) {
  const s = live.get(id);
  unsubs.get(id)?.forEach((f) => f());
  unsubs.delete(id);
  live.delete(id);
  if (s) s.leave();
  storageFor(id).clear();
  writeRegistry(readRegistry().filter((r) => r.id !== id));
  changed();
}

/** Number of matches where it is the local player's move. */
export function myTurnCount(): number {
  let n = 0;
  for (const s of live.values()) if (s.state && !s.state.ended && s.isMyTurn) n++;
  return n;
}
