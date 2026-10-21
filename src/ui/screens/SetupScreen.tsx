import { useMemo, useState } from 'preact/hooks';
import { t } from '../../i18n';
import { navigate, useSettings } from '../store';
import { loadSetup, saveGame, saveSetup, setupToSettings, type SetupPrefs } from '../../storage';
import { createMatch } from '../../core/engine';
import { generateField } from '../../core/field';
import { Rng } from '../../core/rng';
import { SIZES, SIZE_ORDER, type FieldSize, type PlayerType } from '../../core/types';
import { SettingRow, Toggle, TopBar } from '../components/controls';
import { IconPlus, IconX, PlayerToken } from '../components/icons';
import { cellCenter } from '../board/renderer';
import { sfx } from '../../audio/sfx';

const TYPES: PlayerType[] = ['freak', 'dummy', 'hunter', 'master', 'human'];
const LEVEL: Partial<Record<PlayerType, number>> = { freak: 1, dummy: 2, hunter: 3, master: 4 };

function MapPreview({ size, symmetry }: { size: FieldSize; symmetry: boolean }) {
  const field = useMemo(() => generateField({ size, symmetry }, new Rng(7 + SIZE_ORDER.indexOf(size) * 31 + (symmetry ? 1 : 0))), [size, symmetry]);
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
  return (
    <svg viewBox={`${minX} ${minY} ${w} ${h}`} style={{ width: '100%', maxHeight: 200 }}>
      {field.cells.map((c, i) => (
        <polygon
          key={i}
          points={hex(pts[i][0], pts[i][1], c.maxPower > 8 ? 0.88 : 0.74)}
          fill={field.starts.slice(0, 4).includes(i) ? 'rgba(26,163,255,0.5)' : 'rgba(120,140,190,0.12)'}
          stroke={field.starts.slice(0, 4).includes(i) ? 'var(--p0)' : 'rgba(150,170,220,0.4)'}
          stroke-width="0.09"
        />
      ))}
    </svg>
  );
}

export function SetupScreen() {
  const settings = useSettings();
  const [prefs, setPrefs] = useState<SetupPrefs>(loadSetup());
  const [step, setStep] = useState(0);

  const update = (p: Partial<SetupPrefs>) => {
    const next = { ...prefs, ...p };
    setPrefs(next);
    saveSetup(next);
  };

  const humans = prefs.players.filter((p) => p === 'human').length;
  const info = SIZES[prefs.size];

  const start = () => {
    sfx.click();
    const st = createMatch(setupToSettings(prefs));
    saveGame(null);
    navigate({ name: 'game', launch: { state: st, initial: structuredClone(st) } });
  };

  const setType = (slot: number, type: PlayerType) => {
    const players = [...prefs.players];
    players[slot] = type;
    update({ players });
  };

  return (
    <div class="screen">
      <div class="screen-inner">
        <TopBar title={t('setupTitle')} onBack={() => navigate({ name: 'menu' })} />
        <div class="steps">
          {[t('stepMap'), t('stepPlayers'), t('stepModes')].map((label, i) => (
            <button key={i} class={step === i ? 'on' : ''} onClick={() => setStep(i)}>
              {i + 1}. {label}
            </button>
          ))}
        </div>

        {step === 0 && (
          <>
            <div class="size-grid">
              {SIZE_ORDER.map((sz) => (
                <button
                  key={sz}
                  class={`size-tile ${prefs.size === sz ? 'on' : ''}`}
                  onClick={() => {
                    sfx.click();
                    update({ size: sz });
                  }}
                >
                  <b>{sz}</b>
                  <span>{t(`size${sz}` as 'sizeS')}</span>
                </button>
              ))}
            </div>
            <div class="card map-preview">
              <MapPreview size={prefs.size} symmetry={prefs.symmetry} />
              <div class="muted" style={{ fontSize: 13, marginTop: 8 }}>
                {t('sizeInfo', { w: info.w, h: info.h, n: info.cells })}
              </div>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <div class="list">
              {prefs.players.map((type, slot) => (
                <div key={slot} class="player-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <PlayerToken slot={slot} size={30} shape={settings.colorblind} />
                    <div style={{ flex: 1 }}>
                      <div class="title" style={{ fontWeight: 700 }}>
                        {slot === 0 ? t('you') : t(`player_${type}` as 'player_human')}
                        {LEVEL[type] && (
                          <span class="level">
                            {[1, 2, 3, 4].map((k) => (
                              <i key={k} class={k <= LEVEL[type]! ? 'on' : ''} />
                            ))}
                          </span>
                        )}
                      </div>
                      <div class="desc muted" style={{ fontSize: 13 }}>
                        {slot === 0 ? t('desc_human') : t(`desc_${type === 'human' ? 'human' : type}` as 'desc_human')}
                      </div>
                    </div>
                    {slot >= 2 && slot === prefs.players.length - 1 && (
                      <button class="remove-btn" aria-label={t('removePlayer')} onClick={() => update({ players: prefs.players.slice(0, -1) })}>
                        <IconX width={20} height={20} />
                      </button>
                    )}
                  </div>
                  {slot > 0 && (
                    <div class="type-pick" style={{ '--c': `var(--p${slot})` }}>
                      {TYPES.map((tp) => (
                        <button
                          key={tp}
                          class={type === tp ? 'on' : ''}
                          onClick={() => {
                            sfx.click();
                            setType(slot, tp);
                          }}
                        >
                          {t(`player_${tp}` as 'player_human')}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {prefs.players.length < 5 && (
                <button
                  class="add-row"
                  onClick={() => {
                    sfx.click();
                    update({ players: [...prefs.players, 'hunter'] });
                  }}
                >
                  <IconPlus width={18} height={18} /> {t('addPlayer')}
                </button>
              )}
            </div>
            <div class="list">
              <SettingRow title={t('shuffle')} desc={t('shuffleDesc')}>
                <Toggle on={prefs.shuffle} onChange={(v) => update({ shuffle: v })} />
              </SettingRow>
            </div>
            {humans > 1 && <div class="muted" style={{ fontSize: 13, textAlign: 'center' }}>{t('hotseatNote')}</div>}
          </>
        )}

        {step === 2 && (
          <div class="list">
            <SettingRow title={t('darkness')} desc={t('darknessDesc')}>
              <Toggle on={prefs.darkness} onChange={(v) => update({ darkness: v })} />
            </SettingRow>
            <SettingRow title={t('symmetry')} desc={t('symmetryDesc')}>
              <Toggle on={prefs.symmetry} onChange={(v) => update({ symmetry: v })} />
            </SettingRow>
            <SettingRow title={t('crowded')} desc={t('crowdedDesc')}>
              <Toggle on={prefs.crowded} onChange={(v) => update({ crowded: v })} />
            </SettingRow>
            <SettingRow title={t('unions')} desc={humans > 1 ? t('unionsNeedOneHuman') : t('unionsDesc')}>
              <Toggle on={prefs.unions} onChange={(v) => update({ unions: v })} />
            </SettingRow>
          </div>
        )}

        <div class="footer-actions">
          {step < 2 ? (
            <>
              <button class="btn ghost" onClick={start}>
                {t('start')}
              </button>
              <button class="btn" onClick={() => setStep(step + 1)}>
                {t('next')}
              </button>
            </>
          ) : (
            <button class="btn green" onClick={start}>
              {t('start')} · {t('playersCount', { n: prefs.players.length })}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
