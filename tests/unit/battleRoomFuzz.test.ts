/**
 * Randomised battle rooms: random seat mixes (2-6 seats, guests, host humans, bots), random network
 * trouble (link drops, lost messages in both directions, guest and host page reloads), concessions and
 * fillWithBots. After every healing point all peers must hold exactly the host's state.
 */
import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import type { FieldSize, PlayerType } from '../../src/core/types';
import * as E from '../../src/core/engine';
import { expectAllSame, guestOf, heal, makeRoom, playTurn, reloadGuest, reloadHost, send, type Room } from './battleHelpers';

/** BATTLE_FUZZ_SEEDS=600 npx vitest run tests/unit/battleRoomFuzz.test.ts for a long run (BATTLE_FUZZ_FROM to start later) */
const SEEDS = Number(process.env.BATTLE_FUZZ_SEEDS ?? 40);

function randomSeats(rng: Rng): PlayerType[] {
  const n = 2 + rng.int(5);
  const pool: PlayerType[] = ['online', 'online', 'online', 'human', 'dummy', 'hunter', 'freak'];
  const seats = Array.from({ length: n }, () => rng.pick(pool));
  if (!seats.includes('online')) seats[rng.int(n)] = 'online';
  return seats;
}

async function fuzzOne(seed: number) {
  const rng = new Rng(seed);
  const players = randomSeats(rng);
  const size: FieldSize = rng.bool() ? 'S' : 'M';
  const room: Room = await makeRoom({
    players,
    size,
    seed: seed * 7 + 1,
    darkness: rng.bool(),
    shuffle: rng.bool(),
    unions: rng.bool(),
    duelRules: rng.int(4) === 0,
    botSeed: seed,
  });
  expect(room.host.canStart).toBe(true);
  room.host.start();
  await room.hub.flush();
  expectAllSame(room, `seed ${seed} start`);

  const live = () => room.guests.filter((s) => s.g.status !== 'error');
  let stalls = 0;
  let filled = false;
  for (let step = 0; step < 260 && !room.host.state!.ended; step++) {
    const r = rng.float();
    const gs = live();
    const anyGuest = gs.length ? gs[rng.int(gs.length)] : null;
    if (anyGuest) {
      if (r < 0.07) room.hub.disconnect(anyGuest.cid);
      else if (r < 0.16) room.hub.connect(anyGuest.cid);
      else if (r < 0.23) room.hub.dropNext('host', anyGuest.cid, 1 + rng.int(3));
      else if (r < 0.27) room.hub.dropNext(anyGuest.cid, 'host', 1);
      else if (r < 0.3) reloadGuest(room, anyGuest.cid);
      else if (r < 0.315) reloadHost(room);
      else if (r < 0.322 && anyGuest.g.state && E.isAlive(anyGuest.g.state, anyGuest.g.seat)) await send(room, anyGuest.g, { t: 'concede' });
      else if (r < 0.33 && !filled) {
        // somebody left for good
        room.hub.disconnect(anyGuest.cid);
        await room.hub.flush();
        if (room.host.fillWithBots(rng.bool() ? 'dummy' : 'hunter').length) filled = true;
      }
    }
    await room.hub.flush();
    if (rng.float() < 0.3) room.host.heartbeat();
    await room.hub.flush();

    const ok = await playTurn(room);
    if (!ok) {
      stalls++;
      room.host.heartbeat();
      await room.hub.flush();
      if (stalls > 2) {
        // the seat to move belongs to an offline / lagging guest: bring it back
        const cur = guestOf(room, room.host.state!.current);
        if (cur) room.hub.connect(cur.cid);
        else await heal(room);
        stalls = 0;
      }
    } else stalls = 0;

    if (step % 15 === 14) {
      await heal(room);
      expectAllSame(room, `seed ${seed} step ${step}`);
    }
  }
  await heal(room);
  expectAllSame(room, `seed ${seed} end`);
  // a final reload of everybody still agrees
  reloadHost(room);
  for (const s of live()) reloadGuest(room, s.cid);
  await heal(room);
  expectAllSame(room, `seed ${seed} after reloads`);
  return { seq: room.host.seq, ended: !!room.host.state!.ended, players: players.join(',') };
}

describe('battle room fuzz', () => {
  it(`stays consistent over ${SEEDS} random rooms with drops, reconnects and reloads`, async () => {
    let ended = 0;
    let actions = 0;
    for (let seed = Number(process.env.BATTLE_FUZZ_FROM ?? 1); seed <= SEEDS; seed++) {
      const r = await fuzzOne(seed);
      if (r.ended) ended++;
      actions += r.seq;
    }
    expect(actions).toBeGreaterThan(SEEDS * 20);
    expect(ended).toBeGreaterThan(0);
  }, 120_000);
});
