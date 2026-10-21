import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { generateField, isConnected, rowWidth, ROT_LAYOUTS } from '../../src/core/field';
import { createMatch } from '../../src/core/engine';
import { SIZES, SIZE_ORDER, type Field } from '../../src/core/types';

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
  for (const k of [3, 6] as const) {
    for (const layout of ROT_LAYOUTS[k]) {
      it(`${layout} (${k === 3 ? 3 : 5} players) is connected and fair on every size`, () => {
        for (const size of SIZE_ORDER) {
          for (let seed = 1; seed <= 4; seed++) {
            const f = generateField({ size, symmetry: true, players: k === 3 ? 3 : 5, layout }, new Rng(seed * 101 + size.length));
            expect(f.layout).toBe(layout);
            expect(isConnected(f)).toBe(true);
            for (const c of f.cells) expect(c.x).toBeLessThan(rowWidth(f.w, c.y));
            const s = k === 3 ? [f.starts[0], f.starts[1], f.starts[4]] : f.starts;
            expect(new Set(s).size).toBe(s.length);
            for (const a of s) for (const b of s) if (a !== b) expect(f.adj[a]).not.toContain(b);
            // every player sees exactly the same map
            const p0 = profile(f, s[0]);
            for (const st of s) expect(profile(f, st)).toBe(p0);
            // size is in the right ballpark
            expect(f.cells.length).toBeGreaterThan(SIZES[size].cells * 0.7);
            expect(f.cells.length).toBeLessThan(SIZES[size].cells * 1.6 + 8);
          }
        }
      });
    }
  }

  it('random layouts vary between seeds', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) seen.add(generateField({ size: 'L', symmetry: true, players: 3 }, new Rng(seed)).layout!);
    expect(seen.size).toBeGreaterThanOrEqual(5);
  });

  it('ring maps connect players around the rim, not only through the centre', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const f = generateField({ size: 'L', symmetry: true, players: 3, layout: 'ring' }, new Rng(seed * 7));
      const s = [f.starts[0], f.starts[1], f.starts[4]];
      const d = s.map((st) => dist(f, st));
      // the centre: the cell with equal and smallest distance to all three starts
      let centre = -1;
      f.cells.forEach((_, i) => {
        if (d[0][i] === d[1][i] && d[1][i] === d[2][i] && (centre < 0 || d[0][i] < d[0][centre])) centre = i;
      });
      const blocked = new Set(dist(f, centre).flatMap((x, i) => (x >= 0 && x <= 2 ? [i] : [])));
      // BFS from player 0 avoiding the centre area must still reach player 1
      const seen = new Set([s[0]]);
      const q = [s[0]];
      while (q.length) {
        const v = q.shift()!;
        for (const u of f.adj[v]) if (!seen.has(u) && !blocked.has(u)) seen.add(u), q.push(u);
      }
      expect(seen.has(s[1])).toBe(true);
    }
  });

  it('matches start with one cell per player at the symmetric positions', () => {
    const m3 = createMatch({ kind: 'single', size: 'L', players: ['human', 'hunter', 'dummy'], darkness: false, symmetry: true, crowded: false, unions: false, shuffle: false, duelRules: false }, { seed: 5 });
    const owned = m3.field.cells.filter((c) => c.owner >= 0);
    expect(owned.map((c) => c.owner).sort()).toEqual([0, 1, 2]);
    expect(owned.every((c) => c.power === 2)).toBe(true);
    const m5 = createMatch({ kind: 'single', size: 'XL', players: ['human', 'hunter', 'dummy', 'freak', 'master'], darkness: false, symmetry: true, crowded: false, unions: false, shuffle: false, duelRules: false }, { seed: 5 });
    expect(m5.field.cells.filter((c) => c.owner >= 0)).toHaveLength(5);
  });
});

describe('map preview reproducibility', () => {
  it('the same seed gives the same map and start cells (preview == match)', () => {
    for (const players of [2, 3, 4, 5]) {
      for (const symmetry of [true, false]) {
        const settings = {
          kind: 'single' as const,
          size: 'L' as const,
          players: ['human', 'hunter', 'dummy', 'freak', 'master'].slice(0, players) as ('human' | 'hunter' | 'dummy' | 'freak' | 'master')[],
          darkness: false,
          symmetry,
          crowded: false,
          unions: false,
          shuffle: false,
          duelRules: false,
        };
        const a = createMatch(settings, { seed: 4242 });
        const b = createMatch({ ...settings, darkness: true, unions: true }, { seed: 4242 });
        expect(JSON.stringify(b.field)).toBe(JSON.stringify(a.field));
      }
    }
  });
});
