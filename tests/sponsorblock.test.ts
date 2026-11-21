import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { extractWatchVideoId } from '../mods/core/lifecycle.ts';
import type { SponsorBlockSegment } from '../mods/features/sponsorblock.ts';
import {
  BAR_TYPES,
  computeSegmentBarGeometry,
  computeSha256HexPrefix,
  fetchSponsorBlockSegments,
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

describe('fetchSponsorBlockSegments', () => {
  test('requests actionTypes=["skip","poi"] for enabled categories and skips fetch when empty', async (t) => {
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

    const loaded = await fetchSponsorBlockSegments('sbVid1');
    assert.equal(requestedUrls.length, 1);
    const parsedUrl = new URL(requestedUrls[0] ?? '');
    assert.deepEqual(JSON.parse(parsedUrl.searchParams.get('categories') ?? '[]'), [
      'sponsor',
      'intro',
      'outro',
      'interaction',
      'selfpromo',
      'poi_highlight',
    ]);
    assert.deepEqual(JSON.parse(parsedUrl.searchParams.get('actionTypes') ?? '[]'), ['skip', 'poi']);
    assert.deepEqual(
      loaded.map((s) => [s.UUID, s.actionType]),
      [
        ['p1', 'poi'],
        ['s2', 'skip'],
      ]
    );

    status = 404;
    assert.deepEqual(await fetchSponsorBlockSegments('sb404', undefined, ['sponsor']), []);
  });
});
