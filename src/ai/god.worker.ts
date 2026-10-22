/// <reference lib="webworker" />
import { GodBrain } from './god';
import type { GodRequest, GodResponse } from './godProtocol';

let brain: GodBrain | null = null;
let ponderToken = 0;

/** Search ahead in small slices while the UI animates the last move; any new request stops it. */
function startPonder() {
  const token = ++ponderToken;
  const step = () => {
    if (token !== ponderToken || !brain) return;
    if (brain.ponder(15)) setTimeout(step, 0);
  };
  setTimeout(step, 0);
}

const post = (msg: GodResponse) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);

self.onmessage = (e: MessageEvent<GodRequest>) => {
  const req = e.data;
  ponderToken++;
  try {
    if (req.kind === 'init') {
      brain = new GodBrain(req.seed, req.options);
      post({ id: req.id, kind: 'init' });
      return;
    }
    brain ??= new GodBrain();
    if (req.kind === 'attack') {
      const move = brain.decideAttack(req.state, req.ctx);
      post({ id: req.id, kind: 'attack', move, rollouts: brain.lastInfo.rollouts, ms: brain.lastInfo.ms });
      if (move) startPonder();
    } else {
      const placement = [...brain.decidePower(req.state, req.ctx)];
      post({ id: req.id, kind: 'power', placement, rollouts: brain.lastInfo.rollouts, ms: brain.lastInfo.ms });
    }
  } catch (err) {
    post({ id: req.id, kind: 'error', message: String((err as Error)?.stack ?? err) });
  }
};
