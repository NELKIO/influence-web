let uid = 0;

/** SVG version of a board cell (same look as the canvas): dark body, pigment level, number. */
export function HexCell({
  x,
  y,
  r = 20,
  owner = -1,
  power = 0,
  max = 8,
  ring,
  dim,
}: {
  x: number;
  y: number;
  r?: number;
  owner?: number;
  power?: number;
  max?: number;
  /** extra outline colour (selection / target) */
  ring?: string;
  dim?: boolean;
}) {
  const id = `hc${++uid}`;
  const pts = Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    return `${(x + r * Math.cos(a)).toFixed(2)},${(y + r * Math.sin(a)).toFixed(2)}`;
  }).join(' ');
  const ringPts = ring
    ? Array.from({ length: 6 }, (_, i) => {
        const a = (Math.PI / 3) * i - Math.PI / 2;
        const rr = r + 4;
        return `${(x + rr * Math.cos(a)).toFixed(2)},${(y + rr * Math.sin(a)).toFixed(2)}`;
      }).join(' ')
    : '';
  const col = owner >= 0 ? `var(--p${owner})` : '#3a3f49';
  const frac = Math.min(1, power / max);
  return (
    <g opacity={dim ? 0.55 : 1}>
      <clipPath id={id}>
        <polygon points={pts} />
      </clipPath>
      <polygon points={pts} fill={owner >= 0 ? `color-mix(in srgb, ${col} 28%, #0b0c0f)` : '#1a1d23'} />
      {power > 0 && <rect x={x - r} y={y + r - frac * 2 * r} width={r * 2} height={frac * 2 * r} fill={col} clip-path={`url(#${id})`} />}
      <polygon points={pts} fill="none" stroke={owner >= 0 ? `color-mix(in srgb, ${col} 70%, #fff)` : '#2c3038'} stroke-width={owner >= 0 ? 1.6 : 1.2} />
      {ring && <polygon points={ringPts} fill="none" stroke={ring} stroke-width="2" stroke-dasharray={ring === '#fff' ? undefined : '4 3'} />}
      {power > 0 && (
        <text x={x} y={y + r * 0.22} text-anchor="middle" font-family="Unbounded, sans-serif" font-weight="600" font-size={r * 0.62} fill="#fff">
          {power}
        </text>
      )}
    </g>
  );
}

/** Thick same-owner bridge between two cell centres. */
export function Bridge({ x1, y1, x2, y2, owner }: { x1: number; y1: number; x2: number; y2: number; owner: number }) {
  return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={`color-mix(in srgb, var(--p${owner}) 82%, #000)`} stroke-width="7" stroke-linecap="round" />;
}
