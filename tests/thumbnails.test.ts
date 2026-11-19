import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  applyDeArrowBranding,
  applyDeArrowBrandingToItem,
  applyThumbnailUpgrade,
  extractVideoIdForThumbnail,
  resolveFallbackThumbnailUrl,
  selectHighestVotedEntry,
  upgradeFeedItemThumbnails,
  upgradeFeedThumbnails,
} from '../mods/transforms/thumbnails.ts';
import type { DeArrowBrandingResponse } from '../mods/transforms/thumbnails.ts';
import type { FeedItem, LockupViewModel, Thumbnail, TileRenderer } from '../mods/types/innertube.ts';

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
      extractVideoIdForThumbnail(createTileFeedItem({ style: undefined, contentType: 'TILE_CONTENT_TYPE_VIDEO' }).entry),
      'vid1'
    );
    assert.equal(
      extractVideoIdForThumbnail(createTileFeedItem({ onSelectCommand: {} }).entry),
      'tile-fallback-id'
    );
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
    assert.equal(
      extractVideoIdForThumbnail({ richItemRenderer: { content: createTileFeedItem().entry } }),
      'vid1'
    );
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
    assert.equal(extractVideoIdForThumbnail(createTileFeedItem({ contentType: 'TILE_CONTENT_TYPE_SHORTS' }).entry), null);
    assert.equal(extractVideoIdForThumbnail(createTileFeedItem({ contentType: 'TILE_CONTENT_TYPE_CHANNEL' }).entry), null);
    assert.equal(extractVideoIdForThumbnail(createTileFeedItem({ contentType: 'TILE_CONTENT_TYPE_PLAYLIST' }).entry), null);
    assert.equal(extractVideoIdForThumbnail(createTileFeedItem({ contentType: 'TILE_CONTENT_TYPE_VIDEO_AD' }).entry), null);
    assert.equal(
      extractVideoIdForThumbnail(createTileFeedItem({ onSelectCommand: { reelWatchEndpoint: { videoId: 's1' } } }).entry),
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

  test('upgradeFeedThumbnails respects the isEnabled toggle across batches', () => {
    const disabledCase = createTileFeedItem();
    upgradeFeedThumbnails([disabledCase.entry], false);
    assert.equal(disabledCase.tile.header?.tileHeaderRenderer?.thumbnail?.thumbnails?.length, 1);

    const videoTile = createTileFeedItem();
    const channelTile = createTileFeedItem({ contentType: 'TILE_CONTENT_TYPE_CHANNEL' });
    const lockupCase = createLockupFeedItem();
    upgradeFeedThumbnails([videoTile.entry, channelTile.entry, lockupCase.entry], true);

    assert.equal(videoTile.tile.header?.tileHeaderRenderer?.thumbnail?.thumbnails?.length, 2);
    assert.equal(channelTile.tile.header?.tileHeaderRenderer?.thumbnail?.thumbnails?.length, 1);
    assert.equal(lockupCase.lockup.contentImage?.thumbnailViewModel?.image?.sources?.length, 2);
  });
});

describe('DeArrow branding helpers', () => {
  test('selectHighestVotedEntry handles empty lists, winners, and ties', () => {
    assert.equal(selectHighestVotedEntry([]), null);
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

  test('applyDeArrowBrandingToItem updates simpleText, runs, content titles, and preserves fallback thumbnails', () => {
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
    applyDeArrowBrandingToItem(runsTile.entry, 'vid1', branding, false);
    assert.deepEqual(runsTile.tile.metadata?.tileMetadataRenderer?.title?.runs, [{ text: 'Clean Title' }]);
    assert.equal(runsTile.tile.header?.tileHeaderRenderer?.thumbnail?.thumbnails?.length, 1);

    const lockupCase = createLockupFeedItem();
    applyDeArrowBrandingToItem(lockupCase.entry, 'lockup-vid-1', branding, true);
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
      await applyDeArrowBranding(
        [tileCase.entry, { richItemRenderer: { content: richLockupCase.entry } }, channelCase.entry, failingVideoCase.entry],
        { enableDeArrow: true, enableDeArrowThumbnails: true }
      );

      globalThis.fetch = (async (): Promise<Response> => {
        throw new Error('Network offline');
      }) as typeof globalThis.fetch;
      await assert.doesNotReject(() =>
        applyDeArrowBranding([failingVideoCase.entry], { enableDeArrow: true, enableDeArrowThumbnails: true })
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.deepEqual(requestedUrls, [
      'https://sponsor.ajay.app/api/branding?videoID=vid1',
      'https://sponsor.ajay.app/api/branding?videoID=lockup-vid-1',
      'https://sponsor.ajay.app/api/branding?videoID=fail-vid',
    ]);
    assert.equal(tileCase.tile.metadata?.tileMetadataRenderer?.title?.simpleText, 'Fetched Clean Title');
    assert.equal(
      richLockupCase.lockup.metadata?.lockupMetadataViewModel?.title?.content,
      'Fetched Clean Title'
    );
    assert.equal(
      failingVideoCase.tile.metadata?.tileMetadataRenderer?.title?.simpleText,
      'Original Tile Title'
    );
  });
});

describe('resolveFallbackThumbnailUrl', () => {
  test('converts failed hq720 and dearrow URLs to hqdefault and ignores other URLs', () => {
    assert.equal(
      resolveFallbackThumbnailUrl('https://i.ytimg.com/vi/abc123/hq720.jpg?sqp=1'),
      'https://i.ytimg.com/vi/abc123/hqdefault.jpg'
    );
    assert.equal(
      resolveFallbackThumbnailUrl('https://dearrow-thumb.ajay.app/api/v1/getThumbnail?videoID=xyz789&time=12.5'),
      'https://i.ytimg.com/vi/xyz789/hqdefault.jpg'
    );
    assert.equal(resolveFallbackThumbnailUrl('https://i.ytimg.com/vi/abc123/hqdefault.jpg'), null);
    assert.equal(resolveFallbackThumbnailUrl(''), null);
  });
});
