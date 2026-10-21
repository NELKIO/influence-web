import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { BoardRenderer } from '../board/renderer';
import { attachBoardInput } from '../board/input';
import { GameController, type MatchDriver } from '../game/controller';
import { t } from '../../i18n';
import { getSettings, navigate, updateSettings, useSettings, type Launch, type Route } from '../store';
import { playerName } from '../names';
import { playerColor } from '../theme';
import { alivePlayers, anyAttackLeft, cellCount, scoreOf } from '../../core/engine';
import type { MatchState } from '../../core/types';
import { addRecord, saveGame, updateDaily, setupToSettings, loadSetup } from '../../storage';
import { createMatch } from '../../core/engine';
import { createDailyMatch } from '../../daily';
import { Modal } from '../components/controls';
import {
  IconSkip,
  IconFlag,
  IconHome,
  IconPause,
  IconPlay,
  IconRestart,
  IconZoomIn,
  IconZoomOut,
  PlayerToken,
} from '../components/icons';
import { sfx, unlockAudio } from '../../audio/sfx';

export interface OnlineBinding {
  driver: MatchDriver;
  /** called once the controller exists so the session can push remote events */
  bind(ctrl: GameController): () => void;
  /** extra HUD (timer, connection status) */
  Extra?: (p: { ctrl: GameController }) => preact.JSX.Element | null;
  /** result-screen actions instead of restart/new */
  ResultActions?: (p: { ctrl: GameController }) => preact.JSX.Element | null;
  /** where "menu" leads from this match */
  exitTo?: Route;
}

function isSaveable(state: MatchState) {
  return state.settings.kind !== 'duelOnline';
}

