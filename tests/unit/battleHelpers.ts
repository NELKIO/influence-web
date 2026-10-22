import { expect } from 'vitest';
import { createBot } from '../../src/ai';
import type { Bot } from '../../src/ai/types';
import * as E from '../../src/core/engine';
import type { BotType, FieldSize, MatchSettings, MatchState, PlayerType } from '../../src/core/types';
import { battleHash, type BattleRequest } from '../../src/net/battleProtocol';
import { BattleGuest, BattleHost, type RequestResult } from '../../src/net/battleRoom';
import { createLoopbackHub, type LoopbackHub } from '../../src/net/hub';
import { MemoryStorage } from '../../src/net/persist';
import { nextScriptedAttack } from './netHelpers';

export interface GuestSlot {
  cid: string;
  storage: MemoryStorage;
  g: BattleGuest;
}

export interface Room {
  hub: LoopbackHub;
  host: BattleHost;
  hostStorage: MemoryStorage;
  guests: GuestSlot[];
  bots: Map<number, Bot>;
  botSeed: number;
  resyncs: string[];
}

export interface RoomOptions {
  players: PlayerType[];
  size?: FieldSize;
  seed?: number;
  darkness?: boolean;
  shuffle?: boolean;
  unions?: boolean;
  duelRules?: boolean;
  /** how many guests join (default: one per online seat) */
  guests?: number;
  botSeed?: number;
  turnTime?: number;
}

export function battleSettings(o: RoomOptions): MatchSettings {
  return {
    kind: 'single',
    size: o.size ?? 'S',
    players: [...o.players],
    darkness: o.darkness ?? false,
    symmetry: true,
    crowded: false,
    unions: o.unions ?? false,
    shuffle: o.shuffle ?? false,
    duelRules: o.duelRules ?? false,
    turnTime: o.turnTime ?? 0,
  };
}

export async function makeRoom(o: RoomOptions): Promise<Room> {
  const hub = createLoopbackHub('BTL25');
  const hostStorage = new MemoryStorage();
  const host = BattleHost.create({
    settings: battleSettings(o),
    seed: o.seed ?? 77,
    name: 'Hosty',
    storage: hostStorage,
    clientId: 'HOST',
    transport: hub.host,
    heartbeatMs: 0,
  });
  const room: Room = { hub, host, hostStorage, guests: [], bots: new Map(), botSeed: o.botSeed ?? 5, resyncs: [] };
  host.on('resync', (r) => room.resyncs.push(`host:${r}`));
  await hub.flush();
  const n = o.guests ?? o.players.filter((p) => p === 'online').length;
  for (let i = 0; i < n; i++) addGuest(room, `G${i + 1}`);
  await hub.flush();
  return room;
}

export function addGuest(room: Room, cid: string, storage = new MemoryStorage()): GuestSlot {
  const g = BattleGuest.join('btl25', { transport: room.hub.guest(cid), storage, clientId: cid, name: `Guest ${cid}`, helloRetryMs: 0 });
  g.on('resync', (r) => room.resyncs.push(`${cid}:${r}`));
  const slot = { cid, storage, g };
  const old = room.guests.findIndex((s) => s.cid === cid);
  if (old >= 0) room.guests[old] = slot;
  else room.guests.push(slot);
  return slot;
}

/** Simulate a guest page reload: the session dies, a new one resumes from storage. */
export function reloadGuest(room: Room, cid: string): GuestSlot {
  const slot = room.guests.find((s) => s.cid === cid)!;
  slot.g.dispose();
  const g = BattleGuest.resume(slot.storage, { transport: room.hub.guest(cid), helloRetryMs: 0 })!;
  expect(g).toBeTruthy();
  g.on('resync', (r) => room.resyncs.push(`${cid}:${r}`));
  slot.g = g;
  return slot;
}

/** Simulate a host page reload. */
export function reloadHost(room: Room): BattleHost {
  room.host.dispose();
  const ep = room.hub.newHost();
  const host = BattleHost.resume(room.hostStorage, { transport: ep, heartbeatMs: 0 })!;
  expect(host).toBeTruthy();
  host.on('resync', (r) => room.resyncs.push(`host:${r}`));
  room.host = host;
  return host;
}

export function guestOf(room: Room, seat: number): GuestSlot | undefined {
  return room.guests.find((s) => s.g.seat === seat && s.g.status !== 'error');
}

export function botFor(room: Room, seat: number, type: BotType): Bot {
  let b = room.bots.get(seat);
  if (!b || b.type !== type) {
    b = createBot(type === 'master' || type === 'god' ? 'hunter' : type, { seed: room.botSeed * 31 + seat });
    room.bots.set(seat, b);
  }
  return b;
}

const ctx = { speedMs: 0 };

/** A bot turn on the host, applied to host.state through the engine and published (power in a batch). */
export async function hostBotTurn(room: Room, seat: number): Promise<void> {
  const h = room.host;
  const st = h.state!;
  const bot = botFor(room, seat, st.settings.players[seat] as BotType);
  for (let i = 0; i < 500; i++) {
    if (st.ended || st.current !== seat) return;
    const mv = await bot.nextAttack(st, ctx);
    if (!mv) break;
    const ev = E.attack(st, mv.from, mv.to);
    if (typeof ev === 'string') throw new Error(`bot illegal ${ev}`);
    expect(h.publishFight(ev)).toBeTruthy();
  }
  if (st.ended || st.current !== seat) return;
  E.endAttack(st);
  h.publish({ seat, a: { t: 'endAttack' } });
  if (st.ended) return;
  const placement = await bot.placePower(st, ctx);
  const applied: [number, number][] = [];
  for (const [c, n] of placement) {
    const a = E.addPower(st, c, n);
    if (a) applied.push([c, a]);
  }
  if (st.powerLeft > 0) for (const [c, n] of E.autoPower(st)) applied.push([c, n]);
  for (const [cell, amount] of applied) h.publish({ seat, a: { t: 'power', cell, amount } });
  E.finishTurn(st);
  h.publish({ seat, a: { t: 'endTurn' } });
}

