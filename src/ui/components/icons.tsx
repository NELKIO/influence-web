import type { JSX } from 'preact';

type P = JSX.SVGAttributes<SVGSVGElement>;

const base = (children: JSX.Element | JSX.Element[], p: P) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" {...p}>
    {children}
  </svg>
);

export const IconBack = (p: P) => base(<path d="M15 5l-7 7 7 7" />, p);
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

/** The game's logo mark: a cluster of three glowing hexes. */
export function LogoMark(p: P) {
  const hex = (cx: number, cy: number, r: number) => {
    const pts = Array.from({ length: 6 }, (_, i) => {
      const a = (Math.PI / 3) * i - Math.PI / 2;
      return `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`;
    });
    return pts.join(' ');
  };
  return (
    <svg viewBox="0 0 120 120" {...p}>
      <defs>
        <linearGradient id="lg0" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="var(--p0)" stop-opacity="0.95" />
          <stop offset="1" stop-color="var(--p0)" stop-opacity="0.45" />
        </linearGradient>
        <clipPath id="lc">
          <polygon points={hex(60, 44, 27)} />
        </clipPath>
      </defs>
      <g stroke-width="3.5" fill="none">
        <line x1="60" y1="44" x2="36" y2="85" stroke="var(--p0)" stroke-width="4" opacity="0.8" />
        <line x1="60" y1="44" x2="84" y2="85" stroke="var(--p0)" stroke-width="4" opacity="0.8" />
        <polygon points={hex(36, 85, 21)} fill="rgba(166,77,255,0.15)" stroke="var(--p4)" />
        <polygon points={hex(84, 85, 21)} fill="url(#lg0)" stroke="var(--p0)" />
        <polygon points={hex(60, 44, 27)} fill="rgba(26,163,255,0.12)" stroke="var(--p0)" />
        <rect x="30" y="38" width="60" height="40" fill="url(#lg0)" clip-path="url(#lc)" />
      </g>
      <text x="60" y="52" text-anchor="middle" font-size="22" font-weight="800" fill="#fff" font-family="Exo 2, sans-serif">
        7
      </text>
      <text x="84" y="92" text-anchor="middle" font-size="16" font-weight="800" fill="#fff" font-family="Exo 2, sans-serif">
        4
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
    <svg viewBox="0 0 24 24" width={size} height={size} style={{ filter: `drop-shadow(0 0 4px ${c})`, flex: 'none' }}>
      <polygon points={path} fill={c} fill-opacity="0.35" stroke={c} stroke-width="2" />
    </svg>
  );
}
