import type { Palette } from '../storage';

export const PALETTES: Record<Palette, string[]> = {
  main: ['#1aa3ff', '#14d65a', '#ffcc1a', '#ff4b26', '#a64dff'],
  classic: ['#35b7de', '#1fae6a', '#ffd95d', '#e05656', '#9868fc'],
  soft: ['#5b8def', '#4cbf8f', '#e9c46a', '#e76f51', '#c084fc'],
};

export const NEUTRAL_COLOR = '#5a6273';

let current: string[] = PALETTES.main;

export function setPalette(p: Palette) {
  current = PALETTES[p] ?? PALETTES.main;
  const root = document.documentElement.style;
  current.forEach((c, i) => root.setProperty(`--p${i}`, c));
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
