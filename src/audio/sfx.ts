/** Tiny WebAudio synthesiser for UI and game sounds (no audio files needed). */
let ctx: AudioContext | null = null;
let enabled = true;

export function setSoundEnabled(on: boolean) {
  enabled = on;
}

function ac(): AudioContext | null {
  if (!enabled) return null;
  if (!ctx) {
    const C = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
      .AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!C) return null;
    ctx = new C();
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

/** Call from the first user gesture so iOS unlocks audio. */
export function unlockAudio() {
  const c = ac();
  if (!c) return;
  const b = c.createBuffer(1, 1, 22050);
  const s = c.createBufferSource();
  s.buffer = b;
  s.connect(c.destination);
  s.start(0);
}

function tone(freq: number, dur: number, opts: { type?: OscillatorType; vol?: number; slide?: number; delay?: number } = {}) {
  const c = ac();
  if (!c) return;
  const t0 = c.currentTime + (opts.delay ?? 0);
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = opts.type ?? 'sine';
  o.frequency.setValueAtTime(freq, t0);
  if (opts.slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * opts.slide), t0 + dur);
  const v = opts.vol ?? 0.15;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(v, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(c.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}

function noise(dur: number, vol = 0.1, freq = 1200) {
  const c = ac();
  if (!c) return;
  const len = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const s = c.createBufferSource();
  s.buffer = buf;
  const f = c.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = freq;
  const g = c.createGain();
  g.gain.value = vol;
  s.connect(f).connect(g).connect(c.destination);
  s.start();
}

export const sfx = {
  click: () => tone(660, 0.06, { type: 'triangle', vol: 0.08 }),
  select: () => tone(520, 0.07, { type: 'sine', vol: 0.1, slide: 1.3 }),
  capture: () => {
    tone(440, 0.12, { type: 'triangle', vol: 0.14, slide: 1.6 });
    tone(880, 0.14, { type: 'sine', vol: 0.08, delay: 0.05 });
  },
  fail: () => {
    tone(180, 0.22, { type: 'sawtooth', vol: 0.07, slide: 0.6 });
    noise(0.12, 0.06, 400);
  },
  power: () => tone(980, 0.05, { type: 'sine', vol: 0.05, slide: 1.2 }),
  fill: () => tone(740, 0.12, { type: 'sine', vol: 0.08, slide: 1.8 }),
  phase: () => tone(330, 0.12, { type: 'triangle', vol: 0.08, slide: 1.5 }),
  turn: () => {
    tone(523, 0.1, { type: 'triangle', vol: 0.1 });
    tone(784, 0.16, { type: 'triangle', vol: 0.1, delay: 0.09 });
  },
  eliminated: () => {
    noise(0.35, 0.12, 300);
    tone(120, 0.4, { type: 'sawtooth', vol: 0.08, slide: 0.5 });
  },
  win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.25, { type: 'triangle', vol: 0.12, delay: i * 0.11 })),
  lose: () => [392, 330, 262, 196].forEach((f, i) => tone(f, 0.3, { type: 'sine', vol: 0.12, delay: i * 0.14 })),
  versus: () => {
    noise(0.4, 0.15, 900);
    tone(90, 0.5, { type: 'square', vol: 0.06, slide: 0.7 });
  },
};

let vibrate = true;
export function setVibration(on: boolean) {
  vibrate = on;
}
export function buzz(ms: number | number[] = 12) {
  if (vibrate && typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    try {
      navigator.vibrate(ms);
    } catch {
      /* ignore */
    }
  }
}
