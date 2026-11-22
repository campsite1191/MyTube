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
  onSponsorBlockSegmentsReady,
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

    // Clamps segments extending beyond duration and handles <= 0 / non-finite durations.
    assert.deepEqual(computeSegmentBarGeometry({ UUID: 'over', category: 'unknown', segment: [90, 150] }, 120), {
      leftPercent: 75,
      widthPercent: 25,
      color: 'blue',
      opacity: '0.7',
    });
    assert.deepEqual(computeSegmentBarGeometry({ UUID: 'z', category: 'sponsor', segment: [10, 20] }, 0), {
      leftPercent: 0,
      widthPercent: 0,
      color: '#00d400',
      opacity: '0.7',
    });
    assert.deepEqual(computeSegmentBarGeometry(highlight, Number.NaN), {
      leftPercent: 0,
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
          replaceChildren: (...els: unknown[]) => {
            children.length = 0;
            children.push(...els);
          },
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

    const uninstallSponsorBlock = installSponsorBlock();
    t.after(uninstallSponsorBlock);
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

  test('handles A->B /next-before-hashchange race, durationchange bar rescaling, host re-attach, waitingForTrack, and errors', async (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevDocument = globals.document;
    const prevFetch = globals.fetch;
    const prevCssStyleSheet = globals.CSSStyleSheet;
    const prevMutationObserver = globals.MutationObserver;

    const winListeners = new Map<string, Set<() => void>>();
    const videoListeners = new Map<string, Set<() => void>>();
    const observers: Array<{ target: unknown; cb: (m: unknown[]) => void }> = [];
    const fakeLocation = { hash: '#/', search: '' };
    const appendedOverlays: Array<{
      children: Array<{ style: { cssText: string } }>;
      style: Record<string, string> & { setProperty: (k: string, v: string) => void };
    }> = [];

    let mountTrack = false;
    const trackEl = {
      classList: { contains: () => false, [Symbol.iterator]: () => ['customTrack'][Symbol.iterator]() },
      getBoundingClientRect: () => ({ left: 10, top: 5, width: 800, height: 8 }),
    };
    const hostEl = {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 20 }),
      appendChild: (el: (typeof appendedOverlays)[number]) => appendedOverlays.push(el),
    };
    const barEl = {
      isConnected: true,
      getAttribute: () => 'true',
      classList: { contains: () => false },
    };
    const videoEl = {
      duration: 100,
      addEventListener: (type: string, fn: () => void, opts?: { signal?: AbortSignal }) => {
        if (opts?.signal?.aborted) return;
        const set = videoListeners.get(type) ?? new Set();
        set.add(fn);
        videoListeners.set(type, set);
        opts?.signal?.addEventListener('abort', () => set.delete(fn), { once: true });
      },
    };

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
      private readonly cb: (m: unknown[]) => void;
      constructor(cb: (m: unknown[]) => void) {
        this.cb = cb;
      }
      observe(target: unknown): void {
        observers.push({ target, cb: this.cb });
      }
      disconnect(): void {}
    };
    globals.window = {
      location: fakeLocation,
      addEventListener: (type: string, fn: () => void) => {
        const set = winListeners.get(type) ?? new Set();
        set.add(fn);
        winListeners.set(type, set);
      },
      removeEventListener: (type: string, fn: () => void) => {
        winListeners.get(type)?.delete(fn);
      },
    };
    globals.document = {
      body: {},
      documentElement: {},
      adoptedStyleSheets: [],
      createElement: () => {
        const children: Array<{ style: { cssText: string } }> = [];
        const styleObj: Record<string, unknown> = {
          display: '',
          setProperty: (k: string, v: string) => {
            styleObj[k] = v;
          },
        };
        return {
          classList: { add: () => {} },
          style: styleObj,
          children,
          append: (...els: Array<{ style: { cssText: string } }>) => children.push(...els),
          replaceChildren: (...els: Array<{ style: { cssText: string } }>) => {
            children.length = 0;
            children.push(...els);
          },
          remove: () => {},
        };
      },
      querySelector: (sel: string) => {
        if (sel === 'video') return videoEl;
        if (mountTrack && sel.includes('slider')) return trackEl;
        if (mountTrack && sel === 'ytlr-redux-connect-ytlr-progress-bar') return hostEl;
        if (sel === 'ytlr-progress-bar') return barEl;
        return null;
      },
    };

    const resolvers = new Map<string, (resp: Response) => void>();
    let rejectNext = false;
    let abortMidDigest = false;
    globals.fetch = ((url: unknown, init?: { signal?: AbortSignal }) => {
      if (rejectNext) {
        rejectNext = false;
        return Promise.reject(new Error('network down'));
      }
      const key = String(url);
      return new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        resolvers.set(key, resolve);
      });
    }) as typeof fetch;

    const uninstallSponsorBlock = installSponsorBlock();
    t.after(uninstallSponsorBlock);

    // 1. Start Watch on vidA.
    fakeLocation.hash = '#/watch?v=raceVidA';
    for (const fn of winListeners.get('hashchange') ?? []) fn();

    // 2. /next for raceVidB arrives BEFORE hashchange to raceVidB.
    onSponsorBlockSegmentsReady('staleOldVid', () => {
      assert.fail('stale queued listener should be cleared when newer video queues');
    });
    let bNotified = 0;
    onSponsorBlockSegmentsReady('raceVidB', () => {
      bNotified++;
    });
    // Also verify stale listener replacement when an even newer video queues.
    onSponsorBlockSegmentsReady('raceVidB', () => {
      bNotified++;
    });

    // Switch to raceVidB -> raceVidA's abort must NOT wipe raceVidB's queued listeners.
    fakeLocation.hash = '#/watch?v=raceVidB';
    for (const fn of winListeners.get('hashchange') ?? []) fn();

    const hashB = await computeSha256HexPrefix('raceVidB', 4);
    await new Promise((r) => setTimeout(r, 15));
    const entryB = [...resolvers.entries()].find(([u]) => u.includes(hashB));
    entryB?.[1](
      new Response(
        JSON.stringify([{ videoID: 'raceVidB', segments: [{ UUID: 'b1', category: 'sponsor', segment: [10, 30] }] }]),
        { status: 200 }
      )
    );
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(bNotified, 2);

    // Immediate hit path for already-loaded active video.
    let immediateHit = 0;
    onSponsorBlockSegmentsReady('raceVidB', (segs) => {
      immediateHit = segs.length;
    });
    assert.equal(immediateHit, 1);

    // durationchange before overlay mounts takes buildOverlay() fallback safely.
    for (const fn of videoListeners.get('durationchange') ?? []) fn();

    // waitingForTrack observer mounts overlay once track appears; host observer re-attaches removed overlay.
    mountTrack = true;
    for (const obs of observers.filter(
      (o) => o.target === globals.document || o.target === (globals.document as { body: unknown }).body
    )) {
      obs.cb([]);
    }
    assert.equal(appendedOverlays.length, 1);
    const overlay = appendedOverlays[0];
    assert.ok(overlay);
    assert.match(overlay.children[0]?.style.cssText ?? '', /width:\s*20%/);

    // durationchange rescales bars from 100s -> 200s (width halves to 10%).
    videoEl.duration = 200;
    for (const fn of videoListeners.get('durationchange') ?? []) fn();
    assert.match(overlay.children[0]?.style.cssText ?? '', /width:\s*10%/);

    // Host observer re-appends overlay when removed by Incremental DOM.
    const hostObs = observers.find((o) => o.target === hostEl);
    assert.ok(hostObs);
    hostObs.cb([{ removedNodes: [overlay] }]);
    assert.equal(appendedOverlays.length, 2);

    // Network rejection is handled without crashing; abort after digest returns [].
    const origWarn = console.warn;
    let warnCount = 0;
    console.warn = () => {
      warnCount++;
    };
    try {
      rejectNext = true;
      fakeLocation.hash = '#/watch?v=errVid1';
      for (const fn of winListeners.get('hashchange') ?? []) fn();
      await new Promise((r) => setTimeout(r, 15));
      assert.equal(warnCount, 1);

      const abCtrl = new AbortController();
      abortMidDigest = true;
      const pDigest = fetchSponsorBlockSegments('digestVid');
      const pAbort = fetchSponsorBlockSegments('digestVid', abCtrl.signal);
      abCtrl.abort();
      assert.deepEqual(await pAbort, []);
      void pDigest;
      void abortMidDigest;
    } finally {
      console.warn = origWarn;
      fakeLocation.hash = '#/';
      for (const fn of winListeners.get('hashchange') ?? []) fn();
    }
  });
});
