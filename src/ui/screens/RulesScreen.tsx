import { t } from '../../i18n';
import { navigate, useSettings } from '../store';
import { TopBar } from '../components/controls';
import { Bridge, HexCell } from '../components/HexCell';

const DX = 42; // horizontal spacing of the diagram hexes
const DY = 36;

function Diagram({ children, h = 96 }: { children: preact.ComponentChildren; h?: number }) {
  return (
    <svg viewBox={`0 0 300 ${h}`} style={{ width: '100%', height: h, display: 'block' }} aria-hidden="true">
      {children}
    </svg>
  );
}

function Arrow({ x1, y, x2 }: { x1: number; y: number; x2: number }) {
  return (
    <g stroke="#eceef2" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
      <path d={`M${x1} ${y}H${x2}`} />
      <path d={`M${x2 - 5} ${y - 5}l5 5-5 5`} />
    </g>
  );
}

const ODDS: [number, number, number][] = [
  [6, 3, 100],
  [6, 5, 75],
  [6, 6, 50],
  [6, 7, 25],
  [6, 8, 0],
];

export function RulesScreen() {
  useSettings();
  return (
    <div class="screen">
      <div class="screen-inner">
        <TopBar title={t('rulesTitle')} onBack={() => navigate({ name: 'menu' })} />

        <div class="card rule-card">
          <Diagram>
            <Bridge x1={96} y1={30} x2={96 + DX} y2={30} owner={0} />
            <Bridge x1={96} y1={30} x2={96 + DX / 2} y2={30 + DY} owner={0} />
            <Bridge x1={96 + DX} y1={30} x2={96 + DX / 2} y2={30 + DY} owner={0} />
            <HexCell x={96} y={30} owner={0} power={8} />
            <HexCell x={96 + DX} y={30} owner={0} power={5} />
            <HexCell x={96 + DX / 2} y={30 + DY} owner={0} power={3} />
            <HexCell x={96 + DX * 2} y={30} power={0} />
            <HexCell x={96 + DX * 1.5} y={30 + DY} owner={3} power={2} />
          </Diagram>
          <h3>{t('rule1t')}</h3>
          <p>{t('rule1')}</p>
        </div>

        <div class="card rule-card">
          <Diagram>
            <HexCell x={70} y={48} owner={0} power={6} ring="#fff" />
            <Arrow x1={98} y={48} x2={124} />
            <HexCell x={150} y={48} owner={3} power={2} ring="var(--p0)" />
            <Arrow x1={178} y={48} x2={204} />
            <HexCell x={230} y={48} owner={0} power={4} />
          </Diagram>
          <h3>{t('rule2t')}</h3>
          <p>{t('rule2')}</p>
        </div>

        <div class="card rule-card">
          <div class="odds">
            {ODDS.map(([a, d, p]) => (
              <div key={d} class="odds-col">
                <svg viewBox="0 0 60 92" width="60" height="92" aria-hidden="true">
                  <HexCell x={30} y={22} r={18} owner={0} power={a} />
                  <HexCell x={30} y={68} r={18} owner={3} power={d} max={12} />
                </svg>
                <b style={{ color: p >= 75 ? 'var(--good)' : p >= 50 ? 'var(--text)' : p > 0 ? 'var(--warn)' : 'var(--bad)' }}>{p}%</b>
              </div>
            ))}
          </div>
          <h3>{t('rule3t')}</h3>
          <p>{t('rule3')}</p>
        </div>

        <div class="card rule-card">
          <Diagram>
            <text x="40" y="18" class="dg-cap">
              {t('rulesBefore')}
            </text>
            <HexCell x={60} y={56} owner={0} power={7} />
            <HexCell x={60 + DX} y={56} owner={3} power={3} />
            <Arrow x1={135} y={56} x2={160} />
            <text x="190" y="18" class="dg-cap">
              {t('rulesAfter')}
            </text>
            <Bridge x1={200} y1={56} x2={200 + DX} y2={56} owner={0} />
            <HexCell x={200} y={56} owner={0} power={1} />
            <HexCell x={200 + DX} y={56} owner={0} power={4} />
          </Diagram>
          <h3>{t('rule4t')}</h3>
          <p>{t('rule4')}</p>
        </div>

        <div class="card rule-card">
          <Diagram>
            <Bridge x1={80} y1={48} x2={80 + DX} y2={48} owner={1} />
            <Bridge x1={80 + DX} y1={48} x2={80 + DX * 2} y2={48} owner={1} />
            <HexCell x={80} y={48} owner={1} power={2} />
            <HexCell x={80 + DX} y={48} owner={1} power={5} max={12} r={23} />
            <HexCell x={80 + DX * 2} y={48} owner={1} power={8} />
            <text x={80 + DX * 3 + 4} y="54" class="dg-plus">
              +3
            </text>
          </Diagram>
          <h3>{t('rule5t')}</h3>
          <p>{t('rule5')}</p>
        </div>

        <div class="card rule-card">
          <Diagram>
            <HexCell x={70} y={48} owner={4} power={4} />
            <HexCell x={70 + DX} y={48} power={0} />
            <HexCell x={70 + DX * 2} y={48} power={0} dim />
            <g opacity="0.25">
              <HexCell x={70 + DX * 3} y={48} power={0} />
              <HexCell x={70 + DX * 4} y={48} power={0} />
            </g>
          </Diagram>
          <h3>{t('rule6t')}</h3>
          <p>{t('rule6')}</p>
        </div>

        <div class="section-title">{t('duelRulesTitle')}</div>
        <div class="card rule-card">
          <Diagram>
            <Bridge x1={60} y1={48} x2={60 + DX} y2={48} owner={0} />
            <Bridge x1={60 + DX} y1={48} x2={60 + DX * 2} y2={48} owner={0} />
            <HexCell x={60} y={48} owner={0} power={3} />
            <HexCell x={60 + DX} y={48} owner={0} power={3} />
            <HexCell x={60 + DX * 2} y={48} owner={0} power={3} />
            <HexCell x={60 + DX * 3} y={48} power={0} />
            <HexCell x={60 + DX * 4} y={48} owner={0} power={3} dim />
            <text x={60 + DX} y="92" text-anchor="middle" class="dg-plus">
              +3
            </text>
          </Diagram>
          <p>{t('duelRule1')}</p>
          <p>{t('duelRule2')}</p>
          <p>{t('duelRule3')}</p>
        </div>
      </div>
    </div>
  );
}
