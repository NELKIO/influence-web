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
is an **emulator**: every emulated opponent attack is chosen by a UCT search with Master's own
objective, and its placements by threat minimums plus attack stacks. The search runs 128 iterations
per move in real time and 32 in fixed-budget mode. At 32 iterations the emulator alone beats a third
of Master-1000's games. It has to be about as strong as the opponent it models: against real-time
Master, going from 32 to 128 iterations raised the paired score from 65.0% to 73.3%.

## Search

**Duel** (two players alive):
- *Attacks*: UCT over GOD's own attack phase with chance edges (`AttackTree`). The leaf is
  `evalPhase`, which generalises Master's ratio `2·cells / enemy power`. There is incremental Zobrist
  hashing. The tree is reused across the turn's decisions and is pondered in the worker during
  animations.
- *Re-scored attacks*: every attack of the opening (rounds 0–3) and the first attack of later turns.
  The tree's four favourite moves are re-scored by emulated rollouts. A rollout plays the rest of
  GOD's phase, GOD's placement, the opponent's emulated reply and GOD's next attack phase, then
  evaluates. Doing this for every opening attack instead of only the first of each turn moved the
  fixed-budget paired score from 63.8% to 76.7% (240 games). Doing it in later rounds too changed
  no outcome: those games are already decided.
- *Expert rollouts*: each source cell caches its best target. After a fight only the attacker, the
  target and the target's own neighbours are rescored. Leaves are closed-form, from own cell count
  and enemy power tracked incrementally. Together with incremental hashing this makes the search
  about 35% faster than the first version.
- *Starved budgets*: every search runs at least 16 iterations, and when the search has no answer
  while attacks exist GOD plays Master's expert move. It never ends the attack phase because time
  ran out.
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
- **Phantoms (public HUD totals):** the HUD shows every player's cell count and power. The enemy cells
  GOD can't see are put on the board: the unseen, believed-neutral cells closest to that enemy's known
  cells (an enemy never seen: around the unseen cell farthest from GOD), with the unplaced power spread
  over them. Before, the missing power was only added to the evaluation's denominator, so in every
  emulated reply the enemy had a fraction of its real income and GOD under-rated its counterattacks.
  Whatever power still can't be placed goes into the denominator as before.

Tests check that decisions are identical when invisible cells are permuted (the HUD totals stay the
same), also over a whole match with the brain's memory (a second brain fed scrambled invisible cells at
every decision decides exactly the same), and when `state.luck` is changed.

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

## Results

All on a desktop (Apple Silicon, 10 cores).

**Paired protocol (duels):** both seat orders on the same offsets, and the sum is reported. Matches
are M/L/XL, symmetric and random maps, both bots on real-time defaults at UI pace 200 ms
(`gr=0 mp=0 speed=200`). The number of parallel processes is the load: 10 processes on 10 cores is
the slow-device proxy.

| GOD vs Master, real time, paired | games | GOD | M | L | XL |
|---|---|---|---|---|---|
| final, 5 processes | 240 | **73.3%** | 68.8% | 71.3% | 80.0% |
| final, 10 processes | 240 | **69.6%** | 63.8% | 70.0% | 75.0% |
| emulator 256 iterations per move instead of 128, 5 processes | 240 | 70.8% | 58.8% | 78.8% | 75.0% |
| previous version (emulator 32), 5 processes | 240 | 65.0% | | | |
| previous version (emulator 32), 10 processes | 240 | 65.0% | | | |
| version before this round, 5 processes (offsets 0–59) | 120 | 61.7% | | | |

During these runs GOD averaged about 320 ms per decision and Master 125–140 ms.

Fixed budget (GOD 1000 iterations, Master 1000 playouts), paired, 240 games:
- only the first attack of a turn re-scored: 63.8%
- every opening attack re-scored: 76.7%
- every attack re-scored: 76.7%, with identical outcomes
- one extra emulated round: 62.9%
- extra placement candidates: 72.9%
- six re-scored moves instead of four: 77.5%

Other checks:

| match | games | GOD |
|---|---|---|
| vs Hunter 1v1 (fixed budget) | 30 + 60 | **100%** |
| GOD + 3 Masters, 4-player FFA on L (fair share 25%, fixed budget) | 60 / 100 | **60%** / 57% |
| GOD + 5 Hunters, 6 players on L/XL (fair share 16.7%) | 60 | **55%** (7 saturated stalemates at the round cap) |

**Decision times** (`scripts/god-perf.ts -- opp=master`, real time, UI pace 200 ms, S–XXL):

| | average | maximum |
|---|---|---|
| all decisions | 205–360 ms | 1.45 s |
| rounds 0–3 | 428–541 ms | 1.45 s |
| later rounds | 151–205 ms | ~1.0 s |
| placements | 450–620 ms | |

The hard cap is 2 s. Budgets are wall-clock with a minimum of 16 iterations, so a slow phone searches
less but is never slower and never passes because of time. The worker also ponders the next position
during the animation of each attack.

## Round 3: held-out discipline, emulator fidelity, darkness

