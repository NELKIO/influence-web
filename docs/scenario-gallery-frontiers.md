# Scenario gallery and generated frontiers implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Put configurable and new scenarios first, add Colonies and more varied frontier boards, and offer frontier victories on generated battlefields.

**Architecture:** The gallery owns ordering and new variants; the published daily schedule and its board recipes stay frozen. Ordinary battles opt into the existing three-objective win rule in their match settings. The core places objectives from the deterministic field graph and shares their indices with the preview and game.

**Tech Stack:** TypeScript, Preact, Vitest, Playwright.

**Spec:** User-approved design in the conversation: Night Drop first, then new cards; keep both named frontier scenarios; add a frontier toggle for generated maps; add Colonies in place of one old card; use the Night Drop unknown-map treatment for the two dark scenarios.

## Global constraints

- Keep 32 playable gallery cards. Remove Thermopylae from the gallery, not from the published daily calendar or historical builders.
- Do not change previously published daily assignments or their start positions.
- Default the new experimental option to off. Fixed scenarios keep their own rules. Never reveal hidden geometry or objective coordinates in an absolute-darkness preview.
- Run heavy simulations in the isolated simulation-host workspace, then remove only our files and processes and verify cleanup.

### Task 1: Gallery catalog, scenario designs, and legacy dailies

Files: `src/core/scenarios.ts`, `src/daily.ts`, `tests/unit/scenario-designs.test.ts`, `tests/unit/scenarios.test.ts`.

- [x] Add failing deterministic tests for gallery order, blind scouts, neighboring equal-strength bases and scattered flank colonies, and several distinct, connected frontier topologies after normalizing rotation. Capture baseline daily layouts for affected IDs before edits.
- [x] Implement Colonies, unknown exploration for the two scout cards, and wider shape variation on Crossroads and Highlands without one-cell bottlenecks. Keep three reachable neutral points per frontier map.
- [x] Preserve daily rules and builders for changed IDs using a separate daily build entry point. Verify targeted unit tests and historical snapshots.

### Task 2: Generated frontier mode

Files: `src/core/{types,engine,objectives}.ts`, `src/storage.ts`, network validation as needed, `src/ui/components/{ExperimentalModes,MiniMap}.tsx`, `src/ui/screens/SetupScreen.tsx`, `src/i18n/{ru,en}.ts`, objective and browser tests.

- [x] Add failing tests that opt in across generated sizes and player counts, check deterministic separation and reachability, verify setup persistence and that preview points match the started game. Include online setup/validation and darkness interaction.
- [x] Persist `frontierMode` in ordinary battle setup. Choose three initially neutral points with meaningful separation and accessible paths independently of combat RNG. In Crowded, reserve those three before dealing the rest of the cells evenly. Reuse the existing objective victory system. Hide coordinates in an unknown-map preview and preserve normal darkness semantics.
- [x] Keep Duels and fixed scenarios unchanged. Validate generated goals with saves and battle snapshots, version the incompatible battle protocol, and make the setup preview use the same seed/seat shuffling flow as the host so the generated geometry and points match online as well as locally. Use existing `frontierMode` and `frontierModeDesc` locale keys.

### Task 3: Integration verification

- [x] Run typecheck, production build, the unit suite, and browser coverage for gallery order, unknown-map cards, rerolling and playing the preview, and the experimental toggle.
- [x] Run representative gameplay checks on the simulation host and verify its workspace and processes are clean.

**Verification:** 795 unit tests passed on the server using Node 22. Full Playwright: 317 passed, 34 skipped. After the last fixes, the build, 57 focused unit tests, and focused browser suites for frontier placement and medals passed. The final 48 generated smoke games all finished within 14 rounds, including the replay of the previously stalled small walled map. Direct comparison with `a5540e2` found no changes to complete daily starts or schedules over 396 dates; the legacy Thermopylae medal remains earnable without counting it in gallery progress.
