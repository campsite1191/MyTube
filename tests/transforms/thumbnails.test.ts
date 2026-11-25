import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { DeArrowBrandingResponse } from '../../mods/transforms/thumbnails.ts';
import {
  abortPendingDeArrowRequests,
  applyDeArrowBranding,
  applyDeArrowBrandingToItem,
  applyThumbnailUpgrade,
  clearDeArrowCache,
  extractVideoIdForThumbnail,
  installThumbnailErrorFallback,
  resolveFallbackThumbnailUrl,
  selectHighestVotedEntry,
  setupMemoryPressureListener,
  upgradeFeedItemThumbnails,
  upgradeFeedThumbnails,
} from '../../mods/transforms/thumbnails.ts';
import type { FeedItem, LockupViewModel, Thumbnail, TileRenderer } from '../../mods/types/innertube.ts';

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

describe('extractVideoIdForThumbnail', () => {
  test('resolves video IDs across tile, lockup, fallback paths, and richItemRenderer wrappers', () => {
    assert.equal(extractVideoIdForThumbnail(createTileFeedItem().entry), 'vid1');
    assert.equal(
      extractVideoIdForThumbnail(
        createTileFeedItem({ style: undefined, contentType: 'TILE_CONTENT_TYPE_VIDEO' }).entry
      ),
      'vid1'
    );
    assert.equal(extractVideoIdForThumbnail(createTileFeedItem({ onSelectCommand: {} }).entry), 'tile-fallback-id');
    assert.equal(extractVideoIdForThumbnail(createLockupFeedItem().entry), 'lockup-vid-1');
    assert.equal(
      extractVideoIdForThumbnail(
        createLockupFeedItem({
          contentId: undefined,
          rendererContext: {
            commandContext: { onTap: { innertubeCommand: { watchEndpoint: { videoId: 'tap-vid-2' } } } },
          },
        }).entry
      ),
      'tap-vid-2'
    );
    assert.equal(extractVideoIdForThumbnail({ richItemRenderer: { content: createTileFeedItem().entry } }), 'vid1');
    assert.equal(
      extractVideoIdForThumbnail({ richItemRenderer: { content: createLockupFeedItem().entry } }),
      'lockup-vid-1'
    );
  });

  test('skips shorts, channels, playlists, video ads, and invalid inputs', () => {
    assert.equal(extractVideoIdForThumbnail(null), null);
    assert.equal(extractVideoIdForThumbnail(undefined), null);
    assert.equal(extractVideoIdForThumbnail({}), null);
    assert.equal(extractVideoIdForThumbnail(createTileFeedItem({ style: 'TILE_STYLE_YTLR_SHORTS' }).entry), null);
    assert.equal(
      extractVideoIdForThumbnail(createTileFeedItem({ contentType: 'TILE_CONTENT_TYPE_SHORTS' }).entry),
      null
    );
    assert.equal(
      extractVideoIdForThumbnail(createTileFeedItem({ contentType: 'TILE_CONTENT_TYPE_CHANNEL' }).entry),
      null
    );
    assert.equal(
      extractVideoIdForThumbnail(createTileFeedItem({ contentType: 'TILE_CONTENT_TYPE_PLAYLIST' }).entry),
      null
    );
    assert.equal(
      extractVideoIdForThumbnail(createTileFeedItem({ contentType: 'TILE_CONTENT_TYPE_VIDEO_AD' }).entry),
      null
    );
    assert.equal(
      extractVideoIdForThumbnail(
        createTileFeedItem({ onSelectCommand: { reelWatchEndpoint: { videoId: 's1' } } }).entry
      ),
      null
    );
    assert.equal(
      extractVideoIdForThumbnail(createLockupFeedItem({ contentType: 'LOCKUP_CONTENT_TYPE_PLAYLIST' }).entry),
      null
    );
  });
});