Protocol: tuning only on offsets 0–239, every accepted change judged on the held-out offsets 1000–1119
(both seat orders, 240 games). `scripts/god-paired.ts` runs both seat orders and interleaves the
variants' jobs (a variant may run from another checkout with `"_dir"`), so a candidate and the baseline
share the same machine load. `scripts/god-fidelity.ts` measures how often the emulator makes the same
decision as the real Master on the same position; `scripts/god-diag.ts` logs per-decision effort.

Caveat: all real-time numbers below were taken on the shared 10-core Mac while other agents loaded it
(load average 15–90), so they are a slow-device regime. Only interleaved comparisons are meaningful.

**Held-out baseline** (version of round 2, real time, 5 processes, load ≈ 20–30): 149/240 = **62.1%**
(M 58.8%, L 61.3%, XL 66.3%), GOD 337 ms average, 1779 ms maximum. The tuning offsets are easier: the
same version scores 71.9–73.8% on offsets 0–119 in the same conditions. Per game slot (map and seat),
outcomes are far from binomial: over four runs of 114 slots, 53 were always won and 10 always lost.

**Emulator fidelity** (real-time Master as the reference, 9 duels):

| emulated Master attack = real Master's | opening | later |
|---|---|---|
| emulator 128 iterations (round 2) | 81.8% | 54.5% |
| emulator 512 iterations | 82.3% | 54.5% |
| nominal dice + Master's clamped ratio (`emuNominal`) | 85.6% | 72.1% |
| nominal, 512 iterations | 90.6% | 73.0% |
| 4 players: expert policy (whole-turn search model) / emulator / nominal emulator | 80% / 92% / 92% | 58% / 59% / 80% |

Master doesn't know the streak corrector, so it searches with nominal dice; the round-2 emulator
searched with the true odds and therefore mispredicted half of Master's later attacks. The placement
model matches 53% of Master's opening placement points; a Master-like placement search
(K candidate stacks × R expert rollouts) raised that to 56–59%.

**Higher fidelity did not make GOD stronger** (real time, 6 processes, offsets 0–119, interleaved):

| variant | games | GOD |
|---|---|---|
| round 2 | 114 | 71.9% |
| nominal emulator | 114 | 71.1% |
| nominal + emulator trees kept across emulated moves and rollouts | 114 | 58.8% |
| the same + Master-like placement search | 114 | 52.6% |
| round 2 (second window) | 240 | 73.8% |
| opening budgets +100–400 ms (average 419 ms) | 240 | 71.7% |
| the same + emulator 192 iterations | 240 | 69.6% |

Keeping emulator trees makes every rollout of a candidate replay the same emulated opponent decisions,
so a candidate is judged against one sampled reply instead of a spread of them: the comparison gets
much noisier. Fixed-budget screening (GOD 1000 vs Master 2000, 80 games, round 2 = 63/80) found nothing
either: true streak counters at the start of every turn (an upper bound for inferring them from the
fights) 58/80, emulated placements filling another of the three next-best stacks 30% / 50% of the time
62 / 56, 6 / 16 placement candidates 63 / 64, three re-scored attacks 54.

**Multi-player:** GOD + 3 Masters on L, real time, 60 games: 65% (fair share 25%). Master opponents
played by small nominal searches inside the whole-turn search (16 / 48 visits per move, trees kept)
instead of the expert policy: 60% / 65%. Dropped.

**Darkness** (fixed budget GOD 1000 vs Master 2000, Master sees everything):

| variant | offsets 0–29 (60 games) | offsets 0–89 (175–180) |
|---|---|---|
| round 2 | 15.0% | 15.4% |
| phantoms (default now) | 30.0% | 27.2% |
| phantoms + nominal emulator | 38.3% | |
| phantoms anchored at the estimated start (mirror / graph median) | | 27.4% |
| "shadow" board (believed board advanced by modelled enemy turns, reconciled with the HUD) | 43.3% | 15.8% (30–89) |
| cheat: full view | 73.3% | |
| cheat in rounds 0–3 only | 68.3% | |
| cheat in rounds 4+ only | 38.3% | |
| cheat for attack decisions / placements only | 61.7% / 45.0% | |
| cheat: two rings of view in rounds 0–3 | 51.7% | |
| cheat: the true location of an unseen enemy as the phantom anchor | 46.7% | |

The whole darkness handicap is in the opening, and the enemy's location explains only a small part of
it. Phantom details (power on the phantom border, no growth of remembered cells) changed nothing.

## Known weaknesses

- **Duel compute.** GOD uses about 2.5× Master's time per decision. At an equal fixed iteration count
  its placement emulation costs much more than Master's search.
- **Humans in duels.** They are modelled as Master-like players (pessimistic but sensible).
- **Six-player stalemates.** Saturated six-player boards can stall. Bots never accept early finishes.
- **Darkness.** GOD plays fair while Master sees everything, so GOD is handicapped there.
- **No pondering on the opponent's turn.** The worker is idle then; only the next position after
  GOD's own attack is pondered.
