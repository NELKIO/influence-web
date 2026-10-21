import { useState } from 'preact/hooks';
import { t } from '../../i18n';
import { navigate, useSettings } from '../store';
import { loadSavedGame, loadSetup, saveGame, setupToSettings } from '../../storage';
import { createMatch } from '../../core/engine';
import { IconArrow, IconChart, IconGear, IconPlay, LogoMark, ModeArt } from '../components/icons';
import { Modal } from '../components/controls';
import { AmbientBoard } from '../components/AmbientBoard';
import { sfx, unlockAudio } from '../../audio/sfx';
import { dayNumber, dayId } from '../../daily';
import { playerName } from '../names';
import { myTurnCount, onDuelsChange } from '../duels';
import { useEffect } from 'preact/hooks';

export function MenuScreen() {
  useSettings();
  const saved = loadSavedGame();
  const setup = loadSetup();
  const [confirmNew, setConfirmNew] = useState<null | (() => void)>(null);
  const [, setTick] = useState(0);
  useEffect(() => onDuelsChange(() => setTick((n) => n + 1)), []);
  const duelTurns = myTurnCount();

  const go = (fn: () => void) => {
    unlockAudio();
    sfx.click();
    fn();
  };

  const guardNew = (fn: () => void) => {
    if (saved) setConfirmNew(() => fn);
    else fn();
  };

  const quick = () => {
    const st = createMatch(setupToSettings(setup));
    saveGame(null);
    navigate({ name: 'game', launch: { state: st, initial: structuredClone(st) } });
  };

  const savedLabel = () => {
    if (!saved) return '';
    const s = saved.state.settings;
    const kind = s.kind === 'daily' ? t('daily') : s.kind.startsWith('duel') ? t('duels') : t(`size${s.size}` as 'sizeM');
    return `${kind} · ${t('round', { n: saved.state.turn + 1 })}`;
  };

  const opponents = setup.players.slice(1);
  const quickSub = `${t(`size${setup.size}` as 'sizeM')} · ${opponents.map((_, i) => playerName({ ...setupToSettings(setup) }, i + 1)).join(', ')}`;

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
          <button class="play-btn" onClick={() => go(() => guardNew(() => navigate({ name: 'setup' })))}>
            <div>
              <div class="big">{t('play')}</div>
              <div class="small">{t('playSub')}</div>
            </div>
            <div class="arrow">
              <IconArrow />
            </div>
          </button>

          <div class="mode-grid">
            <button class="mode-card" onClick={() => go(() => guardNew(quick))}>
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

      {confirmNew && (
        <Modal onBackdrop={() => setConfirmNew(null)}>
          <h2>{t('unfinishedGame')}</h2>
          <p>{t('unfinishedLost')}</p>
          <div class="row">
            <button class="btn ghost" onClick={() => setConfirmNew(null)}>
              {t('cancel')}
            </button>
            <button
              class="btn red"
              onClick={() => {
                const fn = confirmNew;
                setConfirmNew(null);
                fn();
              }}
            >
              {t('startNew')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
