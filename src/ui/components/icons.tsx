import type { JSX } from 'preact';

type P = JSX.SVGAttributes<SVGSVGElement>;

const base = (children: JSX.Element | JSX.Element[], p: P) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" {...p}>
    {children}
  </svg>
);

export const IconBack = (p: P) => base(<path d="M15 5l-7 7 7 7" />, p);
export const IconChevron = (p: P) => base(<path d="M9 5l7 7-7 7" />, p);
export const IconPause = (p: P) => base([<rect x="6" y="5" width="4" height="14" rx="1" />, <rect x="14" y="5" width="4" height="14" rx="1" />], p);
export const IconPlay = (p: P) => base(<path d="M7 4.5v15l12-7.5z" fill="currentColor" />, p);
export const IconCalendar = (p: P) =>
  base([<rect x="3.5" y="5" width="17" height="15" rx="3" />, <path d="M3.5 10h17M8 3v4M16 3v4" />, <path d="M8.5 15l2 2 4-4" />], p);
export const IconSwords = (p: P) =>
  base([<path d="M4 4l9 9M4 4v4M4 4h4" />, <path d="M20 4l-9 9M20 4v4M20 4h-4" />, <path d="M9 16l-3 3M15 16l3 3M7 14l3 3M17 14l-3 3" />], p);
export const IconGear = (p: P) =>
  base(
    [
      <circle cx="12" cy="12" r="3" />,
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />,
    ],
    p,
  );
