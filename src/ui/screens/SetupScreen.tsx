import { Fragment } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { t } from '../../i18n';
import { navigate, useSettings } from '../store';
import { FRONTIER_DEFAULT_POINTS, loadMedals, loadSetup, saveGame, saveSetup, scenarioOptions, setupPlayers, setupToSettings, type SetupPrefs } from '../../storage';
import { seatsMedal, type MedalTier } from '../../medals';
import { hashString, randomSeed } from '../../core/rng';
import { buildScenario, SCENARIO_META, SCENARIOS, startMatch, type ScenarioConfig, type ScenarioId } from '../../core/scenarios';
import { objectiveHoldTurns, objectiveWinCount } from '../../core/objectives';
import { prepareHost } from '../battle';
import { previewBattleMatch } from '../../net/battleRules';
import { SIZE_ORDER, type Field, type MatchState, type PlayerType } from '../../core/types';
import { Seg, SettingRow, Toggle, TopBar } from '../components/controls';
import { IconLock, IconPlus, IconRestart, IconUsers, IconX, PlayerToken } from '../components/icons';
import { CardTags, cardRules, GoalLine, goalText, RuleChip, RulesList, ruleKeys, scenarioSizeName, TagLegend, type RuleKey } from '../components/ScenarioInfo';
import { SecretMap } from '../components/MiniMap';
import { DarknessRow, ExperimentalModes, FrontierRows, SignalFiresRow } from '../components/ExperimentalModes';
import { Medal } from '../components/Medal';
import { sfx } from '../../audio/sfx';
import { useDiscardGuard } from '../components/DiscardGuard';

const TYPES: PlayerType[] = ['dummy', 'hunter', 'master', 'god', 'human', 'online'];
const LEVEL: Partial<Record<PlayerType, number>> = { dummy: 1, hunter: 2, master: 3, god: 4 };

const playersLabel = (n: number) => t(n >= 5 ? 'playersCountMany' : 'playersCount', { n });

/** Picture of a scenario's map: in darkness without the starts, under exploration fog not even the shape. */
function ScenarioMap({ id, field, objectives, maxHeight }: { id: ScenarioId; field: Field; objectives?: number[]; maxHeight: number }) {
  const m = SCENARIO_META[id];
  return <SecretMap field={field} darkness={m.darkness} blind={m.blind} objectives={objectives} maxHeight={maxHeight} />;
}

