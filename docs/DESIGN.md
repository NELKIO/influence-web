# Influence Web — design

Fan-made browser remake of the turn-based territory game *Influence* (Teremok Games).
All code, graphics and sounds are original; this project is not affiliated with Teremok Games.
Game rules were reconstructed so that matches play like the original.

## Goals

1. Single matches vs bots and hot-seat matches with several humans on one device, with full battle
   setup (map size, 1–4 opponents with individual type, darkness, symmetry, crowded, unions, shuffle).
2. Map of the Day — one date-seeded map for everyone, unlimited retries, no cooldown, local best results
   and a calendar/archive.
3. Game settings (language, sound, vibration, game speed, confirmations, cell look, colour-blind shapes,
   player palettes, battery saver).
4. Duels — duel rules (largest-group income, grey cells first), training vs duel bot, hot-seat duel,
   and online duels between two browsers over WebRTC (room code / invite link).
5. Local statistics.

Runs on any modern browser (iOS Safari, Android Chrome, desktop). Installable PWA, works offline
(except online duels).

## Architecture

```
src/
  core/      pure deterministic rules engine (no DOM). Unit-tested.
    rng.ts        seedable PRNG (sfc32) with serializable state
    types.ts      Cell, Field, MatchSettings, MatchState, events
    field.ts      hex geometry, random + symmetric map generators, routes/walls
    setup.ts      start placement, crowded, shuffle, match creation
    engine.ts     attack/power phases, combat + luck correction, power income,
                  unions, elimination, stuck check, end of match
    serialize.ts  save/load (JSON), map codes
  ai/        bots: freak, dummy, hunter, duelHunter, master (MCTS, runs in a Web Worker)
  net/       PeerJS wrapper + duel protocol (hello / turn / ack / concede / rematch)
  ui/        Preact screens + Canvas board renderer (camera with pan/pinch zoom)
  audio/     WebAudio-synthesised sound effects
  i18n/      ru / en dictionaries
  storage.ts localStorage persistence (settings, saved match, stats, daily results)
```

### Engine contract

`MatchState` is a plain JSON-serialisable object. The engine mutates it through a small API:

- `attack(state, fromCell, toCell) → FightEvent | Refusal`
- `endAttack(state) → UnionEvent?` (switches to POWER, computes income)
- `addPower(state, cell, amount)`, `fillCell`, `autoPower(state)`
- `finishPower(state)` → next alive player, round counter
- `checkStuck(state)`, `isEnded/winner`

All randomness goes through `state.rng` (seedable), so a match is reproducible from its seed and
moves. Online duels send resolved fight outcomes, so peers never re-roll.

### Rules (summary)

- Odd-r offset hex grid; per size W×H: S 5×7, M 7×11, L 10×15, XL 15×19, XXL 20×25.
- Cell capacity 8 (70%) or 12 (30%). Random maps grow from the centre, ~20% of non-tree links become walls.
  Symmetric maps mirror every placement 4-way, no walls.
- Attack from own cell with ≥2 power into adjacent non-own cell. Win chance by `a−d`:
  ≤−2 → 0, −1 → 25%, 0 → 50%, +1 → 75%, ≥2 or empty target → 100%. Attacker drops to 1;
  winner cell gets `max(1, a−d)` (or `a−1` for empty), overflow over capacity returns to attacker;
  on loss defender keeps `max(1, |a−d|)`. A hidden streak breaker favours human attackers.
- Income: one point per owned cell (duels: size of the largest connected group), capped by free capacity.
- Darkness: you see your cells and their direct neighbours.
- Unions (only with exactly one human, from round 3): a weaker bot may hand its cells to the player
  that just attacked when that keeps the leader in check.
- Out when no cells. Match ends when one player is left or no human is left. Stuck check offers an early
  finish when the board is >80% saturated.

### Bots

Psycho (random), Dummy (scan order), Hunter (strongest border cell → weakest neighbour, border-first
power), Master (MCTS against a merged opponent with threat-based power minimums, in a Web Worker),
Duel Hunter (Hunter obeying duel rules).

### Online duels

PeerJS public broker for signalling, then a direct WebRTC data channel. Host creates a room with a
4-letter code (also an invite link `#/duel/CODE`). Host generates the map and sends `hello`. The active
player resolves fights locally and streams actions; the other side replays them. Each message carries a
sequence number and a state hash; on reconnect the peers exchange the full state and continue.
Optional turn timer (off / 1 / 2 / 5 min): when it runs out, the turn is ended with auto power.

### UI

Dark neon look with original artwork drawn in Canvas/SVG; player colours blue, green, yellow, red, purple.
Screens: main menu, battle setup, game (HUD: player colour bar, score bar, status line, end-turn button
with remaining "+N", zoom), pause, results, hand-over screen, Map of the Day, duels lobby, settings,
rules, statistics.

## Testing

- Vitest: combat table, power formulas, generators (connectivity, symmetry, start positions), darkness,
  unions, serialisation round-trip, duel rules.
- Headless simulation: thousands of bot-vs-bot games for every size/mode (no crashes, termination,
  invariants).
- Playwright: all flows on phone and desktop viewports; online duel between two browser contexts.