export const IconChart = (p: P) => base([<path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />], p);
export const IconBook = (p: P) =>
  base([<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v17H6.5A2.5 2.5 0 0 0 4 21.5z" />, <path d="M4 21.5A2.5 2.5 0 0 1 6.5 19H20v3H6.5" />], p);
export const IconZoomIn = (p: P) => base([<circle cx="11" cy="11" r="7" />, <path d="M21 21l-4.5-4.5M11 8v6M8 11h6" />], p);
export const IconZoomOut = (p: P) => base([<circle cx="11" cy="11" r="7" />, <path d="M21 21l-4.5-4.5M8 11h6" />], p);
export const IconCheck = (p: P) => base(<path d="M5 12.5l4.5 4.5L19 7.5" />, p);
export const IconArrow = (p: P) => base(<path d="M5 12h14M13 6l6 6-6 6" />, p);
export const IconX = (p: P) => base(<path d="M6 6l12 12M18 6L6 18" />, p);
export const IconPlus = (p: P) => base(<path d="M12 5v14M5 12h14" />, p);
export const IconRestart = (p: P) => base([<path d="M3 12a9 9 0 1 0 3-6.7" />, <path d="M3 4v5h5" />], p);
export const IconHome = (p: P) => base([<path d="M3 11l9-7 9 7" />, <path d="M5 10v10h14V10" />], p);
export const IconFlag = (p: P) => base([<path d="M5 21V4" />, <path d="M5 4h11l-2 4 2 4H5" />], p);
export const IconShare = (p: P) =>
  base([<circle cx="18" cy="5" r="3" />, <circle cx="6" cy="12" r="3" />, <circle cx="18" cy="19" r="3" />, <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />], p);
export const IconBolt = (p: P) => base(<path d="M13 2L4 14h7l-1 8 9-12h-7z" fill="currentColor" stroke="none" />, p);
export const IconUsers = (p: P) =>
  base([<circle cx="9" cy="8" r="3.5" />, <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />, <path d="M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6" />], p);
export const IconBot = (p: P) =>
  base([<rect x="4" y="8" width="16" height="12" rx="3" />, <path d="M12 4v4M9 13h.01M15 13h.01M9 17h6" />, <circle cx="12" cy="3" r="1" />], p);
export const IconWifi = (p: P) => base([<path d="M2 8.5a15 15 0 0 1 20 0M5 12a10 10 0 0 1 14 0M8.5 15.5a5 5 0 0 1 7 0" />, <circle cx="12" cy="19" r="1" fill="currentColor" />], p);

/** Logo mark: two hexes of different owners joined by a bridge — the core idea of the game. */
export function LogoMark(p: P) {
  const hex = (cx: number, cy: number, r: number) =>
    Array.from({ length: 6 }, (_, i) => {
      const a = (Math.PI / 3) * i - Math.PI / 2;
      return `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`;
    }).join(' ');
  return (
    <svg viewBox="0 0 64 64" {...p}>
      <defs>
        <clipPath id="lm-a">
          <polygon points={hex(24, 26, 17)} />
        </clipPath>
        <clipPath id="lm-b">
          <polygon points={hex(43, 42, 13)} />
        </clipPath>
      </defs>
      <line x1="24" y1="26" x2="43" y2="42" stroke="var(--p0)" stroke-width="7" stroke-linecap="round" opacity="0.75" />
      <polygon points={hex(24, 26, 17)} fill="#0f1a2e" />
      <rect x="4" y="17" width="40" height="30" fill="var(--p0)" clip-path="url(#lm-a)" />
      <polygon points={hex(24, 26, 17)} fill="none" stroke="#8fbaff" stroke-width="1.6" />
      <polygon points={hex(43, 42, 13)} fill="#2a1a17" />
      <rect x="28" y="44" width="30" height="14" fill="var(--p3)" clip-path="url(#lm-b)" />
      <polygon points={hex(43, 42, 13)} fill="none" stroke="#f7a093" stroke-width="1.6" />
    </svg>
  );
}

/** Small illustrations for the mode cards. */
export function ModeArt({ kind }: { kind: 'quick' | 'duel' | 'daily' | 'rules' }) {
  const hex = (cx: number, cy: number, r: number) =>
    Array.from({ length: 6 }, (_, i) => {
      const a = (Math.PI / 3) * i - Math.PI / 2;
      return `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`;
    }).join(' ');
  const cell = (cx: number, cy: number, c: string, fill = 0.6, r = 9) => (
    <g>
      <clipPath id={`ma-${kind}-${cx}-${cy}`}>
        <polygon points={hex(cx, cy, r)} />
      </clipPath>
      <polygon points={hex(cx, cy, r)} fill="#1b1e24" />
      <rect x={cx - r} y={cy + r - fill * 2 * r} width={r * 2} height={fill * 2 * r} fill={c} clip-path={`url(#ma-${kind}-${cx}-${cy})`} />
      <polygon points={hex(cx, cy, r)} fill="none" stroke={c} stroke-opacity="0.9" stroke-width="1.2" />
    </g>
  );
  if (kind === 'quick')
    return (
      <svg class="art" viewBox="0 0 64 52">
        <line x1="16" y1="16" x2="32" y2="16" stroke="var(--p1)" stroke-width="4" opacity="0.7" />
        <line x1="32" y1="16" x2="24" y2="30" stroke="var(--p1)" stroke-width="4" opacity="0.7" />
        {cell(16, 16, 'var(--p1)', 0.9)}
        {cell(32, 16, 'var(--p1)', 0.5)}
        {cell(24, 30, 'var(--p1)', 0.3)}
        {cell(48, 16, 'var(--p2)', 0.6)}
        {cell(40, 30, '#3a3f49', 0)}
        {cell(56, 30, 'var(--p2)', 0.8)}
      </svg>
    );
  if (kind === 'duel')
    return (
      <svg class="art" viewBox="0 0 64 52">
        {cell(14, 24, 'var(--p0)', 0.8, 11)}
        {cell(50, 24, 'var(--p3)', 0.8, 11)}
        <path d="M27 24h10" stroke="#eceef2" stroke-width="2" stroke-linecap="round" />
        <path d="M33 20l4 4-4 4" stroke="#eceef2" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    );
  if (kind === 'daily')
    return (
      <svg class="art" viewBox="0 0 64 52">
        {cell(44, 26, 'var(--p2)', 0.45, 18)}
        <text x="44" y="32" text-anchor="middle" font-family="Unbounded, sans-serif" font-size="15" font-weight="600" fill="#fff">
          {new Date().getDate()}
        </text>
      </svg>
    );
  return (
    <svg class="art" viewBox="0 0 64 52">
      {cell(22, 26, 'var(--p4)', 0.75)}
      {cell(40, 26, '#3a3f49', 0)}
      <text x="40" y="30" text-anchor="middle" font-family="Unbounded, sans-serif" font-size="10" font-weight="600" fill="#8d939e">
        ?
      </text>
    </svg>
  );
}

/** Small player token in the player's colour and (in colour-blind mode) shape. */
export function PlayerToken({ slot, size = 22, shape = false }: { slot: number; size?: number; shape?: boolean }) {
  const c = `var(--p${slot})`;
  const r = 9;
  let path: string;
  const poly = (n: number, rot: number, rr = r) =>
    Array.from({ length: n }, (_, i) => {
      const a = ((Math.PI * 2) / n) * i + rot;
      return `${(12 + rr * Math.cos(a)).toFixed(2)},${(12 + rr * Math.sin(a)).toFixed(2)}`;
    }).join(' ');
  if (!shape || slot === 0) path = poly(6, -Math.PI / 2);
  else if (slot === 1) path = poly(3, -Math.PI / 2, 10);
  else if (slot === 2) path = poly(4, -Math.PI / 2);
  else if (slot === 3) path = poly(5, -Math.PI / 2);
  else path = poly(4, Math.PI / 4);
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} style={{ flex: 'none' }}>
      <polygon points={path} fill={c} stroke={c} stroke-width="1.5" stroke-linejoin="round" />
    </svg>
  );
}
