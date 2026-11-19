import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { formatClockTime, formatRemainingLabel, parseClockSeconds } from '../mods/features/remaining-time.ts';

describe('remaining-time helpers', () => {
  test('parseClockSeconds parses mm:ss and h:mm:ss', () => {
    assert.equal(parseClockSeconds('1:05'), 65);
    assert.equal(parseClockSeconds('1:02:03'), 3723);
    assert.equal(parseClockSeconds('invalid'), null);
  });

  test('formatClockTime formats short and hour-long durations', () => {
    assert.equal(formatClockTime(65), '1:05');
    assert.equal(formatClockTime(3723), '1:02:03');
    assert.equal(formatClockTime(-5), '0:00');
  });

  test('formatRemainingLabel appends remaining time and preserves suffix', () => {
    assert.equal(formatRemainingLabel('1:00', 180, 60, null, false), '1:00 (-2:00)');
    assert.equal(formatRemainingLabel('1:00 (-9:99) / 3:00', 180, 60, 180, false), '1:00 (-2:00) / 3:00');
    assert.equal(formatRemainingLabel('3:00', 180, 60, null, true), '3:00 (-2:00)');
  });
});
