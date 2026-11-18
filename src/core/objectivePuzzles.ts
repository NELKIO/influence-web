/**
 * Which named scenarios are decided by marked control points (hold 2 of 3 until your next turn).
 * Kept apart from scenarios.ts so the engine-side validators can use it without a circular import;
 * SCENARIO_META.objectives must agree (tests/unit/scenario-mechanics.test.ts).
 */

/** The published maps of the day keep their original rules: only these ever had control points there. */
export const DAILY_OBJECTIVE_PUZZLES: ReadonlySet<string> = new Set(['crossroads', 'highlands']);

/** Gallery and battle scenarios built with control points. */
export const OBJECTIVE_PUZZLES: ReadonlySet<string> = new Set([...DAILY_OBJECTIVE_PUZZLES, 'sparks', 'olympus']);

/**
 * Scenarios in which the player may switch on generated frontiers (the absolute-darkness ones, which
 * have no control points of their own); SCENARIO_META's `modes` must agree.
 */
export const FRONTIER_SCENARIOS: ReadonlySet<string> = new Set(['landing', 'moonvale', 'fireflies']);

/** Whether a named scenario match of this kind is played for control points. */
export function objectivePuzzle(puzzle: unknown, kind: unknown): boolean {
  return typeof puzzle === 'string' && (kind === 'daily' ? DAILY_OBJECTIVE_PUZZLES : OBJECTIVE_PUZZLES).has(puzzle);
}

/** Scenarios that gained control points later: a game saved before that has none and stays valid. */
export function objectivesOptional(puzzle: unknown, kind: unknown): boolean {
  return objectivePuzzle(puzzle, kind) && !DAILY_OBJECTIVE_PUZZLES.has(puzzle as string);
}
