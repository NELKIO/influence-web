import { cellCenter, cellRadius } from '../board/renderer';
import type { Field } from '../../core/types';

/** Static SVG thumbnail of a field: owned cells in player colours, the rest as empty hexes. */
export function MiniMap({ field, starts: startCells = [], maxHeight = 200 }: { field: Field; starts?: number[]; maxHeight?: number }) {
  const pts = field.cells.map((c) => cellCenter(c.x, c.y));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs) - 1;
  const minY = Math.min(...ys) - 1;
  const w = Math.max(...xs) - minX + 1;
  const h = Math.max(...ys) - minY + 1;
  const hex = (cx: number, cy: number, r: number) =>
    Array.from({ length: 6 }, (_, i) => {
      const a = (Math.PI / 3) * i - Math.PI / 2;
      return `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`;
    }).join(' ');
  const starts = startCells;
  return (
    <svg viewBox={`${minX} ${minY} ${w} ${h}`} style={{ width: '100%', maxHeight, display: 'block' }} aria-hidden="true">
      {field.cells.map((c, i) => {
        const si = starts.indexOf(i);
        const owner = si >= 0 ? si : c.owner;
        const col = owner >= 0 ? `var(--p${owner})` : null;
        return (
          <polygon
            key={i}
            points={hex(pts[i][0], pts[i][1], cellRadius(c.maxPower))}
            fill={col ?? (c.power > 0 ? '#3f4450' : '#1b1e24')}
            stroke={col ?? '#2c3038'}
            stroke-width="0.08"
          />
        );
      })}
      {/* walls: a short bar across the gap between two cells, like on the board */}
      {field.walls.map(([i, j], k) => {
        const [ax, ay] = pts[i];
        const [bx, by] = pts[j];
        const len = Math.hypot(bx - ax, by - ay) || 1;
        const nx = (-(by - ay) / len) * 0.5;
        const ny = ((bx - ax) / len) * 0.5;
        const mx = (ax + bx) / 2;
        const my = (ay + by) / 2;
        return (
          <line
            key={`w${k}`}
            x1={mx - nx}
            y1={my - ny}
            x2={mx + nx}
            y2={my + ny}
            stroke="rgba(200,206,216,0.8)"
            stroke-width="0.16"
            stroke-linecap="round"
          />
        );
      })}
    </svg>
  );
}

/**
 * Thumbnail of a map nobody has seen yet (exploration fog): a few hexes fading into the dark around
 * a question mark. It shows neither the shape of the map nor where anybody starts.
 */
export function UnknownMap({ maxHeight = 200 }: { maxHeight?: number }) {
  const R = 4;
  const hexes: { x: number; y: number; d: number }[] = [];
  for (let q = -R; q <= R; q++)
    for (let r = -R; r <= R; r++) {
      const d = Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r));
      if (d > R) continue;
      // a ragged edge, the same every time
      if (d >= 3 && ((q * 7 + r * 13 + q * r) & 3) === 0) continue;
      hexes.push({ x: (q + r / 2) * Math.sqrt(3), y: r * 1.5, d });
    }
  const hex = (cx: number, cy: number, r: number) =>
    Array.from({ length: 6 }, (_, i) => {
      const a = (Math.PI / 3) * i - Math.PI / 2;
      return `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`;
    }).join(' ');
  const w = (R + 1) * Math.sqrt(3) * 2;
  const h = (R * 1.5 + 1.2) * 2;
  return (
    <svg viewBox={`${-w / 2} ${-h / 2} ${w} ${h}`} style={{ width: '100%', maxHeight, display: 'block' }} aria-hidden="true" data-unknown-map>
      {hexes.map((c, i) => (
        <polygon
          key={i}
          points={hex(c.x, c.y, 0.8)}
          fill="#1b1e24"
          stroke="#2c3038"
          stroke-width="0.08"
          opacity={c.d === 0 ? 0 : Math.max(0.12, 1 - c.d * 0.22)}
        />
      ))}
      <text
        x="0"
        y="0.1"
        text-anchor="middle"
        dominant-baseline="middle"
        font-family="var(--display)"
        font-weight="600"
        font-size="3.2"
        fill="#b9c2ff"
        opacity="0.85"
      >
        ?
      </text>
    </svg>
  );
}

/**
 * A map as a player may see it before a scenario starts: in darkness without anybody on it, under
 * exploration fog not even its shape.
 */
export function SecretMap({ field, darkness, blind, maxHeight }: { field: Field; darkness?: boolean; blind?: boolean; maxHeight?: number }) {
  if (blind) return <UnknownMap maxHeight={maxHeight} />;
  if (!darkness) return <MiniMap field={field} maxHeight={maxHeight} />;
  return <MiniMap field={{ ...field, cells: field.cells.map((c) => ({ ...c, owner: -1, power: 0 })) }} maxHeight={maxHeight} />;
}