function formatDuration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function GameScreen({ launch }: { launch: Launch }) {
  const settings = useSettings();
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [, setTick] = useState(0);
  const [zoomed, setZoomed] = useState(false);
  const [canZoom, setCanZoom] = useState(false);
  const [dontAsk, setDontAsk] = useState(false);
  const [askConcede, setAskConcede] = useState(false);
  const online = launch.online as OnlineBinding | undefined;

  const ctrl = useMemo(() => {
    const st = launch.state;
    return new GameController({
      state: st,
      settings: getSettings(),
      nameOf: (slot) => playerName(st.settings, slot),
      t: t as (k: string, p?: Record<string, string | number>) => string,
      driver: online?.driver,
      onSave: (s) => {
        if (isSaveable(s) && !s.ended) saveGame({ state: s, initial: launch.initial });
      },
      onEnd: (s) => {
        if (isSaveable(s)) saveGame(null);
        recordResult(s);
      },
    });
  }, [launch]);

  useEffect(() => {
    ctrl.settings = settings;
    ctrl.start();
  }, [settings]);

  useEffect(() => {
    const r = new BoardRenderer(canvas.current!);
    const measure = () => {
      const el = wrap.current!;
      // short landscape screens (phones on their side): controls move to a side column
      const side = el.clientWidth > el.clientHeight && el.clientHeight < 600;
      el.classList.toggle('side', side);
      r.insets = side
        ? { top: (topRef.current?.offsetHeight ?? 0) + 4, bottom: 0, right: (bottomRef.current?.offsetWidth ?? 0) }
        : { top: (topRef.current?.offsetHeight ?? 0) + 6, bottom: (bottomRef.current?.offsetHeight ?? 0) + 2, right: 0 };
      r.resize(el.clientWidth, el.clientHeight);
      setCanZoom(r.canZoom);
      setZoomed(r.zoomed);
    };
    ctrl.attach(r);
    r.onCamera = () => setZoomed(r.zoomed);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap.current!);
    if (topRef.current) ro.observe(topRef.current);
    if (bottomRef.current) ro.observe(bottomRef.current);
    const detach = attachBoardInput(canvas.current!, r, {
      tap: (c) => {
        unlockAudio();
        ctrl.tap(c);
        setZoomed(r.zoomed);
      },
      longPress: (c) => ctrl.longPress(c),
      hover: (c) => ctrl.setHover(c),
    });
    const unsub = ctrl.subscribe(() => {
      setTick((n) => n + 1);
      setZoomed(r.zoomed);
    });
    const unbind = online?.bind(ctrl);
    if (isSaveable(ctrl.state) && !ctrl.state.ended) saveGame({ state: ctrl.state, initial: launch.initial });
    // test/debug hook
    (window as unknown as { __infweb?: unknown }).__infweb = { ctrl, renderer: r };
    ctrl.start();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (ctrl.overlay.kind === 'pause') ctrl.resume();
        else if (ctrl.overlay.kind === 'none') ctrl.pause();
        else if (ctrl.overlay.kind === 'confirmAuto' || ctrl.overlay.kind === 'confirmEndAttack') ctrl.closeOverlay();
      } else if ((e.key === 'Enter' || e.key === ' ') && ctrl.overlay.kind === 'none') {
        e.preventDefault();
        ctrl.endButton(e.shiftKey);
      } else if (e.key === 'Enter' && ctrl.overlay.kind === 'handover') {
        ctrl.dismissHandover();
      }
    };
    window.addEventListener('keydown', key);
    // re-measure once HUD fonts settle
    const tm = window.setTimeout(measure, 300);
    return () => {
      window.removeEventListener('keydown', key);
      const w = window as unknown as { __infweb?: { ctrl: unknown } };
      if (w.__infweb?.ctrl === ctrl) delete w.__infweb;
      clearTimeout(tm);
      unbind?.();
      ro.disconnect();
      detach();
      unsub();
      r.destroy();
      ctrl.dispose();
    };
  }, [ctrl]);

  const s = ctrl.state;
  const cur = s.current;
  const curColor = playerColor(cur);
  const local = ctrl.isLocalTurn;
  const ov = ctrl.overlay;
  const alive = alivePlayers(s);
  const scores = s.settings.players.map((_, i) => scoreOf(s, i));
  const totalScore = scores.reduce((a, b) => a + b, 0) || 1;

  // ---- status line
  let phaseLabel = s.phase === 'attack' ? t('phaseAttack') : t('phasePower');
  let statusText: string;
  if (s.ended) {
    phaseLabel = '';
    statusText = t('statusGameOver');
  } else if (!local) {
    statusText = s.settings.players[cur] === 'remote' ? t('statusWaitRemote') : t('statusWait', { name: playerName(s.settings, cur) });
  } else if (s.phase === 'power') {
    statusText = t('statusPower', { n: s.powerLeft });
  } else if (!anyAttackLeft(s)) {
    statusText = t('statusNoAttacks');
  } else if (s.selected >= 0 && s.field.cells[s.selected]?.owner === cur && s.field.cells[s.selected].power >= 2) {
    statusText = t('statusTarget');
  } else {
    statusText = t('statusSelect');
  }

  const endDisabled = !local || !!s.ended || ctrl.busy;
  const pulse = local && s.phase === 'attack' && !anyAttackLeft(s);

  const toggleZoom = () => {
    const r = ctrl.board;
    if (!r) return;
    if (r.zoomed) r.resetCamera();
    else {
      const sel = s.selected >= 0 ? r.cellScreenPos(s.selected) : null;
      const el = wrap.current!;
      const [x, y] = sel ?? [el.clientWidth / 2, el.clientHeight / 2];
      r.zoomTo(x, y, r.maxScale * 0.85);
    }
    setZoomed(r.zoomed);
  };

  const exitToMenu = () => {
    navigate(online?.exitTo ?? { name: 'menu' });
  };

  const restartSame = () => {
    const init = structuredClone(launch.initial);
    const fresh = createMatch(init.settings, { field: init.field, keepPlacement: true, seed: init.seed + 1 });
    fresh.settings = init.settings;
    navigate({ name: 'game', launch: { state: fresh, initial: launch.initial } });
  };

  const newGame = () => {
    if (s.settings.kind === 'daily' && s.settings.dailyId) {
      const st = createDailyMatch(s.settings.dailyId);
      navigate({ name: 'game', launch: { state: st, initial: structuredClone(st) } });
    } else if (s.settings.kind === 'single') {
      navigate({ name: 'setup' });
    } else {
      navigate({ name: 'duels' });
    }
  };

  const quickRematch = () => {
    if (s.settings.kind === 'single') {
      const st = createMatch(setupToSettings(loadSetup()));
      navigate({ name: 'game', launch: { state: st, initial: structuredClone(st) } });
    } else newGame();
  };

  return (
    <div class="game" ref={wrap} style={{ background: s.settings.darkness ? '#03040a' : undefined }}>
      <canvas ref={canvas} aria-label="game board" />
      <div class="turn-bar" style={{ background: curColor, color: curColor }} />

      <div class="hud-top" ref={topRef}>
        <div class="hud-row">
          <button class="side-btn" aria-label={t('pause')} onClick={() => ctrl.pause()} style={{ width: 40, height: 40, borderRadius: 12 }}>
            <IconPause />
          </button>
          <div class="scorebar" aria-hidden="true">
            {scores.map((sc, i) =>
              sc > 0 ? <div key={i} style={{ flexGrow: sc / totalScore, background: playerColor(i) }} /> : null,
            )}
          </div>
          <div class="round-label">{t('round', { n: s.turn + 1 })}</div>
        </div>
        <div class="players-strip">
          {s.settings.players.map((_, i) => {
            const out = !alive.includes(i);
            return (
              <div key={i} class={`pchip ${i === cur && !s.ended ? 'cur' : ''} ${out ? 'out' : ''}`} style={{ '--c': playerColor(i) }}>
                {settings.colorblind ? <PlayerToken slot={i} size={12} shape /> : <span class="sw" />}
                <span class="nm">{playerName(s.settings, i)}</span>
                {!out && <span class="n">{cellCount(s, i)}</span>}
                {i === cur && ctrl.thinking && (
                  <span class="thinking">
                    <i />
                    <i />
                    <i />
                  </span>
                )}
              </div>
            );
          })}
        </div>
        {online?.Extra && <online.Extra ctrl={ctrl} />}
        {ctrl.hint && (
          <div key={ctrl.hint.id} class="hint" style={{ color: ctrl.hint.color ?? 'var(--text)' }}>
            {ctrl.hint.text}
          </div>
        )}
      </div>

      <div class="hud-bottom" ref={bottomRef}>
        <div class="hud-bottom-inner">
          <button class="side-btn" aria-label="zoom" disabled={!canZoom} onClick={toggleZoom}>
            {zoomed ? <IconZoomOut /> : <IconZoomIn />}
          </button>
          <div class="status">
            {phaseLabel && (
              <div class="phase" style={{ color: curColor }}>
                {phaseLabel}
              </div>
            )}
            <div class="text">{statusText}</div>
          </div>
          <EndButton
            ctrl={ctrl}
            color={curColor}
            disabled={endDisabled}
            pulse={pulse}
            label={s.phase === 'power' && local ? `+${s.powerLeft}` : null}
          />
        </div>
      </div>

      {ov.kind === 'confirmEndAttack' && (
        <Modal onBackdrop={() => ctrl.closeOverlay()}>
          <h2>{t('confirmEndAttack')}</h2>
          <p>{anyAttackLeft(s) ? t('confirmEndAttackText') : t('confirmEndAttackNone')}</p>
          <label class="check">
            <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk((e.target as HTMLInputElement).checked)} />
            {t('dontAskAgain')}
          </label>
          <div class="row">
            <button class="btn ghost" onClick={() => ctrl.closeOverlay()}>
              {t('cancel')}
            </button>
            <button
              class="btn"
              onClick={() => {
                if (dontAsk) updateSettings({ confirmEnd: false });
                ctrl.endButton(true);
              }}
            >
              {t('endAttack')}
            </button>
          </div>
        </Modal>
      )}

      {ov.kind === 'confirmAuto' && (
        <Modal onBackdrop={() => ctrl.closeOverlay()}>
          <h2>{t('confirmAutoPower', { n: s.powerLeft })}</h2>
          <p>{t('confirmAutoPowerText', { n: s.powerLeft })}</p>
          <label class="check">
            <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk((e.target as HTMLInputElement).checked)} />
            {t('dontAskAgain')}
          </label>
          <div class="row">
            <button class="btn ghost" onClick={() => ctrl.closeOverlay()}>
              {t('cancel')}
            </button>
            <button
              class="btn"
              onClick={() => {
                if (dontAsk) updateSettings({ confirmEnd: false });
                ctrl.endButton(true);
              }}
            >
              {t('endTurn')}
            </button>
          </div>
        </Modal>
      )}

      {ov.kind === 'stuck' && (
        <Modal>
          <h2>{t('earlyTitle')}</h2>
          <p>{t(ov.offer.enough ? 'earlyWin' : 'earlyLose', { p: Math.round(ov.offer.percent) })}</p>
          <div class="row">
            <button class="btn ghost" onClick={() => ctrl.acceptStuck(false)}>
              {t('keepPlaying')}
            </button>
            <button class={`btn ${ov.offer.enough ? 'green' : 'red'}`} onClick={() => ctrl.acceptStuck(true)}>
              {t('finishNow')}
            </button>
          </div>
        </Modal>
      )}

      {ov.kind === 'handover' && (
        <div class="overlay solid" onClick={() => ctrl.dismissHandover()}>
          <div class="handover">
            <div class="kicker">{t('handoverTitle')}</div>
            <PlayerToken slot={ov.next} size={84} shape={settings.colorblind} />
            <div class="big" style={{ color: playerColor(ov.next) }}>
              {t('handoverNext', { name: playerName(s.settings, ov.next) })}
            </div>
            <div class="muted">{t('handoverTap')}</div>
          </div>
        </div>
      )}

      {ov.kind === 'pause' && askConcede && (
        <Modal onBackdrop={() => setAskConcede(false)}>
          <h2>{t('concedeConfirm')}</h2>
          <p>{t('concedeText')}</p>
          <div class="row">
            <button class="btn ghost" onClick={() => setAskConcede(false)}>
              {t('cancel')}
            </button>
            <button
              class="btn red"
              onClick={() => {
                setAskConcede(false);
                ctrl.concedeMatch();
              }}
            >
              {t('concede')}
            </button>
          </div>
        </Modal>
      )}

      {ov.kind === 'pause' && !askConcede && (
        <Modal onBackdrop={() => ctrl.resume()}>
          <h2>{t('pause')}</h2>
          <p>{t('round', { n: s.turn + 1 })}</p>
          <button class="btn primary" onClick={() => ctrl.resume()}>
            <IconPlay width={18} height={18} /> {t('resume')}
          </button>
          {s.settings.kind !== 'duelOnline' && !s.ended && (
            <button class="btn ghost" onClick={restartSame}>
              <IconRestart width={18} height={18} /> {t('restartSame')}
            </button>
          )}
          {!s.ended && (s.settings.kind === 'duelOnline' || s.settings.kind === 'daily' || s.settings.kind === 'duelTraining') && (
            <button
              class="btn red"
              onClick={() => setAskConcede(true)}
            >
              <IconFlag width={18} height={18} /> {t('concede')}
            </button>
          )}
          <button class="btn ghost" onClick={exitToMenu}>
            <IconHome width={18} height={18} /> {t('toMenu')}
          </button>
        </Modal>
      )}

      {ov.kind === 'result' && s.ended && (
        <ResultModal
          ctrl={ctrl}
          onMenu={exitToMenu}
          onRestart={s.settings.kind !== 'duelOnline' ? restartSame : undefined}
          onNew={s.settings.kind !== 'duelOnline' ? quickRematch : undefined}
          extra={online?.ResultActions ? <online.ResultActions ctrl={ctrl} /> : null}
        />
      )}
    </div>
  );
}

