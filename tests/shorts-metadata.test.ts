import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  applyShortsFeedMetadata,
  clearShortsMetadataCache,
  enrichShortsPlayerOverlay,
  extractShortsMetadataFromReel,
  formatShortsUploadedAt,
  formatShortsViewCount,
} from '../mods/transforms/shorts-metadata.ts';
import type { FeedItem } from '../mods/types/innertube.ts';

function makeReelPayload(
  videoId: string,
  views: string,
  timestamp: string,
  title = 'Cool Short'
): Record<string, unknown> {
  return {
    overlay: {
      reelPlayerOverlayRenderer: {
        reelPlayerHeaderSupportedRenderers: {
          reelPlayerHeaderRenderer: {
            reelTitleText: { runs: [{ text: title }] },
            timestampText: { simpleText: timestamp },
            channelTitleText: { runs: [{ text: '@Creator' }] },
          },
        },
        buttonBar: {
          reelActionBarViewModel: {
            buttonViewModels: [
              {
                reelActionBarButtonViewModel: {
                  buttonViewModel: {
                    likeButtonViewModel: {
                      toggleButtonViewModel: {
                        toggleButtonViewModel: {
                          defaultButtonViewModel: {
                            buttonViewModel: {
                              iconName: 'EMPTY_HEART',
                              title: '385K',
                              onTap: {
                                innertubeCommand: {
                                  likeEndpoint: { target: { videoId } },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
              {
                reelActionBarButtonViewModel: {
                  buttonViewModel: {
                    buttonViewModel: { iconName: 'COMMENT', title: '6,238' },
                  },
                },
              },
            ],
          },
        },
      },
    },
    engagementPanels: [
      {
        engagementPanelSectionListRenderer: {
          content: {
            structuredDescriptionContentRenderer: {
              items: [
                {
                  videoDescriptionHeaderRenderer: {
                    views: { simpleText: views },
                    publishDate: { simpleText: 'Published on Nov 20, 2026' },
                  },
                },
              ],
            },
          },
        },
      },
    ],
    __videoId: videoId,
  };
}

describe('shorts-metadata', () => {
  test('formats view counts and upload timestamps cleanly', () => {
    assert.equal(formatShortsViewCount('12,318,166 views'), '12.3M views');
    assert.equal(formatShortsViewCount('842 views'), '842 views');
    assert.equal(formatShortsViewCount('1 view'), '1 view');
    assert.equal(formatShortsViewCount('93M views'), '93M views');
    assert.equal(formatShortsViewCount('No views'), 'No views');
    assert.equal(formatShortsViewCount(''), null);

    assert.equal(formatShortsUploadedAt('1 day ago', 'Published on Nov 20, 2026'), '1 day ago');
    assert.equal(formatShortsUploadedAt('', 'Published on Nov 20, 2026'), 'Nov 20, 2026');
    assert.equal(formatShortsUploadedAt('', ''), null);
  });

  test('extractShortsMetadataFromReel and enrichShortsPlayerOverlay append metadata idempotently', () => {
    const payload = makeReelPayload('WjCH5JUNzao', '12,318,166 views', '1 day ago', 'Can I Beat Magnus?');
    assert.equal(extractShortsMetadataFromReel(payload), '12.3M views • 1 day ago');

    assert.equal(enrichShortsPlayerOverlay(payload), true);
    const hdr = (
      payload.overlay as {
        reelPlayerOverlayRenderer: {
          reelPlayerHeaderSupportedRenderers: {
            reelPlayerHeaderRenderer: { reelTitleText: { runs: Array<{ text: string }> } };
          };
          buttonBar: {
            reelActionBarViewModel: {
              buttonViewModels: Array<{
                reelActionBarButtonViewModel?: {
                  buttonViewModel?: { buttonViewModel?: { iconName?: string; accessibilityText?: string } };
                };
              }>;
            };
          };
        };
      }
    ).reelPlayerOverlayRenderer;

    assert.deepEqual(hdr.reelPlayerHeaderSupportedRenderers.reelPlayerHeaderRenderer.reelTitleText.runs, [
      { text: 'Can I Beat Magnus?' },
      { text: '\n12.3M views • 1 day ago' },
    ]);
    assert.equal(hdr.buttonBar.reelActionBarViewModel.buttonViewModels.length, 3);
    assert.equal(
      hdr.buttonBar.reelActionBarViewModel.buttonViewModels[1]?.reelActionBarButtonViewModel?.buttonViewModel
        ?.buttonViewModel?.iconName,
      'DISLIKE'
    );

    // Second call is idempotent
    assert.equal(enrichShortsPlayerOverlay(payload), false);
    assert.equal(hdr.reelPlayerHeaderSupportedRenderers.reelPlayerHeaderRenderer.reelTitleText.runs.length, 2);
    assert.equal(hdr.buttonBar.reelActionBarViewModel.buttonViewModels.length, 3);

    // Also supports simpleText titles
    const simplePayload: Record<string, unknown> = {
      overlay: {
        reelPlayerOverlayRenderer: {
          reelPlayerHeaderSupportedRenderers: {
            reelPlayerHeaderRenderer: {
              reelTitleText: { simpleText: 'Simple Title' },
              timestampText: { simpleText: '3 hours ago' },
            },
          },
        },
      },
      engagementPanels: [
        {
          engagementPanelSectionListRenderer: {
            content: {
              structuredDescriptionContentRenderer: {
                items: [
                  {
                    videoDescriptionHeaderRenderer: {
                      factoid: [
                        { factoidRenderer: { label: { simpleText: 'Views' }, value: { simpleText: '4,500' } } },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    };
    assert.equal(enrichShortsPlayerOverlay(simplePayload), true);
    const simpleHdr = (
      simplePayload.overlay as {
        reelPlayerOverlayRenderer: {
          reelPlayerHeaderSupportedRenderers: {
            reelPlayerHeaderRenderer: { reelTitleText: { simpleText?: string; runs?: Array<{ text: string }> } };
          };
        };
      }
    ).reelPlayerOverlayRenderer.reelPlayerHeaderSupportedRenderers.reelPlayerHeaderRenderer;
    assert.equal(simpleHdr.reelTitleText.simpleText, undefined);
    assert.deepEqual(simpleHdr.reelTitleText.runs, [{ text: 'Simple Title' }, { text: '\n4.5K views • 3 hours ago' }]);
  });

  test('applyShortsFeedMetadata prefetches visible Short shelf tiles and ignores regular videos', async (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevFetch = globals.fetch;

    const fetchedIds: string[] = [];
    globals.window = {
      ytcfg: {
        data_: {
          INNERTUBE_CONTEXT: { client: { clientName: 'TVHTML5' } },
          INNERTUBE_CONTEXT_CLIENT_NAME: 7,
          INNERTUBE_CONTEXT_CLIENT_VERSION: '7.2026',
        },
      },
    };
    globals.fetch = async (_url: unknown, init?: { body?: string }) => {
      const parsed = init?.body ? (JSON.parse(init.body) as { playerRequest?: { videoId?: string } }) : {};
      const vid = parsed.playerRequest?.videoId ?? '';
      fetchedIds.push(vid);
      return {
        ok: true,
        json: async () => makeReelPayload(vid, '2,500,000 views', '2 weeks ago'),
      };
    };

    t.after(() => {
      clearShortsMetadataCache();
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      globals.fetch = prevFetch;
    });

    const regularVideo: FeedItem = {
      tileRenderer: {
        contentId: 'regVid00001',
        contentType: 'TILE_CONTENT_TYPE_VIDEO',
        metadata: { tileMetadataRenderer: { title: { simpleText: 'Regular' } } },
      },
    };
    const shortTile: FeedItem = {
      tileRenderer: {
        style: 'TILE_STYLE_YTLR_SHORTS',
        contentId: 'shortVid001',
        contentType: 'TILE_CONTENT_TYPE_SHORTS',
        metadata: { tileMetadataRenderer: { title: { simpleText: 'My Short' } } },
      },
    };

    await applyShortsFeedMetadata([regularVideo, shortTile]);
    assert.deepEqual(fetchedIds, ['shortVid001']);
    assert.equal(regularVideo.tileRenderer?.metadata?.tileMetadataRenderer?.lines, undefined);
    const shortLines = shortTile.tileRenderer?.metadata?.tileMetadataRenderer?.lines as Array<{
      lineRenderer: { items: Array<{ lineItemRenderer: { text: { simpleText: string } } }> };
    }>;
    assert.equal(
      shortLines?.[0]?.lineRenderer?.items?.[0]?.lineItemRenderer?.text?.simpleText,
      '2.5M views • 2 weeks ago'
    );

    // Subsequent call uses cache without another fetch
    const shortTileCached: FeedItem = {
      tileRenderer: {
        style: 'TILE_STYLE_YTLR_SHORTS',
        contentId: 'shortVid001',
        metadata: { tileMetadataRenderer: { title: { simpleText: 'My Short Again' } } },
      },
    };
    await applyShortsFeedMetadata([shortTileCached]);
    assert.deepEqual(fetchedIds, ['shortVid001']);
    const cachedLines = shortTileCached.tileRenderer?.metadata?.tileMetadataRenderer?.lines as typeof shortLines;
    assert.equal(
      cachedLines?.[0]?.lineRenderer?.items?.[0]?.lineItemRenderer?.text?.simpleText,
      '2.5M views • 2 weeks ago'
    );
  });
});
