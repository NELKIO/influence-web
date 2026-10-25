/**
 * Online battles in the UI: one active room at a time (host or guest), its binding to the game
 * controller, and resume after leaving to the menu or reloading the page.
 *
 * Leaving the board of a running match (menu, another game) never closes the room and never pulls the
 * person back: the menu offers "return to the online battle" while the room is alive. The room lives on
 * the host's page: while the host is elsewhere in the app a screenless controller keeps the bots moving
 * (a host who has not conceded is waited for on their own turn, like a guest who stepped away). The
 * room closes when the host opens another room, closes it from the lobby, leaves a finished match, or
 * closes the page. Someone whose seat is out (conceded / eliminated) is not offered a saved session
 * after a reload: they were only watching.
 *
 * Host: the controller plays on host.state (same object). Every move it applies (its own and the
 * bots') is published to the guests; guests' moves are applied by BattleHost and only animated here.
 * Guest: nothing is applied locally — moves are requests, the board follows what the host sends.
 */
import { useEffect, useState } from 'preact/hooks';
import { BattleGuest, BattleHost, inviteBattleUrl, type KVStorage, type RosterEntry } from '../net';
import { useBroadcastTransport } from '../net/broadcast';
import { isAlive } from '../core/engine';
import type { MatchSettings, MatchState } from '../core/types';
import { GameController } from './game/controller';
import type { OnlineBinding } from './screens/GameScreen';
import { getSettings, navigate } from './store';
import { playerName, setOnlineNames } from './names';
import { t } from '../i18n';
import { buzz, sfx } from '../audio/sfx';
import { playerColor } from './theme';
import { cleanPlayerName } from '../storage';
import { recordOnlineLoss } from './onlineRecord';
import { LinkBadge, useWelcomeBack } from './online';

const BC = useBroadcastTransport();
/** with ?transport=bc several tabs of one browser play together: each tab keeps its own session */
export const battleStorage: KVStorage | undefined = BC ? sessionStorage : undefined;

/**
 * the host sees the "no link" controls (give the seat to a bot / skip the turn) once a guest has been
 * offline this long; BattleHost skips such a guest's turn by itself after 90 s (`awaySkipMs`)
 */
export const AWAY_CONTROLS_MS = 15_000;
/** the stand-in for a guest who left: the Hunter, as in the lobby (cheap on the host's phone, a fair opponent) */
const STAND_IN = 'hunter' as const;

let active: { host?: BattleHost; guest?: BattleGuest } = {};
/** subscriptions of the active room that live as long as the room (results of the person's seat) */
let roomOffs: (() => void)[] = [];
let pendingHost: { settings: MatchSettings; seed: number } | null = null;
/** the host's room running without its board (see the module doc) */
let background: { host: BattleHost; ctrl: GameController; off: () => void } | null = null;
/** game screens currently bound to the host's room */
let hostScreens = 0;

export function getBattle() {
  return active;
}

/** Remember the setup of a room to open on the lobby screen. */
export function prepareHost(settings: MatchSettings, seed: number) {
  pendingHost = { settings: { ...settings, kind: 'battleOnline' }, seed };
}

/** A new room is about to be opened (the lobby must not show the room that is already running). */
export function hasPendingHost(): boolean {
  return !!pendingHost;
}

export function takePendingHost() {
  const p = pendingHost;
  pendingHost = null;
  return p;
}

/** the name this person shows in online rooms ('' = «Игрок N») */
function myName(): string {
  return cleanPlayerName(getSettings().playerName);
}

export function startHost(settings: MatchSettings, seed: number): BattleHost {
  closeBattle();
  const host = BattleHost.create({ settings: { ...settings, kind: 'battleOnline' }, seed, storage: battleStorage, name: myName() });
  setActive({ host });
  return host;
}

export function startGuest(code: string): BattleGuest {
  if (active.guest && active.guest.code === code) return active.guest;
  closeBattle();
  const guest = BattleGuest.join(code, { storage: battleStorage, name: myName() });
  setActive({ guest });
  return guest;
}

function setActive(a: { host?: BattleHost; guest?: BattleGuest }) {
  active = a;
  roomOffs.forEach((f) => f());
  roomOffs = [];
  const room = a.host ?? a.guest;
  if (!room) return;
  // the person's seat goes out (concede, knocked out): their loss is recorded now, wherever they are
  roomOffs.push(room.onState(() => seatOut(room)));
  seatOut(room);
}

