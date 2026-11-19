import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { computeRewindTime } from '../mods/features/rewind-on-pause.ts';

describe('computeRewindTime', () => {
  const base = {
    pausedAt: 10_000,
    pausedSrc: 'blob:https://www.youtube.com/abc',
    currentSrc: 'blob:https://www.youtube.com/abc',
    now: 45_000,
    isWatch: true,
    duration: 600,
    currentTime: 120,
  };

  test('rewinds by 5 seconds after >= 30s pause on the same watch video', () => {
    assert.equal(computeRewindTime(base), 115);
    assert.equal(computeRewindTime({ ...base, currentTime: 3 }), 0);
  });

  test('returns null for short pauses, src mismatch, or non-watch pages', () => {
    assert.equal(computeRewindTime({ ...base, now: 39_999 }), null);
    assert.equal(computeRewindTime({ ...base, currentSrc: 'blob:other' }), null);
    assert.equal(computeRewindTime({ ...base, isWatch: false }), null);
    assert.equal(computeRewindTime({ ...base, pausedAt: 0 }), null);
    assert.equal(computeRewindTime({ ...base, currentTime: 1 }), null);
  });
});
