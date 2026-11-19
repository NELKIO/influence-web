/**
 * Which named scenarios are decided by marked control points (hold 2 of 3 until your next turn).
 * Kept apart from scenarios.ts so the engine-side validators can use it without a circular import;
 * SCENARIO_META.objectives must agree (tests/unit/scenario-mechanics.test.ts).
 */

/** Scenarios that had their control points from the start. */
const FIRST_OBJECTIVE_PUZZLES: ReadonlySet<string> = new Set(['crossroads', 'highlands']);

/** Scenarios built with control points (in the gallery, in battles and on the map of the day alike). */
export const OBJECTIVE_PUZZLES: ReadonlySet<string> = new Set([...FIRST_OBJECTIVE_PUZZLES, 'sparks', 'olympus']);

/**
 * Scenarios in which the player may switch on generated frontiers (the absolute-darkness ones, which
 * have no control points of their own); SCENARIO_META's `modes` must agree.
 */
export const FRONTIER_SCENARIOS: ReadonlySet<string> = new Set(['landing', 'moonvale', 'fireflies']);

/** Whether a named scenario match is played for control points. */
export function objectivePuzzle(puzzle: unknown): boolean {
  return typeof puzzle === 'string' && OBJECTIVE_PUZZLES.has(puzzle);
}

/**
 * Scenarios that gained control points later: a game saved before that (also a map of the day, which
 * used to play them without points) has none and stays valid.
 */
export function objectivesOptional(puzzle: unknown): boolean {
  return objectivePuzzle(puzzle) && !FIRST_OBJECTIVE_PUZZLES.has(puzzle as string);
}
