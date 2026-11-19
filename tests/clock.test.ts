import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { computeEndTimeLabel, formatClockTime, getNextClockDelayMs } from '../mods/ui/clock.ts';

describe('clock helpers', () => {
  test('formatClockTime formats 24h and 12h', () => {
    const date = new Date(2026, 0, 1, 14, 5, 9);
    assert.equal(formatClockTime(date, false), '14:05');
    assert.equal(formatClockTime(date, true), '02:05 PM');

    const midnight = new Date(2026, 0, 1, 0, 7, 0);
    assert.equal(formatClockTime(midnight, true), '12:07 AM');
  });

  test('computeEndTimeLabel projects end time and rounds >= 30s up', () => {
    const now = new Date(2026, 0, 1, 10, 0, 0);
    assert.equal(computeEndTimeLabel(now, 120, 0, 1, false), 'Ends 10:02');
    assert.equal(computeEndTimeLabel(now, 120, 0, 2, false), 'Ends 10:01');
    assert.equal(computeEndTimeLabel(now, 90, 0, 1, false), 'Ends 10:02');
    assert.equal(computeEndTimeLabel(now, Number.POSITIVE_INFINITY, 0, 1, false), '');
  });

  test('getNextClockDelayMs aligns to next minute boundary', () => {
    const midMinute = new Date(2026, 0, 1, 10, 0, 15, 250);
    assert.equal(getNextClockDelayMs(midMinute), 44_750);
  });
});
