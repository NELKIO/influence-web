import { expect, vi } from 'vitest';
import * as E from '../../src/core/engine';
import type { MatchState } from '../../src/core/types';
import { DuelSession, type HostOptions } from '../../src/net/duelSession';
import { MemoryStorage } from '../../src/net/persist';
import { stateHash } from '../../src/net/protocol';
import { createLoopbackPair, type LoopbackLink } from '../../src/net/transport';

export interface Duo {
  link: LoopbackLink;
  host: DuelSession;
  guest: DuelSession;
  hostStorage: MemoryStorage;
  guestStorage: MemoryStorage;
  resyncs: string[];
}

export async function makeDuo(opts: Partial<HostOptions> = {}): Promise<Duo> {
  const link = createLoopbackPair({ code: 'AB2C', hostClientId: 'H', guestClientId: 'G' });
  const hostStorage = new MemoryStorage();
  const guestStorage = new MemoryStorage();
  const host = DuelSession.host({
    transport: link.host,
    storage: hostStorage,
    clientId: 'H',
    name: 'Hosty',
    size: 'S',
    seed: 1234,
    hostFirst: true,
    pingMs: 0,
    ...opts,
  });
  const guest = DuelSession.join('ab2c', { transport: link.guest, storage: guestStorage, clientId: 'G', name: 'Guesty', pingMs: 0 });
  const resyncs: string[] = [];
  host.on('resync', (r) => resyncs.push(`host:${r}`));
  guest.on('resync', (r) => resyncs.push(`guest:${r}`));
  await link.flush();
  return { link, host, guest, hostStorage, guestStorage, resyncs };
}

/** Owners/powers/turn/current/phase equal on both sides. */
export function expectSame(a: MatchState | null, b: MatchState | null) {
  expect(a).toBeTruthy();
  expect(b).toBeTruthy();
  expect(stateHash(a!)).toBe(stateHash(b!));
  expect(a!.field.cells.map((c) => [c.owner, c.power])).toEqual(b!.field.cells.map((c) => [c.owner, c.power]));
  expect([a!.turn, a!.current, a!.phase, a!.powerLeft]).toEqual([b!.turn, b!.current, b!.phase, b!.powerLeft]);
  expect(a!.ended?.winner).toEqual(b!.ended?.winner);
}

/** Deterministic scripted attacker: best-odds attacks with chance >= 50%, at most `maxAttacks`. */
export function nextScriptedAttack(st: MatchState): { from: number; to: number } | null {
  let best: { from: number; to: number; score: number } | null = null;
  for (const from of E.cellsOf(st, st.current)) {
    for (const to of E.targetsFrom(st, from)) {
      const p = E.winChance(st.field.cells[from].power, st.field.cells[to].power);
      if (p < 0.5) continue;
      const score = p * 100 + st.field.cells[from].power - st.field.cells[to].power;
      if (!best || score > best.score) best = { from, to, score };
    }
  }
  return best;
}

/** Play one full turn of the active session with scripted moves (some manual power, rest auto). */
export function playScriptedTurn(s: DuelSession, maxAttacks = 30): void {
  for (let i = 0; i < maxAttacks; i++) {
    const st = s.state!;
    if (st.ended) return;
    const mv = nextScriptedAttack(st);
    if (!mv) break;
    const r = s.attack(mv.from, mv.to);
    expect(typeof r).toBe('object');
  }
  if (s.state!.ended) return;
  expect(s.endAttack()).toBe(true);
  // put 1 point manually on the first own cell that has room, rest via endTurn's auto power
  const st = s.state!;
  const own = E.cellsOf(st, st.current).find((i) => st.field.cells[i].power < st.field.cells[i].maxPower);
  if (own !== undefined && st.powerLeft > 0) expect(s.addPower(own, 1)).toBe(1);
  expect(s.endTurn()).toBe(true);
}

export function active(d: Duo): DuelSession {
  return d.host.isMyTurn ? d.host : d.guest;
}

/** Fake clocks/timers but keep real microtasks (loopback delivery uses queueMicrotask). */
export function fakeTimers() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
}
