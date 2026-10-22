import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { generateField, isConnected, ROT_LAYOUTS } from '../../src/core/field';
import { createMatch } from '../../src/core/engine';
import { chokePoints } from '../../src/core/connectivity';
import { SIZE_ORDER, type Field, type MatchSettings, type PlayerType } from '../../src/core/types';
import { largestPocket, mirrorSymmetric, rotationSymmetric } from './mapChecks';

// A fast sample of what scripts/check-maps.ts checks exhaustively (500 seeds per configuration).

const SEEDS = [1, 2, 4242];

function settings(size: MatchSettings['size'], players: number, symmetry: boolean, crowded: boolean): MatchSettings {
  const types: PlayerType[] = Array.from({ length: players }, (_, i) => (i === 0 ? 'human' : 'hunter'));
  return { kind: 'single', size, players: types, darkness: false, symmetry, crowded, unions: false, shuffle: false, duelRules: false };
}

function symmetric(f: Field, players: number): boolean {
  if (players === 3) return rotationSymmetric(f, 3);
  if (players >= 5) return rotationSymmetric(f, 6);
  return mirrorSymmetric(f);
}

describe('generated maps have no choke points between the players', () => {
  for (const size of SIZE_ORDER) {
    for (const symmetry of [false, true]) {
      it(`${size} ${symmetry ? 'symmetric' : 'random'}, 2-6 players, crowded or not`, () => {
        for (let players = 2; players <= 6; players++) {
          for (const seed of SEEDS) {
            for (const crowded of [false, true]) {
              const m = createMatch(settings(size, players, symmetry, crowded), { seed });
              const f = m.field;
              const where = `${size} n=${players} sym=${symmetry} crowded=${crowded} seed=${seed}`;
              expect(isConnected(f), where).toBe(true);
              // all starts of the map: covers every subset the engine picks
              expect(chokePoints(f.adj, [...new Set(f.starts)]), where).toEqual([]);
              // no fortress: a single cell holds at most 5 cells behind it
              expect(largestPocket(f.adj), where).toBeLessThanOrEqual(5);
              if (!crowded) {
                const owned = Array.from({ length: players }, (_, p) => f.cells.findIndex((c) => c.owner === p));
                expect(chokePoints(f.adj, owned), where).toEqual([]);
              } else {
                // crowded matches play on the same map as uncrowded ones
                const plain = createMatch(settings(size, players, symmetry, false), { seed }).field;
                expect(f.cells.map((c) => c.id), where).toEqual(plain.cells.map((c) => c.id));
              }
              if (symmetry) expect(symmetric(f, players), where).toBe(true);
            }
          }
        }
      });
    }
  }

  for (const k of [3, 6] as const) {
    for (const layout of ROT_LAYOUTS[k]) {
      it(`rotational ${layout} (${k === 3 ? '3' : '5/6'} players) on every size`, () => {
        for (const size of SIZE_ORDER) {
          for (const seed of SEEDS) {
            const f = generateField({ size, symmetry: true, players: k === 3 ? 3 : 5, layout }, new Rng(seed));
            const where = `${layout} ${size} seed=${seed}`;
            expect(f.layout).toBe(layout);
            expect(chokePoints(f.adj, [...new Set(f.starts)]), where).toEqual([]);
            expect(largestPocket(f.adj), where).toBeLessThanOrEqual(5);
            expect(rotationSymmetric(f, k), where).toBe(true);
          }
        }
      });
    }
  }

  it('generation is deterministic per seed', () => {
    for (const [symmetry, players] of [[false, 4], [true, 2], [true, 3], [true, 5]] as const) {
      const a = generateField({ size: 'L', symmetry, players }, new Rng(99));
      const b = generateField({ size: 'L', symmetry, players }, new Rng(99));
      expect(a).toEqual(b);
    }
  });

  it('the symmetry checks catch a broken map', () => {
    const mirrored = generateField({ size: 'L', symmetry: true, players: 2 }, new Rng(5));
    mirrored.cells[0].maxPower = mirrored.cells[0].maxPower === 8 ? 12 : 8;
    expect(mirrorSymmetric(mirrored)).toBe(false);
    const rot = generateField({ size: 'L', symmetry: true, players: 3 }, new Rng(5));
    expect(rotationSymmetric(rot, 3)).toBe(true);
    rot.cells[3].maxPower = rot.cells[3].maxPower === 8 ? 12 : 8;
    expect(rotationSymmetric(rot, 3)).toBe(false);
  });
});
