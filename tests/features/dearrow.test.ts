import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { DeArrowBrandingResponse } from '../../mods/features/dearrow.ts';
import {
  abortPendingDeArrowRequests,
  applyDeArrowBranding,
  applyDeArrowBrandingToItem,
  clearDeArrowCache,
  installDeArrow,
  resolveDeArrowBranding,
  selectHighestVotedEntry,
  setupMemoryPressureListener,
} from '../../mods/features/dearrow.ts';
import type { FeedItem, LockupViewModel, TileRenderer } from '../../mods/types/innertube.ts';

function createTileFeedItem(overrides: Partial<TileRenderer> = {}): {
  entry: FeedItem;
  tile: TileRenderer;
} {
  const tile: TileRenderer = {
    style: 'TILE_STYLE_YTLR_DEFAULT',
    contentId: 'tile-fallback-id',
    header: {
      tileHeaderRenderer: {
        thumbnail: {
          thumbnails: [{ url: 'https://i.ytimg.com/vi/vid1/hqdefault.jpg', width: 480, height: 360 }],
        },
      },
    },
    metadata: {
      tileMetadataRenderer: {
        title: { simpleText: 'Original Tile Title' },
      },
    },
    onSelectCommand: {
      watchEndpoint: { videoId: 'vid1' },
    },
    ...overrides,
  };

  return { entry: { tileRenderer: tile }, tile };
}

function createLockupFeedItem(overrides: Partial<LockupViewModel> = {}): {
  entry: FeedItem;
  lockup: LockupViewModel;
} {
  const lockup: LockupViewModel = {
    contentId: 'lockup-vid-1',
    contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
    contentImage: {
      thumbnailViewModel: {
        image: {
          sources: [{ url: 'https://i.ytimg.com/vi/lockup-vid-1/hqdefault.jpg', width: 480, height: 360 }],
        },
      },
    },
    metadata: {
      lockupMetadataViewModel: {
        title: { content: 'Original Lockup Title' },
      },
    },
    ...overrides,
  };

  return { entry: { lockupViewModel: lockup }, lockup };
}

