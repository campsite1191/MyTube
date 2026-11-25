import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  filterFeedItemsSync,
  filterShelvesInPlaceSync,
  hasBlockedBadge,
  hasPaidOfferEndpoint,
  isBlockedBadge,
  isStandaloneHeaderNode,
  isSurveyItem,
  shouldHideFeedItem,
} from '../../mods/transforms/feed-filter.ts';
import type { FeedItem } from '../../mods/types/innertube.ts';
import { readFormattedText } from '../../mods/utils/innertube-ast.ts';

describe('ads, sign-in nudges, and surveys', () => {
  test('filters ad slots, wrapped ad slots, and sign-in nudges', () => {
    const adItem: FeedItem = { adSlotRenderer: {} };
    const wrappedAd: FeedItem = { richItemRenderer: { content: { adSlotRenderer: {} } } };
    const nudgeItem: FeedItem = { feedNudgeRenderer: {} };
    const wrappedNudge: FeedItem = { richItemRenderer: { content: { feedNudgeRenderer: {} } } };

    assert.equal(shouldHideFeedItem(adItem), true);
    assert.equal(shouldHideFeedItem(wrappedAd), true);
    assert.equal(shouldHideFeedItem(nudgeItem), true);
    assert.equal(shouldHideFeedItem(wrappedNudge), true);
  });

  test('detects survey renderers, prompt titles, and keeps ordinary items', () => {
    assert.equal(isSurveyItem({ surveyRenderer: {} }), true);
    assert.equal(isSurveyItem({ SURVEYRENDERER: {} }), true);
    assert.equal(isSurveyItem({ richQuestionNaire: {} }), true);
    assert.equal(isSurveyItem({ shelfRenderer: { title: 'HELP US IMPROVE the app' } }), true);
    assert.equal(isSurveyItem({ title: { simpleText: 'Help us make YouTube better' } }), true);
    assert.equal(isSurveyItem({ title: { runs: [{ text: 'Help us ' }, { text: 'improve YouTube' }] } }), true);
    assert.equal(
      isSurveyItem({ shelfRenderer: { headerRenderer: { shelfHeaderRenderer: { title: 'Help us improve' } } } }),
      true
    );
    assert.equal(isSurveyItem(null), false);
    assert.equal(isSurveyItem('survey' as unknown as FeedItem), false);
    assert.equal(isSurveyItem({ tileRenderer: { contentId: 'vid-1' } }), false);
    assert.equal(shouldHideFeedItem(null), false);
    assert.equal(shouldHideFeedItem({ badge: { label: 'New' } }), false);
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

describe('filterFeedItemsSync and filterShelvesInPlaceSync', () => {
  test('filters hidden entries cleanly in new arrays and in-place shelf arrays', () => {
    const validVideo: FeedItem = { tileRenderer: { contentId: 'ok' } };
    const paidVideo: FeedItem = { tileRenderer: { onSelectCommand: { ypcGetOffersEndpoint: {} } } };
    const adSlot: FeedItem = { adSlotRenderer: {} };

    assert.deepEqual(filterFeedItemsSync([validVideo, paidVideo, adSlot]), [validVideo]);

    const shelves: FeedItem[] = [
      { surveyRenderer: {} },
      { shelfRenderer: { title: { simpleText: 'Keep Me' } } },
      {
        shelfRenderer: { headerRenderer: { shelfHeaderRenderer: { title: { simpleText: 'Channels you watch' } } } },
      },
      {
        shelfRenderer: { headerRenderer: { shelfHeaderRenderer: { title: { simpleText: 'Top channels you watch' } } } },
      },
      {
        richSectionRenderer: {
          content: {
            richShelfRenderer: {
              header: { richShelfHeaderRenderer: { title: { runs: [{ text: 'Explore more topics' }] } } },
            },
          },
        },
      },
      {
        shelfRenderer: {
          header: { sectionHeaderViewModel: { headline: { text: { content: 'Explore more topics' } } } },
        },
      },
      {
        itemSectionRenderer: {
          contents: [{ shelfRenderer: { title: { simpleText: 'Channels you watch' } } }],
        },
      },
      { tileRenderer: { title: { simpleText: 'Channels you watch' } } },
      { adSlotRenderer: {} },
    ];
    const result = filterShelvesInPlaceSync(shelves);
    assert.equal(result, shelves);
    assert.equal(shelves.length, 2);
    assert.equal(readFormattedText(shelves[0]?.shelfRenderer?.title), 'Keep Me');
    assert.equal(readFormattedText(shelves[1]?.tileRenderer?.title), 'Channels you watch');

    assert.equal(
      isStandaloneHeaderNode({ sectionHeaderViewModel: { headline: { text: { content: 'Top channels you watch' } } } }),
      true
    );
    assert.equal(isStandaloneHeaderNode({ shelfRenderer: {} }), false);

    assert.equal(hasBlockedBadge({ tileRenderer: { badges: [{ text: { simpleText: 'Members only' } }] } }), true);
    assert.equal(hasBlockedBadge(null), false);
    assert.equal(hasPaidOfferEndpoint(null), false);
    assert.equal(shouldHideFeedItem(null), false);
    assert.equal(shouldHideFeedItem({ richItemRenderer: {} } as FeedItem), false);
    assert.equal(shouldHideFeedItem({ richItemRenderer: { content: { surveyRenderer: {} } } }), true);
    assert.equal(
      shouldHideFeedItem({
        richItemRenderer: { content: { shelfRenderer: { title: { simpleText: 'Explore more topics' } } } },
      }),
      true
    );
    assert.equal(filterFeedItemsSync(null as unknown as FeedItem[]), null);

    // Header depth limit (>5) and HEADER_SKIP_KEYS handling + empty survey title fallback.
    assert.equal(
      isSurveyItem({
        shelfRenderer: {
          title: {},
          header: {
            items: [{}],
            a: { b: { c: { d: { e: { f: { title: { simpleText: 'Help us improve' } } } } } } },
          },
        },
      }),
      false
    );

    // Badge variants: badgeLabel, string text, badgeStyle, depth > 6 inside badge, and checkBlocked depth > 10.
    assert.equal(hasBlockedBadge({ tileRenderer: { badges: [{ badgeLabel: 'Rent' }] } }), true);
    assert.equal(hasBlockedBadge({ tileRenderer: { badges: [{ text: 'Buy' }] } }), true);
    assert.equal(
      hasBlockedBadge({ tileRenderer: { badges: [{ badgeStyle: 'BADGE_STYLE_TYPE_MEMBERS_ONLY' }] } }),
      true
    );
    assert.equal(
      hasBlockedBadge({
        tileRenderer: {
          badges: [{ l1: { l2: { l3: { l4: { l5: { l6: { l7: { label: 'Rent' } } } } } } } }],
        },
      }),
      false
    );
    assert.equal(
      hasBlockedBadge({
        tileRenderer: {
          nestedArr: [{ badges: [{ label: 'Buy' }] }],
        },
      } as FeedItem),
      true
    );
    assert.equal(
      hasBlockedBadge({
        tileRenderer: {
          a1: {
            a2: {
              a3: { a4: { a5: { a6: { a7: { a8: { a9: { a10: { a11: { badges: [{ label: 'Rent' }] } } } } } } } } },
            },
          },
        },
      } as FeedItem),
      false
    );
  });
});
