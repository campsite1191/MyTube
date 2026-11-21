import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { extractWatchVideoId } from '../mods/core/lifecycle.ts';
import type { MuteState, SponsorBlockSegment } from '../mods/features/sponsorblock.ts';
import {
  BAR_TYPES,
  computeMuteTransition,
  computeSegmentBarGeometry,
  computeSha256HexPrefix,
  computeSkipDelayMs,
  computeTargetTimeAfterSkip,
  fetchSponsorBlockSegments,
  findActiveMuteSegment,
  findNextSegment,
  getEnabledSkipCategories,
  getRequestedCategories,
  getSuppressionDecision,
} from '../mods/features/sponsorblock.ts';

describe('computeSha256HexPrefix', () => {
  test('computes native WebCrypto SHA-256 hex prefixes for SponsorBlock API lookup', async () => {
    const prefix = await computeSha256HexPrefix('dQw4w9WgXcQ', 4);
    assert.equal(prefix.length, 4);
    assert.match(prefix, /^[0-9a-f]{4}$/);

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

describe('category selection helpers', () => {
  test('returns only enabled skip categories and includes poi_highlight when highlight is enabled', () => {
    const enabledSet = new Set([
      'enableSponsorBlockSponsor',
      'enableSponsorBlockOutro',
      'enableSponsorBlockFiller',
      'enableSponsorBlockHighlight',
    ]);
    assert.deepEqual(
      getEnabledSkipCategories((key) => enabledSet.has(key)),
      ['sponsor', 'outro', 'filler']
    );
    assert.deepEqual(
      getRequestedCategories((key) => enabledSet.has(key)),
      ['sponsor', 'outro', 'filler', 'poi_highlight']
    );
    assert.deepEqual(
      getRequestedCategories(() => false),
      []
    );
  });
});

describe('findNextSegment, mute state, and timing calculations', () => {
  const segments: SponsorBlockSegment[] = [
    { UUID: 'poi-1', category: 'poi_highlight', actionType: 'poi', segment: [5, 5] },
    { UUID: 'mute-1', category: 'sponsor', actionType: 'mute', segment: [6, 9] },
    { UUID: 'seg-2', category: 'outro', actionType: 'skip', segment: [90, 100] },
    { UUID: 'seg-1', category: 'sponsor', actionType: 'skip', segment: [10, 25] },
    { UUID: 'seg-past', category: 'intro', segment: [0, 5] },
  ];

  test('picks earliest upcoming skip segment while ignoring poi and mute segments', () => {
    assert.equal(findNextSegment(segments, 0)?.UUID, 'seg-past');
    // Lookback window (currentTime - 0.3): at 0.2s, seg-past (start 0 > -0.1) is still eligible; at 4.9s, poi-1 & mute-1 are ignored in favor of seg-1.
    assert.equal(findNextSegment(segments, 0.2)?.UUID, 'seg-past');
    assert.equal(findNextSegment(segments, 4.9)?.UUID, 'seg-1');
    assert.equal(findNextSegment(segments, 6)?.UUID, 'seg-1');
    assert.equal(findNextSegment(segments, 10.2)?.UUID, 'seg-1');
    assert.equal(findNextSegment(segments, 26)?.UUID, 'seg-2');
    assert.equal(findNextSegment(segments, 101), null);
  });

  test('finds active mute segments and restores prior mute state cleanly', () => {
    const manualNone = new Set<string>();
    const manualSponsor = new Set<string>(['sponsor']);

    assert.equal(findActiveMuteSegment(segments, 5.9, manualNone), null);
    assert.equal(findActiveMuteSegment(segments, 6, manualNone)?.UUID, 'mute-1');
    assert.equal(findActiveMuteSegment(segments, 8.9, manualNone)?.UUID, 'mute-1');
    assert.equal(findActiveMuteSegment(segments, 9, manualNone), null);
    assert.equal(findActiveMuteSegment(segments, 7, manualSponsor), null);

    // Entering mute from unmuted video mutes audio, then restores unmuted on exit
    const initial: MuteState = { activeMuteUuid: null, priorVideoMuted: false };
    const enter = computeMuteTransition(initial, segments[1] ?? null, false);
    assert.equal(enter.nextMuted, true);
    assert.equal(enter.toastSegment?.UUID, 'mute-1');

    const stay = computeMuteTransition(enter.state, segments[1] ?? null, true);
    assert.equal(stay.nextMuted, null);
    assert.equal(stay.toastSegment, null);

    const exit = computeMuteTransition(stay.state, null, true);
    assert.equal(exit.nextMuted, false);
    assert.deepEqual(exit.state, initial);

    // Entering mute when user already muted preserves true on exit
    const preMutedEnter = computeMuteTransition(initial, segments[1] ?? null, true);
    assert.equal(preMutedEnter.nextMuted, true);
    const preMutedExit = computeMuteTransition(preMutedEnter.state, null, true);
    assert.equal(preMutedExit.nextMuted, true);
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
  test('calculates bar percentages and official poi_highlight marker color and width', () => {
    const sponsor: SponsorBlockSegment = { UUID: 's', category: 'sponsor', segment: [30, 60] };
    assert.deepEqual(computeSegmentBarGeometry(sponsor, 120), {
      leftPercent: 25,
      widthPercent: 25,
      color: BAR_TYPES.sponsor?.color ?? '#00d400',
      opacity: '0.7',
    });

    const highlight: SponsorBlockSegment = {
      UUID: 'h',
      category: 'poi_highlight',
      actionType: 'poi',
      segment: [60, 60],
    };
    assert.deepEqual(computeSegmentBarGeometry(highlight, 120), {
      leftPercent: 50,
      widthPercent: 1,
      color: '#ff1684',
      opacity: '0.7',
    });
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

describe('fetchSponsorBlockSegments', () => {
  test('requests actionTypes=["skip","poi","mute"] for enabled categories and skips fetch when empty', async (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevFetch = globals.fetch;
    const requestedUrls: string[] = [];
    let status = 200;

    t.after(() => {
      globals.fetch = prevFetch;
    });

    globals.fetch = (async (input: unknown): Promise<Response> => {
      requestedUrls.push(String(input));
      if (status !== 200) return new Response(null, { status });
      return new Response(
        JSON.stringify([
          {
            videoID: 'sbVid1',
            segments: [
              { UUID: 's2', category: 'outro', actionType: 'skip', segment: [90, 100] },
              { UUID: 'm1', category: 'sponsor', actionType: 'mute', segment: [15, 20] },
              { UUID: 'p1', category: 'poi_highlight', segment: [5, 5] },
            ],
          },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    // Empty categories skips network fetch completely.
    assert.deepEqual(await fetchSponsorBlockSegments('sbVid1', undefined, []), []);
    assert.equal(requestedUrls.length, 0);

    const loaded = await fetchSponsorBlockSegments('sbVid1', undefined, ['sponsor', 'poi_highlight']);
    assert.equal(requestedUrls.length, 1);
    const parsedUrl = new URL(requestedUrls[0] ?? '');
    assert.deepEqual(JSON.parse(parsedUrl.searchParams.get('categories') ?? '[]'), ['sponsor', 'poi_highlight']);
    assert.deepEqual(JSON.parse(parsedUrl.searchParams.get('actionTypes') ?? '[]'), ['skip', 'poi', 'mute']);
    assert.deepEqual(
      loaded.map((s) => [s.UUID, s.actionType]),
      [
        ['p1', 'poi'],
        ['m1', 'mute'],
        ['s2', 'skip'],
      ]
    );

    status = 404;
    assert.deepEqual(await fetchSponsorBlockSegments('sb404', undefined, ['sponsor']), []);
  });
});
