import {
  addPower,
  alivePlayers,
  anyAttackLeft,
  attack,
  autoPower,
  canAttackFrom,
  checkAttack,
  checkStuck,
  concede,
  endAttack,
  finishEarly,
  finishTurn,
  humansAlive,
  incomeCells,
  isAlive,
  isHuman,
  targetsFrom,
  visibleCells,
  exploredCells,
  winChance,
  type StuckOffer,
} from '../../core/engine';
import type { FightEvent, MatchState, UnionEvent } from '../../core/types';
import type { Bot } from '../../ai/types';
import { createBot } from '../../ai';
import { sfx, buzz } from '../../audio/sfx';
import { playerColor } from '../theme';
import type { BoardRenderer, BoardView } from '../board/renderer';
import { SPEED_MS, type Settings } from '../../storage';

export type Overlay =
  | { kind: 'none' }
  | { kind: 'handover'; next: number }
  | { kind: 'stuck'; offer: StuckOffer }
  | { kind: 'confirmEndAttack' }
  | { kind: 'confirmAuto' }
  | { kind: 'pause' }
  | { kind: 'result' };

/** A move as applied to the state (fights carry their outcome so it can be replayed elsewhere). */
export type AppliedMove =
  | { t: 'attack'; from: number; to: number; win: boolean }
  | { t: 'endAttack' }
  | { t: 'power'; cell: number; amount: number }
  | { t: 'endTurn' };

export interface Hint {
  text: string;
  color?: string;
  id: number;
}

/** Hooks for online play: actions are routed to the session instead of the local engine. */
export interface MatchDriver {
  /** perform a local human attack; returns the fight or a refusal */
  attack(from: number, to: number): FightEvent | string;
  endAttack(): UnionEvent | null;
  addPower(cell: number, amount: number): number;
  autoPower(): Map<number, number>;
  finishTurn(): void;
  concede(slot: number): void;
  /** true when the local device may act for state.current */
  canAct(): boolean;
}

export interface ControllerOptions {
  state: MatchState;
  settings: Settings;
  /** used for name strings */
  nameOf: (slot: number) => string;
  /** override some moves (online play); missing ones use the local engine */
  driver?: Partial<MatchDriver>;
  /**
   * Every move applied to the local state, by anyone (people and bots). An online battle host
   * forwards them to its guests.
   */
  onAction?: (seat: number, a: AppliedMove) => void;
  onSave?: (state: MatchState) => void;
  onEnd?: (state: MatchState) => void;
  /** online battle guest: every move comes from the host, bots are not run locally */
  remoteDriven?: boolean;
  t: (k: string, p?: Record<string, string | number>) => string;
}

export class GameController {
  state: MatchState;
  settings: Settings;
  overlay: Overlay = { kind: 'none' };
  hint: Hint | null = null;
  /** the cell being long-pressed (for UI feedback) */
  pressing = -1;
  hover = -1;
  thinking = false;
  /** wall time when the match ended (for the result screen) */
  endedAt = 0;
  private renderer: BoardRenderer | null = null;
  private bots = new Map<number, Bot>();
  private listeners = new Set<() => void>();
  private running = false;
  private disposed = false;
  private hintTimer = 0;
  private hintSeq = 0;
  private paused = false;
  private handoverDone = -1;
  private stuckChecked = -1;
  private resultShown = false;
  private driver: MatchDriver;
  private opts: ControllerOptions;

  constructor(opts: ControllerOptions) {
    this.opts = opts;
    this.state = opts.state;
    this.settings = opts.settings;
    this.driver = { ...this.localDriver(), ...(opts.driver ?? {}) };
    // a guest of an online battle only replays what the host sends: no bots run here
    if (!opts.remoteDriven) {
      opts.state.settings.players.forEach((p, slot) => {
        if (p !== 'human' && p !== 'remote' && p !== 'online') this.bots.set(slot, createBot(p));
      });
    }
  }

  private localDriver(): MatchDriver {
    return {
      attack: (f, t) => {
        const seat = this.state.current;
        const ev = attack(this.state, f, t);
        if (typeof ev !== 'string') this.report(seat, { t: 'attack', from: f, to: t, win: ev.win });
        return ev;
      },
      endAttack: () => {
        const seat = this.state.current;
        const u = endAttack(this.state);
        this.report(seat, { t: 'endAttack' });
        return u;
      },
      addPower: (c, n) => {
        const added = addPower(this.state, c, n);
        if (added) this.report(this.state.current, { t: 'power', cell: c, amount: added });
        return added;
      },
      autoPower: () => {
        const added = autoPower(this.state);
        for (const [cell, amount] of added) this.report(this.state.current, { t: 'power', cell, amount });
        return added;
      },
      finishTurn: () => {
        const seat = this.state.current;
        finishTurn(this.state);
        this.report(seat, { t: 'endTurn' });
      },
      concede: (slot) => concede(this.state, slot),
      canAct: () => isHuman(this.state, this.state.current),
    };
  }

