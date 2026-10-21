import { useEffect, useState } from 'preact/hooks';
import { t } from '../../i18n';
import { Modal, Seg, SettingRow, Toggle, TopBar } from '../components/controls';
import type { DuelOptions } from './DuelsScreen';
import { inviteUrl, isValidCode, normalizeCode, type DuelSession } from '../../net';
import { errorText, launchOnline } from '../online';
import { canCreate, hostDuel, joinDuel, listSlots, MAX_DUELS, onDuelsChange, removeSlot, resumeAll, slotSession } from '../duels';
import { IconChevron, IconShare, IconX } from '../components/icons';
import { sfx, unlockAudio } from '../../audio/sfx';
import type { FieldSize } from '../../core/types';

const TURN_TIMES = [0, 60, 120, 300];

type View = { kind: 'lobby' } | { kind: 'room'; id: string };

/** Short status of a match for the list. */
function statusOf(s: DuelSession | null): { text: string; tone: 'go' | 'wait' | 'off' | 'win' | 'lose' } {
  if (!s) return { text: t('duelStOffline'), tone: 'off' };
  const st = s.state;
  if (st?.ended) return st.ended.winner === s.localSlot ? { text: t('duelStWon'), tone: 'win' } : { text: t('duelStLost'), tone: 'lose' };
  if (s.status === 'error') return { text: errorText(s.lastError), tone: 'off' };
  if (!st) return { text: s.role === 'host' ? t('duelWaiting') : t('duelConnecting'), tone: 'wait' };
  if (!s.connected) return { text: t('duelStNoLink'), tone: 'off' };
  return s.isMyTurn ? { text: t('yourTurn'), tone: 'go' } : { text: t('statusWaitRemote'), tone: 'wait' };
}

const TONE: Record<string, string> = {
  go: 'var(--good)',
  wait: 'var(--muted)',
  off: 'var(--dim)',
  win: 'var(--good)',
  lose: 'var(--bad)',
};

