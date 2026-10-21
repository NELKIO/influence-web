import { afterEach, describe, expect, it, vi } from 'vitest';
import { Rng } from '../../src/core/rng';
import type { FieldSize } from '../../src/core/types';
import { DuelSession } from '../../src/net/duelSession';
import { MemoryStorage } from '../../src/net/persist';
import { createLoopbackPair } from '../../src/net/transport';
import { expectSame, fakeTimers, makeDuo, nextScriptedAttack, playScriptedTurn } from './netHelpers';

afterEach(() => vi.useRealTimers());

describe('online duel under faults', () => {
  const cases: [number, FieldSize][] = [
    [1, 'S'],
    [2, 'M'],
    [3, 'M'],
    [4, 'L'],
    [5, 'S'],
    [6, 'L'],
    [7, 'M'],
    [8, 'S'],
  ];
  for (const [seed, size] of cases) {
    it(`seed ${seed} ${size}: random disconnects and reloads keep both sides identical until the end`, async () => {
      const d = await makeDuo({ size, seed: seed * 1000, hostFirst: seed % 2 === 0 });
      const rng = new Rng(seed);
      let host = d.host;
      let guest = d.guest;
      let turns = 0;
      let faults = 0;
      while (!host.state!.ended && turns < 500) {
        const a = host.isMyTurn ? host : guest;
        const roll = rng.float();
        if (roll < 0.15) {
          // drop the link in the middle of the turn
          let n = 1 + rng.int(4);
          while (n-- > 0 && !a.state!.ended) {
            const mv = nextScriptedAttack(a.state!);
            if (!mv) break;
            a.attack(mv.from, mv.to);
          }
          d.link.disconnect();
          playScriptedTurn(a);
          d.link.connect();
          faults++;
        } else if (roll < 0.22) {
          // the guest page reloads after the turn
          playScriptedTurn(a);
          if (rng.bool()) await d.link.flush();
          guest.dispose();
          guest = DuelSession.resume({ storage: d.guestStorage, transport: d.link.newGuest(), pingMs: 0 })!;
          d.link.connect();
          faults++;
        } else if (roll < 0.27) {
          // the host page reloads
          playScriptedTurn(a);
          host.dispose();
          host = DuelSession.resume({ storage: d.hostStorage, transport: d.link.newHost(), pingMs: 0 })!;
          d.link.connect();
          faults++;
        } else {
          playScriptedTurn(a);
        }
        await d.link.flush();
        expect(host.status === 'playing' || host.status === 'ended').toBe(true);
        expectSame(host.state, guest.state);
        expect(host.seq).toBe(guest.seq);
        turns++;
      }
      expect(host.state!.ended).toBeTruthy();
      expect(guest.status).toBe('ended');
      expect(faults).toBeGreaterThan(0);
      // no desync was ever needed: everything was recovered from the action logs
      expect(d.resyncs).toEqual([]);
    });
  }

  it('a message lost without a disconnect is re-sent after two pongs', async () => {
    fakeTimers();
    const link = createLoopbackPair({ code: 'PNG2' });
    const host = DuelSession.host({ transport: link.host, storage: new MemoryStorage(), clientId: 'H', size: 'S', hostFirst: true, pingMs: 1000 });
    const guest = DuelSession.join('PNG2', { transport: link.guest, storage: new MemoryStorage(), clientId: 'G', pingMs: 1000 });
    await link.flush();
    // lose the host's final endTurn: the guest would wait forever
    playScriptedTurnExceptLast(host);
    link.dropNext(link.host, 1);
    host.endTurn();
    await link.flush();
    expect(guest.isMyTurn).toBe(false);
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(1000);
      await link.flush();
    }
    expect(guest.isMyTurn).toBe(true);
    expectSame(host.state, guest.state);
    expect(guest.rtt).not.toBe(null);
  });
});

function playScriptedTurnExceptLast(s: DuelSession) {
  for (let i = 0; i < 10; i++) {
    const mv = nextScriptedAttack(s.state!);
    if (!mv) break;
    s.attack(mv.from, mv.to);
  }
  s.endAttack();
  s.autoPower();
}
