/** Map checks shared by tests/unit/maps.test.ts and scripts/check-maps.ts. */
import { mirror, rowWidth } from '../../src/core/field';
import { articulationPoints } from '../../src/core/connectivity';
import type { Field } from '../../src/core/types';

/** Mirrored maps: every cell's three mirror images exist with the same max power, no walls. */
export function mirrorSymmetric(f: Field): boolean {
  if (f.walls.length) return false;
  const byId = new Map(f.cells.map((c) => [c.id, c]));
  return f.cells.every((c) => {
    const [mx, my] = mirror(f.w, f.h, c.x, c.y);
    const images: [number, number][] = [[mx, my], [c.x, my], [rowWidth(f.w, c.y) - 1 - c.x, c.y]];
    return images.every(([x, y]) => byId.get(y * f.w + x)?.maxPower === c.maxPower);
  });
}

/**
 * Rotational maps: turning the map by 360/k degrees around its centre maps every cell onto a cell
 * with the same max power (k = 3 for three-player maps, 6 for six-ray maps).
 */
export function rotationSymmetric(f: Field, k: 3 | 6): boolean {
  if (f.walls.length) return false;
  // odd-r offset -> axial (rows keep their parity, so this is exact)
  const cube = f.cells.map((c) => [c.x - (c.y - (c.y & 1)) / 2, c.y] as const);
  const n = cube.length;
  const cq = cube.reduce((a, c) => a + c[0], 0) / n;
  const cr = cube.reduce((a, c) => a + c[1], 0) / n;
  // the centre of a rotation-symmetric set is its centroid, and a cell
  if (!Number.isInteger(cq) || !Number.isInteger(cr)) return false;
  const at = new Map(cube.map((c, i) => [`${c[0] - cq},${c[1] - cr}`, i]));
  return cube.every(([q0, r0], i) => {
    let q = q0 - cq;
    let r = r0 - cr;
    for (let t = 0; t < 6 / k; t++) [q, r] = [-r, q + r]; // 60 degrees: (q, r, s) -> (-r, -s, -q)
    const j = at.get(`${q},${r}`);
    return j !== undefined && f.cells[j].maxPower === f.cells[i].maxPower;
  });
}

/** Largest group of cells that a single cell cuts off from the biggest remaining part. */
export function largestPocket(adj: number[][]): number {
  let best = 0;
  const n = adj.length;
  for (const v of articulationPoints(adj)) {
    const comp = new Int32Array(n).fill(-1);
    comp[v] = -2;
    const sizes: number[] = [];
    for (let s = 0; s < n; s++) {
      if (comp[s] !== -1) continue;
      const id = sizes.length;
      let cnt = 0;
      const stack = [s];
      comp[s] = id;
      while (stack.length) {
        const u = stack.pop()!;
        cnt++;
        for (const w of adj[u]) if (comp[w] === -1) (comp[w] = id), stack.push(w);
      }
      sizes.push(cnt);
    }
    sizes.sort((a, b) => b - a);
    for (let i = 1; i < sizes.length; i++) best = Math.max(best, sizes[i]);
  }
  return best;
}