function EndButton({
  ctrl,
  color,
  disabled,
  pulse,
  label,
}: {
  ctrl: GameController;
  color: string;
  disabled: boolean;
  pulse: boolean;
  label: string | null;
}) {
  const timer = useRef(0);
  const fired = useRef(false);
  const down = () => {
    fired.current = false;
    timer.current = window.setTimeout(() => {
      fired.current = true;
      sfx.click();
      ctrl.endButton(true);
    }, 500);
  };
  const up = () => {
    clearTimeout(timer.current);
    if (!fired.current) {
      sfx.click();
      ctrl.endButton(false);
    }
    fired.current = true;
  };
  return (
    <button
      class={`end-btn ${pulse ? 'pulse' : ''}`}
      style={{ '--c': color }}
      disabled={disabled}
      aria-label={ctrl.state.phase === 'attack' ? t('endAttack') : t('endTurn')}
      title={ctrl.state.phase === 'attack' ? t('endAttack') : t('endTurn')}
      onPointerDown={down}
      onPointerUp={up}
      onPointerLeave={() => clearTimeout(timer.current)}
      onContextMenu={(e) => e.preventDefault()}
    >
      {label ?? <IconSkip />}
    </button>
  );
}

function ResultModal({
  ctrl,
  onMenu,
  onRestart,
  onNew,
  extra,
}: {
  ctrl: GameController;
  onMenu: () => void;
  onRestart?: () => void;
  onNew?: () => void;
  extra: preact.JSX.Element | null;
}) {
  const s = ctrl.state;
  const end = s.ended!;
  const humans = s.settings.players.filter((p) => p === 'human').length;
  let title: string;
  let color: string;
  if (humans > 1) {
    if (end.winner >= 0) {
      title = t('winnerIs', { name: playerName(s.settings, end.winner) });
      color = playerColor(end.winner);
    } else {
      title = end.humanWon ? t('draw') : t('botsWon');
      color = 'var(--bad)';
    }
  } else {
    title = end.humanWon ? t('win') : t('lose');
    color = end.humanWon ? 'var(--good)' : 'var(--bad)';
  }
  const ch = s.chronicle;
  return (
    <Modal>
      <div class="result-banner">
        <ResultEmblem color={color} win={humans > 1 ? end.winner >= 0 : end.humanWon} />
        <div class="result-title" style={{ color, fontSize: humans > 1 ? 24 : undefined }}>
          {title}
        </div>
        <div class="result-sub">
          {t('round', { n: end.turn + 1 })} · {formatDuration((ctrl.endedAt || Date.now()) - s.startedAt)}
        </div>
      </div>
      {end.reason === 'concede' && s.settings.kind === 'duelOnline' && end.humanWon && <p>{t('oppConceded')}</p>}
      {end.reason === 'timeout' && end.humanWon && <p>{t('timeoutWin')}</p>}
      <div class="result-stats">
        {humans === 1 && (
          <>
            <div>
              <b>{ch.conquered}</b>
              <span>{t('captured')}</span>
            </div>
            <div>
              <b>{ch.attacks ? Math.round((ch.attacksWon / ch.attacks) * 100) : 0}%</b>
              <span>{t('attackSuccess')}</span>
            </div>
          </>
        )}
        {humans > 1 &&
          s.settings.players.map((p, i) =>
            p === 'human' ? (
              <div key={i}>
                <b style={{ color: playerColor(i) }}>{cellCount(s, i)}</b>
                <span>{playerName(s.settings, i)}</span>
              </div>
            ) : null,
          )}
      </div>
      {extra}
      {onNew && (
        <button class="btn primary" onClick={onNew}>
          {s.settings.kind === 'daily' ? t('dailyRetry') : t('newGame')}
        </button>
      )}
      <div class="row">
        <button class="btn ghost" onClick={onMenu}>
          <IconHome width={18} height={18} /> {t('toMenu')}
        </button>
        {onRestart && (
          <button class="btn ghost" onClick={onRestart}>
            <IconRestart width={18} height={18} /> {t('replayShort')}
          </button>
        )}
      </div>
    </Modal>
  );
}

