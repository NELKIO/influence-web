import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { generateField, isConnected, rowWidth } from '../../src/core/field';
import { createMatch } from '../../src/core/engine';
import { SIZE_ORDER, type Field } from '../../src/core/types';

/** BFS distances from a cell. */
function dist(f: Field, from: number): number[] {
  const d = new Array(f.cells.length).fill(-1);
  d[from] = 0;
  const q = [from];
  while (q.length) {
    const v = q.shift()!;
    for (const u of f.adj[v]) if (d[u] < 0) (d[u] = d[v] + 1), q.push(u);
  }
  return d;
}

/** Profile of the map as seen from a start: sorted (distance, capacity) pairs. */
function profile(f: Field, start: number) {
  const d = dist(f, start);
  return d.map((x, i) => `${x}:${f.cells[i].maxPower}`).sort().join('|');
}

describe('rotational symmetric maps', () => {
  for (const size of SIZE_ORDER) {
    it(`${size}: triangle for 3 players is fair`, () => {
      for (let seed = 1; seed <= 6; seed++) {
        const f = generateField({ size, symmetry: true, players: 3 }, new Rng(seed * 101));
        expect(f.layout).toBe('triangle');
        expect(isConnected(f)).toBe(true);
        for (const c of f.cells) expect(c.x).toBeLessThan(rowWidth(f.w, c.y));
        const s = [f.starts[0], f.starts[1], f.starts[4]];
        expect(new Set(s).size).toBe(3);
        for (const a of s) for (const b of s) if (a !== b) expect(f.adj[a]).not.toContain(b);
        // every player sees exactly the same map
        expect(profile(f, s[1])).toBe(profile(f, s[0]));
        expect(profile(f, s[2])).toBe(profile(f, s[0]));
        expect(f.cells.length).toBeGreaterThan(0);
      }
    });

    it(`${size}: star for 5 players`, () => {
      for (let seed = 1; seed <= 6; seed++) {
        const f = generateField({ size, symmetry: true, players: 5 }, new Rng(seed * 37));
        expect(f.layout).toBe('star');
        expect(isConnected(f)).toBe(true);
        expect(new Set(f.starts).size).toBe(5);
        const p0 = profile(f, f.starts[0]);
        for (const st of f.starts) expect(profile(f, st)).toBe(p0);
      }
    });
  }

  it('matches start with one cell per player at the symmetric positions', () => {
    const m3 = createMatch({ kind: 'single', size: 'L', players: ['human', 'hunter', 'dummy'], darkness: false, symmetry: true, crowded: false, unions: false, shuffle: false, duelRules: false }, { seed: 5 });
    const owned = m3.field.cells.filter((c) => c.owner >= 0);
    expect(owned.map((c) => c.owner).sort()).toEqual([0, 1, 2]);
    expect(owned.every((c) => c.power === 2)).toBe(true);
    const m5 = createMatch({ kind: 'single', size: 'XL', players: ['human', 'hunter', 'dummy', 'freak', 'master'], darkness: false, symmetry: true, crowded: false, unions: false, shuffle: false, duelRules: false }, { seed: 5 });
    expect(m5.field.cells.filter((c) => c.owner >= 0)).toHaveLength(5);
  });
});
