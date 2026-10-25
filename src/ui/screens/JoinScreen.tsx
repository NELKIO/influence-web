import { useState } from 'preact/hooks';
import { t } from '../../i18n';
import { navigate } from '../store';
import { TopBar } from '../components/controls';
import { checkJoinCode, cleanJoinInput } from '../joinCode';
import { sfx, unlockAudio } from '../../audio/sfx';

/**
 * One box for every kind of online game: 4-character codes are duels, 5-character codes are
 * battle rooms. A pasted invite link works too (invite links opened directly skip this screen).
 */
export function JoinScreen({ code: initial }: { code?: string }) {
  const [code, setCode] = useState(cleanJoinInput(initial ?? ''));
  const [err, setErr] = useState('');

  const go = () => {
    unlockAudio();
    sfx.click();
    const c = checkJoinCode(code);
    if (!c.ok) setErr(t(c.error === 'length' ? 'joinBadLength' : 'joinBadAlphabet'));
    else if (c.kind === 'duel') navigate({ name: 'duels', join: c.code });
    else navigate({ name: 'battleRoom', join: c.code });
  };

  return (
    <div class="screen">
      <div class="screen-inner">
        <TopBar title={t('joinTitle')} onBack={() => navigate({ name: 'menu' })} />
        <p class="lead">{t('joinDesc')}</p>
        <div class="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input
            class="code-input"
            value={code}
            placeholder="ABCDE"
            autoCapitalize="characters"
            autoComplete="off"
            spellcheck={false}
            aria-label={t('duelCode')}
            aria-describedby="join-hint"
            autoFocus
            onInput={(e) => {
              const el = e.currentTarget as HTMLInputElement;
              const next = cleanJoinInput(el.value);
              // the box shows exactly what will be used, even when the state does not change
              if (el.value !== next) el.value = next;
              setErr('');
              setCode(next);
            }}
            onKeyDown={(e) => e.key === 'Enter' && go()}
          />
          <p id="join-hint" class="muted join-hint">
            {t('joinHint')}
          </p>
          <button class="btn primary" disabled={!code} onClick={go}>
            {t('duelJoinBtn')}
          </button>
          {err && (
            <p role="alert" style={{ color: 'var(--bad)', textAlign: 'center', margin: 0, fontWeight: 600 }}>
              {err}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
