import { beforeEach, describe, expect, it } from 'vitest';
import { matchMedal, seatsMedal } from '../../src/medals';
import { awardMedal, loadMedals } from '../../src/storage';
import { buildScenario, SCENARIO_META, SCENARIOS, type ScenarioId } from '../../src/core/scenarios';
import type { MatchEnd, MatchState, PlayerType } from '../../src/core/types';

const mem = new Map<string, string>();
beforeEach(() => {
  mem.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  };
});

/** any scenario with a seat recommended below God, and one for three or more players */
const DUEL = SCENARIOS.find((id) => SCENARIO_META[id].players.length === 2 && SCENARIO_META[id].players[1] !== 'god')!;
const BATTLE = SCENARIOS.find((id) => SCENARIO_META[id].players.length >= 3 && SCENARIO_META[id].players.some((p) => p !== 'god' && p !== 'human'))!;

const won: MatchEnd = { winner: 0, humanWon: true, reason: 'elimination', turn: 12 };
const lost: MatchEnd = { winner: 1, humanWon: false, reason: 'elimination', turn: 12 };

function finished(id: ScenarioId, players: PlayerType[], end: MatchEnd | null = won, kind: MatchState['settings']['kind'] = 'single'): MatchState {
  const st = buildScenario(id, 7, undefined, players);
  st.settings = { ...st.settings, kind };
  st.ended = end;
  return st;
}

const rec = (id: ScenarioId) => [...SCENARIO_META[id].players];
const stronger = (p: PlayerType): PlayerType => (p === 'dummy' ? 'hunter' : p === 'hunter' ? 'master' : 'god');
const weaker = (p: PlayerType): PlayerType => (p === 'god' ? 'master' : p === 'master' ? 'hunter' : 'dummy');

describe('earning a scenario medal', () => {
  it('a win against the recommended line-up earns a medal', () => {
    expect(seatsMedal(DUEL, rec(DUEL))).toBe('medal');
    expect(matchMedal(finished(DUEL, rec(DUEL)))).toEqual({ id: DUEL, tier: 'medal' });
    expect(matchMedal(finished(BATTLE, rec(BATTLE)))).toEqual({ id: BATTLE, tier: 'medal' });
  });

  it('stronger bots earn a medal too; nothing but Gods earns gold', () => {
    const up = rec(BATTLE).map((p, i) => (i === 0 ? p : stronger(p)));
    expect(matchMedal(finished(BATTLE, up))?.tier).toBe(up.slice(1).every((p) => p === 'god') ? 'gold' : 'medal');
    const gods = rec(BATTLE).map((p, i) => (i === 0 ? p : 'god'));
    expect(matchMedal(finished(BATTLE, gods))).toEqual({ id: BATTLE, tier: 'gold' });
    expect(matchMedal(finished(DUEL, ['human', 'god']))).toEqual({ id: DUEL, tier: 'gold' });
  });

  it('a single weaker seat earns nothing', () => {
    for (let seat = 1; seat < rec(BATTLE).length; seat++) {
      const list = rec(BATTLE).map((p, i) => (i === 0 ? p : 'god' as PlayerType));
      list[seat] = weaker(rec(BATTLE)[seat]);
      expect(seatsMedal(BATTLE, list)).toBe('weaker');
      expect(matchMedal(finished(BATTLE, list))).toBeNull();
    }
    expect(matchMedal(finished(DUEL, ['human', 'dummy']))).toBeNull();
  });

  it('other people at the table (hot seat or online) earn nothing', () => {
    expect(seatsMedal(DUEL, ['human', 'human'])).toBe('people');
    expect(matchMedal(finished(DUEL, ['human', 'human']))).toBeNull();
    const online = rec(BATTLE);
    online[1] = 'online';
    expect(seatsMedal(BATTLE, online)).toBe('people');
    expect(matchMedal(finished(BATTLE, online, won, 'battleOnline'))).toBeNull();
    // a guest's view of an online battle: the host is a remote person
    const guest = rec(DUEL);
    guest[0] = 'remote';
    guest[1] = 'human';
    expect(matchMedal(finished(DUEL, guest, { ...won, winner: 1 }, 'battleOnline'))).toBeNull();
  });

  it('a defeat or an unfinished match earns nothing', () => {
    expect(matchMedal(finished(DUEL, rec(DUEL), lost))).toBeNull();
    expect(matchMedal(finished(DUEL, rec(DUEL), { winner: -1, humanWon: false, reason: 'early', turn: 30 }))).toBeNull();
    expect(matchMedal(finished(DUEL, rec(DUEL), null))).toBeNull();
    // an early finish in your favour is a win
    expect(matchMedal(finished(DUEL, rec(DUEL), { winner: 0, humanWon: true, reason: 'early', turn: 30 }))?.tier).toBe('medal');
  });

  it('the map of the day playing a scenario counts', () => {
    const st = finished(DUEL, rec(DUEL), won, 'daily');
    st.settings.dailyId = '2026-10-23';
    expect(matchMedal(st)).toEqual({ id: DUEL, tier: 'medal' });
  });

  it('ordinary maps earn nothing', () => {
    const st = finished(DUEL, rec(DUEL));
    delete st.settings.puzzle;
    expect(matchMedal(st)).toBeNull();
    st.settings.puzzle = 'retired-scenario';
    expect(matchMedal(st)).toBeNull();
  });
});

