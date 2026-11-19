import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  BAR_TYPES,
  computeSegmentBarGeometry,
  computeSha256HexPrefix,
  computeSkipDelayMs,
  computeTargetTimeAfterSkip,
  extractWatchVideoId,
  findNextSegment,
  getEnabledSkipCategories,
  getSuppressionDecision,
} from '../mods/features/sponsorblock.ts';
import type { SponsorBlockSegment } from '../mods/features/sponsorblock.ts';

describe('computeSha256HexPrefix', () => {
  test('computes native WebCrypto SHA-256 hex prefixes for SponsorBlock API lookup', async () => {
    // SHA-256("dQw4w9WgXcQ") starts with "8f1c..."
    const prefix = await computeSha256HexPrefix('dQw4w9WgXcQ', 4);
    assert.equal(prefix.length, 4);
    assert.match(prefix, /^[0-9a-f]{4}$/);

    // Verify full 8-char prefix determinism
    const longer = await computeSha256HexPrefix('dQw4w9WgXcQ', 8);
    assert.equal(longer.slice(0, 4), prefix);
  });
});

describe('extractWatchVideoId', () => {
  test('extracts v parameter from YouTube TV hash routes', () => {
    assert.equal(extractWatchVideoId('#/watch?v=abc123XYZ'), 'abc123XYZ');
    assert.equal(extractWatchVideoId('#/watch?list=PL1&v=vid_99&t=12'), 'vid_99');
    assert.equal(extractWatchVideoId('/watch?v=directId'), 'directId');
    assert.equal(extractWatchVideoId('#/'), null);
    assert.equal(extractWatchVideoId('#/browse?c=FEtopics'), null);
    assert.equal(extractWatchVideoId(''), null);
  });
});

describe('getEnabledSkipCategories', () => {
  test('returns only categories whose config toggles are enabled', () => {
    const enabledSet = new Set(['enableSponsorBlockSponsor', 'enableSponsorBlockOutro', 'enableSponsorBlockFiller']);
    const categories = getEnabledSkipCategories((key) => enabledSet.has(key));
    assert.deepEqual(categories, ['sponsor', 'outro', 'filler']);
    assert.deepEqual(getEnabledSkipCategories(() => false), []);
  });
});

describe('findNextSegment and timing calculations', () => {
  const segments: SponsorBlockSegment[] = [
    { UUID: 'seg-2', category: 'outro', segment: [90, 100] },
    { UUID: 'seg-1', category: 'sponsor', segment: [10, 25] },
    { UUID: 'seg-past', category: 'intro', segment: [0, 5] },
  ];

  test('picks earliest upcoming segment within the lookback window', () => {
    assert.equal(findNextSegment(segments, 0)?.UUID, 'seg-past');
    assert.equal(findNextSegment(segments, 6)?.UUID, 'seg-1');
    assert.equal(findNextSegment(segments, 10.2)?.UUID, 'seg-1');
    assert.equal(findNextSegment(segments, 26)?.UUID, 'seg-2');
    assert.equal(findNextSegment(segments, 101), null);
  });

  test('computes non-negative skip delay and clamps end time near video end', () => {
    assert.equal(computeSkipDelayMs(10, 8.5), 1500);
    assert.equal(computeSkipDelayMs(10, 10.2), 0);
    assert.equal(computeTargetTimeAfterSkip(25, 120), 25);
    assert.equal(computeTargetTimeAfterSkip(100, 100.4), 99);
    assert.equal(computeTargetTimeAfterSkip(0.5, 0.8), 0);
  });
});

describe('computeSegmentBarGeometry', () => {
  test('calculates bar percentages and special poi_highlight width', () => {
    const sponsor: SponsorBlockSegment = { UUID: 's', category: 'sponsor', segment: [30, 60] };
    assert.deepEqual(computeSegmentBarGeometry(sponsor, 120), {
      leftPercent: 25,
      widthPercent: 25,
      color: BAR_TYPES.sponsor?.color ?? '#00d400',
      opacity: '0.7',
    });

    const highlight: SponsorBlockSegment = { UUID: 'h', category: 'poi_highlight', segment: [60, 61] };
    assert.equal(computeSegmentBarGeometry(highlight, 120).widthPercent, 1);
    assert.equal(computeSegmentBarGeometry(highlight, 120).leftPercent, 50);
  });
});

describe('getSuppressionDecision', () => {
  test('suppresses rapid repeat skips within 1 second and shows toast once', () => {
    let state = { count: 1, firstSkipped: 1000, lastSkipped: 1000, hasShownToast: false };
    
    const d1 = getSuppressionDecision(state, 1200, 1000);
    assert.deepEqual({ suppress: d1.suppress, showToast: d1.showToast }, { suppress: true, showToast: true });
    state = d1.newState;
    assert.equal(state.count, 2);

    const d2 = getSuppressionDecision(state, 1500, 1000);
    assert.deepEqual({ suppress: d2.suppress, showToast: d2.showToast }, { suppress: true, showToast: false });
    state = d2.newState;
    assert.equal(state.count, 3);

    const d3 = getSuppressionDecision(state, 2500, 1000);
    assert.deepEqual({ suppress: d3.suppress, showToast: d3.showToast }, { suppress: false, showToast: false });
  });
});
