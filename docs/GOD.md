# GOD (БОГ): the strongest bot

Code: `src/ai/god.ts` (brain), `godSim.ts` (simulator and opponent models), `godTree.ts` (attack-phase
UCT), `godGame.ts` (whole-turn search), `godBot.ts` + `god.worker.ts` + `godProtocol.ts` (Web Worker
with synchronous fallback). Tests: `tests/unit/god.test.ts`, `godWorker.test.ts`, `godStrength.test.ts`.
Scripts: `scripts/god-strength.ts`, `god-perf.ts`, `god-tune.py`, `god-learn.ts` + `god-fit.py`.

## Simulator

The search runs on a typed-array copy of the rules (`Sim`), not on `MatchState`. It has the exact
fight arithmetic (overflow back to the attacker, the defender keeps `max(1, |a−d|)`, armed grey cells
in puzzles), exact income (cells, or the biggest group under duel rules, capped by free room), duel
greys-first, and the engine's hidden streak corrector with its counters. A unit test replays random
games and puzzle positions through the engine and the simulator and compares them after every step.

Between bots the corrector matters: measured in Master-vs-Master games, "75%" fights win 53%, "50%"
44% and "25%" 27%. GOD never reads `state.luck`. It keeps a belief over the three counters: the
stationary distribution for the line-up's share of people seats, updated after each of its own fights
in the turn (a loss resets a counter to 0, and a win moves it up). Every search iteration samples the
counters from that belief, so the tree's chance edges carry the real odds.

## Opponent models

Each seat is modelled by its own type. Hunter, Duel Hunter, Dummy and Freak are reproduced exactly.
Master is modelled by its expert policy with threat minimums, and people and other GODs by GOD's base
heuristics. A cheap model of Master turned out to be far too weak: it loses to Hunter, while real
Master beats Hunter 100%. Every reply-aware search built on that model lost games. The fix in duels
is an **emulator**: every emulated opponent attack is chosen by a small UCT search (32 iterations)
with Master's own objective, and its placements by threat minimums plus attack stacks. That emulator
alone beats a third of Master's games.

## Search

**Duel** (two players alive):
- *Attacks*: UCT over GOD's own attack phase with chance edges (`AttackTree`). The leaf is
  `evalPhase`, which generalises Master's ratio `2·cells / enemy power`. There is incremental Zobrist
  hashing. The tree is reused across the turn's decisions and is pondered in the worker during
  animations.
- *First attack of each turn*: the tree's four favourite moves are re-scored by emulated rollouts. A
  rollout plays the rest of GOD's phase, GOD's placement, the opponent's emulated reply and GOD's next
  attack phase, then evaluates.
- *Placement* (best response):
  - Threat minimums come first. Every own cell an enemy stack `u` can reach (through greys at 1 per
    cell, through third parties at their power) is raised to `min(u−1, cap)`. This is Master §7.5
    applied per opponent.
  - The candidates are "fill cell X, then the usual rest" for the 10 best attack-stack cells.
  - They are compared by emulated rollouts with common random numbers and successive halving.

**Three or more players alive**:
- A whole-turn UCT (`GameTree`) chooses both attacks and placements.
- GOD's attacks and its canonical placement chunks are tree nodes. Placement chunks are "fill / +3
  on the j-th best stack cell", in increasing j, or "spread the rest".
- Every opponent plays its turn with the model of its type. This simulates who fights whom and lets
  GOD stay out of others' fights instead of assuming one merged enemy, as Master does.
- The horizon is the end of GOD's next attack phase.

## Evaluation

`evalPhase` is computed at the end of an attack phase. It is
`(pCell·cells + pPow·border power + pInt·interior power − exposure) / (qCell·enemy cells + qPow·enemy power + hidden)`,
mapped by `x/(1+x)`. Under duel rules, cells outside the biggest group count `evalDuelStray`.

