import { describe, expect, it } from 'vitest';
import { attack, exploredCells, visibleCells } from '../../src/core/engine';
import { buildScenario } from '../../src/core/scenarios';
import { localizeBattleState } from '../../src/net/battleRules';
import type { MatchState } from '../../src/core/types';

const count = (a: Uint8Array | null) => (a ? a.reduce((n, v) => n + v, 0) : -1);

/** A sure capture for the current seat: a cell of power 2+ next to an empty grey cell. */
function grab(st: MatchState): number {
  const { cells, adj } = st.field;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i].owner !== st.current || cells[i].power < 2) continue;
    const t = adj[i].find((j) => cells[j].owner === -1 && cells[j].power === 0);
    if (t !== undefined) {
      const ev = attack(st, i, t);
      expect(typeof ev).toBe('object');
      return t;
    }
  }
  throw new Error('no capture');
}

describe('exploration fog', () => {
  it('starts with what each person sees and grows with every capture, never shrinking', () => {
    const st = buildScenario('landing', 11);
    expect(st.settings.blind).toBe(true);
    const start = exploredCells(st)!;
    expect(start).not.toBeNull();
    expect([...start]).toEqual([...visibleCells(st, 0)]);
    expect(count(start)).toBeLessThan(st.field.cells.length / 4);
    const t = grab(st);
    const after = exploredCells(st)!;
    expect(count(after)).toBeGreaterThan(count(start));
    for (const n of st.field.adj[t]) expect(after[n]).toBe(1);
    start.forEach((v, i) => v && expect(after[i]).toBe(1));
    // losing the cell again keeps the memory of the land
    st.field.cells[t].owner = 3;
    expect([...exploredCells(st)!]).toEqual([...after]);
    expect(count(visibleCells(st, 0))).toBeLessThan(count(after));
  });

  it('keeps one explored set per person; bots have none', () => {
    const st = buildScenario('landing', 5, undefined, ['human', 'human', 'hunter', 'dummy', 'hunter', 'online']);
    expect(st.explored![2]).toBeUndefined();
    expect(st.explored![3]).toBeUndefined();
    const a = exploredCells(st, 0)!;
    const b = exploredCells(st, 1)!;
    const f = exploredCells(st, 5)!;
    expect([...a]).toEqual([...visibleCells(st, 0)]);
    expect([...b]).toEqual([...visibleCells(st, 1)]);
    expect([...f]).toEqual([...visibleCells(st, 5)]);
    // drops are far apart: the two people have seen different land
    expect(a.some((v, i) => v && b[i])).toBe(false);
    grab(st);
    expect([...exploredCells(st, 1)!]).toEqual([...b]);
  });

  it('survives saving (JSON) and cloning, and a battle guest gets its own set', () => {
    const st = buildScenario('landing', 8, undefined, ['human', 'online', 'hunter', 'dummy', 'hunter', 'dummy']);
    grab(st);
    const json = JSON.parse(JSON.stringify(st)) as MatchState;
    const clone = structuredClone(st);
    expect([...exploredCells(json)!]).toEqual([...exploredCells(st)!]);
    expect([...exploredCells(clone)!]).toEqual([...exploredCells(st)!]);
    const guest = localizeBattleState(st, 1);
    expect([...exploredCells(guest)!]).toEqual([...visibleCells(st, 1)]);
  });

  it('no fog without the setting, and the map shows once the match is over', () => {
    const plain = buildScenario('olympus', 3);
    expect(plain.explored).toBeUndefined();
    expect(exploredCells(plain)).toBeNull();
    const st = buildScenario('landing', 3);
    st.ended = { winner: 1, humanWon: false, reason: 'elimination', turn: 4 };
    expect(exploredCells(st)).toBeNull();
  });
});
