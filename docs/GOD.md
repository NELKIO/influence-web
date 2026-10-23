# GOD (БОГ): the strongest bot

Code: `src/ai/god.ts` (brain), `godSim.ts` (simulator and opponent models), `godTree.ts` (attack-phase
UCT), `godGame.ts` (whole-turn search), `godBot.ts` + `god.worker.ts` + `godProtocol.ts` (Web Worker
with synchronous fallback). Tests: `tests/unit/god.test.ts`, `godWorker.test.ts`, `godStrength.test.ts`.
Scripts: `scripts/god-strength.ts`, `god-perf.ts`, `god-tune.py`, `god-learn.ts` + `god-fit.py`, `god-paired.ts` +
`god-paired-report.py`, `god-fidelity.ts`, `god-placefid.ts`, `god-oracle.ts` + `god-oracle-report.py`,
`god-trace.ts`; the weakness set `god-weak-slots.txt`. In-rollout placement models: `src/ai/godPlace.ts`.

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

**Duel** (two players alive), anchored on Master: every duel decision starts from **Master's own
choice**, found by a real Master search on the true position (attacks: 300 / 150 ms for the first /
other attacks of an opening turn, 250 / 100 ms later; placements 300 ms in the opening, 200 ms later;
all inside GOD's usual budgets). GOD plays something else only when its own analysis shows a clear gain:
- *Re-scored decisions* (opening attacks, the first attack of later turns, placements): Master's
  choice is candidate 0 of the emulated-rollout comparison and is never eliminated. At the end, GOD
  deviates only when the paired gain over Master's choice on the same dice is positive and larger than
  1.5 standard errors (`anchorZ`), over at least 6 rollouts.
- *Other attacks*: the attack tree's value of its best move must exceed the value of Master's move by
  1.5 × 0.15 · √(1/n₁ + 1/n₂).
Below, the machinery GOD uses for its own analysis.

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

## Darkness and fog of war

**Default: GOD sees the whole map**, under darkness and under the exploration fog of the `blind`
scenarios, like every other bot (Master, Hunter… ignore darkness). Held-out on the server (offsets
1000–1119, both seat orders, real time, 6 processes, 240 games each): GOD vs Master in darkness
**64.6%** with the full view against 26.7% with the fair fog (M 62.5 / 28.8, L 61.3 / 25.0, XL 70.0 /
26.3), decision times 340 ms average and 1430 ms maximum.

The fair-fog brain stays available as an explicit option for experiments (`fairFog: true`). It reads
only its own cells and their neighbours. Everything else comes from:
- **Memory:** an enemy cell keeps its last-seen owner and its power grows by 1 per round up to
  capacity. A never-seen cell counts as neutral.
- **Phantoms (public HUD totals):** the HUD shows every player's cell count and power. The enemy cells
  GOD can't see are put on the board: the unseen, believed-neutral cells closest to that enemy's known
  cells (an enemy never seen: around the unseen cell farthest from GOD), with the unplaced power spread
  over them. Before, the missing power was only added to the evaluation's denominator, so in every
  emulated reply the enemy had a fraction of its real income and GOD under-rated its counterattacks.
  Whatever power still can't be placed goes into the denominator as before.

The fairness tests run this option. A test checks that the default brain decides exactly as without
darkness. For `fairFog`, tests check that decisions are identical when invisible cells are permuted (the HUD totals stay the
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

### Held-out results on the server

The target of 72% on the held-out duels was not reached: 67.1% over 480 games, with M the weakest size
(about 60%). Measured on a 12-core Xeon (about 1.7× slower per core than the Mac, so not comparable with the Mac
tables above), offsets 1000–1119, real time (`gr=0 mp=0 speed=200`), round 2 (`_dir` = its checkout)
and this version interleaved in the same run window.

| match | games per version | round 2 | this version |
|---|---|---|---|
| duel vs Master, 12 processes (all cores busy) | 240 | 62.1% (M 58.8, L 67.5, XL 60.0) | **69.6%** (M 61.3, L 72.5, XL 75.0) |
| the same, `attackEmu` 6 instead of 4 | 240 | | 69.2% |
| duel vs Master, 6 processes | 240 | 62.5% (M 53.8, L 66.3, XL 67.5) | **64.6%** (M 60.0, L 66.3, XL 67.5) |
| both duel windows together | 480 | 62.3% | **67.1%** |
| darkness duel vs Master (Master sees everything), fair fog, 6 processes | 120 | 12.5% | **26.7%** |
| duel rules vs Master, 6 processes | 120 | 69.2% | 70.8% (nominal emulator: 74.2%) |
| duel rules, offsets 1060–1119, second window | 120 | | 77.5% (nominal emulator: 70.0%) |
| GOD + 3 Masters on L (fair share 25%) | 60 | 53.3% | 63.3% |
| GOD + 5 Masters on XL (fair share 16.7%) | 30 | 46.7% | 53.3% (51% over 90 games with round 4's extra 60) |

For clear-board duels, duel rules and multi-player games the two versions differ only in the time
discipline of the emulated re-scoring: the opening hard cap of 1.42 s and minimal searches once a
rollout runs past the deadline. The nominal emulator under duel rules was +3.4 points in one window and
−7.5 in the other, so it stays off. Round 2 overran on the slower machine (maximum 1714 ms under duel
rules, 1467 ms in clear duels), the new version stays at 1425–1431 ms. In multi-player games the code
path is identical, so the 53.3% vs 63.3% and 46.7% vs 53.3% differences are pure noise. That noise is
about ±6 points at 60 games, and part of the duel gain may be noise too.

Decision times of this version on the server: duel 328 ms average (maximum 1431 ms), darkness 344 ms,
duel rules 287 ms, four players 170 ms, six players 156 ms.

## Round 4: size M, the opening, multi-player, the ceiling

Same discipline: tuning on 0–119, judging on held-out 1000–1119 (both seat orders), interleaved with
the current version in the same run windows on the server.

**Tuning screens** (real time, 6 processes, offsets 0–119):

| variant | games | current | variant |
|---|---|---|---|
| M only: re-score every attack (`rescoreAll`) | 125 | 62.4% | 64.0% |
| M only: opening budgets for 6 rounds instead of 4 | 125 | 62.4% | 60.8% |
| M only: nominal emulator | 120 | 62.4% | 60.0% |
| M only: own attack tree without forced continuation (`unforced`) | 240 | 62.9% | 62.5% |
| 4 players on L: whole-turn search budgets ×2 / ×3 (`multiScale`) | 64–68 | 64.7% | 60.9% / 57.8% |
| all sizes: Master's own placement and attack choice as extra candidates (`masterCand` 250 ms, `masterAtk` 120 ms) | 240 | 66.3% | 68.8% |

On M, GOD already spends 406 ms per decision on average (short games are mostly opening), so M can't
get more time. The Master candidates were the only lead. **Held-out**, 12 processes, two windows:
current 60.0% / 62.9%, with the Master candidates 62.9% / 62.1%. That is 61.5% vs 62.5% over 480 games,
which is noise, so both options stay off.

**Six players** (GOD + 5 Masters on XL, fair share 16.7%), held-out: 50.0% over 60 more games, 51% over
90 games altogether.

**How much is map and seat luck.** Across the held-out runs of the current version (69.6%, 64.6%,
60.0%, 62.9%; 960 games), GOD averages about 64%; window-to-window spread is ±5 points at 240 games.
- *Seat:* on M, GOD as seat 0 (moves first with 5 power against 7) wins about 50–58%, as seat 1
  60–70%. L and XL show no consistent seat effect.
- *Slots:* over five runs of the 240 held-out slots, 100 slots were always won and 34 always lost
  (16 of them on M). Master was put in GOD's seat on those 34 slots (four real-time games each): it won
  65/136, i.e. about half. 15 slots were lost by Master as well (0/4: structurally lost, about 6% of all
  games). On 14 slots Master won 4/4, so GOD's losses there are its own play, not the map.

So the map and seat set a ceiling around 90%+, not 72%. The 72% target is not reached; the gap is
GOD's play in specific positions, and nothing found in rounds 3–4 (fidelity, budgets, candidates,
search shape) moved the held-out number beyond noise.

## Round 5: GOD must never be weaker than Master

**Root cause.** In round 4, 14 held-out slots (map and seat) were lost by GOD in five runs out of five
but won by Master in GOD's seat four times out of four. Move traces (`scripts/god-trace.ts`) on the
server show the same pattern in them:
- GOD's opening expansion chain heads towards the enemy, often across the map's middle, and leaves a
  line of 1–2-power cells (e.g. slot 1112: 4→14→13→27→37; Master went 4→3→2→1→0 and stacked its
  start cell).
- The enemy, moving second with 7 power, then chains through those cells (1077: the enemy took four
  GOD cells in one turn, 18→17→16→26→34).
- Master expands away from the contact and stacks; it meets the enemy later with a full stack.

GOD's emulated rollouts did prefer its own move, and by a statistically clear margin (slot 1112, first
decision: paired gain 0.004–0.008 over Master's move, z ≈ 3–4 over 85–213 rollouts). So this is a bias
of GOD's own analysis (the rollout's model placement and short horizon), not noise. Such rare biased
judgements are what lose these games.

**Fix: Master-anchored duels** (`anchor`, on by default, described under Search). Master's choice is
the default, and GOD has to prove a deviation; it deviates in about 13–18% of the decisions.

**Results** (server, real time, 12 processes, current version vs anchored, same run windows):

| set | games per version | current | anchored |
|---|---|---|---|
| tuning offsets 0–119, M/L/XL | 240 | 67.9% | **72.1%** (z 2.5 instead of 1.5: 64.2%) |
| held-out 1000–1119, M/L/XL | 240 | 65.8% (M 61.3, L 65.0, XL 71.3) | **70.8%** (M 68.8, L 73.8, XL 70.0) |
| weakness set: the 34 always-lost held-out slots, 4 runs each | 136 | 27.2% | **48.5%** |
| of them the 14 slots Master won in GOD's seat | 56 | 50.0% | **75.0%** |
| held-out 1000–1119 on S/M/L/XL/XXL, window 1 | 240 | 66.7% | 66.7% |
| held-out 1000–1119 on S/M/L/XL/XXL, window 2 | 240 | 62.9% | 62.5% |

Held-out 1000–1119 with sizes S/M/L/XL/XXL (the offset picks the size, so these are other maps than
the M/L/XL runs), both windows together, 96 games per size and version:

| | S | M | L | XL | XXL | symmetric | random | all |
|---|---|---|---|---|---|---|---|---|
| current | 59.4% | 59.4% | 61.5% | 74.0% | 69.8% | 68.8% | 60.8% | 64.8% |
| anchored | 61.5% | 54.2% | 70.8% | 70.8% | 65.6% | 67.1% | 62.1% | 64.6% |

GOD is above 50% in every size and in both map groups; no group is below Master. The general strength
didn't move (all duel windows together: anchored 480/720 = 66.7%, current 469/720 = 65.1%), but the
positions where GOD used to lose to its own misjudgements are fixed (weakness set 27% → 49%; on the
14 slots Master won 50% → 75%). M stays the weakest size with both versions, at about 60% over all
176 M games (current 60.2%, anchored 60.8%); a single window's ±10 points at 96 games swamps the
per-size differences.

Decision times of the anchored version (Mac, one match per size, speed 200): average 344–431 ms per
size, rounds 0–3 at most 1420 ms, later rounds at most 928 ms.

## Round 6: attempts to fix the misjudgement at its source

Tuning on offsets 0–119 (real time, 12 processes on the server, current = Master-anchored round 5),
all variants interleaved in the same windows:

| variant | sizes | games | current | variant |
|---|---|---|---|---|
| playouts end after the enemy's next attacks (GOD's model placement, then the enemy's emulated attack phase), opening only / always (`emuTail`) | M/L/XL | 220 | 69.1% | 57.7% / 63.6% |
| anchor threshold z 0.7 / 1.0 / 2.0 instead of 1.5 | S–XL | 160–165 | 62.4% | 58.8% / 61.2% / 59.4% |
| Master's sure captures always stand, GOD re-judges only chance fights (`anchorMode: 'chance'`) | S–XL | 480 (2 windows) | 59.8% | 59.0% |
| the same, and Master's placements always stand (`'chanceP'`) | S–XL | 240 | 60.4% | 51.7% |
| `'chance'` + placement budgets 1400 / 900 ms (+ 16 placement candidates) | S–XL | 240 | 59.2% | 56.2% (58.3%) |
| `'chance'` + Master's anchor searches as long as the real Master's | S–XL | 220 | 60.0% | 56.4% (placement threshold 1.0: 60.5%) |

`'chance'` keeps the tuning strength with about half the thinking time (206 vs 376 ms per decision), but
on held-out 1000–1119 with S/M/L/XL/XXL (240 games each) it scored 57.5% against 63.3%, so it stays off.

What the screens show:
- **Placements are GOD's edge.** When Master's placements always stand, GOD falls to Master's level
  (51.7%); when Master's sure captures always stand, nothing is lost. GOD's strength over Master comes
  from its best-response placements, where its emulated rollouts are reliable.
- **A longer horizon made things worse.** Ending the playouts after the enemy's next attacks lets the
  rollouts see chains through thin lines, but the extra modelled half-round (GOD's model placement, the
  emulated enemy attacks) adds more bias and noise than it removes (58–64% against 69%).
- **The anchor threshold is flat between 1.0 and 1.5;** lower and higher values are slightly worse.

Held-out with the current version in this round (S/M/L/XL/XXL, 240 games): 63.3% (S 60.4, M 58.3,
L 68.8, XL 75.0, XXL 54.2; symmetric 66.7%, random 60.0%). No default changed in round 6.

## Round 7: is GOD's own placement inside the rollouts the bias?

Round 5's diagnosis was that GOD's emulated rollouts over-rate opening chains towards the enemy because
they model GOD's own placement crudely and look only one round ahead. Round 7 measured that model first,
then measured the rollouts' judgements against the outcome of real continuations, and only then played
matches. Tuning used offsets 0–239. Held-out used 1000–1119, both seat orders, sizes S/M/L/XL/XXL. All runs
were real time (`gr=0 mp=0 speed=200`) on the server with 12 processes, and every variant was interleaved
with the current version (main, from its own checkout) in the same window.

New code (all options, defaults unchanged unless stated below):
- `src/ai/godPlace.ts`:
  - `MasterPlacer`, a real Master placement search with a fixed number of playouts on a light
    `MatchState` view of the simulator board, its dice restarted from the rollout's generator;
  - `masterExpertRest`, Master's rollout policy for placements.
- `ownPlace` / `oppPlace` choose GOD's own and the opponents' placement inside emulated rollouts:
  - `'model'`: threat minimums plus GOD's attack-stack key, as before;
  - `'mstack'`: the same with Master's key;
  - `'expert'`: Master's rollout policy;
  - `'search:N'`: Master's search with N playouts per step;
  - `'late:N'` / `'open:N'`: the search only after / only in the opening.
  Past the decision's deadline the search falls back to the model.
- `chainLeaf` is a leaf term of the rollouts. It counts the own cells that one sure enemy chain could
  take next turn (`chainExposure` in godSim.ts), after GOD's modelled placement, with the enemy's income
  on the chain's start.
- `anchorConfirm` keeps a share of an anchored comparison's rollouts to judge the halving's winner
  against Master's choice on fresh dice. The winner of several noisy means is biased upwards, and this
  removes that bias.
- Scripts:
  - `god-placefid.ts`: placement fidelity;
  - `god-oracle.ts` + `god-oracle-report.py`: rollout judgements against real continuations;
  - `god-paired-report.py`: per-size, map-group and seat tables of `god-paired` output files;
  - `god-weak-slots.txt`: the weakness set.

### 1. Fidelity of the in-rollout placement models

`scripts/god-placefid.ts`, 30 GOD-vs-Master games (offsets 0–29, S–XXL), 119 opening placements of GOD
(rounds 0–3) and 100 later ones. The table gives the share of placed points that land on the same cells
as GOD's real (Master-anchored, best-response) placement in the same position.

| model | opening | later | cost per call |
|---|---|---|---|
| `model` (threat minimums + GOD's stack key, the current one) | **73.6%** | 79.7% | 0.2–0.4 ms |
| Master's own placement (real-time Master, same position) | 71.7% | 92.1% | |
| `expert` (Master's rollout policy) | 40.0% | 74.7% | 0.03 ms |
| `search:16` / `64` / `256` / `1024` | 58.0 / 62.3 / 66.1 / 67.3% | 90.3 / 91.0 / 90.3 / 90.9% | 1–4 / 3–16 / 9–63 / 37–295 ms |

The distribution agrees too. In the opening, GOD's real placement puts points on 2.76 cells on average,
the model on 2.76 and Master on 2.92. The biggest single fill takes 70%, 71% and 66% of the points.

**The current model is not crude.** In the opening, where the misjudged chains happen, it is the most
faithful model of GOD's own placement, closer than Master's own placement. GOD deviates from Master in
41% of its opening placements, and those deviations are what the model captures. After the opening, GOD's
anchored placement is mostly Master's, and a small Master search matches it best (91% against 80%).

The opponent's placement (the real Master opponent) is modelled worse:
- `model`: 72.4% in the opening, 79.8% later;
- `search:64`: 81.1% / 91.8%;
- `search:1024`: 87.2% / 93.4%.

### 2. Rollout judgements against real continuations (oracle)

`scripts/god-oracle.ts`:
- *Collection:* 120 real-time GOD-vs-Master games on offsets 0–119 gave 2286 re-scored opening attack
  decisions. GOD deviated from Master's choice in 428 of them (19%). The same games gave 445 compared
  opening placements, with 184 deviations (41%).
- *Rollouts:* for every decision and every rollout variant, 100 emulated rollouts per candidate with
  common random numbers, exactly as the re-scoring runs them.
- *Oracle:* every candidate is played out to the end of the match K times with common engine dice. The
  opponent is a Master with 200 playouts per decision.
- *Report:* for each variant and anchor threshold z, the decisions where the variant would deviate from
  Master's choice, and the oracle's win-rate gain of those deviations.

The answer depends on who continues GOD's seat in the oracle.

Attack decisions, oracle gain per deviation at z = 1.5 (± standard error):

| rollout variant | Master continues GOD's seat (321 decisions, K = 16) | GOD continues it (200 rollouts, 264 decisions, K = 8) |
|---|---|---|
| current (`model` placements) | +0.048 ± 0.017 | +0.001 ± 0.013 |
| `ownPlace: 'search:64'` | **+0.085 ± 0.020** | −0.012 ± 0.016 |
| `ownPlace` + `oppPlace` `'search:64'` | +0.080 ± 0.019 | −0.002 ± 0.016 |
| `oppPlace: 'search:64'` | +0.056 ± 0.018 | −0.002 ± 0.013 |
| `emuTail: 'opening'` | +0.059 ± 0.017 | +0.014 ± 0.014 |
| the same with Master-search placements in the tail | +0.085 ± 0.019 | +0.002 ± 0.015 |
| `chainLeaf` 0.5 | +0.027 ± 0.017 | −0.002 ± 0.013 |
| nominal emulator | +0.048 ± 0.017 | +0.011 ± 0.014 |
| GOD's real deviations | +0.032 ± 0.015 | +0.002 ± 0.012 |

With Master continuing GOD's seat, Master-like own placements in the rollouts look like a big
improvement. On the same decisions with GOD continuing its own seat, the advantage disappears. A
rollout's value is the value of the position *under the play that follows it*, so modelling GOD's own
placement as Master's makes the rollouts predict Master's continuation, not GOD's. With GOD continuing,
no variant makes opening attack deviations clearly profitable or harmful. GOD's real attack deviations are
worth +0.002 ± 0.012 per deviation, so they are neutral. The "best candidate vs Master's choice" gap,
an upper bound inflated by noise, is only 0.054.

Placement decisions (GOD continues its seat, 200 rollouts, K = 12, 155 decisions; gain per deviation at
z = 1.5):
- current: +0.023 ± 0.023;
- `oppPlace: 'search:64'`: +0.039 ± 0.020;
- nominal emulator: +0.031 ± 0.020;
- `anchorConfirm` (judged on 50 fresh rollouts): +0.065 ± 0.022, 42 instead of 54 deviations;
- `emuTail: 'opening'`: **−0.031 ± 0.022**, and with Master-search placements in the tail +0.011;
- `chainLeaf` 0.5: **−0.044 ± 0.018**.

GOD's real placement deviations are worth +0.024 ± 0.020. The tail and the chain-exposure term make
placement judgements worse.

### 3. Strength (tuning offsets, real time, interleaved with main)

| variant | offsets | games | main | variant | paired difference (± se) |
|---|---|---|---|---|---|
| `anchorConfirm` 0.4 | 0–119 | 240 | 68.8% | 64.2% | −4.6 ± 3.2 |
| `anchorConfirm` 0.4 + nominal emulator | 0–119 | 240 | 68.8% | 66.7% | −2.1 ± 3.3 |
| `anchorConfirm` 0.4 + `oppPlace: 'search:64'` | 0–119 | 240 | 68.8% | 60.4% | −8.3 ± 3.3 (maximum decision time 3217 ms) |
| tail in the opening with Master-search own and opponent placements (`emuTail: 'opening'`, `open:64`) | 120–239 | 240 | 66.3% | 57.1% | **−9.2 ± 3.6** |
| anchor threshold z 1.0 for everything | 120–239 | 240 | 66.3% | 65.0% | −1.2 ± 2.6 |
| anchor threshold z 1.0 for placements only (`anchorZPow`) | 120–239 | 240 | 66.3% | 67.9% | +1.7 ± 2.7 |

None of the oracle's leads survived real play:
- *Confirmation:* it halves the rollouts that choose the candidate, so fewer placements deviate from
  Master, and placements are GOD's edge.
- *Master-search opponent placements:* they cost about 1.5× per rollout, so there are fewer rollouts per
  decision. In big late positions one search overran the 2 s cap; the deadline fallback was added for
  that.
- *The deeper opening horizon:* with the faithful models it is again clearly worse, as in round 6.

The only lead was the lower placement threshold. It was judged on held-out below.

### 4. Held-out and the weakness set

The held-out run covered offsets 1000–1119, both seat orders, S/M/L/XL/XXL, with two windows interleaved
in one run: 480 games per version.

| version | games | all | S | M | L | XL | XXL | symmetric | random | GOD seat 0 / 1 |
|---|---|---|---|---|---|---|---|---|---|---|
| main (current) | 480 | 65.0% ± 2.2 | 62.5% | 55.2% | 66.7% | 76.0% | 64.6% | 69.2% | 60.8% | 68.3% / 61.7% |
| placement threshold 1.0 (`anchorZPow: 1`) | 480 | 65.8% ± 2.2 | 64.6% | 58.3% | 64.6% | 76.0% | 65.6% | 67.5% | 64.2% | 70.8% / 60.8% |

The paired difference is +0.8 ± 1.8 points (window 1: 67.9% vs 65.4%, window 2: 62.1% vs 66.3%). That
is noise, so the option is **not adopted**.

**The weakness set was rebuilt.** The 34 slots of round 4 were lost with the server's cleanup. The new
set is `scripts/god-weak-slots.txt`: the 45 held-out slots (sizes M/L/XL as in round 4: M 15, L 15,
XL 15) that main lost in all 4 of 4 real-time runs. Those runs had 960 games and averaged 65.5%
(67.1 / 65.0 / 64.2 / 65.8%); 112 of the 240 slots were always won. Re-run 4 times each in the same
window:
- main: 20/180 = 11.1% (M 3.3%, L 3.3%, XL 26.7%);
- `anchorZPow: 1`: 21/180 = 11.7% (M 8.3%, L 0%, XL 26.7%).

The set does not get worse. The 11% is the regression from the 0% that selected the slots.

**Decision times** (the defaults are unchanged):
- `scripts/god-perf.ts`, server, one process, two matches per size against Master:
  - all decisions: 240–460 ms on average per size (S 460, M 427, L 407, XL 404, XXL 240);
  - rounds 0–3: 543–619 ms on average, at most 1421 ms;
  - later rounds: 180–309 ms on average, at most 1055 ms;
  - placements: 690–951 ms on average.
- In the 12-process paired runs GOD averaged 314–329 ms per decision with a maximum of 1430 ms. The
  hard cap of 2 s held in every default run.

### Conclusions

- **The in-rollout model of GOD's own placement was not the cause.** In the opening it is the most
  faithful cheap model of GOD's real placement (74% point overlap, better than Master's own placement at
  72%). Replacing it with a Master search makes the rollouts predict Master's continuation, not GOD's.
  In matches, every variant with Master-search placements in the rollouts was worse (−8 and −9 points).
- **Opening attack deviations are neutral.** Against real continuations in which GOD keeps playing its
  seat, GOD's deviations from Master's opening attacks are worth +0.002 ± 0.012 per deviation. No
  rollout variant (horizon, placement models, chain-exposure leaf, nominal dice, confirmation on fresh
  rollouts) makes them clearly profitable.
- **Placement deviations are mildly positive** (+0.024 ± 0.020). This is consistent with round 6
  (placements are GOD's edge). Deviating more often there (threshold 1.0) was +1.7 on tuning and +0.8
  on held-out: noise.
- **The deeper horizon and the exposure term make judgements worse**, both in the oracle (placement
  deviations −0.03 and −0.04) and in play (tail: −9.2 points).
- **No default changed in round 7.** GOD stays at about 65% against Master on held-out S–XXL duels
  (65.0% over 480 games here, 65.5% over 960 M/L/XL games). The 72% target was not reached, and none
  of the levers of this round moves it beyond noise.

## Known weaknesses

- **Duel compute.** GOD uses about 2.5× Master's time per decision. At an equal fixed iteration count
  its placement emulation costs much more than Master's search.
- **Humans in duels.** They are modelled as Master-like players (pessimistic but sensible).
- **Six-player stalemates.** Saturated six-player boards can stall. Bots never accept early finishes.
- **Fair fog** (`fairFog`, not the default). Phantom cells doubled the fair brain's score, but it still
  wins only about a quarter of the duels against a Master that sees everything; with a full view in
  rounds 0–3 alone it would win about 68% (fixed budget), so the handicap is the opening information.
- **No pondering on the opponent's turn.** The worker is idle then; only the next position after
  GOD's own attack is pondered. The position after the opponent's turn (dice and placements) is not
  known in advance, and more thinking time did not help in the measurements above, so it was not added.
