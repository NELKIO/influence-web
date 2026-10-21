import { useState } from 'preact/hooks';
import { t } from '../../i18n';
import { loadSavedGame } from '../../storage';
import { Modal } from './controls';

/**
 * Starting a new local match overwrites the single saved game. `guard(fn, keep?)` runs `fn` right away
 * when there is nothing to lose (or `keep(saved)` says the saved match is the one being opened),
 * otherwise asks first. Render `modal` somewhere in the screen.
 */
export function useDiscardGuard() {
  const [pending, setPending] = useState<null | (() => void)>(null);
  const guard = (fn: () => void, keep?: (saved: NonNullable<ReturnType<typeof loadSavedGame>>) => boolean) => {
    const saved = loadSavedGame();
    if (!saved || keep?.(saved)) fn();
    else setPending(() => fn);
  };
  const modal = pending ? (
    <Modal onBackdrop={() => setPending(null)}>
      <h2>{t('unfinishedGame')}</h2>
      <p>{t('unfinishedLost')}</p>
      <div class="row">
        <button class="btn ghost" onClick={() => setPending(null)}>
          {t('cancel')}
        </button>
        <button
          class="btn red"
          onClick={() => {
            const fn = pending;
            setPending(null);
            fn();
          }}
        >
          {t('startNew')}
        </button>
      </div>
    </Modal>
  ) : null;
  return { guard, modal };
}
