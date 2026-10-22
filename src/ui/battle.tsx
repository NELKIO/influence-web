/**
 * Online battles in the UI: one active room at a time (host or guest), its binding to the game
 * controller, and resume after leaving to the menu or reloading the page.
 *
 * Host: the controller plays on host.state (same object). Every move it applies (its own and the
 * bots') is published to the guests; guests' moves are applied by BattleHost and only animated here.
 * Guest: nothing is applied locally — moves are requests, the board follows what the host sends.
 */
import { BattleGuest, BattleHost, inviteBattleUrl, type KVStorage, type RosterEntry } from '../net';
import { useBroadcastTransport } from '../net/broadcast';
import type { MatchSettings, MatchState } from '../core/types';
import type { GameController } from './game/controller';
import type { OnlineBinding } from './screens/GameScreen';
import { navigate } from './store';
import { setOnlineNames } from './names';
import { t } from '../i18n';
import { buzz, sfx } from '../audio/sfx';
import { playerColor } from './theme';

const BC = useBroadcastTransport();
/** with ?transport=bc several tabs of one browser play together: each tab keeps its own session */
export const battleStorage: KVStorage | undefined = BC ? sessionStorage : undefined;

let active: { host?: BattleHost; guest?: BattleGuest } = {};
let pendingHost: { settings: MatchSettings; seed: number } | null = null;

export function getBattle() {
  return active;
}

/** Remember the setup of a room to open on the lobby screen. */
export function prepareHost(settings: MatchSettings, seed: number) {
  pendingHost = { settings: { ...settings, kind: 'battleOnline' }, seed };
}

export function takePendingHost() {
  const p = pendingHost;
  pendingHost = null;
  return p;
}

export function startHost(settings: MatchSettings, seed: number): BattleHost {
  closeBattle();
  const host = BattleHost.create({ settings: { ...settings, kind: 'battleOnline' }, seed, storage: battleStorage });
  active = { host };
  return host;
}

export function startGuest(code: string): BattleGuest {
  if (active.guest && active.guest.code === code) return active.guest;
  closeBattle();
  const guest = BattleGuest.join(code, { storage: battleStorage });
  active = { guest };
  return guest;
}

/** A battle that can be continued (running in memory or saved before a reload). */
export function resumableBattle(): { role: 'host' | 'guest'; code: string } | null {
  if (active.host?.code && active.host.status !== 'ended' && active.host.status !== 'error') return { role: 'host', code: active.host.code };
  if (active.guest && active.guest.status !== 'ended' && active.guest.status !== 'error') return { role: 'guest', code: active.guest.code ?? '' };
  const h = BattleHost.saved(battleStorage ?? undefined);
  if (h && !h.ended) return { role: 'host', code: h.code };
  const g = BattleGuest.saved(battleStorage ?? undefined);
  if (g && !g.ended) return { role: 'guest', code: g.code };
  return null;
}

/** Bring back the battle from memory or storage. */
export function resumeBattle(): void {
  if (!active.host && !active.guest) {
    const host = BattleHost.resume(battleStorage ?? undefined);
    if (host) active = { host };
    else {
      const guest = BattleGuest.resume(battleStorage ?? undefined);
      if (guest) active = { guest };
    }
  }
  const s = active.host ?? active.guest;
  if (!s) return;
  if (s.state && s.status === 'playing') launchBattle();
  else navigate({ name: 'battleRoom', join: active.guest?.code ?? undefined });
}

export function closeBattle() {
  if (active.host) active.host.close();
  if (active.guest) active.guest.leave();
  active = {};
}

export function battleInvite(code: string) {
  return inviteBattleUrl(code);
}

function updateNames(roster: RosterEntry[]) {
  const names: (string | null)[] = [];
  for (const r of roster) names[r.seat] = r.name;
  setOnlineNames(names);
}

/** Open the game screen for the active battle. */
export function launchBattle() {
  const host = active.host;
  const guest = active.guest;
  if (host?.state) {
    updateNames(host.roster);
    navigate({ name: 'game', launch: { state: host.state, initial: host.state, online: hostBinding(host) } });
  } else if (guest?.state) {
    updateNames(guest.roster);
    navigate({ name: 'game', launch: { state: guest.state, initial: guest.state, online: guestBinding(guest) } });
  }
}

