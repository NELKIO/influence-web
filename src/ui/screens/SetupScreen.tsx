import { useMemo, useState } from 'preact/hooks';
import { t } from '../../i18n';
import { navigate, useSettings } from '../store';
import { loadMedals, loadSetup, saveGame, saveSetup, scenarioOptions, setupPlayers, setupToSettings, type SetupPrefs } from '../../storage';
import { seatsMedal, type MedalTier } from '../../medals';
import { hashString, randomSeed } from '../../core/rng';
import { buildScenario, SCENARIO_META, SCENARIOS, startMatch, type ScenarioConfig, type ScenarioId } from '../../core/scenarios';
import { prepareHost } from '../battle';
import { SIZE_ORDER, type Field, type MatchState, type PlayerType } from '../../core/types';
import { Seg, SettingRow, Toggle, TopBar } from '../components/controls';
import { IconLock, IconMoon, IconPlus, IconRestart, IconUsers, IconX, PlayerToken } from '../components/icons';
import { MiniMap, SecretMap } from '../components/MiniMap';
import { Medal } from '../components/Medal';
import { sfx } from '../../audio/sfx';

const TYPES: PlayerType[] = ['dummy', 'hunter', 'master', 'god', 'human', 'online'];
const LEVEL: Partial<Record<PlayerType, number>> = { dummy: 1, hunter: 2, master: 3, god: 4 };

const playersLabel = (n: number) => t(n >= 5 ? 'playersCountMany' : 'playersCount', { n });

/** Picture of a scenario's map: in darkness without the starts, under exploration fog not even the shape. */
function ScenarioMap({ id, field, maxHeight }: { id: ScenarioId; field: Field; maxHeight: number }) {
  const m = SCENARIO_META[id];
  return <SecretMap field={field} darkness={m.darkness} blind={m.blind} maxHeight={maxHeight} />;
}

const medalLabel = (tier: MedalTier | null) => t(tier === 'gold' ? 'medalGoldTitle' : tier ? 'medalTitle' : 'medalNone');

/** The medal of the chosen scenario: earned, or what it takes (and whether these seats can earn it). */
function MedalStatus({ have, seats, free }: { have: MedalTier | null; seats: ReturnType<typeof seatsMedal>; free?: boolean }) {
  const blocked = seats === 'people' ? t('medalNoPeople') : seats === 'weaker' ? t('medalNoWeaker') : null;
  // what these seats play for, when it is worth saying
  const stake =
    have === 'gold' ? null : blocked ? <div class="note blocked">{blocked}</div> : seats === 'gold' ? <div class="note for-gold">{t('medalGoldSeats')}</div> : null;
  return (
    <div class={`medal-status ${have ?? 'none'}`} data-testid="medal-status">
      <Medal tier={have} size={30} label={medalLabel(have)} />
      <div class="grow">
        {have && <div class="title">{medalLabel(have)}</div>}
        {have === 'gold' && <div class="note">{t('medalGoldDone')}</div>}
        {have === 'medal' && (stake ?? <div class="note">{t('medalGoldNext')}</div>)}
        {!have && <div class="note">{t(free ? 'medalHintFree' : 'medalHint')}</div>}
        {!have && stake}
      </div>
    </div>
  );
}

