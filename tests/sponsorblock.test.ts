import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { extractWatchVideoId } from '../mods/core/lifecycle.ts';
import type { SponsorBlockSegment } from '../mods/features/sponsorblock.ts';
import {
  BAR_TYPES,
  computeSegmentBarGeometry,
  computeSha256HexPrefix,
  fetchSponsorBlockSegments,
  getActiveSponsorBlockSegments,
  installSponsorBlock,
} from '../mods/features/sponsorblock.ts';
import { transformPlayerOverlays, transformTransportControls } from '../mods/transforms/player-overlays.ts';

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

  test('installSponsorBlock injects timely actions and highlight button even when /next parses before SponsorBlock responds', async (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevDocument = globals.document;
    const prevFetch = globals.fetch;
    const prevCssStyleSheet = globals.CSSStyleSheet;
    const prevMutationObserver = globals.MutationObserver;

    const winListeners = new Map<string, Set<() => void>>();
    const fakeLocation = { hash: '#/', search: '' };
    let resolveFetch!: (resp: Response) => void;

    t.after(() => {
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
      globals.fetch = prevFetch;
      if (prevCssStyleSheet === undefined) delete globals.CSSStyleSheet;
      else globals.CSSStyleSheet = prevCssStyleSheet;
      if (prevMutationObserver === undefined) delete globals.MutationObserver;
      else globals.MutationObserver = prevMutationObserver;
    });

    globals.CSSStyleSheet = class {
      cssText = '';
      replaceSync(text: string): void {
        this.cssText = text;
      }
    };
    globals.MutationObserver = class {
      observe(): void {}
      disconnect(): void {}
    };
    globals.window = {
      location: fakeLocation,
      addEventListener: (type: string, fn: () => void) => {
        const set = winListeners.get(type) ?? new Set();
        set.add(fn);
        winListeners.set(type, set);
      },
    };
    const trackEl = {
      classList: { contains: () => false, [Symbol.iterator]: () => [][Symbol.iterator]() },
      getBoundingClientRect: () => ({ left: 10, top: 5, width: 800, height: 8 }),
    };
    const appendedOverlays: Array<{ children: unknown[] }> = [];
    const hostEl = {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 20 }),
      appendChild: (el: { children: unknown[] }) => appendedOverlays.push(el),
    };
    const barEl = {
      isConnected: true,
      getAttribute: () => 'true',
      classList: { contains: () => false },
    };
    const videoEl = {
      duration: 200,
      addEventListener: () => {},
    };
    globals.document = {
      body: {},
      documentElement: {},
      adoptedStyleSheets: [],
      createElement: () => {
        const children: unknown[] = [];
        return {
          classList: { add: () => {} },
          style: { display: '', setProperty: () => {} },
          children,
          append: (...els: unknown[]) => children.push(...els),
          remove: () => {},
        };
      },
      querySelector: (sel: string) => {
        if (sel === 'video') return videoEl;
        if (sel.includes('slider')) return trackEl;
        if (sel === 'ytlr-redux-connect-ytlr-progress-bar') return hostEl;
        if (sel === 'ytlr-progress-bar') return barEl;
        return null;
      },
    };
    globals.fetch = (() =>
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      })) as typeof fetch;

    installSponsorBlock();
    fakeLocation.hash = '#/watch?v=raceVid1';
    for (const fn of winListeners.get('hashchange') ?? []) fn();

    // /youtubei/v1/next arrives while fetchSponsorBlockSegments is still pending
    const nextPayload: Record<string, unknown> = {
      currentVideoEndpoint: { watchEndpoint: { videoId: 'raceVid1' } },
      playerOverlays: {
        playerOverlayRenderer: {
          timelyActionRenderers: [{ timelyActionRenderer: { type: 'TIMELY_ACTION_TYPE_SHOPPING' } }],
        },
      },
      transportControls: {
        transportControlsRenderer: {
          promotedActions: [],
        },
      },
    };
    transformPlayerOverlays(nextPayload);
    transformTransportControls(nextPayload);

    const timelyList = (nextPayload.playerOverlays as { playerOverlayRenderer: { timelyActionRenderers: unknown[] } })
      .playerOverlayRenderer.timelyActionRenderers;
    const promotedList = (
      nextPayload.transportControls as { transportControlsRenderer: { promotedActions: unknown[] } }
    ).transportControlsRenderer.promotedActions;
    assert.equal(timelyList.length, 0);
    assert.equal(promotedList.length, 0);

    // Wait for computeSha256HexPrefix to reach fetch, then resolve SponsorBlock segments
    await new Promise((r) => setTimeout(r, 15));
    resolveFetch(
      new Response(
        JSON.stringify([
          {
            videoID: 'raceVid1',
            segments: [
              { UUID: 'skip1', category: 'sponsor', actionType: 'skip', segment: [15, 30] },
              { UUID: 'poi1', category: 'poi_highlight', actionType: 'poi', segment: [45, 45] },
            ],
          },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(getActiveSponsorBlockSegments('raceVid1').length, 2);
    assert.equal(getActiveSponsorBlockSegments('otherVid').length, 0);
    assert.equal(timelyList.length, 1);
    assert.equal(promotedList.length, 1);
    assert.equal(appendedOverlays.length, 1);
    assert.equal(appendedOverlays[0]?.children.length, 2);

    // Navigating away clears activeSegments
    fakeLocation.hash = '#/';
    for (const fn of winListeners.get('hashchange') ?? []) fn();
    assert.equal(getActiveSponsorBlockSegments().length, 0);
  });
});