describe('applyThumbnailUpgrade and upgradeFeedThumbnails', () => {
  test('prepends hq720 thumbnail and skips already high-res or custom thumbnails', () => {
    const lowRes: Thumbnail[] = [{ url: '/low.jpg', width: 480, height: 360 }];
    const upgraded = applyThumbnailUpgrade(lowRes, 'video-id');
    assert.equal(upgraded.length, 2);
    assert.deepEqual(upgraded[0], {
      url: 'https://i.ytimg.com/vi/video-id/hq720.jpg',
      width: 1280,
      height: 720,
    });
    assert.equal(upgraded[1], lowRes[0]);

    const alreadyHighRes: Thumbnail[] = [{ url: '/hq.jpg', width: 1280, height: 720 }];
    const customThumb: Thumbnail[] = [{ url: '/video_custom_1.jpg', width: 480, height: 360 }];
    assert.equal(applyThumbnailUpgrade(null as unknown as Thumbnail[], 'video-id'), null);
    assert.equal(applyThumbnailUpgrade(alreadyHighRes, ''), alreadyHighRes);
    assert.equal(applyThumbnailUpgrade(alreadyHighRes, 'video-id'), alreadyHighRes);
    assert.equal(applyThumbnailUpgrade(customThumb, 'video-id'), customThumb);
  });

  test('upgrades tile, lockup, and richItemRenderer items while ignoring empty or non-video entries', () => {
    const richTileWrapped = createTileFeedItem({ onSelectCommand: {} });
    assert.equal(upgradeFeedItemThumbnails({ richItemRenderer: { content: richTileWrapped.entry } }), true);
    const richThumbnails = richTileWrapped.tile.header?.tileHeaderRenderer?.thumbnail?.thumbnails;
    assert.equal(richThumbnails?.[0]?.url, 'https://i.ytimg.com/vi/tile-fallback-id/hq720.jpg');

    const lockupCase = createLockupFeedItem();
    assert.equal(upgradeFeedItemThumbnails(lockupCase.entry), true);
    const lockupSources = lockupCase.lockup.contentImage?.thumbnailViewModel?.image?.sources;
    assert.equal(lockupSources?.[0]?.url, 'https://i.ytimg.com/vi/lockup-vid-1/hq720.jpg');
    assert.equal(lockupSources?.length, 2);

    const emptyThumbTile = createTileFeedItem({ header: { tileHeaderRenderer: { thumbnail: { thumbnails: [] } } } });
    assert.equal(upgradeFeedItemThumbnails(emptyThumbTile.entry), false);
  });

  test('upgradeFeedThumbnails upgrades video items and skips non-video entries across batches', () => {
    const videoTile = createTileFeedItem();
    const channelTile = createTileFeedItem({ contentType: 'TILE_CONTENT_TYPE_CHANNEL' });
    const lockupCase = createLockupFeedItem();
    upgradeFeedThumbnails([videoTile.entry, channelTile.entry, lockupCase.entry]);

    assert.equal(videoTile.tile.header?.tileHeaderRenderer?.thumbnail?.thumbnails?.length, 2);
    assert.equal(channelTile.tile.header?.tileHeaderRenderer?.thumbnail?.thumbnails?.length, 1);
    assert.equal(lockupCase.lockup.contentImage?.thumbnailViewModel?.image?.sources?.length, 2);
  });
});

