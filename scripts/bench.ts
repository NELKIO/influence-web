/** Master throughput: plays Master vs Hunter matches with the real time budgets, logs runs/ms per decision. */
import { MasterBot } from '../src/ai/masterBot';
import { HunterBot } from '../src/ai/hunter';
import { addPower, attack, createMatch, endAttack, finishTurn } from '../src/core/engine';
import type { FieldSize } from '../src/core/types';

const speedMs = Number(process.argv[2] ?? 400);
for (const size of (process.argv[3] ?? 'S,M,L,XL,XXL').split(',') as FieldSize[]) {
  for (const n of [2, 4]) {
    const players = n === 2 ? ['master', 'hunter'] : ['master', 'hunter', 'hunter', 'hunter'];
    const st = createMatch({ kind: 'single', size, players: players as any, darkness: false, symmetry: false, crowded: false, unions: false, shuffle: false, duelRules: false }, { seed: 3 });
    const master = new MasterBot({ seed: 1, sync: true });
    const bots = players.map((p, i) => (i === 0 ? master : new HunterBot(i)));
    const att: number[][] = [];
    const pow: number[][] = [];
    let maxMs = 0;
    while (!st.ended && st.turn < 12) {
      const b = bots[st.current];
      for (;;) {
        const mv = await b.nextAttack(st, { speedMs });
        if (b === master) { att.push([master.lastInfo.runs, master.lastInfo.ms]); maxMs = Math.max(maxMs, master.lastInfo.ms); }
        if (!mv) break;
        attack(st, mv.from, mv.to);
        if (st.ended && st.ended.winner === -1) st.ended = null;
        if (st.ended) break;
      }
      if (st.ended) break;
      endAttack(st);
      const pl = await b.placePower(st, { speedMs });
      if (b === master) { pow.push([master.lastInfo.runs, master.lastInfo.ms]); maxMs = Math.max(maxMs, master.lastInfo.ms); }
      for (const [c, k] of pl) addPower(st, c, k);
      finishTurn(st);
    }
    const searched = att.filter(([r]) => r > 0);
    const rate = (xs: number[][]) => { const r = xs.reduce((s, x) => s + x[0], 0); const m = xs.reduce((s, x) => s + x[1], 0); return m ? Math.round((r / m) * 1000) : 0; };
    console.log(`${size} ${n}p: attack decisions ${att.length} (searched ${searched.length}, ${rate(searched)} playouts/s, avg runs ${Math.round(searched.reduce((s, x) => s + x[0], 0) / Math.max(1, searched.length))}); power ${pow.length} (${rate(pow)} playouts/s, avg runs ${Math.round(pow.reduce((s, x) => s + x[0], 0) / Math.max(1, pow.length))}, avg ms ${Math.round(pow.reduce((s, x) => s + x[1], 0) / Math.max(1, pow.length))}); max decision ${Math.round(maxMs)} ms; turn ${st.turn}`);
  }
}