function ResultEmblem({ color, win }: { color: string; win: boolean }) {
  const hex = (r: number) =>
    Array.from({ length: 6 }, (_, i) => {
      const a = (Math.PI / 3) * i - Math.PI / 2;
      return `${(40 + r * Math.cos(a)).toFixed(2)},${(40 + r * Math.sin(a)).toFixed(2)}`;
    }).join(' ');
  return (
    <svg viewBox="0 0 80 80" width="72" height="72" style={{ color }}>
      <polygon points={hex(34)} fill="currentColor" opacity="0.14" />
      <polygon points={hex(26)} fill="currentColor" opacity={win ? 1 : 0.35} />
      {win ? (
        <path d="M28 41l8 8 16-17" stroke="#0b0c0f" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round" />
      ) : (
        <path d="M31 31l18 18M49 31L31 49" stroke="currentColor" stroke-width="5" stroke-linecap="round" />
      )}
    </svg>
  );
}

function recordResult(s: MatchState) {
  const humans = s.settings.players.filter((p) => p === 'human').length;
  const me = s.settings.players.findIndex((p) => p === 'human');
  const win = humans > 1 ? false : !!s.ended?.humanWon;
  addRecord({
    at: Date.now(),
    kind: s.settings.kind,
    size: s.settings.size,
    opponents: s.settings.players.filter((_, i) => i !== me),
    humans,
    win,
    rounds: (s.ended?.turn ?? s.turn) + 1,
    captured: s.chronicle.conquered,
    ms: Date.now() - s.startedAt,
  });
  if (s.settings.kind === 'daily' && s.settings.dailyId) updateDaily(s.settings.dailyId, win, (s.ended?.turn ?? s.turn) + 1);
}
