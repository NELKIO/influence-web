import { useEffect, useRef } from 'preact/hooks';
import { BoardRenderer } from '../board/renderer';
import { addPower, attack, autoPower, createMatch, endAttack, finishTurn, visibleCells } from '../../core/engine';
import { createBot } from '../../ai';
import type { Bot } from '../../ai/types';
import type { MatchState, PlayerType } from '../../core/types';
import { playerColor } from '../theme';
import { getSettings } from '../store';

/** A real match between bots, played slowly behind the main menu. */
export function AmbientBoard() {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const r = new BoardRenderer(canvas.current!);
    let disposed = false;
    let timer = 0;
    let state: MatchState;
    let bots: Bot[] = [];
    const lineups: PlayerType[][] = [
      ['hunter', 'dummy', 'hunter', 'freak'],
      ['hunter', 'hunter', 'dummy', 'dummy', 'freak'],
      ['hunter', 'dummy', 'hunter'],
    ];
    let round = 0;

    const view = () =>
      r.setView({
        state,
        visible: visibleCells(state, -1),
        selected: -1,
        targets: new Set(),
        active: null,
        income: null,
        colorblind: getSettings().colorblind,
        lineAlpha: 0.7,
        lowFx: getSettings().lowFx,
        hover: -1,
        chances: null,
      });

    const newMatch = () => {
      const players = lineups[round++ % lineups.length];
      state = createMatch({
        kind: 'single',
        size: window.innerWidth > 900 ? 'L' : 'M',
        players,
        darkness: false,
        symmetry: round % 2 === 1,
        crowded: false,
        unions: false,
        shuffle: false,
        duelRules: false,
      });
      bots.forEach((b) => b.dispose?.());
      bots = players.map((p) => createBot(p as Exclude<PlayerType, 'human' | 'remote'>));
      view();
    };

    const measure = () => {
      const el = wrap.current;
      if (!el) return;
      r.insets = { top: 0, bottom: 0, right: 0 };
      r.resize(el.clientWidth, el.clientHeight);
    };

    const step = async () => {
      if (disposed) return;
      const delay = document.hidden ? 1500 : 520;
      try {
        if (state.ended || state.turn > 60) {
          await new Promise((res) => setTimeout(res, 2200));
          if (disposed) return;
          newMatch();
        } else {
          const bot = bots[state.current];
          const ctx = { speedMs: 0 };
          if (state.phase === 'attack') {
            const mv = await bot.nextAttack(state, ctx);
            if (disposed) return;
            if (mv) {
              const atk = state.field.cells[mv.from].owner;
              const ev = attack(state, mv.from, mv.to);
              if (typeof ev !== 'string') r.fight(ev.from, ev.to, ev.win, playerColor(ev.win ? atk : ev.defOwnerBefore), playerColor(atk), 520);
              // bot-only match: keep going instead of ending when no human is left
              const end = state.ended as MatchState['ended'];
              if (end && end.reason === 'elimination') {
                const alive = new Set(state.field.cells.filter((c) => c.owner >= 0).map((c) => c.owner));
                if (alive.size > 1) state.ended = null;
              }
            } else endAttack(state);
          } else {
            const placement = await bot.placePower(state, ctx);
            if (disposed) return;
            for (const [cell, n] of placement) addPower(state, cell, n);
            if (state.powerLeft > 0) autoPower(state);
            finishTurn(state);
          }
          view();
        }
      } catch {
        newMatch();
      }
      timer = window.setTimeout(step, delay);
    };

    newMatch();
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap.current!);
    timer = window.setTimeout(step, 400);
    return () => {
      disposed = true;
      clearTimeout(timer);
      ro.disconnect();
      bots.forEach((b) => b.dispose?.());
      r.destroy();
    };
  }, []);

  return (
    <div class="menu-board" ref={wrap} aria-hidden="true">
      <canvas ref={canvas} />
    </div>
  );
}