function hostBinding(host: BattleHost): OnlineBinding {
  return {
    onAction: (seat, a) => {
      host.publish({ seat, a });
    },
    driver: {
      concede: (slot) => {
        host.act(slot, { t: 'concede' });
      },
    },
    bind(ctrl: GameController) {
      const offs = [
        host.onApplied((a, fight) => {
          if (fight) ctrl.remoteFight(fight);
          else if (a.a.t === 'power') ctrl.remotePower(a.a.cell, a.a.amount, a.seat);
          else if (a.a.t === 'settings') ctrl.refreshBots();
        }),
        host.onState(() => {
          if (host.state) ctrl.replaceState(host.state);
        }),
        host.onRoster((r) => {
          updateNames(r);
          ctrl.replaceState(ctrl.state);
        }),
      ];
      return () => offs.forEach((f) => f());
    },
    Extra: ({ ctrl }) => <RoomHud roster={host.roster} ctrl={ctrl} />,
    exitTo: { name: 'menu' },
    onLeaveEnded: () => closeBattle(),
  };
}

function guestBinding(guest: BattleGuest): OnlineBinding {
  // once the last power point of our turn is placed, tell the host the turn is over
  let endSentFor = '';
  const maybeEndTurn = (st: MatchState) => {
    const key = `${st.turn}:${st.current}`;
    if (st.ended || st.current !== guest.seat || st.phase !== 'power' || st.powerLeft > 0 || endSentFor === key) return;
    endSentFor = key;
    void guest.request({ t: 'endTurn' });
  };
  return {
    remoteDriven: true,
    driver: {
      attack: (from, to) => {
        void guest.request({ t: 'attack', from, to });
        return 'pending';
      },
      endAttack: () => {
        void guest.request({ t: 'endAttack' });
        return null;
      },
      addPower: (cell, amount) => {
        void guest.request({ t: 'addPower', cell, amount });
        return 0;
      },
      autoPower: () => {
        void guest.request({ t: 'autoPower' });
        return new Map();
      },
      finishTurn: () => {
        if (guest.state?.phase === 'power') void guest.request({ t: 'endTurn' });
      },
      concede: () => {
        void guest.request({ t: 'concede' });
      },
      canAct: () => guest.canAct,
    },
    bind(ctrl: GameController) {
      let wasMine = guest.isMyTurn;
      const offs = [
        guest.onApplied((a, fight) => {
          if (fight) ctrl.remoteFight(fight);
          else if (a.a.t === 'power') ctrl.remotePower(a.a.cell, a.a.amount, a.seat);
        }),
        guest.onState((st) => {
          ctrl.replaceState(st);
          const mine = guest.isMyTurn;
          if (mine && !wasMine && !st.ended) {
            sfx.turn();
            buzz(20);
            ctrl.showHint(t('yourTurn'), playerColor(guest.seat), 1800);
          }
          wasMine = mine;
          maybeEndTurn(st);
        }),
        guest.onRoster((r) => {
          updateNames(r);
          ctrl.replaceState(ctrl.state);
        }),
        guest.on('connection', () => ctrl.replaceState(ctrl.state)),
      ];
      if (guest.state && guest.state !== ctrl.state) ctrl.replaceState(guest.state);
      return () => offs.forEach((f) => f());
    },
    Extra: ({ ctrl }) => <RoomHud roster={guest.roster} ctrl={ctrl} offline={!guest.connected} />,
    exitTo: { name: 'menu' },
    onLeaveEnded: () => closeBattle(),
  };
}

/** Connection notes in the game HUD: who is offline, our own link. */
function RoomHud({ roster, ctrl, offline }: { roster: RosterEntry[]; ctrl: GameController; offline?: boolean }) {
  if (ctrl.state.ended) return null;
  if (offline) return <div class="hint" style={{ color: 'var(--warn)' }}>{t('duelReconnecting')}</div>;
  const away = roster.filter((r) => r.taken && !r.connected && !r.you);
  // guest: its own link; host: 'relay' as soon as any guest is relayed
  const links = roster.map((r) => r.link).filter(Boolean);
  const linkKind = links.length ? (links.includes('relay') ? 'relay' : 'direct') : null;
  const link = linkKind ? (linkKind === 'relay' ? t('linkRelay') : t('linkDirect')) : null;
  return (
    <>
      {away.length > 0 && (
        <div class="hint" style={{ color: 'var(--warn)' }}>
          {t('battleAway', { names: away.map((r) => r.name || t('playerN', { n: r.seat + 1 })).join(', ') })}
        </div>
      )}
      {link && (
        <div class="muted" data-testid="link-kind" data-link={linkKind} style={{ fontSize: 11, textAlign: 'center', opacity: 0.7 }}>
          {link}
        </div>
      )}
    </>
  );
}
