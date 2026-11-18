import { describe, expect, it } from 'vitest';
import frozen from './fixtures/daily-fingerprints.json';
import { dailyFingerprint } from './dailyFingerprint';

/**
 * Every map of the day of 2026, as published (fingerprints taken from release c0183b0). A redesigned
 * gallery scenario must keep its old builder for the days that use it (LEGACY builders in scenarios.ts).
 */
describe('published maps of the day', () => {
  it('start exactly as they were published', () => {
    const changed = Object.entries(frozen.days as Record<string, string>).filter(([id, fp]) => dailyFingerprint(id) !== fp).map(([id]) => id);
    expect(changed).toEqual([]);
  });
});
