import { describe, expect, it } from 'vitest';
import { attack, checkStuck, concede, createMatch, endAttack, finishEarly, finishTurn } from '../../src/core/engine';
import type { MatchSettings, MatchState } from '../../src/core/types';
import { createBot } from '../../src/ai';
import { stateHash } from '../../src/net/protocol';
import { battleHash } from '../../src/net/battleProtocol';
import { applyBattleAction, localizeBattleState } from '../../src/net/battleRules';
import { isMatchState } from '../../src/storage';
import { expectAllSame, makeRoom, reloadGuest, send } from './battleHelpers';

function board(over: Partial<MatchSettings> = {}) {
  const s = createMatch({ kind: 'single', size: 'S', players: ['human', 'online', 'dummy'], darkness: false, symmetry: false, crowded: false, unions: false, shuffle: false, duelRules: false, puzzle: 'crossroads', ...over }, { seed: 42 });
  // Line 0--1--2--3--4--5. Each seat also owns a reserve, so winning a point is not elimination.
  s.field.cells.forEach((c, i) => { c.owner = i < 6 ? [0, 0, -1, 1, 2, 2][i] : -1; c.power = c.owner < 0 ? 0 : 4; });
  s.field.adj = s.field.cells.map((_, i) => [i - 1, i + 1].filter(n => n >= 0 && n < s.field.cells.length));
  s.objectives = [1, 2, 4];
  return s;
}
const pass = (s: MatchState) => { endAttack(s); finishTurn(s); };

