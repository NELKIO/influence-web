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
import { MiniMap } from '../components/MiniMap';
import { sfx } from '../../audio/sfx';

const TYPES: PlayerType[] = ['freak', 'dummy', 'hunter', 'master', 'human'];
const LEVEL: Partial<Record<PlayerType, number>> = { freak: 1, dummy: 2, hunter: 3, master: 4 };

/** Start cells the engine will use for n players (see engine placeStarts). */
function startCells(starts: number[], n: number): number[] {
  if (n === 2) return [starts[0], starts[1]];
  if (n === 3) return [starts[0], starts[1], starts[4]];
  if (n === 4) return starts.slice(0, 4);
  return starts;
}

function MapPreview({ size, symmetry, players }: { size: FieldSize; symmetry: boolean; players: number }) {
  const field = useMemo(
    () => generateField({ size, symmetry, players }, new Rng(7 + SIZE_ORDER.indexOf(size) * 31 + (symmetry ? 1 : 0) + players * 7)),
    [size, symmetry, players],
  );
  return <MiniMap field={field} starts={startCells(field.starts, players)} />;
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
              <span class="n">{i + 1}</span>
              {label}
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
              <MapPreview size={prefs.size} symmetry={prefs.symmetry} players={prefs.players.length} />
              <div class="muted" style={{ fontSize: 13, marginTop: 8, textAlign: 'center' }}>
                {t('sizeInfo', { w: info.w, h: info.h, n: info.cells })}
                {prefs.symmetry && (prefs.players.length === 3 || prefs.players.length === 5) && (
                  <>
                    <br />
                    {t(prefs.players.length === 3 ? 'layoutTriangle' : 'layoutStar')}
                  </>
                )}
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
            <SettingRow title={t('symmetry')} desc={t('symmetryDesc2')}>
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
              <button class="btn primary" onClick={() => setStep(step + 1)}>
                {t('next')}
              </button>
            </>
          ) : (
            <button class="btn primary" onClick={start}>
              {t('start')} · {t('playersCount', { n: prefs.players.length })}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