/** the seats this device's person plays in `st` (host: its 'human' seats; guest: its own seat) */
function mySeats(room: BattleHost | BattleGuest, st: MatchState): number[] {
  if (room instanceof BattleGuest) return room.seat >= 0 ? [room.seat] : [];
  const seats: number[] = [];
  st.settings.players.forEach((p, i) => p === 'human' && seats.push(i));
  return seats;
}

/**
 * Every seat of this device's person is out of the match: record their loss (with the place they went
 * out on) once, and return true. The game screen then does not record the end of the match again.
 */
function seatOut(room: BattleHost | BattleGuest, st: MatchState | null = room.state): boolean {
  if (!st || !room.matchId) return false;
  const seats = mySeats(room, st);
  if (!seats.length || seats.some((s) => isAlive(st, s))) return false;
  recordOnlineLoss(`battle:${room.matchId}:${seats.join(',')}`, st, seats);
  return true;
}

/** the person still has a seat in the match (not conceded, not knocked out) */
function stillIn(room: BattleHost | BattleGuest, st: MatchState): boolean {
  return mySeats(room, st).some((s) => isAlive(st, s));
}

/**
 * A battle that can be continued: running on this page, or saved before a reload. A saved session
 * whose own seat is out (the person conceded or was knocked out) is dropped, not offered.
 */
export function resumableBattle(): { role: 'host' | 'guest'; code: string } | null {
  if (active.host?.code && active.host.status !== 'ended' && active.host.status !== 'error') return { role: 'host', code: active.host.code };
  if (active.guest && active.guest.status !== 'ended' && active.guest.status !== 'error') return { role: 'guest', code: active.guest.code ?? '' };
  if (active.host || active.guest) return null;
  const store = battleStorage ?? undefined;
  const h = BattleHost.saved(store);
  if (h?.out) BattleHost.clearSaved(store);
  else if (h && !h.ended) return { role: 'host', code: h.code };
  const g = BattleGuest.saved(store);
  if (g?.out) BattleGuest.clearSaved(store);
  else if (g && !g.ended) return { role: 'guest', code: g.code };
  return null;
}

/** Bring back the battle from memory or storage. */
export function resumeBattle(): void {
  if (!active.host && !active.guest) {
    const host = BattleHost.resume(battleStorage ?? undefined);
    if (host) setActive({ host });
    else {
      const guest = BattleGuest.resume(battleStorage ?? undefined, { name: myName() });
      if (guest) setActive({ guest });
    }
  }
  const s = active.host ?? active.guest;
  if (!s) return;
  if (s.state && (s.status === 'playing' || s.status === 'ended')) launchBattle();
  else navigate({ name: 'battleRoom', join: active.guest?.code ?? undefined });
}

export function closeBattle() {
  stopBackground();
  if (active.host) active.host.close();
  if (active.guest) active.guest.leave();
  setActive({});
}

export function battleInvite(code: string) {
  return inviteBattleUrl(code);
}

function updateNames(roster: RosterEntry[]) {
  const names: (string | null)[] = [];
  for (const r of roster) names[r.seat] = r.name;
  setOnlineNames(names);
}

/** matches whose "you are Player N" hint was shown */
const startHinted = new Set<string>();

