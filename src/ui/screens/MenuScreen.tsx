import { useState } from 'preact/hooks';
import { t } from '../../i18n';
import { navigate, useSettings } from '../store';
import { loadSavedGame, loadSetup, saveGame, setupToSettings } from '../../storage';
import { createMatch } from '../../core/engine';
import { IconBolt, IconBook, IconCalendar, IconChart, IconGear, IconPlay, IconSwords, LogoMark } from '../components/icons';
import { Modal } from '../components/controls';
import { sfx, unlockAudio } from '../../audio/sfx';

export function MenuScreen() {
  useSettings();
  const saved = loadSavedGame();
  const [confirmNew, setConfirmNew] = useState<null | (() => void)>(null);

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
    const st = createMatch(setupToSettings(loadSetup()));
    saveGame(null);
    navigate({ name: 'game', launch: { state: st, initial: structuredClone(st) } });
  };

  return (
    <div class="screen menu">
      <div class="screen-inner" style={{ justifyContent: 'center' }}>
        <div class="logo">
          <LogoMark />
          <div class="name">
            Influence<span> web</span>
          </div>
          <div class="tag">{t('tagline')}</div>
        </div>

        {saved && (
          <button class="btn green" onClick={() => go(() => navigate({ name: 'game', launch: { state: saved.state, initial: saved.initial } }))}>
            <IconPlay width={18} height={18} />
            <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
              {t('continue')}
              <span class="sub">{t('round', { n: saved.state.turn + 1 })}</span>
            </span>
          </button>
        )}
        <button class={`btn ${saved ? '' : 'green'}`} onClick={() => go(() => guardNew(() => navigate({ name: 'setup' })))}>
          {t('play')}
        </button>
        <div class="row">
          <button class="btn yellow" onClick={() => go(() => guardNew(quick))}>
            <IconBolt width={18} height={18} /> {t('quickStart')}
          </button>
          <button class="btn red" onClick={() => go(() => navigate({ name: 'duels' }))}>
            <IconSwords width={18} height={18} /> {t('duels')}
          </button>
        </div>

        <div class="menu-grid">
          <button class="tile" onClick={() => go(() => navigate({ name: 'daily' }))}>
            <IconCalendar style={{ color: 'var(--good)' }} />
            {t('daily')}
          </button>
          <button class="tile" onClick={() => go(() => navigate({ name: 'stats' }))}>
            <IconChart style={{ color: 'var(--warn)' }} />
            {t('stats')}
          </button>
          <button class="tile" onClick={() => go(() => navigate({ name: 'rules' }))}>
            <IconBook style={{ color: 'var(--p4)' }} />
            {t('rules')}
          </button>
          <button class="tile" onClick={() => go(() => navigate({ name: 'settings' }))}>
            <IconGear style={{ color: 'var(--accent)' }} />
            {t('settings')}
          </button>
        </div>

        <div class="fan-note">{t('fanNote')}</div>
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
