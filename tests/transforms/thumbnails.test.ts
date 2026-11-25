import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  applyThumbnailUpgrade,
  extractVideoIdForThumbnail,
  installThumbnailErrorFallback,
  resolveFallbackThumbnailUrl,
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
    assert.equal(
      extractVideoIdForThumbnail(createLockupFeedItem({ contentId: undefined, rendererContext: {} }).entry),
      null
    );
    assert.equal(
      extractVideoIdForThumbnail(
        createTileFeedItem({ style: 'TILE_STYLE_UNKNOWN', contentType: 'TILE_CONTENT_TYPE_UNKNOWN' }).entry
      ),
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
    assert.equal(upgradeFeedItemThumbnails(createTileFeedItem({ header: {} }).entry), false);
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
    const prevHTMLImageElement = globals.HTMLImageElement;

    class MockHTMLImageElement {
      src: string;
      constructor(src: string) {
        this.src = src;
      }
    }

    let errorHandler: ((event: Event) => void) | undefined;
    let domReadyHandler: (() => void) | undefined;

    globals.HTMLImageElement = MockHTMLImageElement;
    globals.document = {
      addEventListener: (type: string, listener: (event: Event) => void) => {
        if (type === 'error') errorHandler = listener;
        if (type === 'DOMContentLoaded') domReadyHandler = listener as unknown as () => void;
      },
    };

    t.after(() => {
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
      if (prevHTMLImageElement === undefined) delete globals.HTMLImageElement;
      else globals.HTMLImageElement = prevHTMLImageElement;
    });

    installThumbnailErrorFallback();
    // Repeated call on the same Document is a no-op.
    installThumbnailErrorFallback();
    assert.ok(errorHandler);
    assert.ok(domReadyHandler);
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
  });

  test('[H2] stacks CSS fallback layers on mounted TV ytlr-thumbnail-details for hq720.jpg without DOM error events', (t) => {
    const globals = globalThis as Record<string, unknown>;
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
    const alreadyStackedThumb = {
      tagName: 'YTLR-THUMBNAIL-DETAILS',
      style: {
        backgroundImage:
          'url("https://i.ytimg.com/vi/stacked0001/hq720.jpg"), url("https://i.ytimg.com/vi/stacked0001/hqdefault.jpg")',
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
    const missingStyleThumb = {
      tagName: 'YTLR-THUMBNAIL-DETAILS',
    };
    const bodyEl = {};

    globals.document = {
      body: bodyEl,
      documentElement: bodyEl,
      addEventListener: () => {},
      querySelectorAll: (sel: string) =>
        sel.includes('hq720.jpg') || sel.includes('ytlr-thumbnail-details')
          ? [mountedThumb, deArrowThumb, alreadyStackedThumb, invalidBgThumb, invalidIdThumb, missingStyleThumb]
          : [],
    };

    t.after(() => {
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

  test('covers helper edges, missing document guard, MutationObserver documentElement fallback, and mutation filters', (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevDocument = globals.document;
    const prevMutationObserver = globals.MutationObserver;
    const prevHtmlImg = globals.HTMLImageElement;

    delete globals.document;
    installThumbnailErrorFallback();

    globals.document = {
      body: {},
      addEventListener: () => {},
    };
    installThumbnailErrorFallback();

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
    const docEl = { nodeName: 'HTML' };

    globals.document = {
      body: null,
      documentElement: docEl,
      addEventListener: (type: string, cb: (e: Event) => void) => {
        if (type === 'error') errorListener = cb;
      },
      querySelectorAll: () => [],
    };

    t.after(() => {
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
      if (prevMutationObserver === undefined) delete globals.MutationObserver;
      else globals.MutationObserver = prevMutationObserver;
      if (prevHtmlImg === undefined) delete globals.HTMLImageElement;
      else globals.HTMLImageElement = prevHtmlImg;
    });

    installThumbnailErrorFallback();
    errorListener?.({ target: new MockImg('') } as unknown as Event);
    const obs = observers.find((o) => o.target === docEl);
    assert.ok(obs);
    obs.cb([
      { type: 'childList', addedNodes: undefined },
      { type: 'attributes', target: { tagName: 'DIV' } },
    ]);
  });
});
