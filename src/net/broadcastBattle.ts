/**
 * Same-browser battle room transport over BroadcastChannel: one tab hosts, any number of other tabs of
 * the same browser join (end-to-end tests, local debugging; enabled with `?transport=bc`). Messages are
 * addressed (host ↔ one guest tab), so guests never see each other's traffic.
 *
 * Note: tabs of one browser share localStorage, so each tab needs its own clientId (e.g. keep the
 * clientId in sessionStorage in bc mode, as the duel UI does).
 */
import { Emitter } from './emitter';
import { BaseMultiHost } from './hub';
import { generateBattleCode, isValidBattleCode } from './room';
import type { Transport, TransportError, TransportEvents, TransportRole } from './transport';

type Wire =
  | { k: 'dial'; id: string; clientId: string }
  | { k: 'accept'; to: string }
  | { k: 'reject'; to: string }
  | { k: 'msg'; from: string; to: string; data: unknown }
  | { k: 'bye'; from: string }
  | { k: 'hostUp' };

const HOST = 'host';
const channelName = (code: string) => `infweb-bcb-${code}`;
const tabId = () => Math.random().toString(36).slice(2);

export class BroadcastBattleHost extends BaseMultiHost {
  private ch: BroadcastChannel;
  private byClient = new Map<string, string>();
  private byTab = new Map<string, string>();
  private closed = false;
  private onPageHide = () => this.post({ k: 'bye', from: HOST });

  static create(_clientId: string, code = generateBattleCode()): BroadcastBattleHost {
    return new BroadcastBattleHost(code);
  }

  private constructor(public code: string) {
    super();
    this.ch = new BroadcastChannel(channelName(code));
    this.ch.onmessage = (e) => this.handle(e.data as Wire);
    if (typeof window !== 'undefined') window.addEventListener('pagehide', this.onPageHide);
    queueMicrotask(() => {
      if (this.closed) return;
      this.em.emit('ready', code);
      this.post({ k: 'hostUp' });
    });
  }

  get clients(): string[] {
    return [...this.byClient.keys()];
  }

  isOpen(clientId: string): boolean {
    return this.byClient.has(clientId);
  }

  send(clientId: string, msg: unknown): boolean {
    const tab = this.byClient.get(clientId);
    if (!tab || this.closed) return false;
    this.post({ k: 'msg', from: HOST, to: tab, data: JSON.parse(JSON.stringify(msg)) });
    return true;
  }

  kick(clientId: string): void {
    const tab = this.byClient.get(clientId);
    if (!tab) return;
    this.post({ k: 'reject', to: tab });
    this.remove(clientId);
  }

  close(): void {
    if (this.closed) return;
    this.post({ k: 'bye', from: HOST });
    this.closed = true;
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', this.onPageHide);
    this.ch.close();
  }

  private post(w: Wire) {
    if (!this.closed) this.ch.postMessage(w);
  }

  private remove(clientId: string) {
    const tab = this.byClient.get(clientId);
    if (!tab) return;
    this.byClient.delete(clientId);
    this.byTab.delete(tab);
    this.em.emit('leave', clientId);
  }

  private handle(w: Wire) {
    if (this.closed) return;
    if (w.k === 'dial') {
      if (this.byClient.has(w.clientId)) this.remove(w.clientId);
      this.byClient.set(w.clientId, w.id);
      this.byTab.set(w.id, w.clientId);
      this.post({ k: 'accept', to: w.id });
      this.em.emit('join', w.clientId);
    } else if (w.k === 'msg' && w.to === HOST) {
      const cid = this.byTab.get(w.from);
      if (cid) this.em.emit('message', cid, w.data);
    } else if (w.k === 'bye') {
      const cid = this.byTab.get(w.from);
      if (cid) this.remove(cid);
    }
  }
}

export class BroadcastBattleGuest implements Transport {
  readonly role: TransportRole = 'guest';
  isOpen = false;
  remoteClientId: string | null = HOST;
  private em = new Emitter<TransportEvents>();
  private ch: BroadcastChannel;
  private id = tabId();
  private closed = false;
  private everOpened = false;
  private dialTimer: ReturnType<typeof setTimeout> | null = null;
  private onPageHide = () => this.post({ k: 'bye', from: this.id });

  static join(code: string, clientId: string): BroadcastBattleGuest {
    return new BroadcastBattleGuest(code, clientId);
  }

  private constructor(
    public code: string | null,
    private clientId: string,
  ) {
    this.ch = new BroadcastChannel(channelName(code ?? ''));
    this.ch.onmessage = (e) => this.handle(e.data as Wire);
    if (typeof window !== 'undefined') window.addEventListener('pagehide', this.onPageHide);
    queueMicrotask(() => {
      if (!code || !isValidBattleCode(code)) {
        this.em.emit('error', { code: 'bad-code', message: 'invalid code', fatal: true });
        return;
      }
      this.em.emit('ready', code);
      this.dial(0);
    });
  }

  private dial(tries: number) {
    if (this.closed || this.isOpen) return;
    if (!this.everOpened && tries > 10) {
      this.em.emit('error', { code: 'bad-code', message: 'no such room', fatal: true });
      this.close();
      return;
    }
    this.post({ k: 'dial', id: this.id, clientId: this.clientId });
    if (this.dialTimer) clearTimeout(this.dialTimer);
    this.dialTimer = setTimeout(() => this.dial(tries + 1), this.everOpened ? 1000 : 300);
  }

  private post(w: Wire) {
    if (!this.closed) this.ch.postMessage(w);
  }

  private setOpen(open: boolean) {
    if (this.isOpen === open) return;
    this.isOpen = open;
    if (open) this.everOpened = true;
    this.em.emit(open ? 'open' : 'close');
  }

  private handle(w: Wire) {
    if (this.closed) return;
    if (w.k === 'accept' && w.to === this.id) {
      if (this.dialTimer) clearTimeout(this.dialTimer);
      this.dialTimer = null;
      if (this.isOpen) this.setOpen(false);
      this.setOpen(true);
    } else if (w.k === 'reject' && w.to === this.id) {
      this.setOpen(false);
    } else if (w.k === 'msg' && w.to === this.id) {
      if (this.isOpen) this.em.emit('message', w.data);
    } else if (w.k === 'bye' && w.from === HOST) {
      this.setOpen(false);
      this.dial(0);
    } else if (w.k === 'hostUp') {
      // a (reloaded) host is back: dial again
      this.setOpen(false);
      this.dial(0);
    }
  }

  send(msg: unknown): boolean {
    if (!this.isOpen || this.closed) return false;
    this.post({ k: 'msg', from: this.id, to: HOST, data: JSON.parse(JSON.stringify(msg)) });
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.post({ k: 'bye', from: this.id });
    this.closed = true;
    this.isOpen = false;
    if (this.dialTimer) clearTimeout(this.dialTimer);
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', this.onPageHide);
    this.ch.close();
  }

  onReady(cb: (code: string) => void) {
    return this.em.on('ready', cb);
  }
  onOpen(cb: () => void) {
    return this.em.on('open', cb);
  }
  onClose(cb: () => void) {
    return this.em.on('close', cb);
  }
  onMessage(cb: (msg: unknown) => void) {
    return this.em.on('message', cb);
  }
  onError(cb: (err: TransportError) => void) {
    return this.em.on('error', cb);
  }
}
