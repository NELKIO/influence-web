import { useState } from 'preact/hooks';
import { t } from '../../i18n';
import { navigate } from '../store';
import { TopBar } from '../components/controls';
import { normalizeCode } from '../../net';
import { sfx, unlockAudio } from '../../audio/sfx';

/**
 * One box for every kind of online game: 4-character codes are duels, 5-character codes are
 * battle rooms. Invite links (#/duel/CODE, #/join/CODE) skip this screen.
 */
export function JoinScreen({ code: initial }: { code?: string }) {
  const [code, setCode] = useState(initial ?? '');
  const [err, setErr] = useState('');

  const go = () => {
    unlockAudio();
    sfx.click();
    const c = normalizeCode(code);
    if (c.length === 4) navigate({ name: 'duels', join: c });
    else if (c.length === 5) navigate({ name: 'battleRoom', join: c });
    else setErr(t('joinBadLength'));
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
            maxLength={5}
            placeholder="ABCDE"
            autoCapitalize="characters"
            autoComplete="off"
            spellcheck={false}
            aria-label={t('duelCode')}
            autoFocus
            onInput={(e) => {
              setErr('');
              setCode(normalizeCode((e.target as HTMLInputElement).value).slice(0, 5));
            }}
            onKeyDown={(e) => e.key === 'Enter' && go()}
          />
          <button class="btn primary" disabled={code.length < 4} onClick={go}>
            {t('duelJoinBtn')}
          </button>
          {err && <p style={{ color: 'var(--bad)', textAlign: 'center', margin: 0, fontWeight: 600 }}>{err}</p>}
        </div>
      </div>
    </div>
  );
}
