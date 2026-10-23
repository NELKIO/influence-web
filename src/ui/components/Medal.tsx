import type { MedalTier } from '../../medals';

// A hexagonal medal on a ribbon, faceted like a cut stone (light from the top left).
const CX = 16;
const CY = 22;

const pt = (r: number, i: number, cy = CY) => {
  const a = (Math.PI / 3) * i - Math.PI / 2;
  return [CX + r * Math.cos(a), cy + r * Math.sin(a)];
};
const hex = (r: number, cy = CY) =>
  Array.from({ length: 6 }, (_, i) => pt(r, i, cy).map((v) => v.toFixed(2)).join(',')).join(' ');
/** the facet between vertex i and the next one, cut down to the inner plate */
const facet = (i: number, outer: number, inner: number) =>
  [pt(outer, i), pt(outer, (i + 1) % 6), pt(inner, (i + 1) % 6), pt(inner, i)].map((p) => p.map((v) => v.toFixed(2)).join(',')).join(' ');
const star = (r: number, k: number) =>
  Array.from({ length: 10 }, (_, i) => {
    const a = (Math.PI / 5) * i - Math.PI / 2;
    const rr = i % 2 ? r * k : r;
    return `${(CX + rr * Math.cos(a)).toFixed(2)},${(CY + 0.4 + rr * Math.sin(a)).toFixed(2)}`;
  }).join(' ');

const METAL = {
  // facets from the top-right one clockwise: top-right, right, bottom-right, bottom-left, left, top-left
  medal: { facets: ['#e4e8ee', '#b4bbc6', '#8f97a4', '#a3aab6', '#d3d8e0', '#f4f6f9'], plate: '#c7cdd6', mark: '#6e7683', ribbon: ['#2f6fd6', '#3f8cff'] },
  gold: { facets: ['#ffd36b', '#e9a531', '#c7861d', '#d99626', '#f7c04e', '#ffe39a'], plate: '#f2b33d', mark: '#9a6510', ribbon: ['#c4402f', '#f0604d'] },
} as const;

const RIBBON_L = '6,1 12.5,1 18,15 11.5,15';
const RIBBON_R = '26,1 19.5,1 14,15 20.5,15';

/** The medal of a scenario: earned (silver or gold) or an empty dashed outline to win it. */
export function Medal({ tier, size = 24, label }: { tier: MedalTier | null; size?: number; label?: string }) {
  const a11y = label ? { role: 'img' as const, 'aria-label': label } : { 'aria-hidden': true };
  if (!tier) {
    return (
      <svg class="medal empty" viewBox="0 0 32 36" width={size} height={(size * 36) / 32} {...a11y}>
        <g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round">
          <polyline points="7.5,0.8 12.2,13.4" />
          <polyline points="24.5,0.8 19.8,13.4" />
          <polygon points={hex(10.5)} stroke-dasharray="2.4 2.1" />
          <polygon points={star(3.8, 0.45)} stroke-width="1.2" />
        </g>
      </svg>
    );
  }
  const m = METAL[tier];
  return (
    <svg class={`medal ${tier}`} viewBox="0 0 32 36" width={size} height={(size * 36) / 32} {...a11y}>
      <polygon points={RIBBON_L} fill={m.ribbon[0]} />
      <polygon points={RIBBON_R} fill={m.ribbon[1]} />
      {m.facets.map((c, i) => (
        <polygon key={i} points={facet(i, 11, 7.6)} fill={c} />
      ))}
      <polygon points={hex(7.6)} fill={m.plate} />
      <polygon points={star(4.4, 0.42)} fill={m.mark} />
    </svg>
  );
}
