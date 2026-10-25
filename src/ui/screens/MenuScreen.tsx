import { useState } from 'preact/hooks';
import { t } from '../../i18n';
import { navigate, useSettings } from '../store';
import { loadSavedGame, loadSetup, saveGame, setupPlayers, setupToSettings } from '../../storage';
import { isScenarioId, startMatch } from '../../core/scenarios';
import { IconArrow, IconChart, IconGear, IconPlay, IconWifi, LogoMark, ModeArt } from '../components/icons';
import { useDiscardGuard } from '../components/DiscardGuard';
import { AmbientBoard } from '../components/AmbientBoard';
import { sfx, unlockAudio } from '../../audio/sfx';
import { dayNumber, dayId } from '../../daily';
import { myTurnCount, onDuelsChange } from '../duels';
import { prepareHost, resumableBattle, resumeBattle } from '../battle';
import { randomSeed } from '../../core/rng';
import { useEffect } from 'preact/hooks';

export function MenuScreen() {
  useSettings();
  const saved = loadSavedGame();
  const setup = loadSetup();
  const { guard, modal } = useDiscardGuard();
  const [, setTick] = useState(0);
  useEffect(() => onDuelsChange(() => setTick((n) => n + 1)), []);
  const duelTurns = myTurnCount();
  const battle = resumableBattle();

  const go = (fn: () => void) => {
    unlockAudio();
    sfx.click();
    fn();
  };

  const quick = () => {
    if (setupPlayers(setup).includes('online')) {
      // an online room leaves the local saved match alone
      prepareHost(setupToSettings(setup), randomSeed());
      navigate({ name: 'battleRoom' });
      return;
    }
    // a new local match replaces the saved one: ask first when there is one
    guard(() => {
      const st = startMatch(setupToSettings(setup));
      saveGame(null);
      navigate({ name: 'game', launch: { state: st, initial: structuredClone(st) } });
    });
  };

  /** What the saved match is: the map of the day, a duel, a scenario by name, or a battle by map size; and its round. */
  const savedLabel = () => {
    if (!saved) return '';
    const s = saved.state.settings;
    const kind =
      s.kind === 'daily'
        ? t('daily')
        : s.kind.startsWith('duel')
          ? t('duels')
          : isScenarioId(s.puzzle)
            ? t(`puzzle_${s.puzzle}` as 'puzzle_siege')
            : t(`size${s.size}` as 'sizeM');
    return `${kind} · ${t('round', { n: saved.state.turn + 1 })}`;
  };

  const opponents = setupPlayers(setup).slice(1);
  const quickSub = `${setup.scenario ? t(`puzzle_${setup.scenario}` as 'puzzle_siege') : t(`size${setup.size}` as 'sizeM')} · ${t('opponentsN', { n: opponents.length })}`;

  return (
    <div class="menu-screen">
      <AmbientBoard />
      <div class="menu-shade" />
      <div class="menu-content">
        <div class="menu-head">
          <div class="wordmark">
            <LogoMark />
            <div class="name">
              Influence
              <small>web edition</small>
            </div>
          </div>
          <div class="menu-tagline">{t('tagline')}</div>
        </div>

        <div class="menu-actions">
          {battle && (
            <button class="play-btn cont" onClick={() => go(resumeBattle)}>
              <div>
                <div class="big" style={{ fontSize: 17 }}>
                  {t('battleResume')}
                </div>
                <div class="small">{battle.code}</div>
              </div>
              <div class="arrow">
                <IconPlay />
              </div>
            </button>
          )}
          {saved && (
            <button class="play-btn cont" onClick={() => go(() => navigate({ name: 'game', launch: { state: saved.state, initial: saved.initial } }))}>
              <div>
                <div class="big" style={{ fontSize: 17 }}>
                  {t('continue')}
                </div>
                <div class="small">{savedLabel()}</div>
              </div>
              <div class="arrow">
                <IconPlay />
              </div>
            </button>
          )}
          <button class="play-btn" onClick={() => go(() => navigate({ name: 'setup' }))}>
            <div>
              <div class="big">{t('play')}</div>
              <div class="small">{t('playSub')}</div>
            </div>
            <div class="arrow">
              <IconArrow />
            </div>
          </button>

          <div class="mode-grid">
            <button class="mode-card" onClick={() => go(quick)}>
              <ModeArt kind="quick" />
              <div class="t">{t('quickStart')}</div>
              <div class="d">{quickSub}</div>
            </button>
            <button class="mode-card" onClick={() => go(() => navigate({ name: 'duels', online: duelTurns > 0 }))}>
              <ModeArt kind="duel" />
              {duelTurns > 0 && <span class="badge">{t('duelsYourTurn', { n: duelTurns })}</span>}
              <div class="t">{t('duels')}</div>
              <div class="d">{t('duelsCardSub')}</div>
            </button>
            <button class="mode-card" onClick={() => go(() => navigate({ name: 'daily' }))}>
              <ModeArt kind="daily" />
              <div class="t">{t('daily')}</div>
              <div class="d">#{dayNumber(dayId())}</div>
            </button>
            <button class="mode-card" onClick={() => go(() => navigate({ name: 'rules' }))}>
              <ModeArt kind="rules" />
              <div class="t">{t('rules')}</div>
              <div class="d">{t('rulesCardSub')}</div>
            </button>
            <button class="join-btn" onClick={() => go(() => navigate({ name: 'join' }))}>
              <IconWifi />
              <div>
                <div class="t">{t('joinGame')}</div>
                <div class="d">{t('joinGameSub')}</div>
              </div>
              <span class="arrow">
                <IconArrow />
              </span>
            </button>
          </div>

          <div class="menu-links">
            <button onClick={() => go(() => navigate({ name: 'stats' }))}>
              <IconChart /> {t('stats')}
            </button>
            <button onClick={() => go(() => navigate({ name: 'settings' }))}>
              <IconGear /> {t('settings')}
            </button>
          </div>
          <div class="fan-note">{t('fanNote')}</div>
        </div>
      </div>

      {modal}
    </div>
  );
}