describe('medal storage', () => {
  it('stores versioned medals; a gold replaces a medal, never the reverse', () => {
    expect(loadMedals()).toEqual({});
    expect(awardMedal(DUEL, 'medal', 100)).toBe('medal');
    expect(JSON.parse(mem.get('infweb.medals')!)).toEqual({ v: 1, medals: { [DUEL]: { tier: 'medal', at: 100 } } });
    // the same medal again changes nothing (the first date stays)
    expect(awardMedal(DUEL, 'medal', 200)).toBeNull();
    expect(loadMedals()[DUEL]).toEqual({ tier: 'medal', at: 100 });
    expect(awardMedal(DUEL, 'gold', 300)).toBe('gold');
    expect(awardMedal(DUEL, 'medal', 400)).toBeNull();
    expect(awardMedal(DUEL, 'gold', 500)).toBeNull();
    expect(loadMedals()[DUEL]).toEqual({ tier: 'gold', at: 300 });
    expect(awardMedal(BATTLE, 'gold', 600)).toBe('gold');
    expect(Object.keys(loadMedals()).sort()).toEqual([DUEL, BATTLE].sort());
  });

  it('ignores garbage and scenarios that are not offered', () => {
    for (const raw of ['{oops', 'null', '42', '[]', '{"v":2,"medals":{}}', `{"v":1,"medals":[]}`, `{"v":1}`]) {
      mem.set('infweb.medals', raw);
      expect(loadMedals()).toEqual({});
    }
    mem.set(
      'infweb.medals',
      JSON.stringify({
        v: 1,
        medals: {
          [DUEL]: { tier: 'medal', at: 5 },
          [BATTLE]: { tier: 'platinum', at: 5 },
          gone: { tier: 'gold', at: 5 },
          __proto__x: 'junk',
          siegeX: null,
        },
      }),
    );
    expect(loadMedals()).toEqual({ [DUEL]: { tier: 'medal', at: 5 } });
    mem.set('infweb.medals', JSON.stringify({ v: 1, medals: { [DUEL]: { tier: 'gold', at: 'yesterday' } } }));
    expect(loadMedals()).toEqual({});
    // a broken file does not stop a new medal from being saved
    mem.set('infweb.medals', '{oops');
    expect(awardMedal(DUEL, 'medal', 9)).toBe('medal');
    expect(loadMedals()).toEqual({ [DUEL]: { tier: 'medal', at: 9 } });
  });

  it('keeps a retired scenario on file (it may come back) but does not count it', () => {
    mem.set('infweb.medals', JSON.stringify({ v: 1, medals: { gone: { tier: 'gold', at: 1 } } }));
    awardMedal(DUEL, 'medal', 2);
    expect(JSON.parse(mem.get('infweb.medals')!).medals.gone).toEqual({ tier: 'gold', at: 1 });
    expect(Object.keys(loadMedals())).toEqual([DUEL]);
  });

  it('survives storage that throws', () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {},
    };
    expect(loadMedals()).toEqual({});
    expect(() => awardMedal(DUEL, 'medal')).not.toThrow();
  });
});
