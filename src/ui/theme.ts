import type { Palette } from '../storage';

/** Pigment palettes: saturated but not neon, readable on the warm near-black board. */
export const PALETTES: Record<Palette, string[]> = {
  main: ['#3f8cff', '#2fbf83', '#f2b33d', '#f0604d', '#a070f5'],
  classic: ['#2ea3d9', '#57b346', '#f5cf4b', '#de4b5b', '#8c63e6'],
  soft: ['#6f9be8', '#62b89a', '#e3bd6f', '#e07c6a', '#b08fe0'],
};

export const NEUTRAL_COLOR = '#3a3f49';

let current: string[] = PALETTES.main;

export function setPalette(p: Palette) {
  current = PALETTES[p] ?? PALETTES.main;
  const root = document.documentElement.style;
  current.forEach((c, i) => root.setProperty(`--p${i}`, c));
  root.setProperty('--accent', current[0]);
}

export function playerColor(slot: number): string {
  return slot < 0 ? NEUTRAL_COLOR : current[slot % current.length];
}

/** Mix a hex colour with black (t<0) or white (t>0). */
export function shade(hex: string, t: number): string {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255;
  let g = (n >> 8) & 255;
  let b = n & 255;
  const target = t < 0 ? 0 : 255;
  const k = Math.abs(t);
  r = Math.round(r + (target - r) * k);
  g = Math.round(g + (target - g) * k);
  b = Math.round(b + (target - b) * k);
  return `rgb(${r},${g},${b})`;
}

export function withAlpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
