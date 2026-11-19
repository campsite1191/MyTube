import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  extractItemChannelInfo,
  extractWatchedPercent,
  filterFeedItems,
  filterShelvesInPlace,
  hasBlockedBadge,
  hasPaidOfferEndpoint,
  isBlockedBadge,
  isChannelHidden,
  isShortsItem,
  isSurveyItem,
  resolveFeedPageName,
  shouldHideFeedItem,
  shouldHideWatchedItem,
} from '../mods/transforms/feed-filter.ts';
import type { FeedItem } from '../mods/types/innertube.ts';

describe('ads, sign-in nudges, and surveys', () => {
  test('filters ad slots, wrapped ad slots, and sign-in nudges according to options', () => {
    const adItem: FeedItem = { adSlotRenderer: {} };
    const wrappedAd: FeedItem = { richItemRenderer: { content: { adSlotRenderer: {} } } };
    const nudgeItem: FeedItem = { feedNudgeRenderer: {} };
    const wrappedNudge: FeedItem = { richItemRenderer: { content: { feedNudgeRenderer: {} } } };

    assert.equal(shouldHideFeedItem(adItem, { enableAdBlock: true }), true);
    assert.equal(shouldHideFeedItem(wrappedAd, { enableAdBlock: true }), true);
    assert.equal(shouldHideFeedItem(adItem, { enableAdBlock: false }), false);

    assert.equal(shouldHideFeedItem(nudgeItem, { enableSigninReminder: false }), true);
    assert.equal(shouldHideFeedItem(wrappedNudge, { enableSigninReminder: false }), true);
    assert.equal(shouldHideFeedItem(nudgeItem, { enableSigninReminder: true }), false);
  });

  test('detects survey renderers and survey prompt titles', () => {
    assert.equal(isSurveyItem({ surveyRenderer: {} }), true);
    assert.equal(isSurveyItem({ richQuestionNaire: {} }), true);
    assert.equal(
      isSurveyItem({ shelfRenderer: { headerRenderer: { shelfHeaderRenderer: { title: 'Help us improve' } } } }),
      true
    );
    assert.equal(isSurveyItem({ tileRenderer: { contentId: 'vid-1' } }), false);
  });
});

describe('Shorts detection and filtering', () => {
  test('recognizes all Shorts shelf and item variants', () => {
    const shortsVariants: FeedItem[] = [
      { shelfRenderer: { tvhtml5ShelfRendererType: 'TVHTML5_SHELF_RENDERER_TYPE_SHORTS' } },
      { reelShelfRenderer: {} },
      { shortsLockupViewModel: {} },
      { richItemRenderer: { content: { shortsLockupViewModel: {} } } },
      { lockupViewModel: { contentType: 'LOCKUP_CONTENT_TYPE_SHORT' } },
      { tileRenderer: { tvhtml5ShelfRendererType: 'TVHTML5_TILE_RENDERER_TYPE_SHORTS' } },
      { tileRenderer: { style: 'TILE_STYLE_YTLR_SHORTS' } },
      { tileRenderer: { contentType: 'TILE_CONTENT_TYPE_SHORTS' } },
      { tileRenderer: { onSelectCommand: { reelWatchEndpoint: { videoId: 's1' } } } },
    ];

    for (const item of shortsVariants) {
      assert.equal(isShortsItem(item), true);
      assert.equal(shouldHideFeedItem(item, { enableShorts: false }), true);
      assert.equal(shouldHideFeedItem(item, { enableShorts: true }), false);
    }

    assert.equal(isShortsItem({ tileRenderer: { contentId: 'regular', contentType: 'TILE_CONTENT_TYPE_VIDEO' } }), false);
  });
});