export function SetupScreen() {
  const settings = useSettings();
  const [prefs, setPrefs] = useState<SetupPrefs>(loadSetup());
  const [step, setStep] = useState(0);
  const [mapSeed, setMapSeed] = useState(() => randomSeed());
  const [medals] = useState(loadMedals);
  const medalCount = SCENARIOS.filter((id) => medals[id]).length;

  const scenario = prefs.scenario;
  const meta = scenario ? SCENARIO_META[scenario] : null;
  const players = setupPlayers(prefs);
  // what a configurable scenario lets you choose, and what is chosen
  const conf = meta?.configurable;
  const opts = scenario ? scenarioOptions(prefs, scenario) : null;

  // the preview IS the match that will start: same map, same start cells
  const preview = useMemo(
    () => startMatch(setupToSettings(prefs), mapSeed),
    [mapSeed, scenario, prefs.size, prefs.symmetry, prefs.crowded, prefs.shuffle, players.join(','), opts?.size],
  );

  const update = (p: Partial<SetupPrefs>) => {
    const next = { ...prefs, ...p };
    setPrefs(next);
    saveSetup(next);
  };

  const humans = players.filter((p) => p === 'human').length;
  const hasOnline = players.includes('online');

  const start = () => {
    sfx.click();
    if (hasOnline) {
      // seats for people on other devices: open a room first
      prepareHost(setupToSettings(prefs), mapSeed);
      navigate({ name: 'battleRoom' });
      return;
    }
    // same seed as the preview -> the same map and start cells, with the current modes
    const st = startMatch(setupToSettings(prefs), mapSeed);
    saveGame(null);
    navigate({ name: 'game', launch: { state: st, initial: structuredClone(st) } });
  };

  const samples = useMemo(
    () => Object.fromEntries(SCENARIOS.map((id) => [id, buildScenario(id, hashString(`sample:${id}`))])) as Record<ScenarioId, MatchState>,
    [],
  );

  const pickScenario = (id: ScenarioId) => {
    sfx.click();
    update({ scenario: id });
    setMapSeed(randomSeed());
    // the chosen scenario is shown at the top of the tab
    document.querySelector('.screen')?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const clearScenario = () => {
    sfx.click();
    update({ scenario: null });
    setMapSeed(randomSeed());
  };

  const setSeats = (list: PlayerType[]) => {
    if (scenario) update({ scenarioSeats: { ...prefs.scenarioSeats, [scenario]: list } });
    else update({ players: list });
  };

  const setType = (slot: number, type: PlayerType) => {
    const list = [...players];
    list[slot] = type;
    setSeats(list);
  };

  const configure = (c: ScenarioConfig) => {
    if (scenario) update({ scenarioConfig: { ...prefs.scenarioConfig, [scenario]: { ...prefs.scenarioConfig[scenario], ...c } } });
  };

  // seats can be added and removed in an ordinary battle and in a scenario that allows it
  const minSeats = meta ? (conf?.seats[0] ?? players.length) : 2;
  const maxSeats = meta ? (conf?.seats[1] ?? players.length) : 6;

  const locked = (on: boolean) => <Toggle on={on} onChange={() => {}} disabled />;

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
            {scenario && meta ? (
              <div class="card scenario-pick" data-testid="scenario-pick">
                <ScenarioMap id={scenario} field={preview.field} maxHeight={220} />
                <div class="scenario-head">
                  <div class="grow">
                    <div class="kicker">{t('scenarioKicker')}</div>
                    <div class="name">{t(`puzzle_${scenario}` as 'puzzle_siege')}</div>
                  </div>
                  <button class="scenario-clear" aria-label={t('scenarioClear')} onClick={clearScenario}>
                    <IconX width={18} height={18} />
                  </button>
                </div>
                <div class="desc">{t(`puzzleDesc_${scenario}` as 'puzzleDesc_siege')}</div>
                {conf && opts && conf.sizes.length > 1 && (
                  <div class="scenario-size" data-testid="scenario-size">
                    <Seg
                      label={t('scenarioSize')}
                      value={opts.size}
                      options={conf.sizes.map((sz) => ({ value: sz, label: t(`size${sz}` as 'sizeS') }))}
                      onChange={(size) => configure({ size })}
                    />
                  </div>
                )}
                <div class="chips">
                  <span class="chip">
                    <IconUsers width={14} height={14} /> {playersLabel(players.length)}
                  </span>
                  {meta.darkness && (
                    <span class="chip dark">
                      <IconMoon width={13} height={13} /> {t('darkness')}
                    </span>
                  )}
                  {meta.blind ? (
                    <span class="chip">{t('scenarioUncharted')}</span>
                  ) : (
                    <span class="chip">{t('mapCells', { n: preview.field.cells.length })}</span>
                  )}
                  {opts?.unions && <span class="chip">{t('unions')}</span>}
                </div>
                <MedalStatus have={medals[scenario]?.tier ?? null} seats={seatsMedal(scenario, players)} free={!!conf} />
              </div>
            ) : (
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
                        {preview.field.layout
                          ? t(`layout_${preview.field.layout}` as 'layout_ring')
                          : prefs.symmetry
                            ? t('layout_mirror')
                            : t('layout_random')}
                      </div>
                      <div class="desc">
                        {t('mapCells', { n: preview.field.cells.length })}
                        {preview.field.layout &&
                          ` · ${t(players.length === 3 ? 'layoutFair3' : players.length === 6 ? 'layoutFair6' : 'layoutFair5')}`}
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
              </>
            )}

            <div class="section-title with-aside">
              <span>{t('puzzles')}</span>
              <span class="medal-count" data-testid="medal-count">
                {t('medalCount', { n: medalCount, total: SCENARIOS.length })}
              </span>
            </div>
            <p class="lead" style={{ marginTop: -4 }}>
              {t('puzzlesDesc')}
            </p>
            <div class="puzzle-grid">
              {SCENARIOS.map((id) => {
                const m = SCENARIO_META[id];
                const on = id === scenario;
                const tier = medals[id]?.tier ?? null;
                return (
                  <button key={id} class={`puzzle-card ${on ? 'on' : ''}`} aria-pressed={on} data-scenario={id} onClick={() => pickScenario(id)}>
                    <ScenarioMap id={id} field={samples[id].field} maxHeight={84} />
                    <span class="medal-badge" data-medal={tier ?? 'none'} title={medalLabel(tier)}>
                      <Medal tier={tier} size={22} label={medalLabel(tier)} />
                    </span>
                    <span class="name">{t(`puzzle_${id}` as 'puzzle_siege')}</span>
                    <span class="meta">
                      <IconUsers width={12} height={12} />
                      {m.configurable ? `${m.configurable.seats[0]}–${m.configurable.seats[1]}` : m.players.length}
                      {m.darkness && <IconMoon width={12} height={12} aria-label={t('darkness')} />}
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        )}

        {step === 1 && (
          <>
            {meta && (
              <div class="locked-note">
                {conf ? (
                  <>
                    <IconUsers width={14} height={14} /> {t('scenarioSeatsFree', { min: conf.seats[0], max: conf.seats[1] })}
                  </>
                ) : (
                  <>
                    <IconLock width={14} height={14} /> {t('scenarioSeatsNote')}
                  </>
                )}
              </div>
            )}
            <div class="list">
              {players.map((type, slot) => (
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
                    {slot >= Math.max(2, minSeats) && slot === players.length - 1 && (
                      <button class="remove-btn" aria-label={t('removePlayer')} onClick={() => setSeats(players.slice(0, -1))}>
                        <IconX width={20} height={20} />
                      </button>
                    )}
                  </div>
                  {slot > 0 && (
                    <div class="type-pick" style={{ '--c': `var(--p${slot})` }}>
                      {TYPES.map((tp) => {
                        const rec = meta?.players[slot] === tp;
                        return (
                          <button
                            key={tp}
                            class={`${tp} ${type === tp ? 'on' : ''} ${rec ? 'rec' : ''}`}
                            title={rec ? t('scenarioRecommended') : undefined}
                            onClick={() => {
                              sfx.click();
                              setType(slot, tp);
                            }}
                          >
                            {tp === 'human' ? t('pick_human') : t(`player_${tp}` as 'player_human')}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
              {players.length < maxSeats && (
                <button
                  class="add-row"
                  onClick={() => {
                    sfx.click();
                    // a scenario's seat comes back as designed
                    setSeats([...players, meta?.players[players.length] ?? 'hunter']);
                  }}
                >
                  <IconPlus width={18} height={18} /> {t('addPlayer')}
                </button>
              )}
            </div>
            {(!meta || meta.configurable) && (
              <div class="list">
                <SettingRow title={t('shuffle')} desc={t('shuffleDesc')}>
                  <Toggle on={prefs.shuffle} onChange={(v) => update({ shuffle: v })} />
                </SettingRow>
              </div>
            )}
            {humans > 1 && <div class="muted" style={{ fontSize: 13, textAlign: 'center' }}>{t('hotseatNote')}</div>}
          </>
        )}

        {step === 2 &&
          (meta ? (
            <>
              <div class="locked-note">
                <IconLock width={14} height={14} />{' '}
                {t(conf ? 'scenarioModesFree' : 'scenarioModesNote', { name: t(`puzzle_${scenario}` as 'puzzle_siege') })}
              </div>
              <div class="list locked">
                <SettingRow title={t('darkness')} desc={t('darknessDesc')}>
                  {locked(!!meta.darkness)}
                </SettingRow>
                {meta.blind && (
                  <SettingRow title={t('scenarioUncharted')} desc={t('blindDesc')}>
                    {locked(true)}
                  </SettingRow>
                )}
                <SettingRow title={t('symmetry')} desc={t('symmetryDesc2')}>
                  {locked(false)}
                </SettingRow>
                <SettingRow title={t('crowded')} desc={t('crowdedDesc')}>
                  {locked(!!meta.crowded)}
                </SettingRow>
                {!conf?.modes.includes('unions') && (
                  <SettingRow title={t('unions')} desc={humans > 1 && meta.unions ? t('unionsNeedOneHuman') : t('unionsDesc')}>
                    {locked(!!meta.unions)}
                  </SettingRow>
                )}
              </div>
              {conf?.modes.includes('unions') && (
                <div class="list" data-testid="scenario-unions">
                  <SettingRow title={t('unions')} desc={humans > 1 ? t('unionsNeedOneHuman') : t('unionsDesc')}>
                    <Toggle on={!!opts?.unions} onChange={(v) => configure({ unions: v })} />
                  </SettingRow>
                </div>
              )}
            </>
          ) : (
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
          ))}

        <div class="footer-actions">
          {step < 2 ? (
            <>
              <button class="btn ghost" onClick={start}>
                {hasOnline ? t('battleCreate') : t('start')}
              </button>
              <button class="btn primary" onClick={() => setStep(step + 1)}>
                {t('next')}
              </button>
            </>
          ) : (
            <button class="btn primary" onClick={start}>
              {hasOnline ? t('battleCreate') : t('start')} · {playersLabel(players.length)}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
