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
            fill={col ?? '#1b1e24'}
            stroke={col ?? '#2c3038'}
            stroke-width="0.08"
          />
        );
      })}
    </svg>
  );
}