describe('paid offers and deep badge scanning', () => {
  test('identifies paid/member badges while ignoring paid promotion disclosures', () => {
    assert.equal(isBlockedBadge('BADGE_STYLE_TYPE_MEMBERS_ONLY', ''), true);
    assert.equal(isBlockedBadge('BADGE_STYLE_TYPE_SPONSORS_ONLY', ''), true);
    assert.equal(isBlockedBadge('BADGE_STYLE_TYPE_YPC', 'Included'), true);
    assert.equal(isBlockedBadge('', 'Buy or rent'), true);
    assert.equal(isBlockedBadge('', 'Members-only'), true);
    assert.equal(isBlockedBadge('', 'Includes paid promotion'), false);
    assert.equal(isBlockedBadge('BADGE_STYLE_TYPE_SIMPLE', '4K'), false);

    const nestedTileHeader = {
      thumbnailOverlays: [] as Array<Record<string, unknown>>,
      badges: [{ metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_MEMBERS_ONLY', label: 'Members only' } }],
    };
    const nestedMembersTile: FeedItem = {
      tileRenderer: {
        contentId: 'm1',
        header: {
          tileHeaderRenderer: nestedTileHeader,
        },
      },
    };
    const promoLockup: FeedItem = {
      lockupViewModel: {
        contentId: 'p1',
        badges: [{ badgeViewModel: { badgeText: 'Includes paid promotion' } }],
        menu: {
          menuRenderer: {
            items: [{ badgedItem: { badgeStyle: 'BADGE_STYLE_TYPE_PAID' } }],
          },
        },
      },
    };

    assert.equal(hasBlockedBadge(nestedMembersTile), true);
    assert.equal(shouldHideFeedItem(nestedMembersTile), true);
    assert.equal(hasBlockedBadge(promoLockup), false);
    assert.equal(shouldHideFeedItem(promoLockup), false);
  });

  test('does not hide an entire shelf container because of nested child badges', () => {
    const shelf: FeedItem = {
      shelfRenderer: {
        title: { simpleText: 'Home Feed' },
        content: {
          horizontalListRenderer: {
            items: [
              {
                tileRenderer: {
                  contentId: 'members-only',
                  metadata: {
                    tileMetadataRenderer: {
                      lines: [
                        {
                          lineRenderer: {
                            items: [{ badgeRenderer: { badgeStyle: 'BADGE_STYLE_TYPE_MEMBERS_ONLY' } }],
                          },
                        },
                      ],
                    },
                  },
                },
              },
            ],
          },
        },
      },
    };

    assert.equal(shouldHideFeedItem(shelf), false);
  });

  test('detects ypcGetOffersEndpoint on tiles and lockupViewModel tap commands', () => {
    const paidTile: FeedItem = {
      tileRenderer: { onSelectCommand: { ypcGetOffersEndpoint: { params: 'offer' } } },
    };
    const paidLockup: FeedItem = {
      lockupViewModel: {
        rendererContext: {
          commandContext: {
            onTap: { innertubeCommand: { ypcGetOffersEndpoint: { params: 'offer' } } },
          },
        },
      },
    };

    assert.equal(hasPaidOfferEndpoint(paidTile), true);
    assert.equal(hasPaidOfferEndpoint(paidLockup), true);
    assert.equal(shouldHideFeedItem(paidLockup), true);
    assert.equal(hasPaidOfferEndpoint({ tileRenderer: { contentId: 'free' } }), false);
  });
});

describe('channel extraction and hidden channel filtering', () => {
  test('extracts channel info from tileRenderer menu and lockupViewModel avatar commands', () => {
    const tileItem: FeedItem = {
      tileRenderer: {
        contentId: 't1',
        metadata: {
          tileMetadataRenderer: {
            lines: [{ lineRenderer: { items: [{ lineItemRenderer: { text: { simpleText: 'Tech Channel' } } }] } }],
          },
        },
        menu: {
          menuRenderer: {
            items: [{ menuNavigationItemRenderer: { navigationEndpoint: { browseEndpoint: { browseId: 'UC123456' } } } }],
          },
        },
      },
    };
    const lockupMetadata = {
      metadata: {
        contentMetadataViewModel: {
          metadataRows: [{ metadataParts: [{ text: { content: 'Music Channel' } }] }],
        },
      },
      avatar: {
        decoratedAvatarViewModel: {
          rendererContext: {
            commandContext: {
              onTap: { innertubeCommand: { browseEndpoint: { browseId: 'UC654321' } } },
            },
          },
        },
      },
    };
    const lockupItem: FeedItem = {
      lockupViewModel: {
        contentId: 'l1',
        metadata: {
          lockupMetadataViewModel: lockupMetadata,
        },
      },
    };

    assert.deepEqual(extractItemChannelInfo(tileItem), { id: 'UC123456', name: 'Tech Channel' });
    assert.deepEqual(extractItemChannelInfo(lockupItem), { id: 'UC654321', name: 'Music Channel' });

    assert.equal(isChannelHidden(tileItem, [{ id: 'UC123456', name: 'Old Name' }]), true);
    assert.equal(isChannelHidden(lockupItem, [{ id: '', name: 'music channel' }]), true);
    assert.equal(isChannelHidden(lockupItem, [{ id: 'UC000000', name: 'Other Channel' }]), false);
    assert.equal(shouldHideFeedItem(tileItem, { hiddenChannels: [{ id: 'UC123456', name: 'Tech Channel' }] }), true);
  });
});

describe('watched video filtering', () => {
  test('extracts progress percentage from both tileRenderer and lockupViewModel', () => {
    const tile: FeedItem = {
      tileRenderer: {
        header: {
          tileHeaderRenderer: {
            thumbnailOverlays: [{ thumbnailOverlayResumePlaybackRenderer: { percentDurationWatched: 85 } }],
          },
        },
      },
    };
    const lockup: FeedItem = {
      lockupViewModel: {
        contentImage: {
          thumbnailViewModel: {
            overlays: [
              {
                thumbnailBottomOverlayViewModel: {
                  progressBar: { thumbnailOverlayProgressBarViewModel: { startPercent: 92 } },
                },
              },
            ],
          },
        },
      },
    };

    assert.equal(extractWatchedPercent(tile), 85);
    assert.equal(extractWatchedPercent(lockup), 92);
    assert.equal(extractWatchedPercent({ tileRenderer: { contentId: 'unwatched' } }), null);
  });

  test('resolves YouTube TV route hashes into settings page identifiers', () => {
    assert.equal(resolveFeedPageName('#/'), 'home');
    assert.equal(resolveFeedPageName('#/search?q=lofi'), 'search');
    assert.equal(resolveFeedPageName('#/browse?c=FEsubscriptions'), 'subscriptions');
    assert.equal(resolveFeedPageName('#/browse?c=FEtopics_gaming'), 'gaming');
    assert.equal(resolveFeedPageName('#/browse?c=FElibrary'), 'library');
  });

  test('respects enableHideWatchedVideos, enabled pages, and percentage threshold', () => {
    const lockup90: FeedItem = {
      lockupViewModel: {
        contentImage: {
          thumbnailViewModel: {
            overlays: [
              {
                thumbnailBottomOverlayViewModel: {
                  progressBar: { thumbnailOverlayProgressBarViewModel: { startPercent: 90 } },
                },
              },
            ],
          },
        },
      },
    };
    const tile100: FeedItem = {
      tileRenderer: {
        header: {
          tileHeaderRenderer: {
            thumbnailOverlays: [{ thumbnailOverlayResumePlaybackRenderer: { percentDurationWatched: 100 } }],
          },
        },
      },
    };

    // Master switch off -> always kept
    assert.equal(
      shouldHideWatchedItem(lockup90, {
        enableHideWatchedVideos: false,
        hideWatchedVideosPages: ['home'],
        hideWatchedVideosThreshold: 80,
        locationHash: '#/',
      }),
      false
    );

    // Master switch on + matching page + above threshold -> hidden
    assert.equal(
      shouldHideWatchedItem(lockup90, {
        enableHideWatchedVideos: true,
        hideWatchedVideosPages: ['home'],
        hideWatchedVideosThreshold: 80,
        locationHash: '#/',
      }),
      true
    );

    // Non-matching page -> kept
    assert.equal(
      shouldHideWatchedItem(lockup90, {
        enableHideWatchedVideos: true,
        hideWatchedVideosPages: ['subscriptions'],
        hideWatchedVideosThreshold: 80,
        locationHash: '#/',
      }),
      false
    );

    // Threshold 100 hides 100% watched videos
    assert.equal(
      shouldHideWatchedItem(tile100, {
        enableHideWatchedVideos: true,
        hideWatchedVideosPages: ['home'],
        hideWatchedVideosThreshold: 100,
        locationHash: '#/',
      }),
      true
    );
  });
});

describe('filterFeedItems and filterShelvesInPlace', () => {
  test('filters items cleanly and compacts shelves in place', async () => {
    const validVideo: FeedItem = { tileRenderer: { contentId: 'keep-me' } };
    const paidVideo: FeedItem = { tileRenderer: { onSelectCommand: { ypcGetOffersEndpoint: {} } } };
    const shortVideo: FeedItem = { lockupViewModel: { contentType: 'LOCKUP_CONTENT_TYPE_SHORT' } };

    assert.deepEqual(await filterFeedItems([validVideo, paidVideo, shortVideo], { enableShorts: false }), [validVideo]);

    const shelves: FeedItem[] = [
      { adSlotRenderer: {} },
      { shelfRenderer: { title: 'Recommended' } },
      { feedNudgeRenderer: {} },
      { shelfRenderer: { tvhtml5ShelfRendererType: 'TVHTML5_SHELF_RENDERER_TYPE_SHORTS' } },
    ];
    const result = await filterShelvesInPlace(shelves, {
      enableAdBlock: true,
      enableSigninReminder: false,
      enableShorts: false,
    });

    assert.equal(result, shelves);
    assert.deepEqual(shelves, [{ shelfRenderer: { title: 'Recommended' } }]);
  });
});
