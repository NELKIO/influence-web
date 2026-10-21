import { useMemo, useState } from 'preact/hooks';
import { t } from '../../i18n';
import { navigate, useSettings } from '../store';
import { loadSetup, saveGame, saveSetup, setupToSettings, type SetupPrefs } from '../../storage';
import { createMatch } from '../../core/engine';
import { hashString, randomSeed } from '../../core/rng';
import { buildScenario } from '../../core/scenarios';
import { createPuzzleMatch, SCENARIOS, type ScenarioId } from '../../daily';
import { SIZE_ORDER, type MatchState, type PlayerType } from '../../core/types';
import { SettingRow, Toggle, TopBar } from '../components/controls';
import { IconPlus, IconRestart, IconX, PlayerToken } from '../components/icons';
import { MiniMap } from '../components/MiniMap';
import { sfx } from '../../audio/sfx';

const TYPES: PlayerType[] = ['freak', 'dummy', 'hunter', 'master', 'human'];
const LEVEL: Partial<Record<PlayerType, number>> = { freak: 1, dummy: 2, hunter: 3, master: 4 };

export function SetupScreen() {
  const settings = useSettings();
  const [prefs, setPrefs] = useState<SetupPrefs>(loadSetup());
  const [step, setStep] = useState(0);
  const [mapSeed, setMapSeed] = useState(() => randomSeed());

  // the preview IS the match that will start: same map, same start cells
  const preview = useMemo(
    () => createMatch(setupToSettings(prefs), { seed: mapSeed }),
    [mapSeed, prefs.size, prefs.symmetry, prefs.crowded, prefs.players.length, prefs.shuffle, prefs.players.join(',')],
  );

  const update = (p: Partial<SetupPrefs>) => {
    const next = { ...prefs, ...p };
    setPrefs(next);
    saveSetup(next);
  };

  const humans = prefs.players.filter((p) => p === 'human').length;

  const start = () => {
    sfx.click();
    // same seed as the preview -> the same map and start cells, with the current modes
    const st = createMatch(setupToSettings(prefs), { seed: mapSeed });
    saveGame(null);
    navigate({ name: 'game', launch: { state: st, initial: structuredClone(st) } });
  };

  const samples = useMemo(
    () => Object.fromEntries(SCENARIOS.map((id) => [id, buildScenario(id, hashString(`sample:${id}`))])) as Record<ScenarioId, MatchState>,
    [],
  );

  const playPuzzle = (id: ScenarioId) => {
    sfx.click();
    const st = createPuzzleMatch(id);
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
              <MiniMap field={preview.field} />
              <div class="map-meta">
                <div>
                  <div class="title" style={{ fontSize: 14 }}>
                    {preview.field.layout ? t(`layout_${preview.field.layout}` as 'layout_ring') : prefs.symmetry ? t('layout_mirror') : t('layout_random')}
                  </div>
                  <div class="desc">
                    {t('mapCells', { n: preview.field.cells.length })}
                    {preview.field.layout && ` · ${t(prefs.players.length === 3 ? 'layoutFair3' : 'layoutFair5')}`}
                  </div>
                </div>
                <button
                  class="btn small"
                  aria-label={t('reroll')}
                  onClick={() => {
                    sfx.click();
                    setMapSeed(randomSeed());
                  }}
                >
                  <IconRestart width={16} height={16} /> {t('reroll')}
                </button>
              </div>
            </div>

            <div class="section-title">{t('puzzles')}</div>
            <p class="lead" style={{ marginTop: -4 }}>
              {t('puzzlesDesc')}
            </p>
            <div class="puzzle-grid">
              {SCENARIOS.map((id) => (
                <button key={id} class="puzzle-card" onClick={() => playPuzzle(id)}>
                  <MiniMap field={samples[id].field} maxHeight={84} />
                  <span>{t(`puzzle_${id}` as 'puzzle_siege')}</span>
                </button>
              ))}
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