describe('DeArrow branding helpers', () => {
  test('selectHighestVotedEntry ignores negative unlocked votes, handles ties, and prioritizes locked entries', () => {
    assert.equal(selectHighestVotedEntry([]), null);
    assert.equal(selectHighestVotedEntry([{ title: 'Spam', votes: -3 }]), null);
    assert.deepEqual(
      selectHighestVotedEntry([
        { title: 'First', votes: 3 },
        { title: 'Tied', votes: 3 },
        { title: 'Lower', votes: 1 },
      ]),
      { title: 'First', votes: 3 }
    );
    assert.deepEqual(
      selectHighestVotedEntry([
        { title: 'Low', votes: 1 },
        { title: 'Winner', votes: 9 },
      ]),
      { title: 'Winner', votes: 9 }
    );
    assert.deepEqual(
      selectHighestVotedEntry([
        { title: 'Popular Unlocked', votes: 100, locked: false },
        { title: 'Locked Low', votes: -1, locked: true },
        { title: 'Locked Higher', votes: 2, locked: true },
      ]),
      { title: 'Locked Higher', votes: 2, locked: true }
    );
  });

  test('applyDeArrowBrandingToItem updates titles, prepends thumbnail once, honors original entries, and preserves fallbacks', () => {
    const branding: DeArrowBrandingResponse = {
      titles: [
        { title: 'Less Voted', votes: 1 },
        { title: 'Clean Title', votes: 5 },
      ],
      thumbnails: [{ timestamp: 42.5, votes: 3 }],
    };

    const runsTile = createTileFeedItem({
      metadata: { tileMetadataRenderer: { title: { runs: [{ text: 'Clickbait!' }] } } },
    });
    applyDeArrowBrandingToItem(runsTile.entry, 'vid1', { titles: branding.titles });
    assert.deepEqual(runsTile.tile.metadata?.tileMetadataRenderer?.title?.runs, [{ text: 'Clean Title' }]);
    assert.equal(runsTile.tile.header?.tileHeaderRenderer?.thumbnail?.thumbnails?.length, 1);

    const lockupCase = createLockupFeedItem();
    applyDeArrowBrandingToItem(lockupCase.entry, 'lockup-vid-1', branding);
    applyDeArrowBrandingToItem(lockupCase.entry, 'lockup-vid-1', branding);
    assert.equal(lockupCase.lockup.metadata?.lockupMetadataViewModel?.title?.content, 'Clean Title');
    const sources = lockupCase.lockup.contentImage?.thumbnailViewModel?.image?.sources;
    assert.equal(
      sources?.[0]?.url,
      'https://dearrow-thumb.ajay.app/api/v1/getThumbnail?videoID=lockup-vid-1&time=42.5'
    );
    assert.equal(sources?.length, 2);

    const originalCase = createLockupFeedItem();
    applyDeArrowBrandingToItem(originalCase.entry, 'lockup-vid-1', {
      titles: [{ title: 'Ignored Original', votes: 10, locked: true, original: true }],
      thumbnails: [{ timestamp: 10, votes: 10, locked: true, original: true }],
    });
    assert.equal(originalCase.lockup.metadata?.lockupMetadataViewModel?.title?.content, 'Original Lockup Title');
    assert.equal(
      originalCase.lockup.contentImage?.thumbnailViewModel?.image?.sources?.[0]?.url,
      'https://i.ytimg.com/vi/lockup-vid-1/hqdefault.jpg'
    );

    const emptyFromOriginal = resolveDeArrowBranding({
      titles: [{ title: 'Ignored', votes: 5, original: true }],
      thumbnails: [{ timestamp: 10, votes: 5, original: true }],
    });
    const emptyFromMissing = resolveDeArrowBranding({});
    assert.equal(emptyFromOriginal, emptyFromMissing);
    assert.deepEqual(
      resolveDeArrowBranding({
        titles: [{ title: 'Kept', votes: 3 }],
        thumbnails: [{ timestamp: 14, votes: 2 }],
      }),
      { title: 'Kept', timestamp: 14 }
    );
  });

  test('applyDeArrowBranding fetches only for valid videos and survives HTTP/network errors', async () => {
    const tileCase = createTileFeedItem();
    const richLockupCase = createLockupFeedItem();
    const channelCase = createTileFeedItem({ contentType: 'TILE_CONTENT_TYPE_CHANNEL' });
    const failingVideoCase = createTileFeedItem({
      onSelectCommand: { watchEndpoint: { videoId: 'fail-vid' } },
    });

    const requestedUrls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requestedUrls.push(requestUrl);

      if (requestUrl.includes('fail-vid')) {
        return new Response(null, { status: 404 });
      }

      return new Response(
        JSON.stringify({
          titles: [{ title: 'Fetched Clean Title', votes: 4 }],
          thumbnails: [{ timestamp: 12, votes: 2 }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof globalThis.fetch;

    try {
      await applyDeArrowBranding([
        tileCase.entry,
        { richItemRenderer: { content: richLockupCase.entry } },
        channelCase.entry,
        failingVideoCase.entry,
      ]);

      globalThis.fetch = (async (): Promise<Response> => {
        throw new Error('Network offline');
      }) as typeof globalThis.fetch;
      await assert.doesNotReject(() => applyDeArrowBranding([failingVideoCase.entry]));
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.deepEqual(requestedUrls, [
      'https://sponsor.ajay.app/api/branding?videoID=vid1',
      'https://sponsor.ajay.app/api/branding?videoID=lockup-vid-1',
      'https://sponsor.ajay.app/api/branding?videoID=fail-vid',
    ]);
    assert.equal(tileCase.tile.metadata?.tileMetadataRenderer?.title?.simpleText, 'Fetched Clean Title');
    assert.equal(richLockupCase.lockup.metadata?.lockupMetadataViewModel?.title?.content, 'Fetched Clean Title');
    assert.equal(failingVideoCase.tile.metadata?.tileMetadataRenderer?.title?.simpleText, 'Original Tile Title');
  });

  test('applyDeArrowBranding updates already-mounted DOM tile and lockup titles and thumbnails on cold-cache resolution', async (t) => {
    clearDeArrowCache();
    const globals = globalThis as Record<string, unknown>;
    const prevDocument = globals.document;
    const prevFetch = globals.fetch;

    const mountedTitleEl = { textContent: 'Clickbait DOM Title' };
    const mountedTileEl = {
      querySelector: (sel: string) => (sel.includes('title') ? mountedTitleEl : null),
    };
    const mountedThumbEl = {
      tagName: 'YTLR-THUMBNAIL-DETAILS',
      style: { backgroundImage: 'url("https://i.ytimg.com/vi/mountedVid1/hq720.jpg?v=1")' },
      closest: (sel: string) => (sel.includes('ytlr-tile-renderer') ? mountedTileEl : null),
    };

    const mountedLockupTitleEl = { textContent: 'Clickbait Lockup Title' };
    const mountedLockupEl = {
      querySelector: (sel: string) => (sel.includes('prqC5c') ? mountedLockupTitleEl : null),
    };
    const mountedLockupImageEl = {
      tagName: 'IMAGE',
      style: {
        backgroundImage:
          'linear-gradient(rgba(0, 0, 0, 0), rgba(0, 0, 0, 0.8)), url("https://i.ytimg.com/vi/mountedVid1/hq720.jpg?v=1")',
      },
      closest: (sel: string) => (sel.includes('yt-lockup-view-model') ? mountedLockupEl : null),
    };

    globals.document = {
      querySelectorAll: (sel: string) => (sel.includes('/mountedVid1/') ? [mountedThumbEl, mountedLockupImageEl] : []),
    };
    globals.fetch = (async () =>
      new Response(
        JSON.stringify({
          titles: [{ title: 'Mounted DeArrow Title', votes: 8 }],
          thumbnails: [{ timestamp: 19, votes: 4 }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )) as typeof fetch;

    t.after(() => {
      clearDeArrowCache();
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
      globals.fetch = prevFetch;
    });

    const tileCase = createTileFeedItem({
      contentId: 'mountedVid1',
      onSelectCommand: { watchEndpoint: { videoId: 'mountedVid1' } },
    });
    await applyDeArrowBranding([tileCase.entry]);

    assert.equal(mountedTitleEl.textContent, 'Mounted DeArrow Title');
    assert.equal(
      mountedThumbEl.style.backgroundImage,
      'url("https://dearrow-thumb.ajay.app/api/v1/getThumbnail?videoID=mountedVid1&time=19"), url("https://i.ytimg.com/vi/mountedVid1/hq720.jpg?v=1"), url("https://i.ytimg.com/vi/mountedVid1/hqdefault.jpg")'
    );
    assert.equal(mountedLockupTitleEl.textContent, 'Mounted DeArrow Title');
    assert.equal(
      mountedLockupImageEl.style.backgroundImage,
      'linear-gradient(rgba(0, 0, 0, 0), rgba(0, 0, 0, 0.8)), url("https://dearrow-thumb.ajay.app/api/v1/getThumbnail?videoID=mountedVid1&time=19"), url("https://i.ytimg.com/vi/mountedVid1/hq720.jpg?v=1"), url("https://i.ytimg.com/vi/mountedVid1/hqdefault.jpg")'
    );
  });

  test('caches 404 misses, retries transient 500s, and aborts stale fetches on navigation', async () => {
    clearDeArrowCache();
    let fetchCount = 0;
    let transientStatus = 500;
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      fetchCount++;
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('miss-404')) {
        return new Response(null, { status: 404 });
      }
      if (url.includes('transient-500')) {
        if (transientStatus !== 200) {
          return new Response(null, { status: transientStatus });
        }
        return new Response(JSON.stringify({ titles: [{ title: 'Recovered Title', votes: 5 }], thumbnails: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(null, { status: 404 });
    }) as typeof globalThis.fetch;

    try {
      const missItem = createTileFeedItem({ onSelectCommand: { watchEndpoint: { videoId: 'miss-404' } } });
      await applyDeArrowBranding([missItem.entry]);
      await applyDeArrowBranding([missItem.entry]);
      assert.equal(fetchCount, 1);

      const flakyItem = createTileFeedItem({ onSelectCommand: { watchEndpoint: { videoId: 'transient-500' } } });
      await applyDeArrowBranding([flakyItem.entry]);
      assert.equal(fetchCount, 2);
      assert.equal(flakyItem.tile.metadata?.tileMetadataRenderer?.title?.simpleText, 'Original Tile Title');

      transientStatus = 200;
      await applyDeArrowBranding([flakyItem.entry]);
      assert.equal(fetchCount, 3);
      assert.equal(flakyItem.tile.metadata?.tileMetadataRenderer?.title?.simpleText, 'Recovered Title');

      // 1) Synchronous abort before p-limit dispatches queued work skips fetch entirely.
      let queuedFetchCalled = false;
      globalThis.fetch = (async (): Promise<Response> => {
        queuedFetchCalled = true;
        return new Response(null, { status: 404 });
      }) as typeof globalThis.fetch;
      const queuedItem = createTileFeedItem({ onSelectCommand: { watchEndpoint: { videoId: 'queued-abort' } } });
      const pendingQueued = applyDeArrowBranding([queuedItem.entry]);
      abortPendingDeArrowRequests();
      await pendingQueued;
      assert.equal(queuedFetchCalled, false);

      // 2) Navigation abort while fetch is already in-flight rejects with AbortError, skips stale DOM mutation, and does NOT cache.
      let sawAbort = false;
      let notifyStarted!: () => void;
      const fetchStarted = new Promise<void>((resolve) => {
        notifyStarted = resolve;
      });
      globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          notifyStarted();
          init?.signal?.addEventListener('abort', () => {
            sawAbort = true;
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        })) as typeof globalThis.fetch;

      const staleItem = createTileFeedItem({ onSelectCommand: { watchEndpoint: { videoId: 'stale-abort' } } });
      const pending = applyDeArrowBranding([staleItem.entry]);
      await fetchStarted;
      abortPendingDeArrowRequests();
      await pending;

      assert.equal(sawAbort, true);
      assert.equal(staleItem.tile.metadata?.tileMetadataRenderer?.title?.simpleText, 'Original Tile Title');

      // 3) Re-fetching stale-abort must still hit network because aborted results are never cached.
      let refetched = false;
      globalThis.fetch = (async () => {
        refetched = true;
        return new Response(JSON.stringify({ titles: [{ title: 'Fresh Title', votes: 3 }], thumbnails: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof globalThis.fetch;
      await applyDeArrowBranding([staleItem.entry]);
      assert.equal(refetched, true);
      assert.equal(staleItem.tile.metadata?.tileMetadataRenderer?.title?.simpleText, 'Fresh Title');
    } finally {
      clearDeArrowCache();
      globalThis.fetch = originalFetch;
    }
  });

  test('updates TV tile DOM without Image probes or desktop selectors, skips cache-hit DOM queries, and wires memory pressure', async (t) => {
    clearDeArrowCache();
    const globals = globalThis as Record<string, unknown>;
    const prevDocument = globals.document;
    const prevWindow = globals.window;
    const prevImage = globals.Image;
    const prevFetch = globals.fetch;

    let imageProbeConstructed = 0;
    globals.Image = class {
      constructor() {
        imageProbeConstructed++;
      }
    };

    const queriedSelectors: string[] = [];
    const bgThumb = {
      tagName: 'YTLR-THUMBNAIL-DETAILS',
      style: { backgroundImage: 'url("https://i.ytimg.com/vi/probeVid123/hq720.jpg?v=1")' },
      closest: (sel: string) => (sel.includes('ytlr-tile-renderer') ? tileCard : null),
    };
    const tileTitle = { textContent: 'Old' };
    const tileCard = { querySelector: () => tileTitle };

    globals.document = {
      querySelectorAll: (sel: string) => {
        queriedSelectors.push(sel);
        if (sel.includes('/probeVid123/')) return [bgThumb];
        return [];
      },
    };
    globals.fetch = (async () =>
      new Response(
        JSON.stringify({
          titles: [{ title: 'New Clean Title', votes: 7 }],
          thumbnails: [{ timestamp: 8, votes: 4 }],
        }),
        { status: 200 }
      )) as typeof fetch;

    const pressureListeners: Array<() => void> = [];
    const origWarn = console.warn;
    console.warn = () => {};
    globals.window = {
      h5vcc: {
        system: {
          onMemoryPressure: {
            addListener: (cb: () => void) => pressureListeners.push(cb),
          },
        },
      },
    };

    t.after(() => {
      console.warn = origWarn;
      clearDeArrowCache();
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevImage === undefined) delete globals.Image;
      else globals.Image = prevImage;
      globals.fetch = prevFetch;
    });

    // Invalid videoId must be ignored by updateMountedDeArrowDom without calling querySelectorAll.
    applyDeArrowBrandingToItem(createTileFeedItem().entry, 'bad"]id', {
      titles: [{ title: 'X', votes: 1 }],
    });
    assert.equal(queriedSelectors.length, 0);

    // Cold fetch updates mounted TV tile using only ytlr-tile-renderer selector and no Image probes.
    const probeTile = createTileFeedItem({
      contentId: 'probeVid123',
      onSelectCommand: { watchEndpoint: { videoId: 'probeVid123' } },
    });
    await applyDeArrowBranding([probeTile.entry]);
    assert.equal(queriedSelectors.length, 1);
    assert.equal(
      queriedSelectors[0],
      'ytlr-tile-renderer ytlr-thumbnail-details[style*="/probeVid123/"], yt-lockup-view-model image[style*="/probeVid123/"]'
    );
    assert.equal(imageProbeConstructed, 0);
    assert.equal(tileTitle.textContent, 'New Clean Title');
    assert.equal(
      bgThumb.style.backgroundImage,
      'url("https://dearrow-thumb.ajay.app/api/v1/getThumbnail?videoID=probeVid123&time=8"), url("https://i.ytimg.com/vi/probeVid123/hq720.jpg?v=1"), url("https://i.ytimg.com/vi/probeVid123/hqdefault.jpg")'
    );

    // Warm cache hit does NOT invoke querySelectorAll.
    await applyDeArrowBranding([probeTile.entry]);
    assert.equal(queriedSelectors.length, 1);

    // Memory pressure listener evicts DeArrow cache cleanly and triggers fresh fetch + DOM update.
    setupMemoryPressureListener();
    assert.equal(pressureListeners.length, 1);
    pressureListeners[0]?.();
    await applyDeArrowBranding([probeTile.entry]);
    assert.equal(queriedSelectors.length, 2);
  });

  test('[H2] stacks CSS multi-background fallback layers on mounted TV ytlr-thumbnail-details when applying DeArrow branding', async (t) => {
    clearDeArrowCache();
    const globals = globalThis as Record<string, unknown>;
    const prevDocument = globals.document;
    const prevFetch = globals.fetch;

    const mountedTitleEl = { textContent: 'Original Title' };
    const mountedTileEl = {
      querySelector: (sel: string) => (sel.includes('title') ? mountedTitleEl : null),
    };
    const mountedThumbEl = {
      tagName: 'YTLR-THUMBNAIL-DETAILS',
      style: { backgroundImage: 'url("https://i.ytimg.com/vi/mountedFb01/hq720.jpg?v=1")' },
      closest: (sel: string) => (sel.includes('ytlr-tile-renderer') ? mountedTileEl : null),
    };

    globals.document = {
      querySelectorAll: (sel: string) => (sel.includes('/mountedFb01/') ? [mountedThumbEl] : []),
    };
    globals.fetch = (async () =>
      new Response(
        JSON.stringify({
          titles: [{ title: 'Clean Title', votes: 5 }],
          thumbnails: [{ timestamp: 12, votes: 5 }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )) as typeof fetch;

    t.after(() => {
      clearDeArrowCache();
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
      globals.fetch = prevFetch;
    });

    const tileCase = createTileFeedItem({
      contentId: 'mountedFb01',
      onSelectCommand: { watchEndpoint: { videoId: 'mountedFb01' } },
    });
    await applyDeArrowBranding([tileCase.entry]);

    assert.equal(
      mountedThumbEl.style.backgroundImage,
      'url("https://dearrow-thumb.ajay.app/api/v1/getThumbnail?videoID=mountedFb01&time=12"), url("https://i.ytimg.com/vi/mountedFb01/hq720.jpg?v=1"), url("https://i.ytimg.com/vi/mountedFb01/hqdefault.jpg")'
    );
  });

  test('applyDeArrowBranding deduplicates, caches, and clears cache on clearDeArrowCache', async () => {
    clearDeArrowCache();
    let fetchCalls = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> => {
      fetchCalls++;
      return new Response(JSON.stringify({ titles: [{ title: 'Cached Title', votes: 10 }], thumbnails: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    const makeItem = (id: string) => ({
      tileRenderer: {
        contentId: id,
        style: 'TILE_STYLE_YTLR_DEFAULT',
        metadata: { tileMetadataRenderer: { title: { simpleText: 'Orig' } } },
        onSelectCommand: { watchEndpoint: { videoId: id } },
      },
    });

    try {
      const a = makeItem('dedupVid1');
      const b = makeItem('dedupVid1');
      await applyDeArrowBranding([a, b]);
      assert.equal(fetchCalls, 1);
      assert.equal(a.tileRenderer.metadata.tileMetadataRenderer.title.simpleText, 'Cached Title');
      assert.equal(b.tileRenderer.metadata.tileMetadataRenderer.title.simpleText, 'Cached Title');

      const c = makeItem('dedupVid1');
      await applyDeArrowBranding([c]);
      assert.equal(fetchCalls, 1);
      assert.equal(c.tileRenderer.metadata.tileMetadataRenderer.title.simpleText, 'Cached Title');

      clearDeArrowCache();
      const d = makeItem('dedupVid1');
      await applyDeArrowBranding([d]);
      assert.equal(fetchCalls, 2);

      // Original/empty 200 OK branding caches as EMPTY_RESOLVED_BRANDING without refetching on next pass.
      globalThis.fetch = (async (): Promise<Response> => {
        fetchCalls++;
        return new Response(JSON.stringify({ titles: [{ title: 'Orig', votes: 5, original: true }], thumbnails: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof globalThis.fetch;
      const origItem = makeItem('origOnly1');
      await applyDeArrowBranding([origItem]);
      await applyDeArrowBranding([origItem]);
      assert.equal(fetchCalls, 3);
      assert.equal(origItem.tileRenderer.metadata.tileMetadataRenderer.title.simpleText, 'Orig');
    } finally {
      clearDeArrowCache();
      globalThis.fetch = origFetch;
    }
  });
});

describe('installDeArrow lifecycle and edge cases', () => {
  test('[M1] installDeArrow aborts in-flight Home shelf fetches on Shorts entry, handles hashchange, and tears down cleanly', async (t) => {
    clearDeArrowCache();
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevDocument = globals.document;
    const prevFetch = globals.fetch;
    const prevMutationObserver = globals.MutationObserver;

    let uninstall: (() => void) | undefined;

    // Guard check when document is missing -> returns NOOP.
    delete globals.document;
    const noopCleanup = installDeArrow();
    noopCleanup();

    const observers: Array<{ target: unknown; cb: (mutations: unknown[]) => void; disconnected: boolean }> = [];
    globals.MutationObserver = class {
      private readonly rec: { target: unknown; cb: (mutations: unknown[]) => void; disconnected: boolean };
      constructor(cb: (mutations: unknown[]) => void) {
        this.rec = { target: null, cb, disconnected: false };
      }
      observe(target: unknown): void {
        this.rec.target = target;
        observers.push(this.rec);
      }
      disconnect(): void {
        this.rec.disconnected = true;
      }
    };

    const bodyClasses = new Set<string>();
    const bodyEl = {
      classList: {
        add: (cls: string) => bodyClasses.add(cls),
        remove: (cls: string) => bodyClasses.delete(cls),
        contains: (cls: string) => bodyClasses.has(cls),
      },
    };
    const hashListeners: Array<() => void> = [];
    globals.window = {
      location: { hash: '#/', search: '' },
      addEventListener: (type: string, listener: () => void) => {
        if (type === 'hashchange') hashListeners.push(listener);
      },
      removeEventListener: (type: string, listener: () => void) => {
        if (type === 'hashchange') {
          const idx = hashListeners.indexOf(listener);
          if (idx >= 0) hashListeners.splice(idx, 1);
        }
      },
    };
    globals.document = {
      body: bodyEl,
      documentElement: bodyEl,
      addEventListener: () => {},
      querySelectorAll: () => [],
    };

    let fetchSignal: AbortSignal | undefined;
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    globals.fetch = ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        fetchSignal = init?.signal ?? undefined;
        notifyStarted();
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      })) as typeof fetch;

    t.after(() => {
      uninstall?.();
      clearDeArrowCache();
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
      globals.fetch = prevFetch;
      if (prevMutationObserver === undefined) delete globals.MutationObserver;
      else globals.MutationObserver = prevMutationObserver;
    });

    uninstall = installDeArrow();
    // Second install while active returns NOOP and preserves single listener.
    const secondInstall = installDeArrow();
    secondInstall();
    assert.equal(hashListeners.length, 1);

    const item: FeedItem = {
      tileRenderer: {
        contentId: 'homeCardDe1',
        style: 'TILE_STYLE_YTLR_DEFAULT',
        onSelectCommand: { watchEndpoint: { videoId: 'homeCardDe1' } },
      },
    };
    const pending = applyDeArrowBranding([item]);
    await started;

    bodyClasses.add('WEB_PAGE_TYPE_SHORTS');
    for (const obs of observers.filter(
      (o) => !o.disconnected && (o.target === bodyEl || o.target === globals.document)
    )) {
      obs.cb([{ type: 'attributes', attributeName: 'class', target: bodyEl }]);
    }

    assert.equal(fetchSignal?.aborted, true);
    await pending;

    // Leaving Shorts does not trigger an extra abort; hashchange invokes abort listener cleanly.
    bodyClasses.delete('WEB_PAGE_TYPE_SHORTS');
    for (const obs of observers.filter((o) => !o.disconnected)) {
      obs.cb([{ type: 'attributes', attributeName: 'class', target: bodyEl }]);
    }
    hashListeners[0]?.();

    uninstall();
    uninstall = undefined;
    assert.equal(hashListeners.length, 0);

    // Install and uninstall cleanly when window lacks addEventListener/removeEventListener.
    globals.window = undefined;
    const winlessCleanup = installDeArrow();
    winlessCleanup();
  });

  test('covers missing window guard, item/DOM edges, and aborted/null DeArrow responses', async (t) => {
    clearDeArrowCache();
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevDocument = globals.document;
    const prevFetch = globals.fetch;

    delete globals.window;
    setupMemoryPressureListener();

    applyDeArrowBrandingToItem(null as unknown as FeedItem, 'vid12345678', {
      titles: [{ title: 'NullEntry', votes: 1 }],
    });
    applyDeArrowBrandingToItem({ tileRenderer: {} }, 'vid12345678', { titles: [{ title: 'NoContainer', votes: 1 }] });
    applyDeArrowBrandingToItem({} as FeedItem, 'invalid', { titles: [{ title: 'InvalidId', votes: 1 }] });

    const lockupRuns: FeedItem = {
      lockupViewModel: {
        contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
        contentId: 'lockRuns001',
        contentImage: { thumbnailViewModel: { image: {} } },
        metadata: { lockupMetadataViewModel: { title: { runs: [{ text: 'Old' }] } } },
      },
    };
    applyDeArrowBrandingToItem(lockupRuns, 'lockRuns001', {
      titles: [
        { title: '', votes: 5 },
        { title: 'Clean Runs', votes: 6 },
      ],
      thumbnails: [{ timestamp: 4, votes: 3 }],
    });
    assert.deepEqual(lockupRuns.lockupViewModel?.metadata?.lockupMetadataViewModel?.title?.runs, [
      { text: 'Clean Runs' },
    ]);
    applyDeArrowBrandingToItem(lockupRuns, 'lockRuns001', { titles: [], thumbnails: [] });

    globals.document = {
      querySelectorAll: () => [
        { style: { backgroundImage: 'url("https://i.ytimg.com/vi/noTile00001/hq720.jpg")' }, closest: () => null },
      ],
    };
    applyDeArrowBrandingToItem(lockupRuns, 'noTile00001', { titles: [{ title: 'New', votes: 1 }] });
    applyDeArrowBrandingToItem(createTileFeedItem({ contentId: 'thumbOnly01' }).entry, 'thumbOnly01', {
      titles: [],
      thumbnails: [{ timestamp: 2, votes: 5 }],
    });

    await applyDeArrowBranding(null as unknown as FeedItem[]);
    let resolveAbortedFetch!: (r: Response) => void;
    let resolveAbortedJson!: (v: unknown) => void;
    let fetchStep = 0;
    globals.fetch = (() => {
      fetchStep++;
      if (fetchStep === 1) {
        return new Promise<Response>((resolve) => {
          resolveAbortedFetch = resolve;
        });
      }
      if (fetchStep === 2) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            new Promise((resolve) => {
              resolveAbortedJson = resolve;
            }),
        } as unknown as Response);
      }
      return Promise.resolve(new Response('null', { status: 200 }));
    }) as typeof fetch;

    t.after(() => {
      clearDeArrowCache();
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
      globals.fetch = prevFetch;
    });

    const abortedTask = applyDeArrowBranding([createTileFeedItem({ contentId: 'abortDe0001' }).entry]);
    await new Promise((r) => setTimeout(r, 10));
    abortPendingDeArrowRequests();
    resolveAbortedFetch(new Response(JSON.stringify({ titles: [{ title: 'Late', votes: 1 }] }), { status: 200 }));
    await abortedTask;

    const abortedJsonTask = applyDeArrowBranding([createTileFeedItem({ contentId: 'abortJson01' }).entry]);
    await new Promise((r) => setTimeout(r, 10));
    abortPendingDeArrowRequests();
    resolveAbortedJson({ titles: [{ title: 'LateJson', votes: 1 }] });
    await abortedJsonTask;

    await applyDeArrowBranding([createTileFeedItem({ contentId: 'nullDe00001' }).entry]);
  });
});
