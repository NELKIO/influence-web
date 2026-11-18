import { describe, expect, it } from 'vitest';
import * as E from '../../src/core/engine';
import { battleHash } from '../../src/net/battleProtocol';
import { stateHash } from '../../src/net/protocol';
import { battleSettings, makeRoom, reloadGuest, send } from './battleHelpers';
import { makeDuo } from './netHelpers';

// Linear passages: source 0 sees 1 normally, 2 by fire, never 3. Rival starts at 6.
function board() {
  const settings = { ...battleSettings({ players: ['human', 'human'], darkness: true }), signalFires: true, blind: true };
  const cells = Array.from({ length: 7 }, (_, i) => ({ id: i, x: i, y: 0, owner: i === 0 ? 0 : i === 6 ? 1 : -1, power: 1, maxPower: 8 }));
  return E.createMatch(settings, { seed: 1, keepPlacement: true, field: {
    size: 'S', w: 7, h: 1, cells, starts: [0, 6], walls: [], adj: cells.map((_, i) => [i - 1, i + 1].filter(j => j >= 0 && j < cells.length)),
  } });
}

describe('signal fires', () => {
  it('reveals two passages to the owner, only the source to rivals; memory is per seat', () => {
    const s = board();
    const old = structuredClone(s);
    expect(E.lightSignalFire(s, 6)).toBe(false);
    expect(E.lightSignalFire(s, 0)).toBe(true);
    expect(E.lightSignalFire(s, 0)).toBe(false);
    expect([...E.visibleCells(s, 0)]).toEqual([1,1,1,0,0,0,0]);
    expect([...E.visibleCells(s, 1)]).toEqual([1,0,0,0,0,1,1]);
    expect(battleHash(s)).not.toBe(battleHash(old));
    expect(stateHash(s)).not.toBe(stateHash(old));
    const saved = JSON.parse(JSON.stringify(s));
    expect(E.lightSignalFire(saved, 0)).toBe(false);
    E.finishTurn(saved);
    expect(E.lightSignalFire(saved, 6)).toBe(true);
    E.finishTurn(saved);
    expect([...E.visibleCells(saved, 0)]).toEqual([1,1,0,0,0,0,1]);
    expect([...E.visibleCells(saved, 1)]).toEqual([0,0,0,0,1,1,1]);
    expect([...E.exploredCells(saved, 0)!]).toEqual([1,1,1,0,0,0,1]);
    expect([...E.exploredCells(saved, 1)!]).toEqual([1,0,0,0,1,1,1]);
  });
  it('expires when the owner actually starts a turn, including consecutive turns', () => {
    const s = board();
    s.settings.orderComp = { order: 'snake' };
    E.finishTurn(s);
    E.endAttack(s);
    expect(E.lightSignalFire(s, 6)).toBe(true);
    E.finishTurn(s);
    expect(s.current).toBe(1);
    expect(E.visibleCells(s, 0)[6]).toBe(0);
    expect(E.lightSignalFire(s, 6)).toBe(true);
  });
  it('requires both settings and a live match; clears eliminated sources', () => {
    const s = board();
    s.settings.darkness = false;
    expect(E.lightSignalFire(s, 0)).toBe(false);
    s.settings.darkness = true;
    delete s.settings.signalFires;
    expect(E.lightSignalFire(s, 0)).toBe(false);
    s.settings.signalFires = true;
    E.lightSignalFire(s, 0);
    E.finishTurn(s);
    s.field.cells[1].owner = 1;
    s.field.cells[1].power = 4;
    E.attack(s, 1, 0, { win: true });
    expect(s.signalFireCells?.[0] ?? -1).toBe(-1);
    expect(E.lightSignalFire(s, 6)).toBe(false);
  });
  it('replicates a guest request and restores the spent fire after rejoin', async () => {
    const r = await makeRoom({ players: ['human', 'online'], darkness: true, signalFires: true });
    r.host.start();
    await r.hub.flush();
    r.host.act(0, { t: 'endTurn' });
    await r.hub.flush();
    const { g, cid } = r.guests[0];
    const req = { t: 'signalFire' as const, cell: E.cellsOf(g.state!, g.seat)[0] };
    expect((await send(r, g, req))?.ok).toBe(true);
    expect(r.host.state!.signalFireCells?.[g.seat]).toBe(req.cell);
    const resumed = reloadGuest(r, cid).g;
    await r.hub.flush();
    expect((await send(r, resumed, req))?.ok).toBe(false);
    expect(battleHash(resumed.state!)).toBe(battleHash(r.host.state!));
    expect(r.resyncs).toEqual([]);
    resumed.dispose(); r.host.dispose();
  });
  it('rejects a fire that was lost and retried after the seat’s turn ended', async () => {
    const r = await makeRoom({ players: ['human', 'online'], darkness: true, signalFires: true });
    const { g, cid } = r.guests[0];
    try {
      expect(r.host.start()).toBe(true);
      expect(r.host.act(0, { t: 'endTurn' }).ok).toBe(true);
      await r.hub.flush();
      const cell = E.cellsOf(g.state!, g.seat)[0];
      r.hub.dropNext(cid, 'host');
      const pending = g.request({ t: 'signalFire', cell });
      await r.hub.flush();
      expect(r.host.state!.signalFireCells?.[g.seat] ?? -1).toBe(-1);
      r.hub.disconnect(cid);
      expect(r.host.act(g.seat, { t: 'endTurn' }).ok).toBe(true);
      expect(r.host.act(0, { t: 'endTurn' }).ok).toBe(true);
      expect(r.host.state!.turn).toBe(1);
      r.hub.connect(cid);
      await r.hub.flush();
      expect(await pending).toMatchObject({ ok: false, reason: 'notYourTurn' });
      expect(r.host.state!.signalFireCells?.[g.seat] ?? -1).toBe(-1);
      expect((await send(r, g, { t: 'signalFire', cell }))?.ok).toBe(true);
      expect(battleHash(g.state!)).toBe(battleHash(r.host.state!));
    } finally {
      g.dispose(); r.host.dispose();
    }
  });

  it('streams the separate duel action and expires it identically on both devices', async () => {
    const { host, guest, link, resyncs } = await makeDuo({ darkness: true, signalFires: true });
    const cell = E.cellsOf(host.state!, 0)[0];
    expect(guest.lightSignalFire(cell)).toBe(false);
    expect(host.lightSignalFire(cell)).toBe(true);
    await link.flush();
    expect(guest.state!.signalFireCells?.[0]).toBe(cell);
    host.endTurn(); await link.flush(); guest.endTurn(); await link.flush();
    expect(guest.state!.signalFireCells?.[0] ?? -1).toBe(-1);
    expect(stateHash(guest.state!)).toBe(stateHash(host.state!));
    expect(resyncs).toEqual([]);
    guest.dispose(); host.dispose();
  });
});
