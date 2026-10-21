/**
 * Same-browser transport over BroadcastChannel: two tabs of one browser act as host and guest.
 * Used by end-to-end tests (the WebRTC path needs a real network) and handy for local debugging;
 * enabled with `?transport=bc` in the page URL.
 */
import { Emitter } from './emitter';
import { generateCode, isValidCode } from './room';
import type { Transport, TransportEvents, TransportRole, TransportError } from './transport';

type Wire =
  | { k: 'dial'; id: string; clientId: string }
  | { k: 'accept'; to: string; clientId: string }
  | { k: 'reject'; to: string }
  | { k: 'msg'; from: TransportRole; data: unknown }
  | { k: 'bye'; from: TransportRole };

export class BroadcastTransport implements Transport {
  private em = new Emitter<TransportEvents>();
  private ch: BroadcastChannel;
  private id = Math.random().toString(36).slice(2);
  private closed = false;
  isOpen = false;
  remoteClientId: string | null = null;

  private constructor(
    readonly role: TransportRole,
    public code: string | null,
    private clientId: string,
  ) {
    this.ch = new BroadcastChannel(`infweb-bc-${code}`);
    this.ch.onmessage = (e) => this.handle(e.data as Wire);
  }

  static host(clientId: string, code = generateCode()): BroadcastTransport {
    const t = new BroadcastTransport('host', code, clientId);
    queueMicrotask(() => t.em.emit('ready', code));
    return t;
  }

  static join(code: string, clientId: string): BroadcastTransport {
    const t = new BroadcastTransport('guest', code, clientId);
    if (!isValidCode(code)) {
      queueMicrotask(() => t.fail({ code: 'bad-code', message: 'invalid code', fatal: true }));
      return t;
    }
    queueMicrotask(() => {
      t.em.emit('ready', code);
      t.dial();
    });
    return t;
  }

  private dial() {
    if (this.closed || this.isOpen) return;
    this.post({ k: 'dial', id: this.id, clientId: this.clientId });
    // no host answered: keep retrying a few times, then report a bad code
    let tries = 0;
    const retry = () => {
      if (this.closed || this.isOpen) return;
      if (++tries > 10) return this.fail({ code: 'bad-code', message: 'no such room', fatal: true });
      this.post({ k: 'dial', id: this.id, clientId: this.clientId });
      setTimeout(retry, 300);
    };
    setTimeout(retry, 300);
  }

  private fail(err: TransportError) {
    this.em.emit('error', err);
  }

  private post(w: Wire) {
    if (!this.closed) this.ch.postMessage(w);
  }

  private setOpen(open: boolean) {
    if (this.isOpen === open) return;
    this.isOpen = open;
    this.em.emit(open ? 'open' : 'close');
  }

  private handle(w: Wire) {
    if (this.closed) return;
    if (this.role === 'host') {
      if (w.k === 'dial') {
        if (this.remoteClientId && this.remoteClientId !== w.clientId) {
          this.post({ k: 'reject', to: w.id });
          return;
        }
        this.remoteClientId = w.clientId;
        this.post({ k: 'accept', to: w.id, clientId: this.clientId });
        if (this.isOpen) this.setOpen(false);
        this.setOpen(true);
      } else if (w.k === 'msg' && w.from === 'guest') {
        this.em.emit('message', w.data);
      } else if (w.k === 'bye' && w.from === 'guest') {
        this.setOpen(false);
      }
    } else {
      if (w.k === 'accept' && w.to === this.id) {
        this.remoteClientId = w.clientId;
        this.setOpen(true);
      } else if (w.k === 'reject' && w.to === this.id) {
        this.fail({ code: 'room-full', message: 'room full', fatal: true });
      } else if (w.k === 'msg' && w.from === 'host') {
        this.em.emit('message', w.data);
      } else if (w.k === 'bye' && w.from === 'host') {
        this.setOpen(false);
      }
    }
  }

  send(msg: unknown): boolean {
    if (!this.isOpen || this.closed) return false;
    this.post({ k: 'msg', from: this.role, data: JSON.parse(JSON.stringify(msg)) });
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.post({ k: 'bye', from: this.role });
    this.closed = true;
    this.isOpen = false;
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

export function useBroadcastTransport(): boolean {
  return typeof location !== 'undefined' && new URLSearchParams(location.search).get('transport') === 'bc';
}
