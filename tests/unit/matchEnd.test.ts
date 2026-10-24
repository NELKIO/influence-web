import { describe, expect, it } from 'vitest';
import { alivePlayers, cellCount, checkEnd, checkStuck, concede, finishTurn, spectateCopy, visibleCells, createMatch, finishEarly, isAlive } from '../../src/core/engine';
import type { MatchSettings, MatchState, PlayerType } from '../../src/core/types';

function match(players: PlayerType[], seed = 3): MatchState {
  const settings: MatchSettings = {
    kind: 'single',
    size: 'M',
    players,
    darkness: false,
    symmetry: false,
    crowded: false,
    unions: false,
    shuffle: false,
    duelRules: false,
  };
  return createMatch(settings, { seed });
}

/** Hand every cell to the given owners, round-robin, at full power (a saturated board). */
function saturate(s: MatchState, owners: number[], shares: number[]) {
  const total = s.field.cells.length;
  let i = 0;
  owners.forEach((o, k) => {
    const n = k === owners.length - 1 ? total - i : Math.round(total * shares[k]);
    for (let j = 0; j < n; j++, i++) {
      s.field.cells[i].owner = o;
      s.field.cells[i].power = s.field.cells[i].maxPower;
    }
  });
}

describe('conceding', () => {
  it('one of two people on a device gives up while bots are alive: the match goes on for the other person', () => {
    const s = match(['human', 'hunter', 'human', 'master']);
    concede(s, 0);
    expect(s.ended).toBeNull();
    expect(isAlive(s, 0)).toBe(false);
    expect(alivePlayers(s)).toEqual([1, 2, 3]);
    // it was seat 0's turn: the turn moved on
    expect(s.current).toBe(1);
    // the remaining person sees the board through their own eyes
    expect(s.viewer).toBe(2);
  });

  it('the other person wins once the bots are gone too', () => {
    const s = match(['human', 'hunter', 'human']);
    concede(s, 0);
    // the remaining person takes the bot's last cells
    for (const c of s.field.cells) if (c.owner === 1) c.owner = 2;
    checkEnd(s);
    expect(s.ended).toMatchObject({ winner: 2, humanWon: true, reason: 'elimination' });
  });

  it('two people left: the one who stays wins at once', () => {
    const s = match(['human', 'human', 'hunter']);
    for (const c of s.field.cells) if (c.owner === 2) c.owner = 1;
    concede(s, 1);
    expect(s.ended).toMatchObject({ winner: 0, humanWon: true, reason: 'concede' });
  });

  it('the only person gives up against several bots: a defeat', () => {
    const s = match(['human', 'hunter', 'master']);
    concede(s, 0);
    expect(s.ended).toMatchObject({ winner: -1, humanWon: false, reason: 'concede' });
  });

  it('a duel concession ends the match and keeps the board', () => {
    const s = match(['human', 'master']);
    const before = cellCount(s, 0);
    concede(s, 0);
    expect(s.ended).toMatchObject({ winner: 1, humanWon: false, reason: 'concede' });
    expect(cellCount(s, 0)).toBe(before);
  });

  it('a seat that is already out cannot concede', () => {
    const s = match(['human', 'hunter', 'human']);
    concede(s, 0);
    const snap = JSON.stringify(s);
    concede(s, 0);
    expect(JSON.stringify(s)).toBe(snap);
  });
});

describe('early finish with several people', () => {
  function stuckBoard(shares: number[]) {
    const s = match(['human', 'hunter', 'human']);
    saturate(s, [0, 1, 2], shares);
    s.turn = 200;
    s.lastStuck = -100;
    s.current = 0;
    return s;
  }

  it('a person who is not ahead cannot claim the win, and finishing hands it to the leader', () => {
    const s = stuckBoard([0.36, 0.04, 0.6]);
    const offer = checkStuck(s)!;
    expect(offer.percent).toBeGreaterThan(100 / 3);
    expect(offer.enough).toBe(false);
    finishEarly(s, offer);
    expect(s.ended).toMatchObject({ winner: 2, humanWon: true, reason: 'early' });
  });

  it('the leader can claim the win', () => {
    const s = stuckBoard([0.6, 0.04, 0.36]);
    const offer = checkStuck(s)!;
    expect(offer.enough).toBe(true);
    finishEarly(s, offer);
    expect(s.ended).toMatchObject({ winner: 0, humanWon: true, reason: 'early' });
  });

  it('alone against bots the original rule stays: a fair share is enough', () => {
    const s = match(['human', 'hunter', 'master']);
    saturate(s, [0, 1, 2], [0.36, 0.04, 0.6]);
    s.turn = 200;
    s.lastStuck = -100;
    s.current = 0;
    const offer = checkStuck(s)!;
    expect(offer.enough).toBe(true);
  });
});

describe('darkness at the end of a match', () => {
  it('the fog lifts for everyone once the match is over', () => {
    const s = createMatch(
      { kind: 'single', size: 'M', players: ['human', 'hunter', 'master'], darkness: true, symmetry: false, crowded: false, unions: false, shuffle: false, duelRules: false },
      { seed: 4 },
    );
    expect(visibleCells(s, 0).every((v) => v === 1)).toBe(false);
    concede(s, 1);
    concede(s, 2);
    expect(s.ended).not.toBeNull();
    // the person is still alive, yet sees the whole map
    expect(visibleCells(s, 0).every((v) => v === 1)).toBe(true);
  });
});

describe('watching the bots fight on after the people lost', () => {
  it('the copy goes on without people and ends when one bot is left', () => {
    const s = match(['human', 'hunter', 'master']);
    concede(s, 0);
    expect(s.ended).toMatchObject({ winner: -1, humanWon: false });
    const w = spectateCopy(s)!;
    expect(w).not.toBeNull();
    expect(w.ended).toBeNull();
    // the original is untouched
    expect(s.ended).not.toBeNull();
    // the dead person's turn is skipped
    expect(isAlive(w, w.current)).toBe(true);
    // the whole map is visible
    expect(visibleCells(w, 0).every((v) => v === 1)).toBe(true);
    // a bot takes the other's last cell: the match ends with that bot as the winner
    for (const c of w.field.cells) if (c.owner === 2) c.owner = 1;
    checkEnd(w);
    expect(w.ended).toMatchObject({ winner: 1, humanWon: false, reason: 'elimination' });
  });

  it('stops after the round limit with nobody winning', () => {
    const s = match(['human', 'hunter', 'master']);
    concede(s, 0);
    const w = spectateCopy(s, 2)!;
    for (let k = 0; k < 10 && !w.ended; k++) finishTurn(w);
    expect(w.ended).toMatchObject({ winner: -1, reason: 'cap' });
  });

  it('is not offered with a person still on the board or a single bot left', () => {
    const s = match(['human', 'hunter', 'master']);
    expect(spectateCopy(s)).toBeNull();
    const d = match(['human', 'master']);
    concede(d, 0);
    expect(spectateCopy(d)).toBeNull();
  });
});