  private report(seat: number, a: AppliedMove) {
    this.opts.onAction?.(seat, a);
  }

  /** Create bots for seats that became bots (e.g. an online seat handed over to a bot). */
  refreshBots() {
    if (this.opts.remoteDriven) return;
    this.state.settings.players.forEach((p, slot) => {
      if (p !== 'human' && p !== 'remote' && p !== 'online' && !this.bots.has(slot)) this.bots.set(slot, createBot(p));
    });
    this.afterChange();
  }

  // ------------------------------------------------------------ wiring

  attach(renderer: BoardRenderer) {
    this.renderer = renderer;
    this.pushView();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.pushView();
    for (const fn of this.listeners) fn();
  }

  /** External state replacement (online sync). */
  replaceState(state: MatchState) {
    this.state = state;
    this.emit();
    this.afterChange();
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.hintTimer);
    for (const b of this.bots.values()) b.dispose?.();
    this.listeners.clear();
  }

  start() {
    this.emit();
    this.afterChange();
  }

  // ------------------------------------------------------------ derived

  get isLocalTurn(): boolean {
    return !this.state.ended && this.driver.canAct();
  }

  get humansCount(): number {
    return this.state.settings.players.filter((p) => p === 'human').length;
  }

  /** Viewer for darkness: in hot-seat the current human, otherwise the single human. */
  get viewer(): number {
    return this.state.viewer;
  }

  view(): BoardView {
    const s = this.state;
    const visible = visibleCells(s, s.viewer);
    const known = exploredCells(s, s.viewer);
    const local = this.isLocalTurn && this.overlay.kind !== 'handover';
    const selected = local && s.phase === 'attack' ? s.selected : -1;
    const targets = new Set<number>(selected >= 0 ? targetsFrom(s, selected) : []);
    let active: Set<number> | null = null;
    if (local && s.phase === 'attack' && this.settings.inactiveCells) {
      active = new Set();
      s.field.cells.forEach((c, i) => c.owner === s.current && canAttackFrom(s, i) && active!.add(i));
    }
    let income: Set<number> | null = null;
    if (s.settings.duelRules) {
      income = new Set();
      for (const p of alivePlayers(s)) for (const i of incomeCells(s, p)) income.add(i);
    }
    let chances: Map<number, number> | null = null;
    if (selected >= 0 && this.settings.showChance) {
      chances = new Map();
      const a = s.field.cells[selected].power;
      for (const ti of targets) {
        const d = s.field.cells[ti];
        if (d.owner >= 0 || d.power > 0) chances.set(ti, Math.round(winChance(a, d.power) * 100));
      }
    }
    return {
      state: s,
      visible,
      known,
      selected,
      targets,
      chances,
      active,
      income,
      colorblind: this.settings.colorblind,
      lineAlpha: this.settings.cellLines / 100,
      lowFx: this.settings.lowFx,
      hover: this.hover,
    };
  }

  private pushView() {
    if (this.renderer) this.renderer.setView(this.view());
  }

  name(slot: number) {
    return this.opts.nameOf(slot);
  }

  /** the seat is the only person at this device, shown as "Вы" (needs its own grammar in messages) */
  private isYou(slot: number) {
    return isHuman(this.state, slot) && this.humansCount === 1;
  }

  // ------------------------------------------------------------ hints

  showHint(text: string, color?: string, ms = 2600) {
    this.hint = { text, color, id: ++this.hintSeq };
    clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => {
      this.hint = null;
      this.emit();
    }, ms);
    this.emit();
  }

  // ------------------------------------------------------------ human input

  tap(cell: number) {
    const s = this.state;
    if (!this.isLocalTurn || this.overlay.kind !== 'none' || this.running) return;
    const c = s.field.cells[cell];
    if (!c) return;
    if (s.phase === 'attack') {
      if (c.owner === s.current) {
        s.selected = s.selected === cell && !canAttackFrom(s, cell) ? -1 : cell;
        if (canAttackFrom(s, cell)) sfx.select();
        this.emit();
        return;
      }
      if (s.selected < 0) {
        this.emit();
        return;
      }
      const refusal = checkAttack(s, s.selected, cell);
      if (refusal === 'greysFirst') {
        this.showHint(this.opts.t('greysFirst'));
        buzz(30);
        return;
      }
      if (refusal) {
        // tapping a non-adjacent foreign cell just clears the selection
        s.selected = -1;
        this.emit();
        return;
      }
      const ev = this.driver.attack(s.selected, cell);
      if (typeof ev !== 'string') this.onFight(ev, true);
      this.saveAndEmit();
      this.afterChange();
    } else {
      if (c.owner !== s.current) return;
      const added = this.driver.addPower(cell, 1);
      if (added) {
        sfx.power();
        this.renderer?.floatText(cell, `+${added}`, playerColor(s.current));
        this.afterPowerAdded();
      } else {
        if (!this.opts.remoteDriven) buzz(8);
      }
    }
  }

  longPress(cell: number) {
    const s = this.state;
    if (!this.isLocalTurn || this.overlay.kind !== 'none' || this.running) return;
    const c = s.field.cells[cell];
    if (!c) return;
    if (s.phase === 'power') {
      if (c.owner !== s.current) return;
      const added = this.driver.addPower(cell, c.maxPower - c.power);
      if (added) {
        sfx.fill();
        buzz(15);
        this.renderer?.floatText(cell, `+${added}`, playerColor(s.current));
        this.afterPowerAdded();
      }
      return;
    }
    // attack phase: show the chance against this cell
    if (s.selected >= 0 && c.owner !== s.current && targetsFrom(s, s.selected).includes(cell)) this.showChance(s.selected, cell);
    else if (c.owner === s.current) this.tap(cell);
  }

  setHover(cell: number) {
    if (cell === this.hover) return;
    this.hover = cell;
    const s = this.state;
    if (
      this.settings.showChance &&
      cell >= 0 &&
      this.isLocalTurn &&
      s.phase === 'attack' &&
      s.selected >= 0 &&
      targetsFrom(s, s.selected).includes(cell)
    ) {
      this.showChance(s.selected, cell, 1600);
    }
    this.pushView();
  }

  private showChance(from: number, to: number, ms = 2200) {
    const s = this.state;
    const a = s.field.cells[from].power;
    const d = s.field.cells[to].power;
    if (!visibleCells(s)[to]) return;
    this.showHint(this.opts.t('chance', { a, d, p: Math.round(winChance(a, d) * 100) }), undefined, ms);
  }

  private afterPowerAdded() {
    if (this.state.powerLeft <= 0) {
      this.driver.finishTurn();
      this.saveAndEmit();
      this.afterChange();
    } else {
      this.saveAndEmit();
    }
  }

  /** End-turn button. `force` skips confirmations (long press). */
  endButton(force = false) {
    const s = this.state;
    if (!this.isLocalTurn || this.running) return;
    if (this.overlay.kind !== 'none' && this.overlay.kind !== 'confirmEndAttack' && this.overlay.kind !== 'confirmAuto') return;
    if (s.phase === 'attack') {
      // confirm only when some cell could still attack
      if (!force && this.settings.confirmEnd && anyAttackLeft(s) && this.overlay.kind !== 'confirmEndAttack') {
        this.overlay = { kind: 'confirmEndAttack' };
        this.emit();
        return;
      }
      this.overlay = { kind: 'none' };
      const u = this.driver.endAttack();
      if (u) this.onUnion(u);
      sfx.phase();
      if (this.state.powerLeft === 0) this.driver.finishTurn();
      this.saveAndEmit();
      this.afterChange();
    } else {
      if (!force && this.settings.confirmEnd && this.overlay.kind !== 'confirmAuto') {
        this.overlay = { kind: 'confirmAuto' };
        this.emit();
        return;
      }
      this.overlay = { kind: 'none' };
      const added = this.driver.autoPower();
      for (const [cell, n] of added) this.renderer?.floatText(cell, `+${n}`, playerColor(s.current));
      sfx.fill();
      this.driver.finishTurn();
      this.saveAndEmit();
      this.afterChange();
    }
  }

  closeOverlay() {
    this.overlay = { kind: 'none' };
    this.emit();
  }

  dismissHandover() {
    if (this.overlay.kind !== 'handover') return;
    this.handoverDone = this.overlay.next;
    this.overlay = { kind: 'none' };
    sfx.turn();
    this.emit();
    this.afterChange();
  }

  pause() {
    if (this.overlay.kind !== 'none' && this.overlay.kind !== 'result') return;
    this.paused = true;
    this.overlay = { kind: 'pause' };
    this.emit();
  }

  resume() {
    this.paused = false;
    this.overlay = this.state.ended && this.resultShown ? { kind: 'result' } : { kind: 'none' };
    this.emit();
    this.afterChange();
  }

  acceptStuck(finish: boolean) {
    if (this.overlay.kind !== 'stuck') return;
    const offer = this.overlay.offer;
    this.overlay = { kind: 'none' };
    if (finish) finishEarly(this.state, offer);
    this.saveAndEmit();
    this.afterChange();
  }

  /**
   * The local person gives up. With other seats still in play the match goes on without them (the
   * driver decides: engine rules locally, the host in an online battle); it ends only by the usual rules.
   */
  concedeMatch() {
    const slot = this.localHumanSlot();
    if (slot < 0) return;
    this.driver.concede(slot);
    this.paused = false;
    this.overlay = { kind: 'none' };
    this.saveAndEmit();
    this.afterChange();
  }

  /** The person at this device who is giving up: whoever's turn it is, else the one who played last. */
  localHumanSlot(): number {
    const s = this.state;
    const alive = (p: number) => p >= 0 && isHuman(s, p) && isAlive(s, p);
    if (alive(s.current)) return s.current;
    if (alive(s.viewer)) return s.viewer;
    return s.settings.players.findIndex((_, i) => alive(i));
  }

  // ------------------------------------------------------------ events / effects

  private onFight(ev: FightEvent, local: boolean) {
    const winnerSlot = ev.win ? ev.player : ev.defOwnerBefore;
    const vis = visibleCells(this.state);
    const seen = vis[ev.from] || vis[ev.to];
    if (seen) {
      this.renderer?.fight(ev.from, ev.to, ev.win, playerColor(winnerSlot), playerColor(ev.player));
      if (ev.win) sfx.capture();
      else sfx.fail();
      this.renderer?.ensureVisible(ev.to);
    }
    if (local || isHuman(this.state, ev.defOwnerBefore)) buzz(ev.win ? 10 : [10, 40, 10]);
    if (ev.eliminated !== null) {
      sfx.eliminated();
      if (seen) this.renderer?.ring(ev.to, playerColor(ev.eliminated), true);
      const text = this.isYou(ev.eliminated) ? this.opts.t('youEliminated') : this.opts.t('eliminated', { name: this.name(ev.eliminated) });
      this.showHint(text, playerColor(ev.eliminated), 3000);
    }
  }

  /** Called by the online driver when the opponent's fight arrives. */
  remoteFight(ev: FightEvent) {
    this.onFight(ev, false);
    this.emit();
  }

  remotePower(cell: number, amount: number, slot: number) {
    if (visibleCells(this.state)[cell]) this.renderer?.floatText(cell, `+${amount}`, playerColor(slot));
    this.emit();
  }

  private onUnion(u: UnionEvent) {
    sfx.eliminated();
    const text = this.isYou(u.absorber)
      ? this.opts.t('unitedYou', { a: this.name(u.absorbed) })
      : this.opts.t('united', { a: this.name(u.absorbed), b: this.name(u.absorber) });
    this.showHint(text, playerColor(u.absorber), 3500);
  }

  private saveAndEmit() {
    this.opts.onSave?.(this.state);
    this.emit();
  }

  // ------------------------------------------------------------ flow

  /** Re-evaluate what happens next (bot turn, hand-over, stuck offer, end). */
  private afterChange() {
    if (this.disposed) return;
    const s = this.state;
    if (s.ended) {
      if (!this.resultShown) {
        this.resultShown = true;
        this.endedAt = Date.now();
        this.opts.onEnd?.(s);
        const won = s.ended.humanWon;
        window.setTimeout(() => {
          if (this.disposed) return;
          if (won || s.settings.spectate || (this.humansCount > 1 && s.ended && s.ended.winner >= 0 && isHuman(s, s.ended.winner))) sfx.win();
          else sfx.lose();
          if (!this.paused) this.overlay = { kind: 'result' };
          this.emit();
        }, 650);
      }
      return;
    }
    if ((this.overlay.kind === 'confirmAuto' || this.overlay.kind === 'confirmEndAttack') && !this.isLocalTurn) {
      this.overlay = { kind: 'none' };
      this.emit();
    }
    if (this.paused || this.overlay.kind !== 'none') return;
    const cur = s.current;
    if (isHuman(s, cur)) {
      // hot-seat: a new human takes over the device
      if (humansAlive(s).length > 1 && this.handoverDone !== cur && s.phase === 'attack' && s.powerLeft === 0) {
        if (s.settings.darkness) {
          // in darkness the board must stay hidden until the next player is ready
          this.overlay = { kind: 'handover', next: cur };
          this.emit();
          return;
        }
        this.handoverDone = cur;
        sfx.turn();
        this.showHint(this.opts.t('handoverNext', { name: this.name(cur) }), playerColor(cur), 1800);
      }
      if (s.phase === 'attack' && this.stuckChecked !== s.turn * 10 + cur) {
        this.stuckChecked = s.turn * 10 + cur;
        const offer = checkStuck(s);
        if (offer) {
          this.overlay = { kind: 'stuck', offer };
          this.emit();
          return;
        }
      }
      return;
    }
    if (this.bots.has(cur)) void this.runBots();
  }

  private sleep(ms: number) {
    return new Promise<void>((r) => window.setTimeout(r, ms));
  }

  private async waitWhilePaused() {
    while (this.paused && !this.disposed) await this.sleep(120);
  }

  private async runBots() {
    if (this.running) return;
    this.running = true;
    this.emit();
    try {
      while (!this.disposed && !this.state.ended) {
        await this.waitWhilePaused();
        const s = this.state;
        const slot = s.current;
        const bot = this.bots.get(slot);
        if (!bot) break;
        const speed = this.botSpeed();
        const ctx = { speedMs: speed };
        if (s.phase === 'attack') {
          this.thinking = true;
          const mv = await bot.nextAttack(s, ctx);
          this.thinking = false;
          if (this.disposed) return;
          await this.waitWhilePaused();
          if (this.disposed || this.state !== s) return;
          if (mv) {
            const vis = visibleCells(this.state);
            const seen = vis[mv.from] || vis[mv.to];
            if (seen && speed > 0) {
              this.state.selected = mv.from;
              this.renderer?.ensureVisible(mv.from);
              this.emit();
              await this.sleep(speed * 0.5);
              if (this.disposed) return;
              await this.waitWhilePaused();
              if (this.disposed) return;
            }
            if (this.state !== s) continue;
            const ev = attack(this.state, mv.from, mv.to);
            if (typeof ev !== 'string') this.report(slot, { t: 'attack', from: mv.from, to: mv.to, win: ev.win });
            this.state.selected = -1;
            if (typeof ev === 'string') {
              // illegal move from a bot: end its attack instead of looping
              console.warn('bot produced illegal attack', mv, ev);
              this.botEndAttack();
            } else {
              this.onFight(ev, false);
              this.emit();
              if (seen && speed > 0) await this.sleep(speed * 0.8);
              if (this.disposed) return;
            }
          } else {
            this.botEndAttack();
          }
        } else {
          const placement = await bot.placePower(s, ctx);
          if (this.disposed) return;
          await this.waitWhilePaused();
          if (this.disposed || this.state !== s) return;
          const vis = visibleCells(this.state);
          for (const [cell, n] of placement) {
            const added = addPower(this.state, cell, n);
            if (added) this.report(slot, { t: 'power', cell, amount: added });
            if (added && vis[cell]) this.renderer?.floatText(cell, `+${added}`, playerColor(slot));
          }
          if (this.state.powerLeft > 0) for (const [cell, amount] of autoPower(this.state)) this.report(slot, { t: 'power', cell, amount });
          finishTurn(this.state);
          this.report(slot, { t: 'endTurn' });
          this.opts.onSave?.(this.state);
          // a human moves next: stop here so the hand-over screen (if any) appears before the new view
          if (isHuman(this.state, this.state.current)) break;
          this.emit();
          if (speed > 0 && placement.size) await this.sleep(Math.min(400, speed));
          if (this.disposed) return;
        }
      }
    } finally {
      this.running = false;
      this.thinking = false;
    }
    this.emit();
    if (isHuman(this.state, this.state.current) && !this.state.ended) sfx.turn();
    this.afterChange();
  }

  /**
   * Delay between bot actions. With several bots moving in a row their pace is shortened so a round
   * against many opponents does not drag on (two bots: full speed, four: about half).
   */
  private botSpeed(): number {
    const base = SPEED_MS[this.settings.speed];
    const bots = alivePlayers(this.state).filter((p) => this.bots.has(p)).length;
    return Math.round((base * Math.min(1, 2 / Math.max(1, bots))) / this.spectateSpeedup);
  }

  /** how much faster the bots move while the people watch them fight on (MatchSettings.spectate) */
  spectateSpeedup = 1;

  private botEndAttack() {
    const seat = this.state.current;
    const u = endAttack(this.state);
    this.report(seat, { t: 'endAttack' });
    if (u) this.onUnion(u);
    this.emit();
  }

  get busy() {
    return this.running;
  }

  get board(): BoardRenderer | null {
    return this.renderer;
  }
}