export function OnlinePanel({ opts: initial, join, onBack }: { opts: DuelOptions; join?: string; onBack: () => void }) {
  const [opts, setOpts] = useState<DuelOptions>(initial);
  const [view, setView] = useState<View>({ kind: 'lobby' });
  const [code, setCode] = useState(join ?? '');
  const [, setTick] = useState(0);
  const [err, setErr] = useState('');
  const [toast, setToast] = useState('');
  const [askRemove, setAskRemove] = useState<string | null>(null);

  useEffect(() => {
    resumeAll();
    const off = onDuelsChange(() => setTick((n) => n + 1));
    if (join && isValidCode(normalizeCode(join))) startJoin(join);
    return off;
  }, []);

  // open the board as soon as the match of the room we are looking at starts
  const room = view.kind === 'room' ? slotSession(view.id) : null;
  useEffect(() => {
    if (room?.state && !room.state.ended && room.status !== 'error') {
      sfx.versus();
      launchOnline(room);
    }
  });

  const host = () => {
    unlockAudio();
    sfx.click();
    setErr('');
    if (!canCreate()) {
      setErr(t('duelTooMany', { n: MAX_DUELS }));
      return;
    }
    const { id } = hostDuel({ size: opts.size, darkness: opts.darkness, turnTime: opts.turnTime });
    setView({ kind: 'room', id });
  };

  const startJoin = (raw: string) => {
    unlockAudio();
    const c = normalizeCode(raw);
    if (!isValidCode(c)) {
      setErr(t('duelBadCode'));
      return;
    }
    if (!canCreate() && !listSlots().some((x) => x.session?.code === c)) {
      setErr(t('duelTooMany', { n: MAX_DUELS }));
      return;
    }
    setErr('');
    const { id } = joinDuel(c);
    setView({ kind: 'room', id });
  };

  const open = (id: string) => {
    const s = slotSession(id);
    sfx.click();
    if (s?.state) launchOnline(s);
    else setView({ kind: 'room', id });
  };

  const remove = (id: string) => {
    const s = slotSession(id);
    if (s?.state && !s.state.ended) s.concede();
    removeSlot(id);
    setAskRemove(null);
    if (view.kind === 'room' && view.id === id) setView({ kind: 'lobby' });
  };

  const share = async (s: DuelSession) => {
    if (!s.code) return;
    const url = inviteUrl(s.code);
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Influence Web', text: t('duelInviteText', { code: s.code }), url });
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

  const slots = listSlots();
  const back = () => (view.kind === 'room' ? setView({ kind: 'lobby' }) : onBack());
  const askedSession = askRemove ? slotSession(askRemove) : null;

  return (
    <div class="screen">
      <div class="screen-inner">
        <TopBar title={t('duelOnline')} onBack={back} />

        {view.kind === 'lobby' && (
          <>
            {slots.length > 0 && (
              <>
                <div class="section-title">{t('duelMyMatches', { n: slots.length, max: MAX_DUELS })}</div>
                <div class="list">
                  {slots.map(({ id, session: s }) => {
                    const st = statusOf(s);
                    return (
                      <div key={id} class="list-item duel-row" onClick={() => open(id)} role="button" data-testid="duel-row">
                        <span class="duel-code">{s?.code ?? '····'}</span>
                        <div class="grow">
                          <div class="title" style={{ fontSize: 14 }}>
                            {s?.opponentName || (s?.state ? t('player_remote') : t('duelNoOpponent'))}
                          </div>
                          <div class="desc" style={{ color: TONE[st.tone], fontWeight: 700 }}>
                            {st.tone === 'go' && <span class="live-dot" />}
                            {st.text}
                          </div>
                        </div>
                        <button
                          class="remove-btn"
                          aria-label={t('duelRemove')}
                          onClick={(e) => {
                            e.stopPropagation();
                            setAskRemove(id);
                          }}
                        >
                          <IconX width={18} height={18} />
                        </button>
                        <IconChevron width={18} height={18} style={{ color: 'var(--dim)' }} />
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            <div class="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div class="title">{t('duelJoin')}</div>
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
              <button class="btn primary" disabled={code.length !== 4} onClick={() => startJoin(code)}>
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
            {err && <p style={{ color: 'var(--bad)', textAlign: 'center', margin: 0, fontWeight: 600 }}>{err}</p>}
            <p class="muted" style={{ fontSize: 12, textAlign: 'center', lineHeight: 1.5 }}>
              {t('duelP2PNote')}
            </p>
          </>
        )}

        {view.kind === 'room' && room && (
          <div class="card" style={{ display: 'flex', flexDirection: 'column', gap: 16, textAlign: 'center' }}>
            {room.status === 'error' ? (
              <>
                <div style={{ color: 'var(--bad)', fontWeight: 700, fontSize: 17 }}>{errorText(room.lastError)}</div>
                <button
                  class="btn"
                  onClick={() => {
                    removeSlot(view.id);
                    setView({ kind: 'lobby' });
                  }}
                >
                  {t('ok')}
                </button>
              </>
            ) : room.role === 'host' && room.code ? (
              <>
                <div class="muted">{t('duelCodeShare')}</div>
                <div class="room-code" data-testid="room-code">
                  {room.code}
                </div>
                <button class="btn primary" onClick={() => share(room)}>
                  <IconShare width={18} height={18} /> {t('duelShare')}
                </button>
                <div class="spinner" />
                <div class="muted">{t('duelWaiting')}</div>
                <div class="row">
                  <button class="btn ghost small" onClick={() => setView({ kind: 'lobby' })}>
                    {t('duelToList')}
                  </button>
                  <button
                    class="btn ghost small"
                    onClick={() => {
                      removeSlot(view.id);
                      setView({ kind: 'lobby' });
                    }}
                  >
                    {t('duelCancelRoom')}
                  </button>
                </div>
              </>
            ) : (
              <>
                {room.code && <div class="room-code">{room.code}</div>}
                <div class="spinner" />
                <div class="muted">{room.status === 'reconnecting' ? t('duelReconnecting') : t('duelConnecting')}</div>
                <button
                  class="btn ghost small"
                  onClick={() => {
                    removeSlot(view.id);
                    setView({ kind: 'lobby' });
                  }}
                >
                  {t('cancel')}
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {askRemove && (
        <Modal onBackdrop={() => setAskRemove(null)}>
          <h2>{t('duelRemove')}</h2>
          <p>{askedSession?.state && !askedSession.state.ended ? t('duelRemoveRunning') : t('duelRemoveText')}</p>
          <div class="row">
            <button class="btn ghost" onClick={() => setAskRemove(null)}>
              {t('cancel')}
            </button>
            <button class="btn red" onClick={() => remove(askRemove)}>
              {t('duelRemoveDo')}
            </button>
          </div>
        </Modal>
      )}
      {toast && <div class="toast">{toast}</div>}
    </div>
  );
}
