import { useEffect, useState } from 'preact/hooks';
import { t } from '../../i18n';
import { Seg, SettingRow, Toggle, TopBar } from '../components/controls';
import type { DuelOptions } from './DuelsScreen';
import { DuelSession, getClientId, inviteUrl, isValidCode, normalizeCode, type KVStorage } from '../../net';
import { BroadcastTransport, useBroadcastTransport } from '../../net/broadcast';
import { errorText, getActiveSession, launchOnline, setActiveSession } from '../online';
import { IconShare } from '../components/icons';
import { sfx, unlockAudio } from '../../audio/sfx';
import type { FieldSize } from '../../core/types';

const TURN_TIMES = [0, 60, 120, 300];

/** Test/debug mode: two tabs of one browser talk over BroadcastChannel, each tab keeps its own session. */
const BC = useBroadcastTransport();
const bcStorage: KVStorage | undefined = BC ? sessionStorage : undefined;

type Phase = 'menu' | 'hosting' | 'joining' | 'error';

export function OnlinePanel({ opts: initial, join, onBack }: { opts: DuelOptions; join?: string; onBack: () => void }) {
  const [opts, setOpts] = useState<DuelOptions>(initial);
  const [phase, setPhase] = useState<Phase>('menu');
  const [code, setCode] = useState(join ?? '');
  const [session, setSession] = useState<DuelSession | null>(getActiveSession());
  const [, setTick] = useState(0);
  const [err, setErr] = useState('');
  const [toast, setToast] = useState('');
  const saved = DuelSession.saved(bcStorage);

  const watch = (s: DuelSession) => {
    setActiveSession(s);
    setSession(s);
    const offs = [
      s.onStatus((st) => {
        setTick((n) => n + 1);
        if (st === 'error') {
          setErr(errorText(s.lastError));
          setPhase('error');
        } else if (st === 'playing' && s.state && !s.state.ended) {
          offs.forEach((f) => f());
          launchOnline(s);
        }
      }),
      s.onState(() => {
        if (s.state && !s.state.ended && s.status !== 'error') {
          offs.forEach((f) => f());
          sfx.versus();
          launchOnline(s);
        }
      }),
      s.onError((e) => {
        if (e.fatal) {
          setErr(errorText(e));
          setPhase('error');
        }
      }),
    ];
    // already in a match (resume): open the board right away, the HUD shows the reconnect status
    if (s.state && !s.state.ended) {
      offs.forEach((f) => f());
      launchOnline(s);
    }
    return offs;
  };

  useEffect(() => {
    if (join && isValidCode(normalizeCode(join))) startJoin(join);
  }, []);

  const host = () => {
    unlockAudio();
    sfx.click();
    setErr('');
    const s = DuelSession.host({
      size: opts.size,
      darkness: opts.darkness,
      turnTime: opts.turnTime,
      symmetry: true,
      storage: bcStorage,
      transport: BC ? BroadcastTransport.host(getClientId(bcStorage)) : undefined,
    });
    watch(s);
    setPhase('hosting');
  };

  const startJoin = (raw: string) => {
    unlockAudio();
    const c = normalizeCode(raw);
    if (!isValidCode(c)) {
      setErr(t('duelBadCode'));
      return;
    }
    setErr('');
    const s = DuelSession.join(c, { storage: bcStorage, transport: BC ? BroadcastTransport.join(c, getClientId(bcStorage)) : undefined });
    watch(s);
    setPhase('joining');
  };

  const resume = () => {
    unlockAudio();
    const info = DuelSession.saved(bcStorage);
    const s = DuelSession.resume({
      storage: bcStorage,
      transport: BC && info ? (info.role === 'host' ? BroadcastTransport.host(getClientId(bcStorage), info.code) : BroadcastTransport.join(info.code, getClientId(bcStorage))) : undefined,
    });
    if (!s) return;
    watch(s);
    setPhase(s.role === 'host' ? 'hosting' : 'joining');
  };

  const cancel = () => {
    session?.leave();
    setActiveSession(null);
    setSession(null);
    setPhase('menu');
  };

  const share = async () => {
    if (!session?.code) return;
    const url = inviteUrl(session.code);
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Influence Web', text: t('duelInviteText', { code: session.code }), url });
        return;
      }
    } catch {
      /* fall back to clipboard */
    }
    try {
      await navigator.clipboard.writeText(url);
      setToast(t('duelCopied'));
      setTimeout(() => setToast(''), 1800);
    } catch {
      setToast(url);
    }
  };

  const back = () => {
    if (phase !== 'menu') cancel();
    else onBack();
  };

  return (
    <div class="screen">
      <div class="screen-inner">
        <TopBar title={t('duelOnline')} onBack={back} />

        {phase === 'menu' && (
          <>
            {saved && saved.inMatch && !saved.ended && (
              <button class="choice green" onClick={resume}>
                <div>
                  <div class="t">{t('duelResume')}</div>
                  <div class="d">
                    {t('duelCode')}: {saved.code}
                  </div>
                </div>
              </button>
            )}
            <div class="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div class="title" style={{ fontWeight: 700 }}>
                {t('duelJoin')}
              </div>
              <input
                class="code-input"
                value={code}
                maxLength={4}
                placeholder="ABCD"
                autoCapitalize="characters"
                autoComplete="off"
                spellcheck={false}
                aria-label={t('duelCode')}
                onInput={(e) => setCode(normalizeCode((e.target as HTMLInputElement).value).slice(0, 4))}
                onKeyDown={(e) => e.key === 'Enter' && startJoin(code)}
              />
              <button class="btn" disabled={code.length !== 4} onClick={() => startJoin(code)}>
                {t('duelJoinBtn')}
              </button>
            </div>

            <div class="section-title">{t('duelCreate')}</div>
            <div class="list">
              <div class="list-item" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                <div class="title">{t('mapSize')}</div>
                <Seg<FieldSize>
                  value={opts.size}
                  options={(['M', 'L', 'XL'] as FieldSize[]).map((v) => ({ value: v, label: t(`size${v}` as 'sizeM') }))}
                  onChange={(v) => setOpts({ ...opts, size: v })}
                />
              </div>
              <div class="list-item" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                <div class="title">{t('turnTime')}</div>
                <Seg<number>
                  value={opts.turnTime}
                  options={TURN_TIMES.map((v) => ({ value: v, label: v ? t('minutes', { n: v / 60 }) : '∞' }))}
                  onChange={(v) => setOpts({ ...opts, turnTime: v })}
                />
              </div>
              <SettingRow title={t('darkness')} desc={t('darknessDesc')}>
                <Toggle on={opts.darkness} onChange={(v) => setOpts({ ...opts, darkness: v })} />
              </SettingRow>
            </div>
            <button class="btn red" onClick={host}>
              {t('duelCreate')}
            </button>
            {err && <p style={{ color: 'var(--bad)', textAlign: 'center', margin: 0 }}>{err}</p>}
            <p class="muted" style={{ fontSize: 12, textAlign: 'center', lineHeight: 1.45 }}>
              {t('duelP2PNote')}
            </p>
          </>
        )}

        {phase === 'hosting' && session && (
          <div class="card" style={{ display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'stretch', textAlign: 'center' }}>
            {session.code ? (
              <>
                <div class="muted">{t('duelCodeShare')}</div>
                <div class="room-code" data-testid="room-code">
                  {session.code}
                </div>
                <button class="btn" onClick={share}>
                  <IconShare width={18} height={18} /> {t('duelShare')}
                </button>
                <div class="spinner" />
                <div class="muted">{t('duelWaiting')}</div>
              </>
            ) : (
              <>
                <div class="spinner" />
                <div class="muted">{t('duelConnecting')}</div>
              </>
            )}
            <button class="btn ghost small" onClick={cancel}>
              {t('cancel')}
            </button>
          </div>
        )}

        {phase === 'joining' && session && (
          <div class="card" style={{ display: 'flex', flexDirection: 'column', gap: 16, textAlign: 'center' }}>
            <div class="room-code">{session.code}</div>
            <div class="spinner" />
            <div class="muted">{session.status === 'reconnecting' ? t('duelReconnecting') : t('duelConnecting')}</div>
            <button class="btn ghost small" onClick={cancel}>
              {t('cancel')}
            </button>
          </div>
        )}

        {phase === 'error' && (
          <div class="card" style={{ display: 'flex', flexDirection: 'column', gap: 14, textAlign: 'center' }}>
            <div style={{ color: 'var(--bad)', fontWeight: 700, fontSize: 18 }}>{err || t('duelError')}</div>
            <button class="btn" onClick={cancel}>
              {t('ok')}
            </button>
          </div>
        )}
      </div>
      {toast && <div class="toast">{toast}</div>}
    </div>
  );
}