/** Gallery sections: scenarios whose map changes from launch to launch come first. */
const flexible = (id: ScenarioId) => !!SCENARIO_META[id].varied;
const GALLERY = [
  { key: 'varied', title: 'galleryVaried', desc: 'galleryVariedDesc', ids: SCENARIOS.filter(flexible) },
  { key: 'fixed', title: 'galleryFixed', desc: 'galleryFixedDesc', ids: SCENARIOS.filter((id) => !flexible(id)) },
] as const;
/** the icons some gallery card shows, for the legend */
const LEGEND_KEYS = (['blind', 'darkness', 'objectives', 'crowded', 'unions'] as RuleKey[]).filter((k) =>
  SCENARIOS.some((id) => cardRules(SCENARIO_META[id]).includes(k)),
);

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
        {!have && (blocked ? stake : <div class="note">{t(free ? 'medalHintFree' : 'medalHint')}</div>)}
        {!have && !blocked && stake}
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
    () => {
      const settings = setupToSettings(prefs);
      return players.includes('online')
        ? previewBattleMatch({ ...settings, kind: 'battleOnline' }, mapSeed).state
        : startMatch(settings, mapSeed);
    },
    [mapSeed, scenario, prefs.size, prefs.symmetry, prefs.crowded, prefs.frontierMode, prefs.frontierPoints, prefs.frontierWin, prefs.frontierHold, prefs.shuffle, players.join(','), opts?.size, opts?.frontier?.pointCount, opts?.frontier?.winCount, opts?.frontier?.holdTurns],
  );

  const reroll = () => setMapSeed(old => {
    const seed = randomSeed();
    return seed === old ? (old + 1) >>> 0 : seed;
  });

  const update = (p: Partial<SetupPrefs>) => {
    const next = { ...prefs, ...p };
    // Do not start an exploration game on a map the player has already seen in the preview.
    if (!prefs.blind && next.blind && !next.scenario) reroll();
    setPrefs(next);
    saveSetup(next);
  };

  const humans = players.filter((p) => p === 'human').length;
  // unions need exactly one person (on this device or online): with more the toggle is off and locked
  const persons = players.filter((p) => p === 'human' || p === 'online').length;
  const hasOnline = players.includes('online');
  const { guard, modal } = useDiscardGuard();

  // the goal and the special rules of the chosen scenario (the preview is the match that will start)
  // (frontier victory chosen in a dark scenario counts like the scenario's own control points)
  const goal = goalText(meta?.objectives || opts?.frontier ? { k: objectiveWinCount(preview), n: preview.objectives?.length ?? 3, h: objectiveHoldTurns(preview) } : null);
  const flags = meta ? { varied: meta.varied, blind: meta.blind, darkness: meta.darkness, objectives: meta.objectives || !!opts?.frontier, crowded: meta.crowded } : {};
  // on the card: unions as they will be played (they need a single person)
  // (a changing map is said by the "another map" button, not by a chip)
  const pickRules = ruleKeys({ ...flags, unions: !!opts?.unions && persons < 2 }).filter((k) => k !== 'varied');
  // in the modes step: the fixed rules; unions a scenario lets you switch are a choice, not a rule
  const unionsChoice = !!conf?.modes.includes('unions');
  const frontierChoice = !!conf?.modes.includes('frontier');
  const firesChoice = !!conf?.modes.includes('signalFires');
  const stepRules = ruleKeys({ ...flags, objectives: !!meta?.objectives, unions: !unionsChoice && !!meta?.unions });
  const chosen = scenario ? prefs.scenarioConfig[scenario] : undefined;

  const start = () => {
    sfx.click();
    if (hasOnline) {
      // seats for people on other devices: open a room first (the local saved match stays)
      prepareHost(setupToSettings(prefs), mapSeed);
      navigate({ name: 'battleRoom' });
      return;
    }
    // a new local match replaces the saved one: ask first when there is one
    guard(() => {
      // same seed as the preview -> the same map and start cells, with the current modes
      const st = startMatch(setupToSettings(prefs), mapSeed);
      saveGame(null);
      navigate({ name: 'game', launch: { state: st, initial: structuredClone(st) } });
    });
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
                {/* keyed by the seed: a new map (even a hidden one) comes in visibly */}
                <div class="pick-map" key={mapSeed}>
                  <ScenarioMap id={scenario} field={preview.field} objectives={preview.objectives} maxHeight={220} />
                </div>
                <div class="scenario-head">
                  <div class="grow">
                    <div class="kicker">
                      {t('scenarioKicker')}
                    </div>
                    <div class="name">{t(`puzzle_${scenario}` as 'puzzle_siege')}</div>
                  </div>
                  <button class="scenario-clear" aria-label={t('scenarioClear')} onClick={clearScenario}>
                    <IconX width={18} height={18} />
                  </button>
                </div>
                <div class="desc">{t(`puzzleDesc_${scenario}` as 'puzzleDesc_siege')}</div>
                <GoalLine text={goal} />
                {/* one line: who plays and how big the map is (an uncharted one says so by its darkness chip), then the
                    rules; a changing map that you can see has "another map" at the right end of the same line */}
                <div class="pick-foot">
                  <div class="chips one-line">
                    <span class="chip">
                      <IconUsers width={14} height={14} /> {playersLabel(players.length)}
                      {!meta.blind && <> · {t('mapCells', { n: preview.field.cells.length })}</>}
                    </span>
                    {pickRules.map((k) => (
                      <RuleChip key={k} k={k} points={preview.objectives?.length} />
                    ))}
                  </div>
                  {meta.varied && !meta.blind && (
                    <button
                      class="btn small reroll-btn"
                      data-testid="scenario-reroll"
                      aria-label={t('reroll')}
                      title={t('reroll')}
                      onClick={() => {
                        sfx.click();
                        reroll();
                      }}
                    >
                      <IconRestart width={16} height={16} /> <span class="reroll-label">{t('reroll')}</span>
                    </button>
                  )}
                </div>
                {conf && opts && conf.sizes.length > 1 && (
                  <div class="scenario-size" data-testid="scenario-size">
                    <Seg
                      label={t('scenarioSize')}
                      value={opts.size}
                      options={conf.sizes.map((sz) => ({ value: sz, label: scenarioSizeName(scenario, sz) }))}
                      onChange={(size) => configure({ size })}
                    />
                  </div>
                )}
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
                  <SecretMap field={preview.field} darkness={prefs.darkness} blind={prefs.blind} objectives={preview.objectives} />
                  <div class="map-meta">
                    <div>
                      <div class="title" style={{ fontSize: 14 }}>
                        {prefs.blind
                          ? t('scenarioUncharted')
                          : preview.field.layout
                            ? t(`layout_${preview.field.layout}` as 'layout_ring')
                            : t(prefs.symmetry ? 'layout_mirror' : 'layout_random')}
                      </div>
                      {!prefs.blind && (
                        <div class="desc">
                          {t('mapCells', { n: preview.field.cells.length })}
                          {preview.field.layout &&
                            ` · ${t(players.length === 3 ? 'layoutFair3' : players.length === 6 ? 'layoutFair6' : 'layoutFair5')}`}
                        </div>
                      )}
                    </div>
                    {/* nothing to reroll on a map nobody can see: a new one is dealt every time anyway */}
                    {!prefs.blind && (
                      <button
                        class="btn small"
                        aria-label={t('reroll')}
                        onClick={() => {
                          sfx.click();
                          reroll();
                        }}
                      >
                        <IconRestart width={16} height={16} /> {t('reroll')}
                      </button>
                    )}
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
            <TagLegend keys={LEGEND_KEYS} />
            <div class="puzzle-grid">
              {GALLERY.filter((g) => g.ids.length > 0).map((g) => (
                <Fragment key={g.key}>
                  <div class="puzzle-section" data-section={g.key}>
                    <span class="t">{t(g.title)}</span>
                    <span class="d">{t(g.desc)}</span>
                  </div>
                  {g.ids.map((id) => {
                    const m = SCENARIO_META[id];
                    const on = id === scenario;
                    const tier = medals[id]?.tier ?? null;
                    return (
                      <button key={id} class={`puzzle-card ${on ? 'on' : ''}`} aria-pressed={on} data-scenario={id} data-section={g.key} onClick={() => pickScenario(id)}>
                        <ScenarioMap id={id} field={samples[id].field} objectives={samples[id].objectives} maxHeight={84} />
                        <span class="medal-badge" data-medal={tier ?? 'none'} title={medalLabel(tier)}>
                          <Medal tier={tier} size={22} label={medalLabel(tier)} />
                        </span>
                        <span class="name">{t(`puzzle_${id}` as 'puzzle_siege')}</span>
                        <CardTags meta={m} />
                      </button>
                    );
                  })}
                </Fragment>
              ))}
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
              <div class="section-title">{t('scenarioRules')}</div>
              <RulesList keys={stepRules} goal={goal} notes={persons > 1 ? { unions: t('unionsNeedOneHuman') } : {}} />
              {(unionsChoice || frontierChoice || firesChoice) && (
                <>
                  <div class="section-title">{t('scenarioYourChoice')}</div>
                  <div class="list" data-testid="scenario-choice">
                    {unionsChoice && (
                      <SettingRow title={t('unions')} desc={persons > 1 ? t('unionsNeedOneHuman') : t('unionsDesc')}>
                        <Toggle label={t('unions')} on={persons < 2 && !!opts?.unions} disabled={persons > 1} onChange={(v) => configure({ unions: v })} />
                      </SettingRow>
                    )}
                    {frontierChoice && (
                      <FrontierRows
                        options={{ frontierMode: !!opts?.frontier, frontierPoints: chosen?.frontierPoints ?? FRONTIER_DEFAULT_POINTS, frontierWin: chosen?.frontierWin ?? null, frontierHold: chosen?.frontierHold ?? 1 }}
                        update={configure}
                      />
                    )}
                    {firesChoice && <SignalFiresRow on={!!opts?.signalFires} onChange={(v) => configure({ signalFires: v })} />}
                  </div>
                </>
              )}
            </>
          ) : (
            <>
              <div class="list">
                <DarknessRow options={prefs} update={update} />
                <SettingRow title={t('symmetry')} desc={t('symmetryDesc2')}>
                  <Toggle on={prefs.symmetry} onChange={(v) => update({ symmetry: v })} />
                </SettingRow>
                <SettingRow title={t('crowded')} desc={t('crowdedDesc')}>
                  <Toggle on={prefs.crowded} onChange={(v) => update({ crowded: v })} />
                </SettingRow>
                <SettingRow title={t('unions')} desc={persons > 1 ? t('unionsNeedOneHuman') : t('unionsDesc')}>
                  <Toggle on={persons < 2 && prefs.unions} disabled={persons > 1} onChange={(v) => update({ unions: v })} />
                </SettingRow>
              </div>
              <ExperimentalModes options={prefs} update={update} />
            </>
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
      {modal}
    </div>
  );
}
