import { describe, expect, it } from 'vitest';
import { attack, checkStuck, concede, createMatch, endAttack, finishEarly, finishTurn } from '../../src/core/engine';
import { NEUTRAL, SIZE_ORDER, type Field, type FieldSize, type MatchSettings, type MatchState } from '../../src/core/types';
import { createBot } from '../../src/ai';
import { stateHash } from '../../src/net/protocol';
import { battleHash, parseBattleMessage, BATTLE_PROTOCOL_VERSION } from '../../src/net/battleProtocol';
import { startMatch } from '../../src/core/scenarios';
import { applyBattleAction, localizeBattleState, previewBattleMatch } from '../../src/net/battleRules';
import { chooseFrontierPoints } from '../../src/core/objectives';
import { articulationPoints } from '../../src/core/connectivity';
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

describe('generated frontiers', () => {
  const settings = (size: FieldSize, count: number, crowded = false, symmetry = true): MatchSettings => ({
    kind: 'single', size, players: ['human', ...Array.from({ length: count - 1 }, () => 'hunter' as const)],
    darkness: false, symmetry, crowded, unions: false, shuffle: false, duelRules: false, frontierMode: true,
  });
  const distances = (adj: number[][], from: number) => {
    const d = Array(adj.length).fill(Infinity); d[from] = 0;
    const queue = [from];
    for (const i of queue) for (const j of adj[i]) if (d[j] === Infinity) { d[j] = d[i] + 1; queue.push(j); }
    return d as number[];
  };

  it('chooses three reachable, separated, neutral non-leaf targets without altering battle dice', () => {
    for (const size of SIZE_ORDER) for (let count = 2; count <= 6; count++) for (const symmetry of [false, true]) for (const seed of [3, 19]) {
      const off = startMatch({ ...settings(size, count, false, symmetry), frontierMode: false }, seed);
      const on = startMatch(settings(size, count, false, symmetry), seed);
      expect(off.objectives).toBeUndefined();
      expect(on.objectives).toHaveLength(3);
      expect(on.objectives).toEqual(startMatch(settings(size, count, false, symmetry), seed).objectives);
      expect(on.rng).toEqual(off.rng);
      expect(on.field).toEqual(off.field);
      expect(on.objectives!.every(i => on.field.cells[i].owner === NEUTRAL && on.field.adj[i].length >= 2 && !on.field.starts.includes(i))).toBe(true);
      const starts = on.field.cells.flatMap((c, i) => c.owner >= 0 ? [i] : []);
      for (const target of on.objectives!) expect(starts.every(i => Number.isFinite(distances(on.field.adj, i)[target]))).toBe(true);
      for (const a of on.objectives!) for (const b of on.objectives!) if (a !== b) expect(distances(on.field.adj, a)[b]).toBeGreaterThanOrEqual(2);
    }
  });

  it('does not place a target on a single-cell chokepoint when better choices exist', () => {
    const state = startMatch(settings('S', 2, false, false), 24699);
    const cuts = articulationPoints(state.field.adj);
    expect(cuts.length).toBeGreaterThan(0);
    expect(state.objectives).toHaveLength(3);
    expect(state.objectives!.some(i => cuts.includes(i))).toBe(false);
  });

  it('reserves three neutral targets before an otherwise even Crowded deal', () => {
    for (const count of [2, 3, 4, 5, 6]) {
      const on = startMatch(settings('S', count, true), 17);
      const off = startMatch({ ...settings('S', count, true), frontierMode: false }, 17);
      expect(on.objectives).toHaveLength(3);
      expect(on.rng).toEqual(off.rng);
      expect(on.objectives!.every(i => on.field.cells[i].owner === NEUTRAL && on.field.cells[i].power === 0)).toBe(true);
      const totals = on.settings.players.map((_, seat) => on.field.cells.filter(c => c.owner === seat).length);
      expect(Math.max(...totals) - Math.min(...totals)).toBeLessThanOrEqual(1);
      expect(off.field.cells.every(c => c.owner >= 0)).toBe(true);
    }
  });

  it('still returns three non-start targets when the only candidates touch each other', () => {
    const field: Field = {
      size: 'S', w: 5, h: 1, walls: [], starts: [0, 4],
      cells: Array.from({ length: 5 }, (_, i) => ({ id: i, x: i, y: 0, maxPower: 8, power: 0, owner: i === 0 ? 0 : i === 4 ? 1 : NEUTRAL })),
      adj: Array.from({ length: 5 }, (_, i) => [0, 1, 2, 3, 4].filter(j => i !== j)),
    };
    expect(chooseFrontierPoints(field).sort()).toEqual([1, 2, 3]);
  });

  it('validates matching options and targets on saves and online snapshots', () => {
    const state = startMatch({ ...settings('M', 3), kind: 'battleOnline' }, 41);
    const wire = (state: unknown) => ({ t: 'bStart', matchId: 'room', seat: 0, seq: 0, state, roster: [] });
    expect(isMatchState(JSON.parse(JSON.stringify(state)))).toBe(true);
    expect(parseBattleMessage(JSON.stringify(wire(state)))).not.toBeNull();
    for (const bad of [
      { ...state, settings: { ...state.settings, frontierMode: false } },
      { ...state, settings: { ...state.settings, frontierMode: undefined } },
      { ...state, settings: { ...state.settings, kind: 'duelOnline' as const }, objectives: undefined },
      { ...state, settings: { ...state.settings, puzzle: 'titans' }, objectives: undefined },
      { ...state, objectives: undefined },
      { ...state, objectives: [0, 0, 0] },
    ]) {
      expect(isMatchState(bad)).toBe(false);
      expect(parseBattleMessage(wire(bad))).toBeNull();
    }
    expect(BATTLE_PROTOCOL_VERSION).toBe(8);
  });

  it('previews exactly the map and seat shuffle that the online host starts', async () => {
    const room = await makeRoom({ players: ['human', 'online', 'hunter', 'master'], size: 'M', seed: 27, shuffle: true, frontierMode: true });
    try {
      const preview = previewBattleMatch(room.host.settings, 27).state;
      expect(room.host.start()).toBe(true);
      expect(preview.objectives).toHaveLength(3);
      expect(preview.objectives).toEqual(room.host.state?.objectives);
      expect(preview.field).toEqual(room.host.state?.field);
      expect(preview.settings.players).toEqual(room.host.state?.settings.players);
      await room.hub.flush();
      expect(room.guests[0].g.state?.objectives).toEqual(preview.objectives);
    } finally {
      room.guests.forEach(g => g.g.dispose());
      room.host.dispose();
    }
  });
});

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