describe('DeArrow branding helpers', () => {
  test('selectHighestVotedEntry ignores negative votes and handles ties', () => {
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
  });

  test('applyDeArrowBrandingToItem updates titles, prepends thumbnail once, and preserves fallbacks', () => {
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

  test('applyDeArrowBranding updates already-mounted DOM tile titles and thumbnails on cold-cache resolution', async (t) => {
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
      style: { backgroundImage: 'url("https://i.ytimg.com/vi/mountedVid1/hq720.jpg")' },
      closest: (sel: string) => (sel === 'ytlr-tile-renderer' ? mountedTileEl : null),
    };

    globals.document = {
      querySelectorAll: (sel: string) => (sel.includes('/mountedVid1/') ? [mountedThumbEl] : []),
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
      'url("https://dearrow-thumb.ajay.app/api/v1/getThumbnail?videoID=mountedVid1&time=19"), url("https://i.ytimg.com/vi/mountedVid1/hq720.jpg"), url("https://i.ytimg.com/vi/mountedVid1/hqdefault.jpg")'
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
      style: { backgroundImage: 'url("https://i.ytimg.com/vi/probeVid123/hq720.jpg")' },
      closest: (sel: string) => (sel === 'ytlr-tile-renderer' ? tileCard : null),
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
    assert.equal(queriedSelectors[0], 'ytlr-tile-renderer ytlr-thumbnail-details[style*="/probeVid123/"]');
    assert.equal(imageProbeConstructed, 0);
    assert.equal(tileTitle.textContent, 'New Clean Title');
    assert.equal(
      bgThumb.style.backgroundImage,
      'url("https://dearrow-thumb.ajay.app/api/v1/getThumbnail?videoID=probeVid123&time=8"), url("https://i.ytimg.com/vi/probeVid123/hq720.jpg"), url("https://i.ytimg.com/vi/probeVid123/hqdefault.jpg")'
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
});

describe('resolveFallbackThumbnailUrl and installThumbnailErrorFallback', () => {
  test('steps down DeArrow -> hq720.jpg -> hqdefault.jpg and ignores other URLs', () => {
    assert.equal(
      resolveFallbackThumbnailUrl('https://dearrow-thumb.ajay.app/api/v1/getThumbnail?videoID=xyz789&time=12.5'),
      'https://i.ytimg.com/vi/xyz789/hq720.jpg'
    );
    assert.equal(
      resolveFallbackThumbnailUrl('https://i.ytimg.com/vi/xyz789/hq720.jpg?sqp=1'),
      'https://i.ytimg.com/vi/xyz789/hqdefault.jpg'
    );
    assert.equal(resolveFallbackThumbnailUrl('https://i.ytimg.com/vi/xyz789/hqdefault.jpg'), null);
    assert.equal(resolveFallbackThumbnailUrl(''), null);
  });

  test('installThumbnailErrorFallback recovers failed images including recycled DOM nodes', (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevDocument = globals.document;
    const prevWindow = globals.window;
    const prevHTMLImageElement = globals.HTMLImageElement;

    class MockHTMLImageElement {
      src: string;
      constructor(src: string) {
        this.src = src;
      }
    }

    let errorHandler: ((event: Event) => void) | undefined;
    let domReadyHandler: (() => void) | undefined;
    let hashChangeHandler: (() => void) | undefined;

    globals.HTMLImageElement = MockHTMLImageElement;
    globals.window = {
      addEventListener: (type: string, listener: () => void) => {
        if (type === 'hashchange') hashChangeHandler = listener;
      },
    };
    globals.document = {
      addEventListener: (type: string, listener: (event: Event) => void) => {
        if (type === 'error') errorHandler = listener;
        if (type === 'DOMContentLoaded') domReadyHandler = listener as unknown as () => void;
      },
    };

    t.after(() => {
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevHTMLImageElement === undefined) delete globals.HTMLImageElement;
      else globals.HTMLImageElement = prevHTMLImageElement;
    });

    installThumbnailErrorFallback();
    assert.ok(errorHandler);
    assert.ok(domReadyHandler);
    assert.ok(hashChangeHandler);
    domReadyHandler();

    const img = new MockHTMLImageElement('https://dearrow-thumb.ajay.app/api/v1/getThumbnail?videoID=rec1&time=5');
    errorHandler({ target: img } as unknown as Event);
    assert.equal(img.src, 'https://i.ytimg.com/vi/rec1/hq720.jpg');

    errorHandler({ target: img } as unknown as Event);
    assert.equal(img.src, 'https://i.ytimg.com/vi/rec1/hqdefault.jpg');

    // Recycled DOM element loads the same failing DeArrow URL again on a later scroll -> still recovers.
    img.src = 'https://dearrow-thumb.ajay.app/api/v1/getThumbnail?videoID=rec1&time=5';
    errorHandler({ target: img } as unknown as Event);
    assert.equal(img.src, 'https://i.ytimg.com/vi/rec1/hq720.jpg');

    // Non-image targets are ignored cleanly.
    errorHandler({ target: {} } as unknown as Event);
    hashChangeHandler();
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
      style: { backgroundImage: 'url("https://i.ytimg.com/vi/mountedFb01/hq720.jpg")' },
      closest: (sel: string) => (sel === 'ytlr-tile-renderer' ? mountedTileEl : null),
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
      'url("https://dearrow-thumb.ajay.app/api/v1/getThumbnail?videoID=mountedFb01&time=12"), url("https://i.ytimg.com/vi/mountedFb01/hq720.jpg"), url("https://i.ytimg.com/vi/mountedFb01/hqdefault.jpg")'
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
    } finally {
      clearDeArrowCache();
      globalThis.fetch = origFetch;
    }
  });
});

describe('TV thumbnail lifecycle & Shorts entry cancellation', () => {
  test('[H2] stacks CSS fallback layers on mounted TV ytlr-thumbnail-details for hq720.jpg without DOM error events', (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevDocument = globals.document;
    const prevMutationObserver = globals.MutationObserver;

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

    const mountedThumb = {
      tagName: 'YTLR-THUMBNAIL-DETAILS',
      style: { backgroundImage: 'url("https://i.ytimg.com/vi/sdUpload001/hq720.jpg")' },
    };
    const deArrowThumb = {
      tagName: 'YTLR-THUMBNAIL-DETAILS',
      style: {
        backgroundImage: 'url("https://dearrow-thumb.ajay.app/api/v1/getThumbnail?videoID=deCard00001&time=5")',
      },
    };
    const invalidBgThumb = {
      tagName: 'YTLR-THUMBNAIL-DETAILS',
      style: { backgroundImage: 'none' },
    };
    const invalidIdThumb = {
      tagName: 'YTLR-THUMBNAIL-DETAILS',
      style: { backgroundImage: 'url("https://i.ytimg.com/vi/bad/hq720.jpg")' },
    };
    const bodyClasses = new Set<string>();
    const bodyEl = {
      classList: {
        add: (cls: string) => bodyClasses.add(cls),
        remove: (cls: string) => bodyClasses.delete(cls),
        contains: (cls: string) => bodyClasses.has(cls),
      },
    };

    globals.window = {
      location: { hash: '#/', search: '' },
      addEventListener: () => {},
    };
    globals.document = {
      body: bodyEl,
      documentElement: bodyEl,
      addEventListener: () => {},
      querySelectorAll: (sel: string) =>
        sel.includes('hq720.jpg') || sel.includes('ytlr-thumbnail-details')
          ? [mountedThumb, deArrowThumb, invalidBgThumb, invalidIdThumb]
          : [],
    };

    t.after(() => {
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
      if (prevMutationObserver === undefined) delete globals.MutationObserver;
      else globals.MutationObserver = prevMutationObserver;
    });

    installThumbnailErrorFallback();
    for (const obs of observers.filter((o) => !o.disconnected)) {
      obs.cb([{ type: 'childList', target: bodyEl, addedNodes: [], removedNodes: [] }]);
      obs.cb([{ type: 'childList', target: bodyEl, addedNodes: [mountedThumb], removedNodes: [] }]);
      obs.cb([{ type: 'attributes', target: mountedThumb }]);
    }

    assert.equal(
      mountedThumb.style.backgroundImage,
      'url("https://i.ytimg.com/vi/sdUpload001/hq720.jpg"), url("https://i.ytimg.com/vi/sdUpload001/hqdefault.jpg")'
    );
    assert.equal(
      deArrowThumb.style.backgroundImage,
      'url("https://dearrow-thumb.ajay.app/api/v1/getThumbnail?videoID=deCard00001&time=5"), url("https://i.ytimg.com/vi/deCard00001/hq720.jpg"), url("https://i.ytimg.com/vi/deCard00001/hqdefault.jpg")'
    );
  });

  test('[M1] aborts in-flight Home shelf DeArrow fetches when entering WEB_PAGE_TYPE_SHORTS without hashchange', async (t) => {
    clearDeArrowCache();
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevDocument = globals.document;
    const prevFetch = globals.fetch;
    const prevMutationObserver = globals.MutationObserver;

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
    globals.window = {
      location: { hash: '#/', search: '' },
      addEventListener: () => {},
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
      clearDeArrowCache();
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
      globals.fetch = prevFetch;
      if (prevMutationObserver === undefined) delete globals.MutationObserver;
      else globals.MutationObserver = prevMutationObserver;
    });

    installThumbnailErrorFallback();

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
  });

  test('covers helper edges, missing DOM/window guards, DeArrow queue/cache/null responses, and mutation filters', async (t) => {
    clearDeArrowCache();
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevDocument = globals.document;
    const prevFetch = globals.fetch;
    const prevMutationObserver = globals.MutationObserver;
    const prevHtmlImg = globals.HTMLImageElement;

    // 1. Missing window/document guards + pure helper edges.
    delete globals.window;
    setupMemoryPressureListener();

    const custThumb = { url: 'https://i.ytimg.com/vi/vid12345678/hqdefault_custom_1.jpg', width: 480, height: 360 };
    assert.deepEqual(applyThumbnailUpgrade([custThumb], 'vid12345678'), [custThumb]);
    assert.deepEqual(
      applyThumbnailUpgrade([null as unknown as Thumbnail, { width: 480, height: 360 } as Thumbnail], 'vid12345678'),
      [
        { url: 'https://i.ytimg.com/vi/vid12345678/hq720.jpg', width: 1280, height: 720 },
        null as unknown as Thumbnail,
        { width: 480, height: 360 } as Thumbnail,
      ]
    );
    assert.equal(extractVideoIdForThumbnail({ tileRenderer: { style: 'TILE_STYLE_YTLR_DEFAULT' } }), null);
    assert.equal(
      upgradeFeedItemThumbnails({
        tileRenderer: {
          style: 'TILE_STYLE_YTLR_DEFAULT',
          contentId: 'alreadyHq01',
          header: {
            tileHeaderRenderer: {
              thumbnail: {
                thumbnails: [{ url: 'https://i.ytimg.com/vi/alreadyHq01/hq720.jpg', width: 1280, height: 720 }],
              },
            },
          },
        },
      }),
      false
    );
    upgradeFeedThumbnails(null as unknown as FeedItem[]);
    applyDeArrowBrandingToItem(null as unknown as FeedItem, 'vid12345678', {});
    applyDeArrowBrandingToItem({ tileRenderer: {} }, 'vid12345678', { titles: [{ title: 'NoContainer', votes: 1 }] });
    applyDeArrowBrandingToItem({} as FeedItem, 'invalid', { titles: [{ title: 'InvalidId', votes: 1 }] });

    // lockupViewModel with `runs` title hits fallback `runs` branch in setFormattedTitle + undefined getThumbnails().
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
    // Missing title + missing thumbnail skips DOM update; thumb without matching tile skipped cleanly.
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

    // 2. MutationObserver with document.body === null, HTMLImageElement with empty src, and unrelated mutations.
    const observers: Array<{ target: unknown; cb: (m: unknown[]) => void }> = [];
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
    class MockImg {
      src: string;
      constructor(src: string) {
        this.src = src;
      }
    }
    globals.HTMLImageElement = MockImg;
    let errorListener: ((e: Event) => void) | undefined;
    const bodyEl: unknown = null;
    let docEl: unknown = null;
    globals.window = {};
    globals.document = {
      get body() {
        return bodyEl;
      },
      get documentElement() {
        return docEl;
      },
      addEventListener: (type: string, cb: (e: Event) => void) => {
        if (type === 'error') errorListener = cb;
      },
      querySelectorAll: () => [],
    };
    installThumbnailErrorFallback();
    errorListener?.({ target: new MockImg('') } as unknown as Event);

    docEl = { nodeName: 'HTML' };
    const doc2 = {
      body: null,
      documentElement: docEl,
      addEventListener: () => {},
      querySelectorAll: () => [],
    };
    globals.document = doc2;
    installThumbnailErrorFallback();
    const doc2Obs = observers.find((o) => o.target === docEl);
    assert.ok(doc2Obs);
    doc2Obs.cb([
      { type: 'childList', addedNodes: undefined },
      { type: 'attributes', target: { tagName: 'DIV' } },
    ]);

    // 3. DeArrow fetch edge cases: null array guard, aborted after fetch resolves, aborted during response.json(), and null JSON.
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
      if (fetchStep === 3) {
        return Promise.resolve(new Response('null', { status: 200 }));
      }
      return new Promise<Response>(() => {});
    }) as typeof fetch;

    t.after(() => {
      clearDeArrowCache();
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
      globals.fetch = prevFetch;
      if (prevMutationObserver === undefined) delete globals.MutationObserver;
      else globals.MutationObserver = prevMutationObserver;
      if (prevHtmlImg === undefined) delete globals.HTMLImageElement;
      else globals.HTMLImageElement = prevHtmlImg;
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
