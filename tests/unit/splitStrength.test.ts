import { expect, it } from 'vitest';
import { concede, createMatch } from '../../src/core/engine';

// One absent seat (1), two live recipients (0 and 3). Only the listed cells are gifts.
function board(powers: number[]) {
  const s = createMatch({ kind: 'single', size: 'S', players: ['human','dummy','human','human'], darkness: false, symmetry: false, crowded: false, unions: false, shuffle: false, duelRules: false }, { seed: 132 });
  s.field.cells.forEach((c, i) => { c.owner = i < powers.length ? 2 : i === powers.length ? 3 : 0; c.power = powers[i] ?? 1; });
  return s;
}

it('splits paired weak and strong cells into equally useful shares, independently of seed', () => {
  for (let seed = 0; seed < 30; seed++) {
    const s = board([8, 1, 8, 1]);
    s.seed = seed;
    expect(concede(s, 2, 'split')).toBe(true);
    for (const p of [0, 3]) expect(s.field.cells.slice(0, 4).filter(c => c.owner === p).map(c => c.power).sort()).toEqual([1, 8]);
  }
});

it('balances gifts that require swapping cells across different strength bands', () => {
  const s = board([10, 4, 4, 4, 1, 1]);
  expect(concede(s, 2, 'split')).toBe(true);
  for (const p of [0, 3]) {
    const gifts = s.field.cells.slice(0, 6).filter(c => c.owner === p);
    expect(gifts).toHaveLength(3);
    expect(gifts.reduce((sum, cell) => sum + cell.power, 0)).toBe(12);
  }
});

it.each([
  // On the loser's turn, 3 is next in this round, 0 is later.
  { current: 2, turn: 0, order: 'rotate' as const, later: 0 },
  // At the end of rotated round 3 the next round starts at 0, not at 3.
  { current: 2, turn: 3, order: 'rotate' as const, later: 3 },
  { current: 2, turn: 1, order: 'snake' as const, later: 3 },
  // Off-turn: 0 can immediately use the gift even though 3 follows the loser in seat order.
  { current: 0, order: 'rotate' as const, later: 3 },
  // Last seat gets two consecutive turns in snake, 0 still has to wait.
  { current: 3, order: 'snake' as const, later: 0 },
])('a lone indivisible gift is only slightly biased toward the later turn ($order, current $current)', ({ current, turn, order, later }) => {
  const s = board([6]);
  s.settings.orderComp = { order };
  let late = 0;
  // Reuse only the field; concede otherwise mutates its own per-deal bookkeeping.
  for (let seed = 0; seed < 8192; seed++) {
    s.field.cells[0].owner = 2;
    const deal = { ...s, current, seed, turn: turn ?? 0, outAt: [...s.outAt] };
    concede(deal, 2, 'split');
    if (deal.field.cells[0].owner === later) late++;
  }
  expect(late / 8192).toBeGreaterThan(0.525);
  expect(late / 8192).toBeLessThan(0.58);
});
