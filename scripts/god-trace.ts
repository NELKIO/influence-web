/**
 * Trace one match of scripts/god-strength.ts (same seeds and seats): cells and power of both seats at the
 * start of every turn. Usage: npx vite-node scripts/god-trace.ts -- offset=1032 a=god b=master [gr=0 mp=0 speed=200]
 */
import { runMatch } from '../src/ai/arena';
import { createBot } from '../src/ai';
import type { Bot } from '../src/ai/types';
import type { BotType, FieldSize, MatchSettings } from '../src/core/types';
import { cellCount, scoreOf } from '../src/core/engine';

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const i = a.indexOf('=');
  if (i > 0) args.set(a.slice(0, i), a.slice(i + 1));
}
const get = (k: string, d: string) => args.get(k) ?? d;
const g = Number(get('offset', '1032'));
const A = get('a', 'god') as BotType;
const B = get('b', 'master') as BotType;
const gr = Number(get('gr', '0'));
const mp = Number(get('mp', '0'));
const speed = Number(get('speed', '200'));
const sizes = ['M', 'L', 'XL'] as FieldSize[];
const size = sizes[g % 3];
const symmetry = Math.floor(g / 3) % 2 === 1;
const swap = Math.floor(g / 6) % 2 === 1 ? g % 2 === 0 : g % 2 === 1;
const types: BotType[] = swap ? [B, A] : [A, B];
const aSeat = swap ? 1 : 0;
const settings: MatchSettings = { kind: 'single', size, players: types, darkness: false, symmetry, crowded: false, unions: false, shuffle: false, duelRules: false };
const log: string[] = [];
const bots: Bot[] = types.map((t, i) => {
  const bot = createBot(t, { seed: 1000 + g * 13 + i, master: { sync: true, playouts: mp > 0 ? mp : undefined }, god: { sync: true, rollouts: gr > 0 ? gr : undefined } });
  return {
    type: bot.type,
    nextAttack: (s, c) => bot.nextAttack(s, c),
    async placePower(s, c) {
      log.push(`r${s.turn} s${s.current}: ${cellCount(s, 0)}/${scoreOf(s, 0)} vs ${cellCount(s, 1)}/${scoreOf(s, 1)} +${s.powerLeft}`);
      return bot.placePower(s, c);
    },
  };
});
const r = await runMatch(settings, { seed: 5000 + g, bots, maxRounds: 200, ctx: { speedMs: speed } });
console.log(`offset ${g} ${size}${symmetry ? 's' : ''} seats ${types.join(',')} (A=${A} at seat ${aSeat}) winner seat ${r.winner} (${types[r.winner]}) after ${r.rounds} rounds`);
console.log(log.slice(0, 10).join('\n'));
