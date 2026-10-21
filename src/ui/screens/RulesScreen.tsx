import { t } from '../../i18n';
import { navigate, useSettings } from '../store';
import { TopBar } from '../components/controls';

function MiniHex({ fill, color, n, x, y }: { fill: number; color: string; n?: number; x: number; y: number }) {
  const r = 9;
  const pts = Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    return `${(x + r * Math.cos(a)).toFixed(2)},${(y + r * Math.sin(a)).toFixed(2)}`;
  }).join(' ');
  const id = `c${x}${y}${color.replace(/\W/g, '')}`;
  return (
    <g>
      <clipPath id={id}>
        <polygon points={pts} />
      </clipPath>
      <polygon points={pts} fill={color} fill-opacity="0.12" />
      <rect x={x - r} y={y + r - fill * 2 * r} width={2 * r} height={fill * 2 * r} fill={color} fill-opacity="0.8" clip-path={`url(#${id})`} />
      <polygon points={pts} fill="none" stroke={color} stroke-width="1.6" />
      {n !== undefined && (
        <text x={x} y={y + 3.5} text-anchor="middle" font-size="10" font-weight="800" fill="#fff">
          {n}
        </text>
      )}
    </g>
  );
}

const ICONS = [
  <svg viewBox="0 0 40 40">
    <MiniHex x={12} y={12} fill={1} color="var(--p0)" n={8} />
    <MiniHex x={28} y={12} fill={1} color="var(--p0)" n={6} />
    <MiniHex x={20} y={27} fill={0.8} color="var(--p0)" n={6} />
  </svg>,
  <svg viewBox="0 0 40 40">
    <MiniHex x={10} y={20} fill={0.7} color="var(--p0)" n={6} />
    <path d="M20 20h6" stroke="#fff" stroke-width="2" />
    <MiniHex x={31} y={20} fill={0.3} color="var(--p3)" n={2} />
  </svg>,
  <svg viewBox="0 0 40 40">
    <text x="20" y="25" text-anchor="middle" font-size="13" font-weight="800" fill="var(--warn)">
      %
    </text>
    <circle cx="20" cy="20" r="15" fill="none" stroke="var(--warn)" stroke-width="2" stroke-dasharray="70 30" />
  </svg>,
  <svg viewBox="0 0 40 40">
    <MiniHex x={10} y={20} fill={0.12} color="var(--p0)" n={1} />
    <MiniHex x={30} y={20} fill={0.6} color="var(--p0)" n={4} />
  </svg>,
  <svg viewBox="0 0 40 40">
    <MiniHex x={20} y={22} fill={0.55} color="var(--p1)" n={5} />
    <text x="30" y="11" font-size="10" font-weight="800" fill="var(--p1)">
      +1
    </text>
  </svg>,
  <svg viewBox="0 0 40 40">
    <MiniHex x={12} y={20} fill={0.5} color="var(--p4)" />
    <MiniHex x={28} y={20} fill={0} color="#333a4d" />
  </svg>,
];

export function RulesScreen() {
  useSettings();
  const rules = [1, 2, 3, 4, 5, 6] as const;
  return (
    <div class="screen">
      <div class="screen-inner">
        <TopBar title={t('rulesTitle')} onBack={() => navigate({ name: 'menu' })} />
        <div class="card" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {rules.map((n, i) => (
            <div class="rule" key={n}>
              {ICONS[i]}
              <div>
                <h3>{t(`rule${n}t` as 'rule1t')}</h3>
                <p>{t(`rule${n}` as 'rule1')}</p>
              </div>
            </div>
          ))}
        </div>
        <div class="section-title">{t('duelRulesTitle')}</div>
        <div class="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <p class="muted" style={{ margin: 0, lineHeight: 1.45 }}>• {t('duelRule1')}</p>
          <p class="muted" style={{ margin: 0, lineHeight: 1.45 }}>• {t('duelRule2')}</p>
          <p class="muted" style={{ margin: 0, lineHeight: 1.45 }}>• {t('duelRule3')}</p>
        </div>
      </div>
    </div>
  );
}
