import { useEffect, useState } from 'preact/hooks';
import { DuelSession, type DuelError } from '../net';
import type { GameController, MatchDriver } from './game/controller';
import type { OnlineBinding } from './screens/GameScreen';
import { navigate } from './store';
import { t } from '../i18n';
import { playerColor } from './theme';
import { sfx, buzz } from '../audio/sfx';
import { setViewing, slotIdOf } from './duels';
import type { MatchState } from '../core/types';

export function errorText(e: DuelError | null): string {
  if (!e) return t('duelError');
  if (e.code === 'bad-code') return t('duelBadCode');
  if (e.code === 'room-full') return t('duelRoomFull');
  if (e.code === 'webrtc') return t('duelNoP2P');
  if (e.code === 'version') return t('duelVersion');
  return t('duelError');
}

/** Open the game screen for the session's current match. */
export function launchOnline(session: DuelSession) {
  const st = session.state!;
  navigate({ name: 'game', launch: { state: st, initial: st, online: makeBinding(session) } });
}

function makeBinding(session: DuelSession): OnlineBinding {
  const matchId = session.matchId;
  const driver: MatchDriver = {
    attack: (f, to) => session.attack(f, to),
    endAttack: () => {
      session.endAttack();
      return null;
    },
    addPower: (c, n) => session.addPower(c, n),
    autoPower: () => session.autoPower(),
    finishTurn: () => {
      session.endTurn();
    },
    concede: () => {
      session.concede();
    },
    canAct: () => session.canAct,
  };
  return {
    driver,
    bind(ctrl: GameController) {
      setViewing(slotIdOf(session));
      const offs = [
        session.onRemoteFight((ev) => ctrl.remoteFight(ev)),
        session.onRemotePower((ev) => ctrl.remotePower(ev.cell, ev.amount, ev.player)),
        session.onState((st: MatchState) => {
          if (session.matchId !== matchId) {
            // a rematch started: open a fresh game screen
            if (!st.ended) launchOnline(session);
            return;
          }
          ctrl.replaceState(st);
        }),
        session.onTurn((info) => {
          if (info.mine) {
            sfx.turn();
            buzz(20);
            ctrl.showHint(t('yourTurn'), playerColor(session.localSlot), 1800);
          }
        }),
        session.onStatus(() => ctrl.replaceState(session.state ?? ctrl.state)),
      ];
      if (session.state && session.state !== ctrl.state) ctrl.replaceState(session.state);
      return () => {
        setViewing(null);
        offs.forEach((f) => f());
      };
    },
    Extra: ({ ctrl }) => <OnlineHud session={session} ctrl={ctrl} />,
    ResultActions: () => <RematchBox session={session} />,
    // the match keeps running in the background; it stays listed in the duels lobby
    exitTo: { name: 'duels', online: true },
  };
}

function useTick(ms: number) {
  const [, set] = useState(0);
  useEffect(() => {
    const id = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

function fmt(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function OnlineHud({ session, ctrl }: { session: DuelSession; ctrl: GameController }) {
  useTick(500);
  const total = (session.config.turnTime || 0) * 1000;
  const left = session.timeLeftMs();
  const st = ctrl.state;
  return (
    <>
      {total > 0 && left !== null && !st.ended && (
        <div class="hud-row" style={{ gap: 8 }}>
          <div class="timer-bar" style={{ flex: 1 }}>
            <div
              style={{
                width: `${Math.max(0, Math.min(100, (left / total) * 100))}%`,
                background: left < 15000 ? 'var(--bad)' : playerColor(st.current),
              }}
            />
          </div>
          <span style={{ fontSize: 12, fontWeight: 700, color: left < 15000 ? 'var(--bad)' : 'var(--muted)', minWidth: 36 }}>
            {fmt(left)}
          </span>
        </div>
      )}
      {(session.status === 'reconnecting' || !session.connected) && !st.ended && (
        <div class="hint" style={{ color: 'var(--warn)' }}>
          {t('duelReconnecting')}
        </div>
      )}
      {session.canClaimTimeout && !st.ended && (
        <button class="btn small red" style={{ alignSelf: 'center' }} onClick={() => session.claimTimeout()}>
          {t('claimTimeout')}
        </button>
      )}
    </>
  );
}

function RematchBox({ session }: { session: DuelSession }) {
  const [r, setR] = useState({ ...session.rematch });
  useEffect(() => session.onRematch((x) => setR({ ...x })), [session]);
  if (!session.connected && !r.remote) return <p>{t('opponentLeft')}</p>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {r.remote && !r.local && <p style={{ color: 'var(--warn)' }}>{t('rematchOffered')}</p>}
      {r.local && !r.remote ? (
        <p>{t('rematchWaiting')}</p>
      ) : (
        <button class="btn yellow" onClick={() => session.requestRematch()}>
          {t('rematch')}
        </button>
      )}
    </div>
  );
}