describe('hold two of three until your next turn', () => {
  it.each(['crossroads', 'highlands'])('%s: capture and passing the round boundary are not enough', puzzle => {
    const s = board({ puzzle });
    attack(s, 1, 2, { win: true });
    expect(s.ended).toBeNull();
    pass(s); expect(s.objectiveHolder).toBe(0);
    pass(s); expect(s.ended).toBeNull();
    pass(s); expect(s.ended).toMatchObject({ reason: 'objective', winner: 0 });
  });

  it('losing the majority and getting it back through a concession restarts the hold', () => {
    const s = board(); attack(s, 1, 2, { win: true }); pass(s);
    attack(s, 3, 2, { win: true }); expect(s.objectiveHolder).toBeUndefined();
    concede(s, 1, 0); pass(s);
    expect(s.current).toBe(0); expect(s.ended).toBeNull();
    pass(s); pass(s); expect(s.ended?.winner).toBe(0);
  });

  it('retains a three-to-two majority even after losing one point', () => {
    const s = board(); s.field.cells[4].owner = 0;
    attack(s, 1, 2, { win: true }); pass(s); attack(s, 3, 2, { win: true });
    pass(s); pass(s); expect(s.ended?.winner).toBe(0);
  });

  it.each(['snake', 'rotate'] as const)('%s order follows actual seat handoffs, never the round counter alone', order => {
    const s = board({ orderComp: { order } }); s.current = 2; s.field.cells[2].owner = 2;
    pass(s); expect(s.ended).toBeNull();
    if (s.current === 2) pass(s); // consecutive snake turns: nobody had a chance to interrupt
    while (s.current !== 2) pass(s);
    expect(s.ended).toMatchObject({ reason: 'objective', winner: 2, humanWon: false });
  });

  it('a saturated field can draw, never award a territory win or overwrite the result', () => {
    const s = board(); s.turn = 100;
    s.field.cells.forEach((c, i) => { c.owner = i < 5 ? 1 : 0; c.power = c.maxPower; });
    expect(checkStuck(s)).toMatchObject({ draw: true, enough: false });
    finishEarly(s, { enough: true, percent: 90 });
    expect(s.ended).toMatchObject({ winner: -1, draw: true }); pass(s); expect(s.ended?.winner).toBe(-1);
  });

  it('pending saves/snapshots replay on peers and rewind without retaining progress', () => {
    const s = board(); const start = structuredClone(s);
    const guest = localizeBattleState(s, 1);
    attack(s, 1, 2, { win: true }); pass(s);
    for (const a of [{ t: 'attack', from: 1, to: 2, win: true }, { t: 'endAttack' }, { t: 'endTurn' }] as const)
      expect(applyBattleAction(guest, 0, a, 1).ok).toBe(true);
    const resumed = JSON.parse(JSON.stringify(s)); expect(isMatchState(resumed)).toBe(true);
    for (const hash of [battleHash, stateHash]) {
      expect(hash(guest)).toBe(hash(resumed));
      expect(hash({ ...s, objectiveHolder: undefined })).not.toBe(hash(s));
      expect(hash({ ...s, objectives: [1, 2, 5] })).not.toBe(hash(s));
    }
    pass(resumed); pass(guest); pass(resumed); pass(guest);
    expect(resumed.ended.humanWon).toBe(true); expect(guest.ended?.humanWon).toBe(false);
    expect(battleHash(resumed)).toBe(battleHash(guest));
    pass(start); pass(start); pass(start); expect(start.ended).toBeNull();
    expect(isMatchState({ ...s, objectives: [1, 1, 2] })).toBe(false);
  });

  it('the live room keeps a pending hold over a guest reload and publishes the eventual win', async () => {
    const r = await makeRoom({ players: ['human', 'online'], puzzle: 'crossroads', seed: 42 });
    const guest = r.guests[0];
    const bot = createBot('hunter', { seed: 9 });
    try {
      expect(r.host.start()).toBe(true);
      await r.hub.flush();
      const s = r.host.state!;
      expect(guest.g.state?.objectives).toHaveLength(3);
      for (let round = 0; round < 25 && s.objectiveHolder === undefined && !s.ended; round++) {
        for (let i = 0; i < s.field.cells.length && !s.ended; i++) {
          const a = await bot.nextAttack(s, { speedMs: 0 });
          if (!a) break;
          expect(r.host.act(0, { t: 'attack', ...a }).ok).toBe(true);
          if (s.objectives!.filter(j => s.field.cells[j].owner === 0).length >= 2) break;
        }
        expect(r.host.act(0, { t: 'endTurn' }).ok).toBe(true);
        await r.hub.flush();
        if (s.objectiveHolder === undefined) expect(await send(r, guest.g, { t: 'endTurn' })).toMatchObject({ ok: true });
      }
      expect(s.ended).toBeNull();
      expect(s.objectiveHolder).toBe(0);
      reloadGuest(r, guest.cid);
      await r.hub.flush();
      expect(guest.g.state?.objectiveHolder).toBe(0);
      expect(await send(r, guest.g, { t: 'endTurn' })).toMatchObject({ ok: true });
      expect(s.ended).toMatchObject({ reason: 'objective', winner: 0, humanWon: true });
      expect(guest.g.state?.ended).toMatchObject({ reason: 'objective', winner: 0, humanWon: false });
      expectAllSame(r);
      expect(r.resyncs).toEqual([]);
    } finally {
      bot.dispose?.();
      guest.g.dispose();
      r.host.dispose();
    }
  });

  it('a bot holding two points attacks a rival who could take one back', async () => {
    const s = board({ players: ['human', 'hunter'] });
    s.current = 1;
    s.objectives = [1, 4, 5];
    const cells = s.field.cells;
    cells.forEach((c, i) => { c.owner = i === 3 ? 0 : [1, 2, 4].includes(i) ? 1 : -1; c.power = [0, 2, 12, 8, 1, 4][i] ?? 0; c.maxPower = 12; });
    const bot = createBot('hunter');
    const move = await bot.nextAttack(s, { speedMs: 0 });
    expect(move).toEqual({ from: 2, to: 3 });
    attack(s, move!.from, move!.to);
    expect(s.ended?.winner).toBe(1);
    bot.dispose?.();
  });

  it('even a passive bot contests an adjacent winning point', async () => {
    const s = board(); const bot = createBot('dummy');
    expect(await bot.nextAttack(s, { speedMs: 0 })).toEqual({ from: 1, to: 2 });
    bot.dispose?.();
  });
});
