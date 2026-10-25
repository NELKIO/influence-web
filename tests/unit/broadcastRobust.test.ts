import { afterEach, describe, expect, it, vi } from 'vitest';
import { BroadcastTransport } from '../../src/net/broadcast';
import type { TransportError } from '../../src/net/transport';

// The duel test transport (?transport=bc) must not be confused by a third tab, and duel guests must
// find a reloaded host again.

const opened: { close(): void }[] = [];
const track = <T extends { close(): void }>(t: T): T => (opened.push(t), t);
afterEach(() => {
  for (const t of opened.splice(0)) t.close();
  vi.useRealTimers();
});

let n = 0;
const code4 = () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[n++ % 32] + 'K' + 'M' + 'N';

function events(t: BroadcastTransport) {
  const log = { open: 0, close: 0, msgs: [] as unknown[], errors: [] as TransportError[] };
  t.onOpen(() => log.open++);
  t.onClose(() => log.close++);
  t.onMessage((m) => log.msgs.push(m));
  t.onError((e) => log.errors.push(e));
  return log;
}

const settle = () => new Promise((r) => setTimeout(r, 60));

describe('BroadcastTransport robustness', () => {
  it("a third tab's rejected join and its bye do not disconnect the real guest", async () => {
    const code = code4();
    const host = track(BroadcastTransport.host('host', code));
    const h = events(host);
    const guest = track(BroadcastTransport.join(code, 'me'));
    const g = events(guest);
    await vi.waitFor(() => expect(host.isOpen && guest.isOpen).toBe(true));

    const other = track(BroadcastTransport.join(code, 'stranger'));
    const o = events(other);
    await vi.waitFor(() => expect(o.errors.map((e) => e.code)).toEqual(['room-full']));
    other.close(); // its bye goes out on the shared channel
    await settle();
    expect(host.isOpen).toBe(true);
    expect(guest.isOpen).toBe(true);
    expect(h.close).toBe(0);
    expect(g.close).toBe(0);

    // the host's messages reach the real guest only; the stranger's never reach the host
    host.send('to-guest');
    await vi.waitFor(() => expect(g.msgs).toEqual(['to-guest']));
    expect(o.msgs).toEqual([]);
    expect(h.msgs).toEqual([]);
  });

  it('a tab that is still dialling does not hear the host talking to another guest', async () => {
    const code = code4();
    const host = track(BroadcastTransport.host('host', code));
    const guest = track(BroadcastTransport.join(code, 'me'));
    await vi.waitFor(() => expect(guest.isOpen).toBe(true));
    const other = track(BroadcastTransport.join(code, 'stranger'));
    const o = events(other);
    host.send({ secret: 1 });
    await settle();
    expect(o.msgs).toEqual([]);
  });

  it('after a host reload (bye on pagehide, hostUp on start) the guest dials again and reconnects', { timeout: 10_000 }, async () => {
    const code = code4();
    const host = BroadcastTransport.host('host', code);
    const guest = track(BroadcastTransport.join(code, 'me'));
    const g = events(guest);
    await vi.waitFor(() => expect(guest.isOpen).toBe(true));
    host.close(); // the page goes away
    await vi.waitFor(() => expect(guest.isOpen).toBe(false));
    expect(g.close).toBe(1);
    // nobody hosts for longer than the first-dial retries last: a once-connected guest keeps waiting
    await new Promise((r) => setTimeout(r, 3500));
    expect(g.errors).toEqual([]);
    const again = track(BroadcastTransport.host('host', code));
    const h2 = events(again);
    await vi.waitFor(() => expect(guest.isOpen && again.isOpen).toBe(true), { timeout: 3000 });
    expect(g.open).toBe(2);
    expect(again.remoteClientId).toBe('me');
    guest.send('back');
    await vi.waitFor(() => expect(h2.msgs).toEqual(['back']));
  });
});