/** A scripted turn of a host-device human: attacks via engine + publish, power via host.act. */
export function hostHumanTurn(room: Room, seat: number): void {
  const h = room.host;
  const st = h.state!;
  for (let i = 0; i < 40; i++) {
    if (st.ended || st.current !== seat) return;
    const mv = nextScriptedAttack(st);
    if (!mv) break;
    if (i % 2 === 0) {
      const ev = E.attack(st, mv.from, mv.to);
      if (typeof ev === 'string') throw new Error(ev);
      h.publishFight(ev);
    } else {
      expect(h.act(seat, { t: 'attack', from: mv.from, to: mv.to }).ok).toBe(true);
    }
  }
  if (st.ended) return;
  expect(h.act(seat, { t: 'endAttack' }).ok).toBe(true);
  const own = E.cellsOf(st, seat).find((i) => st.field.cells[i].power < st.field.cells[i].maxPower);
  if (own !== undefined && st.powerLeft > 0) expect(h.act(seat, { t: 'addPower', cell: own, amount: 1 }).ok).toBe(true);
  expect(h.act(seat, { t: 'endTurn' }).ok).toBe(true);
}

/** Send a request and deliver everything; returns the result, or null if it is still pending. */
export async function send(room: Room, g: BattleGuest, req: BattleRequest): Promise<RequestResult | null> {
  let res: RequestResult | null = null;
  void g.request(req).then((r) => (res = r));
  await room.hub.flush();
  await Promise.resolve();
  return res;
}

/** A scripted guest turn through requests (greedy attacks with >= 50 %, 1 manual power point, end). */
export async function guestTurn(room: Room, g: BattleGuest, maxAttacks = 40): Promise<void> {
  for (let i = 0; i < maxAttacks; i++) {
    const st = g.state;
    if (!st || !g.canAct || st.phase !== 'attack') break;
    const mv = nextScriptedAttack(st);
    if (!mv) break;
    const r = await send(room, g, { t: 'attack', from: mv.from, to: mv.to });
    if (!r || !r.ok) break;
  }
  if (!g.canAct) return;
  if (g.state!.phase === 'attack') await send(room, g, { t: 'endAttack' });
  const st = g.state!;
  if (g.canAct && st.phase === 'power' && st.powerLeft > 0) {
    const own = E.cellsOf(st, g.seat).find((i) => st.field.cells[i].power < st.field.cells[i].maxPower);
    if (own !== undefined) await send(room, g, { t: 'addPower', cell: own, amount: 1 });
  }
  if (g.canAct) await send(room, g, { t: 'endTurn' });
}

/** Play the current seat's turn (bot / host human / guest). Returns false if nothing could be done. */
export async function playTurn(room: Room): Promise<boolean> {
  const st = room.host.state!;
  if (st.ended) return false;
  const seat = st.current;
  const kind = st.settings.players[seat];
  if (kind === 'online') {
    const slot = guestOf(room, seat);
    if (!slot || !slot.g.canAct) return false;
    await guestTurn(room, slot.g);
  } else if (kind === 'human') {
    hostHumanTurn(room, seat);
  } else {
    await hostBotTurn(room, seat);
  }
  await room.hub.flush();
  return true;
}

export function cellsOf(st: MatchState) {
  return st.field.cells.map((c) => [c.owner, c.power]);
}

/** Every connected guest has exactly the host's state. */
export function expectAllSame(room: Room, label = ''): void {
  const hs = room.host.state!;
  for (const { cid, g } of room.guests) {
    if (g.status === 'error' || !g.connected) continue;
    expect(g.state, `${label} ${cid} has state`).toBeTruthy();
    const gs = g.state!;
    expect(battleHash(gs), `${label} ${cid} hash`).toBe(battleHash(hs));
    expect(cellsOf(gs), `${label} ${cid} cells`).toEqual(cellsOf(hs));
    expect([gs.turn, gs.current, gs.phase, gs.powerLeft]).toEqual([hs.turn, hs.current, hs.phase, hs.powerLeft]);
    expect(gs.ended?.winner, `${label} ${cid} winner`).toEqual(hs.ended?.winner);
    expect(g.seq, `${label} ${cid} seq`).toBe(room.host.seq);
    // localisation: own seat human, other persons remote, bots unchanged
    gs.settings.players.forEach((p, i) => {
      const hp = hs.settings.players[i];
      if (i === g.seat) expect(p).toBe('human');
      else if (E.isPersonType(hp)) expect(p).toBe('remote');
      else expect(p).toBe(hp);
    });
  }
}

/** Reconnect everything, heartbeat and deliver until quiet. */
export async function heal(room: Room): Promise<void> {
  room.hub.clearDrops();
  room.hub.reconnectAll();
  for (let i = 0; i < 3; i++) {
    await room.hub.flush();
    room.host.heartbeat();
    await room.hub.flush();
  }
}
