import { describe, expect, it } from 'vitest';
import { createMatch } from '../../src/core/engine';
import type { MatchSettings } from '../../src/core/types';

const settings = (crowded: boolean, n = 7): MatchSettings => ({
  kind: 'single', size: 'L', players: ['human', 'hunter', 'hunter', 'hunter', 'hunter'], darkness: false, symmetry: false,
  crowded, unions: false, shuffle: false, duelRules: false, frontierMode: true, frontierPointCount: n, frontierWinCount: 3,
});

describe('control points on a crowded map', () => {
  it('are neutral garrisons stronger than a dealt cell, so the first mover cannot grab them all for free', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const st = createMatch(settings(true), { seed });
      for (const i of st.objectives!) {
        expect(st.field.cells[i].owner).toBe(-1);
        expect(st.field.cells[i].power).toBe(3);
      }
    }
  });

  it('stay empty on an open map, where they lie far from the starts', () => {
    const st = createMatch(settings(false), { seed: 3 });
    for (const i of st.objectives!) expect(st.field.cells[i].power).toBe(0);
  });
});
