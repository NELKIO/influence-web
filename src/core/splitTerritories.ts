import type { Cell } from './types';
import type { Rng } from './rng';

interface Pile {
  strength: number;
  cells: number[];
}

/** Improve any pairing the deal got wrong, without changing a pile's size. */
function balanceStrength(piles: Pile[], cells: Cell[]): void {
  for (;;) {
    let bestGain = 0;
    let swap: { high: Pile; low: Pile; a: number; b: number; delta: number } | undefined;
    // Only one representative of each power is needed in a pile (most cells are duplicates).
    const powers = piles.map(pile => new Map(pile.cells.map((i, j) => [cells[i].power, j])));
    piles.forEach((high, i) => piles.forEach((low, j) => {
      const gap = high.strength - low.strength;
      if (gap < 2) return;
      for (const [aPower, a] of powers[i]) for (const [bPower, b] of powers[j]) {
        const delta = aPower - bPower;
        if (delta <= 0 || delta >= gap) continue;
        const gain = delta * (gap - delta); // half the reduction in the sum of squared strengths
        if (gain > bestGain) {
          bestGain = gain;
          swap = { high, low, a, b, delta };
        }
      }
    }));
    if (!swap) return;
    const { high, low, a, b, delta } = swap;
    [high.cells[a], low.cells[b]] = [low.cells[b], high.cells[a]];
    high.strength -= delta;
    low.strength += delta;
  }
}

/** Deal intact cells, with seats in the order in which they can next use the gift. */
export function splitTerritories(cells: Cell[], gifts: number[], seats: number[], rng: Rng): void {
  const piles: Pile[] = seats.map(() => ({ strength: 0, cells: [] }));
  // Largest first; each pass gives at most one cell to each pile. Break equal-power ties
  // by shuffling first, so equivalent cells scattered around the board do not form stripes.
  rng.shuffle(gifts).sort((a, b) => cells[b].power - cells[a].power);
  for (let start = 0; start < gifts.length; start += seats.length) {
    piles.sort((a, b) => a.strength - b.strength);
    gifts.slice(start, start + seats.length).forEach((i, j) => {
      piles[j].cells.push(i);
      piles[j].strength += cells[i].power;
    });
  }
  balanceStrength(piles, cells);
  rng.shuffle(piles);
  // Nudge only one random pair in one deal out of ten. With two unequal piles this
  // gives the later player 55%, not a guaranteed bonus; with more seats it is gentler.
  if (seats.length > 1 && rng.float() < 0.1) {
    const a = rng.int(seats.length);
    const b = (a + 1 + rng.int(seats.length - 1)) % seats.length;
    const first = Math.min(a, b), last = Math.max(a, b);
    const diff = piles[first].strength - piles[last].strength || piles[first].cells.length - piles[last].cells.length;
    if (diff > 0) [piles[first], piles[last]] = [piles[last], piles[first]];
  }
  piles.forEach((pile, j) => { for (const i of pile.cells) cells[i].owner = seats[j]; });
}
