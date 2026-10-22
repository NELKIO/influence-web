import { useEffect, useState } from 'preact/hooks';
import { t } from '../../i18n';
import { navigate, useSettings } from '../store';
import { Modal, TopBar } from '../components/controls';
import { IconShare, PlayerToken } from '../components/icons';
import { sfx, unlockAudio } from '../../audio/sfx';
import type { BattleGuest, BattleHost, RosterEntry } from '../../net';
import { battleInvite, closeBattle, getBattle, launchBattle, startGuest, startHost, takePendingHost } from '../battle';
import { playerColor } from '../theme';

/**
 * Lobby of an online battle. Host: room code, invite link, seats filling up, start.
 * Guest (`join`): joins the room by code and waits for the host.
 */
export function BattleRoomScreen({ join }: { join?: string }) {
  const settings = useSettings();
  const [, setTick] = useState(0);
  const [toast, setToast] = useState('');
  const [askLeave, setAskLeave] = useState(false);
  const [room, setRoom] = useState<BattleHost | BattleGuest | null>(() => {
    const a = getBattle();
    if (join) return a.guest?.code === join ? a.guest : null;
    return a.host ?? null;
  });

  // open the room on first show
  useEffect(() => {
    if (room) return;
    if (join) setRoom(startGuest(join));
    else {
      const pending = takePendingHost();
      if (pending) setRoom(startHost(pending.settings, pending.seed));
      else navigate({ name: 'setup' });
    }
  }, []);

  useEffect(() => {
    if (!room) return;
    const tick = () => setTick((n) => n + 1);
    const offs = [room.onStatus(tick), room.onRoster(tick), room.onError(tick), room.onState(tick)];
    // events may have arrived before we subscribed; also refresh once a second while in the lobby
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => {
      clearInterval(timer);
      offs.forEach((f) => f());
    };
  }, [room]);

  // the match started: go to the board
  useEffect(() => {
    if (room?.status === 'playing' && room.state) {
      sfx.versus();
      launchBattle();
    }
  });

  if (!room) return null;
  const isHost = 'canStart' in room;
  const host = isHost ? (room as BattleHost) : null;
  const roster = room.roster;
  const code = room.code;
  const error = room.status === 'error';

  const share = async () => {
    if (!code) return;
    const url = battleInvite(code);
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Influence Web', text: t('duelInviteText', { code }), url });
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

  const leave = () => {
    closeBattle();
    navigate({ name: 'menu' });
  };

  const linkText = (r: RosterEntry) => (r.link ? ` · ${r.link === 'relay' ? 'relay' : 'P2P'}` : '');
  const seatStatus = (r: RosterEntry) => {
    if (r.you) return t('battleSeatYou') + linkText(r);
    if (r.onHost) return t('battleSeatHost');
    if (r.kind === 'online' || r.kind === 'remote') {
      if (!r.taken) return t('battleSeatWaiting');
      return (r.connected ? t('battleSeatOnline') : t('battleSeatOffline')) + linkText(r);
    }
    return '';
  };

  const seatName = (r: RosterEntry) => {
    if (r.name) return r.name;
    if (r.kind === 'online' || r.kind === 'remote' || r.kind === 'human') return t('playerN', { n: r.seat + 1 });
    return t(`player_${r.kind}` as 'player_human');
  };

  return (
    <div class="screen">
      <div class="screen-inner">
        <TopBar title={t('battleRoomTitle')} onBack={() => (room.status === 'lobby' ? setAskLeave(true) : navigate({ name: 'menu' }))} />

        {error ? (
          <div class="card" style={{ display: 'flex', flexDirection: 'column', gap: 14, textAlign: 'center' }}>
            <div style={{ color: 'var(--bad)', fontWeight: 700, fontSize: 17 }}>{battleErrorText(room)}</div>
            <button class="btn" onClick={leave}>
              {t('ok')}
            </button>
          </div>
        ) : (
          <>
            <div class="card" style={{ display: 'flex', flexDirection: 'column', gap: 14, textAlign: 'center' }}>
              {code ? (
                <>
                  <div class="muted" style={{ fontSize: 14 }}>
                    {isHost ? t('battleRoomHostHint') : t('battleRoomGuestHint')}
                  </div>
                  <div class="room-code" data-testid="room-code">
                    {code}
                  </div>
                  {isHost && (
                    <button class="btn primary" onClick={share}>
                      <IconShare width={18} height={18} /> {t('duelShare')}
                    </button>
                  )}
                </>
              ) : (
                <>
                  <div class="spinner" />
                  <div class="muted">{t('duelConnecting')}</div>
                </>
              )}
            </div>

            {roster.length > 0 && (
              <div class="list" data-testid="roster">
                {roster.map((r) => {
                  const waiting = (r.kind === 'online' || r.kind === 'remote') && !r.taken;
                  return (
                    <div key={r.seat} class="list-item" style={{ minHeight: 56, opacity: waiting ? 0.6 : 1 }}>
                      <PlayerToken slot={r.seat} size={26} shape={settings.colorblind} />
                      <div class="grow">
                        <div class="title" style={{ fontSize: 15, color: r.you ? playerColor(r.seat) : undefined }}>
                          {seatName(r)}
                        </div>
                        <div class="desc">{seatStatus(r)}</div>
                      </div>
                      {waiting && <div class="spinner" style={{ width: 18, height: 18, borderWidth: 2, margin: 0 }} />}
                    </div>
                  );
                })}
              </div>
            )}

            {host && (
              <>
                <button
                  class="btn green"
                  disabled={!host.canStart}
                  onClick={() => {
                    unlockAudio();
                    host.start();
                  }}
                >
                  {t('battleStart')}
                </button>
                {!host.canStart && host.status === 'lobby' && (
                  <button class="btn ghost small" onClick={() => host.fillWithBots('hunter')}>
                    {t('battleFillBots')}
                  </button>
                )}
              </>
            )}
            <button class="btn ghost small" onClick={() => setAskLeave(true)}>
              {isHost ? t('battleClose') : t('battleLeave')}
            </button>
          </>
        )}
      </div>

      {askLeave && (
        <Modal onBackdrop={() => setAskLeave(false)}>
          <h2>{isHost ? t('battleClose') : t('battleLeave')}?</h2>
          <div class="row">
            <button class="btn ghost" onClick={() => setAskLeave(false)}>
              {t('cancel')}
            </button>
            <button class="btn red" onClick={leave}>
              {isHost ? t('battleClose') : t('battleLeave')}
            </button>
          </div>
        </Modal>
      )}
      {toast && <div class="toast">{toast}</div>}
    </div>
  );
}

function battleErrorText(room: BattleHost | BattleGuest): string {
  const e = (room as { lastError?: { code?: string } }).lastError;
  const code = e?.code ?? '';
  if (code === 'bad-code') return t('duelBadCode');
  if (code === 'full' || code === 'room-full') return t('battleRoomFull');
  if (code === 'closed') return t('battleRoomClosed');
  if (code === 'webrtc') return t('duelNoP2P');
  if (code === 'version') return t('duelVersion');
  return t('duelError');
}