/** Seats shuffled: tell the person which seat (number, colour) they got, once per match. */
function startHint(ctrl: GameController, matchId: string | null, seat: number) {
  const st = ctrl.state;
  if (!matchId || seat < 0 || !st.settings.shuffle || st.turn > 0 || st.ended || startHinted.has(matchId)) return;
  startHinted.add(matchId);
  const mine = st.current === seat;
  const text = t('battleYouAre', { n: seat + 1 }) + (mine ? ` · ${t('yourTurn')}` : '');
  ctrl.showHint(text, playerColor(seat), 3500);
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

function stopBackground() {
  if (!background) return;
  background.off();
  background.ctrl.dispose();
  background = null;
}

/** Keep the host's room going without its board: bots move, guests' moves are applied as usual. */
function startBackground(host: BattleHost) {
  if (background || hostScreens > 0 || active.host !== host || !host.state || host.status !== 'playing') return;
  const binding = hostBinding(host);
  const ctrl: GameController = new GameController({
    state: host.state,
    settings: getSettings(),
    nameOf: (slot) => playerName(ctrl.state.settings, slot),
    t: t as (k: string, p?: Record<string, string | number>) => string,
    driver: binding.driver,
    onAction: binding.onAction,
    background: true,
  });
  const offs = [
    host.onApplied((a) => {
      if (a.a.t === 'settings') ctrl.refreshBots();
    }),
    host.onState(() => {
      if (host.state) ctrl.replaceState(host.state);
    }),
    host.onStatus((st) => {
      if (st !== 'playing') stopBackground();
    }),
  ];
  background = { host, ctrl, off: () => offs.forEach((f) => f()) };
  ctrl.start();
}

function hostBinding(host: BattleHost): OnlineBinding {
  return {
    onAction: (seat, a) => {
      host.publish({ seat, a });
      // the host's own moves and the bots' are not 'state' events: a bot may just have knocked the host out
      seatOut(host);
    },
    driver: {
      concede: (slot) => {
        host.act(slot, { t: 'concede' });
      },
    },
    ownsResult: (s) => seatOut(host, s),
    bind(ctrl: GameController) {
      hostScreens++;
      stopBackground();
      startHint(ctrl, host.matchId, host.players.indexOf('human'));
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
      return () => {
        offs.forEach((f) => f());
        hostScreens--;
        // the board is gone (menu, another game): the room plays on without it. Deferred so that a
        // board replacing this one (back to the room) binds first.
        setTimeout(() => startBackground(host), 0);
      };
    },
    Extra: ({ ctrl }) => <HostHud host={host} ctrl={ctrl} />,
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
        // offline the concede waits for the link (RoomHud says so); it is never dropped
        void guest.request({ t: 'concede' });
      },
      canAct: () => guest.canAct,
    },
    ownsResult: (s) => seatOut(guest, s),
    bind(ctrl: GameController) {
      let wasMine = guest.isMyTurn;
      startHint(ctrl, guest.matchId, guest.seat);
      const offs = [
        guest.onApplied((a, fight) => {
          if (fight) ctrl.remoteFight(fight);
          else if (a.a.t === 'power') ctrl.remotePower(a.a.cell, a.a.amount, a.seat);
        }),
        guest.onState((st) => {
          const mine = guest.isMyTurn;
          // the turn passed: the "your turn" note goes with it
          if (!mine && ctrl.hint?.text === t('yourTurn')) ctrl.hint = null;
          ctrl.replaceState(st);
          startHint(ctrl, guest.matchId, guest.seat);
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
        guest.onStatus(() => ctrl.replaceState(ctrl.state)),
      ];
      if (guest.state && guest.state !== ctrl.state) ctrl.replaceState(guest.state);
      return () => offs.forEach((f) => f());
    },
    Extra: ({ ctrl }) => <GuestHud guest={guest} ctrl={ctrl} />,
    exitTo: { name: 'menu' },
    onLeaveEnded: () => closeBattle(),
  };
}

/** Text of a room error (lobby and game HUD). */
export function battleErrorText(e: { code?: string; message?: string } | null | undefined): string {
  switch (e?.code ?? '') {
    case 'bad-code':
      // a malformed code is caught before dialling; otherwise nobody hosts this code
      return /^invalid/i.test(e?.message ?? '') ? t('duelBadCode') : t('roomNotFound');
    case 'full':
    case 'room-full':
      return t('battleRoomFull');
    case 'started':
      return t('battleStarted');
    case 'replaced':
      return t('battleReplaced');
    case 'closed':
      return t('battleRoomClosed');
    case 'webrtc':
      return t('duelNoP2P');
    case 'version':
      return t('battleVersion');
    default:
      return t('duelError');
  }
}

function useTick(ms: number) {
  const [, set] = useState(0);
  useEffect(() => {
    const id = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

const seatLabel = (r: RosterEntry) => r.name || t('playerN', { n: r.seat + 1 });

/**
 * «Прямое соединение · 80 мс» / «Через ретранслятор · 250 мс» under the HUD: a guest's own link; for
 * the host 'relay' as soon as any guest is relayed, with the slowest round trip of that kind
 */
function LinkLine({ roster }: { roster: RosterEntry[] }) {
  const links = roster.filter((r) => r.link);
  if (!links.length) return null;
  const kind = links.some((r) => r.link === 'relay') ? 'relay' : 'direct';
  const rtts = links.filter((r) => r.link === kind && typeof r.rtt === 'number').map((r) => r.rtt as number);
  return <LinkBadge kind={kind} rtt={rtts.length ? Math.max(...rtts) : null} />;
}

/** «Игрок 2 свернул игру — ход продолжится, когда он вернётся» for the seat whose turn it is */
function TurnHidden({ roster, st }: { roster: RosterEntry[]; st: MatchState }) {
  const r = roster.find((x) => x.seat === st.current && x.hidden && !x.you);
  if (!r) return null;
  return (
    <div class="hint" data-testid="player-hidden" style={{ color: 'var(--warn)' }}>
      {t('playerHidden', { name: seatLabel(r) })}
    </div>
  );
}

const Watching = () => (
  <div class="muted" data-testid="watching" style={{ fontSize: 12, textAlign: 'center', fontWeight: 700 }}>
    {t('battleWatching')}
  </div>
);

/**
 * The host's HUD: who is offline; a guest offline for AWAY_CONTROLS_MS gets controls (the seat to a
 * bot, skip its turn) and, on its turn, the countdown of the automatic skip.
 */
function HostHud({ host, ctrl }: { host: BattleHost; ctrl: GameController }) {
  useTick(1000);
  useWelcomeBack(
    ctrl,
    () => !host.state?.ended && host.roster.some((r) => r.kind === 'online' && r.connected),
    t('welcomeBackHost'),
    playerColor(Math.max(0, host.players.indexOf('human'))),
  );
  const st = ctrl.state;
  if (st.ended) return null;
  const now = Date.now();
  const roster = host.roster;
  const away = roster.filter((r) => r.kind === 'online' && r.taken && !r.connected);
  const long = away.filter((r) => now - (host.awaySince(r.seat) ?? now) >= AWAY_CONTROLS_MS);
  const short = away.filter((r) => !long.includes(r));
  const skipAt = host.awaySkipAt;
  return (
    <>
      {short.length > 0 && (
        <div class="hint" style={{ color: 'var(--warn)' }}>
          {t('battleAway', { names: short.map(seatLabel).join(', ') })}
        </div>
      )}
      {long.map((r) => {
        const theirTurn = st.current === r.seat;
        return (
          <div key={r.seat} class="away-card" data-testid="away-controls" data-seat={r.seat}>
            <div class="away-title" style={{ color: playerColor(r.seat) }}>
              {t('battleNoLink', { name: seatLabel(r) })}
            </div>
            {theirTurn && skipAt !== null && (
              <div class="muted" style={{ fontSize: 11 }}>
                {t('battleAutoSkip', { s: Math.max(0, Math.ceil((skipAt - now) / 1000)) })}
              </div>
            )}
            <div class="away-actions">
              <button class="btn small" data-testid="away-bot" onClick={() => host.fillWithBots(STAND_IN, [r.seat])}>
                {t('battleGiveToBot')}
              </button>
              {theirTurn && (
                <button class="btn small ghost" data-testid="away-skip" onClick={() => host.act(r.seat, { t: 'endTurn' })}>
                  {t('battleSkipTurn')}
                </button>
              )}
            </div>
          </div>
        );
      })}
      <TurnHidden roster={roster} st={st} />
      {!stillIn(host, st) && <Watching />}
      <LinkLine roster={roster} />
    </>
  );
}

/** A guest's HUD: our link, a concede waiting for it, the room gone, who else is offline, watching. */
function GuestHud({ guest, ctrl }: { guest: BattleGuest; ctrl: GameController }) {
  useTick(1000);
  const st = ctrl.state;
  if (st.ended) return null;
  // the room is gone for good (the host closed it, our seat was given away...)
  if (guest.status === 'error') {
    return (
      <div class="hint" data-testid="room-gone" style={{ color: 'var(--bad)' }}>
        {battleErrorText(guest.lastError)}
      </div>
    );
  }
  if (guest.hostHidden) {
    return (
      <div class="hint" data-testid="host-hidden" style={{ color: 'var(--warn)' }}>
        {t('hostHidden')}
      </div>
    );
  }
  if (!guest.online) {
    return (
      <div class="hint" data-testid="guest-offline" style={{ color: 'var(--warn)' }}>
        {guest.concedePending ? t('battleConcedeQueued') : t('duelReconnecting')}
      </div>
    );
  }
  const roster = guest.roster;
  const away = roster.filter((r) => r.taken && !r.connected && !r.you);
  return (
    <>
      {away.length > 0 && (
        <div class="hint" style={{ color: 'var(--warn)' }}>
          {t('battleAway', { names: away.map(seatLabel).join(', ') })}
        </div>
      )}
      <TurnHidden roster={roster} st={st} />
      {guest.seat >= 0 && !isAlive(st, guest.seat) && <Watching />}
      <LinkLine roster={roster} />
    </>
  );
}