Tuning settled on Master's own weights (2 per cell, 1 per enemy unit). Every extra term lost games:
- own border power 0.2: −6
- own power 0.5: −6
- exposure penalty: −18
- enemy cells: −5
- interior discount 0.5: −1 / 0.2: −5

The likely reason is a mechanic: every attack costs the defender one unit more than the attacker,
whatever the outcome. So aggression pays, and own stacks left unused at the end of a phase are worth
little.

A logistic model fitted on 82k end-of-phase positions from 4,600 Master-vs-Master games (20 features,
`scripts/god-learn.ts` + `god-fit.py`) predicted the result no better than the ratio: AUC 0.960 vs
0.960. As a leaf it scored 47.5%.

Two other measurements:
- **Outcome by round.** The ratio's AUC for the final result is 0.62 at round 0, 0.81 at round 1, 0.93
  at round 2 and 0.98 at round 3, so matches are decided in the opening.
- **Compute.** Master with 10× playouts beats itself only 58–64%.

## Fog of war

With darkness on, GOD reads only its own cells and their neighbours. Everything else comes from:
- **Memory:** an enemy cell keeps its last-seen owner and its power grows by 1 per round up to
  capacity. A never-seen cell counts as neutral.
- **Public HUD totals:** the enemy power GOD can't place on the board is added to the evaluation's
  denominator.

Tests check that decisions are identical when invisible cells are permuted (the HUD totals stay the
same), and when `state.luck` is changed.

## Tuning procedure

1. Run a paired comparison on fixed seeds (`scripts/god-strength.ts`, 200–300 games split over 10
   processes, seats alternated, sizes M/L/XL, symmetric and random maps). A standard error is about
   3.5 points at 200 games.
2. Run component ablations. Hybrids of GOD and Master parts locate which half is weaker.
3. Run coordinate ascent (`scripts/god-tune.py`) over the stack key, the margins and the emulator
   budget. A change is accepted only above +1.5 points. This found the stack key (`chain` 0.5, the
   room for a chain within two steps) and threat margin 0: −1 and +1 are much worse (18.5% / 37.5% as
   a pure heuristic).
4. Validate on the full suite below.

## Results (desktop, Apple Silicon, 10 parallel processes)

| match | games | GOD |
|---|---|---|
| vs Master 1v1, fixed budget (GOD 1000 iterations, Master 1000 playouts) | 300 | **60.7%** (M 61, L 57, XL 64) |
| vs Master 1v1, equal decision time (GOD 1000 → 65 ms avg, Master 10000 → 74 ms avg) | 200 | **57.5%** (M 52, L 55, XL 65) |
| vs Master 1v1, real-time defaults, UI pace 200 ms | 150 | **55.3%** (M 46, L 54, XL 66) |
| Master vs Master, same seeds (seat/seed bias reference) | 300 | 56.7% for side A |
| vs Hunter 1v1 | 60 | **100%** |
| GOD + 3 Masters, 4-player FFA on L (fair share 25%) | 100 | **57%** |
| GOD + 5 Hunters, 6 players on L/XL (fair share 16.7%) | 60 | **55%** (7 saturated stalemates at the round cap) |

Decision times, real-time mode at UI pace 200 ms on desktop: attacks average 140–160 ms; the first
attack of a turn takes up to about 0.9 s with the re-scoring; placements average 210–290 ms, max 465 ms
on XXL. The hard cap is 1.2 s per decision. Budgets are wall-clock, so a slower phone searches less
but is never slower.

## Known weaknesses

- **Duels against Master.** GOD is ahead but not by the targeted 65%. In fixed-iteration mode the
  emulated placements cost about 10× Master's compute per decision. At equal decision time it is
  57.5%, and at real-time defaults 55%.
- **Humans in duels.** They are modelled as Master-like players (pessimistic but sensible).
- **Six-player stalemates.** Saturated six-player boards can stall. Bots never accept early finishes.
- **Darkness.** GOD plays fair while Master sees everything, so GOD is handicapped there.
