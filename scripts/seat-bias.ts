/**
 * Turn-order bias: identical bots in every seat, so any difference between the seats is the order in
 * which they move (seat 0 first). Deterministic (fixed-budget bots, seeds from the game index), one
 * JSON line per game on stdout. A run can be a grid (several seat counts, sizes, map kinds and order
 * compensations) split over processes with shard / shards.
 *
 * Usage: npx vite-node scripts/seat-bias.ts -- [key=value ...]
 *   mode=battle|landing|scenario   battle: an ordinary generated map; landing: the night drop;
 *                         scenario: the scenario named by scenario= with its own seats (ns = its seat count)
 *   bot=hunter            the bot in every seat (hunter | duelHunter | master | god | dummy | freak)
 *   star=                 optional: one seat (rotating with the game index) played by this bot instead
 *   ns=4                  seat counts (battle: 2..6; landing: 3..6), comma separated
 *   sizes=M               map sizes, comma separated
 *   syms=0                symmetric maps (battle): 0, 1 or 0,1
 *   duel=0|1              duel rules (2 players)
 *   games=100 offset=0    game indices offset .. offset+games-1 for every grid point
 *   shard=0 shards=1      this process plays the grid units u with u % shards == shard
 *   block=0|1             1: shard s plays games offset + [s, s+1) * games / shards of every grid point
 *   mp=200 gr=200         Master playouts / GOD rollouts per decision
 *   comps=[...]           order compensations to compare: a JSON array (or an object by seat count
 *                         of arrays); items 'off' (none), 'default' (what the game does) or an
 *                         OrderComp, optionally with an "id"
 *   even=1                landing: your squad is like the others (no knob); 0: seat 0 gets the knob
 *   knob=                 landing: knob for seat 0 when even=0 (missing: the scenario's)
 *   maxRounds=200 tag=    round cap; a free label echoed in every line
 */
import { runMatch } from '../src/ai/arena';
import { createBot } from '../src/ai';
import { cellCount, createMatch } from '../src/core/engine';
import { buildScenario, type ScenarioId } from '../src/core/scenarios';
import type { BotType, FieldSize, MatchSettings, MatchState, OrderComp } from '../src/core/types';

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const i = a.indexOf('=');
  if (i > 0) args.set(a.slice(0, i), a.slice(i + 1));
}
const get = (k: string, d: string) => args.get(k) ?? d;
const mode = get('mode', 'battle');
const bot = get('bot', 'hunter') as BotType;
const star = (args.get('star') || '') as BotType | '';
const list = (k: string, d: string) => get(k, d).split(',').filter(Boolean);
const ns = list('ns', get('players', '4')).map(Number);
const sizes = list('sizes', get('size', 'M')) as FieldSize[];
const syms = list('syms', get('sym', '0')).map((v) => v === '1');
const duel = get('duel', '0') === '1';
const games = Number(get('games', '100'));
const offset = Number(get('offset', '0'));
const shard = Number(get('shard', '0'));
const shards = Number(get('shards', '1'));
const mp = Number(get('mp', '200'));
const gr = Number(get('gr', '200'));
type CompItem = 'off' | 'default' | (OrderComp & { id?: string });
const compsRaw = JSON.parse(get('comps', '["default"]')) as CompItem[] | Record<string, CompItem[]>;
const compsFor = (n: number): CompItem[] => (Array.isArray(compsRaw) ? compsRaw : (compsRaw[String(n)] ?? []));
const even = get('even', '1') === '1';
const knob = args.has('knob') ? Number(args.get('knob')) : undefined;
const maxRounds = Number(get('maxRounds', '200'));
const tag = get('tag', '');
const scenario = get('scenario', 'olympus') as ScenarioId;

function compOf(item: CompItem): { id: string; comp: OrderComp | 'off' | undefined } {
  if (item === 'off' || item === 'default') return { id: item, comp: item === 'off' ? 'off' : undefined };
  const { id, ...comp } = item;
  return { id: id ?? JSON.stringify(comp), comp };
}

/** places 1..n: the winner / the survivors by cells, then the eliminated, later out = better (ties share) */
function places(st: MatchState): number[] {
  const seats = st.settings.players.map((_, i) => i);
  const alive = seats.filter((p) => st.outAt[p] < 0 && cellCount(st, p) > 0);
  const out = seats.filter((p) => !alive.includes(p));
  const score = (p: number) => (alive.includes(p) ? 1e6 + cellCount(st, p) : st.outAt[p]);
  const res = new Array(seats.length).fill(0);
  const sorted = [...alive, ...out].sort((a, b) => score(b) - score(a));
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && score(sorted[j + 1]) === score(sorted[i])) j++;
    for (let k = i; k <= j; k++) res[sorted[k]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return res;
}

interface Unit {
  n: number;
  size: FieldSize;
  sym: boolean;
  item: CompItem;
  g: number;
}
const units: Unit[] = [];
for (let gi = 0; gi < games; gi++)
  for (const n of ns)
    for (const size of sizes)
      for (const sym of mode === 'battle' ? syms : [false]) for (const item of compsFor(n)) units.push({ n, size, sym, item, g: gi + offset });

// block=1: shard s plays a block of game indices over the whole grid (every grid point fills up evenly
// even when the shards run one after another); otherwise the units are dealt out round-robin
const mine =
  get('block', '0') === '1'
    ? units.filter((x) => Math.floor(((x.g - offset) * shards) / games) === shard)
    : units.filter((_, u) => u % shards === shard);
for (const { n, size, sym, item, g } of mine) {
  const { id: compId, comp } = compOf(item);
  const seed = 7_000_003 + g * 7919;
  const starSeat = star ? g % n : -1;
  const types: BotType[] = Array.from({ length: n }, (_, i) => (i === starSeat ? (star as BotType) : bot));
  let state: MatchState;
  if (mode === 'landing') {
    state = buildScenario('landing', seed, knob, types, { size, even, ...(comp !== undefined ? { orderComp: comp } : {}) });
  } else if (mode === 'scenario') {
    // another scenario with its own seats (seat 0 is the person's seat, with the knob), the same bot everywhere
    state = buildScenario(scenario, seed, knob, types);
  } else {
    const settings: MatchSettings = {
      kind: duel ? 'duelTraining' : 'single',
      size,
      players: types,
      darkness: false,
      symmetry: sym,
      crowded: false,
      unions: false,
      shuffle: false,
      duelRules: duel,
      ...(comp !== undefined ? { orderComp: comp } : {}),
    };
    state = createMatch(settings, { seed });
  }
  const bots = types.map((t, i) =>
    createBot(t, { seed: (seed * 31 + i * 101) >>> 0, master: { sync: true, playouts: mp }, god: { sync: true, rollouts: gr } }),
  );
  const t0 = performance.now();
  const r = await runMatch(state.settings, { seed, bots, state, maxRounds });
  bots.forEach((b) => b.dispose?.());
  const st = r.state;
  const start = state.settings.players.map((_, p) => state.field.cells.filter((c) => c.owner === p).reduce((a, c) => a + c.power, 0));
  console.log(
    JSON.stringify({
      tag,
      mode,
      bot,
      ...(star ? { star, starSeat } : {}),
      ...(mode === 'scenario' ? { scenario } : {}),
      n,
      size,
      sym,
      duel,
      comp: compId,
      g,
      winner: r.winner,
      capped: r.capped,
      rounds: r.rounds,
      place: places(st),
      outAt: st.outAt,
      cells: st.settings.players.map((_, p) => cellCount(st, p)),
      start,
      ms: Math.round(performance.now() - t0),
    }),
  );
}
