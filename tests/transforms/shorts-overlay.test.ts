import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  adjustOverlayEnrichmentSuppression,
  enrichShortsPlayerOverlay,
  extractShortsMetadataFromReel,
  formatShortsUploadedAt,
  formatShortsViewCount,
} from '../../mods/transforms/shorts-overlay.ts';

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
                          toggledButtonViewModel: {
                            buttonViewModel: {
                              iconName: 'HEART',
                              title: '385K',
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

describe('shorts-overlay', () => {
  test('formats view counts and upload timestamps cleanly', () => {
    assert.equal(formatShortsViewCount(null), null);
    assert.equal(formatShortsViewCount('12,318,166 views'), '12.3M views');
    assert.equal(formatShortsViewCount('842 views'), '842 views');
    assert.equal(formatShortsViewCount('1 view'), '1 view');
    assert.equal(formatShortsViewCount('93M views'), '93M views');
    assert.equal(formatShortsViewCount('No views'), 'No views');
    assert.equal(formatShortsViewCount(''), null);

    assert.equal(formatShortsUploadedAt(null, null), null);
    assert.equal(formatShortsUploadedAt('   ', null), null);
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
    const likeToggleModel = (
      payload.overlay as {
        reelPlayerOverlayRenderer: {
          buttonBar: {
            reelActionBarViewModel: {
              buttonViewModels: Array<{
                reelActionBarButtonViewModel?: {
                  buttonViewModel?: {
                    likeButtonViewModel?: {
                      toggleButtonViewModel?: {
                        toggleButtonViewModel?: {
                          defaultButtonViewModel?: { buttonViewModel?: { title?: string } };
                          toggledButtonViewModel?: { buttonViewModel?: { title?: string } };
                        };
                      };
                    };
                  };
                };
              }>;
            };
          };
        };
      }
    ).reelPlayerOverlayRenderer.buttonBar.reelActionBarViewModel.buttonViewModels[0]?.reelActionBarButtonViewModel
      ?.buttonViewModel?.likeButtonViewModel?.toggleButtonViewModel?.toggleButtonViewModel;
    assert.equal('title' in (likeToggleModel?.defaultButtonViewModel?.buttonViewModel ?? {}), false);
    assert.equal('title' in (likeToggleModel?.toggledButtonViewModel?.buttonViewModel ?? {}), false);

    // Second call is idempotent.
    assert.equal(enrichShortsPlayerOverlay(payload), false);
    assert.equal(hdr.reelPlayerHeaderSupportedRenderers.reelPlayerHeaderRenderer.reelTitleText.runs.length, 2);
    assert.equal(hdr.buttonBar.reelActionBarViewModel.buttonViewModels.length, 3);

    // Supports simpleText titles and factoid views.
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

  test('covers helper fallbacks, engagementPanel/action-bar edge cases, and suppression guard', () => {
    assert.equal(extractShortsMetadataFromReel(null), null);
    assert.equal(
      extractShortsMetadataFromReel({
        engagementPanels: [
          {
            engagementPanelSectionListRenderer: {
              content: { structuredDescriptionContentRenderer: { items: [{ unrelated: {} }] } },
            },
          },
        ],
      }),
      null
    );
    assert.equal(
      extractShortsMetadataFromReel({
        engagementPanels: [
          { engagementPanelSectionListRenderer: { content: { structuredDescriptionContentRenderer: {} } } },
          {
            engagementPanelSectionListRenderer: {
              content: {
                structuredDescriptionContentRenderer: {
                  items: [null, { videoDescriptionHeaderRenderer: {} }],
                },
              },
            },
          },
        ],
      }),
      null
    );
    assert.equal(
      extractShortsMetadataFromReel({
        engagementPanels: [
          {
            engagementPanelSectionListRenderer: {
              content: {
                structuredDescriptionContentRenderer: {
                  items: [
                    {
                      videoDescriptionHeaderRenderer: {
                        factoid: [
                          { other: {} },
                          { factoidRenderer: { label: { simpleText: 'Likes' }, value: { simpleText: '5' } } },
                          { factoidRenderer: { label: { simpleText: 'Views' }, value: {} } },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        ],
      }),
      null
    );

    const authOverlayPayload: Record<string, unknown> = {
      overlay: {
        reelPlayerOverlayRenderer: {
          reelPlayerHeaderSupportedRenderers: {
            reelPlayerHeaderRenderer: {
              timestampText: { simpleText: '' },
            },
          },
          buttonBar: {
            reelActionBarViewModel: {
              buttonViewModels: [
                null,
                {
                  reelActionBarButtonViewModel: {
                    buttonViewModel: {
                      likeButtonViewModel: {
                        toggleButtonViewModel: {
                          toggleButtonViewModel: {
                            defaultButtonViewModel: {
                              buttonViewModel: {
                                title: '99',
                                onTap: {
                                  innertubeCommand: {
                                    authDeterminedCommand: {
                                      authenticatedCommand: {
                                        likeEndpoint: { target: { videoId: 'authShort01' } },
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
                  },
                },
              ],
            },
          },
        },
      },
    };
    assert.equal(enrichShortsPlayerOverlay(authOverlayPayload), true);
    assert.equal(enrichShortsPlayerOverlay({ overlay: { reelPlayerOverlayRenderer: {} } }), false);
    assert.equal(
      enrichShortsPlayerOverlay({
        ...makeReelPayload('noTitle0001', '500 views', '1 day ago'),
        overlay: {
          reelPlayerOverlayRenderer: {
            reelPlayerHeaderSupportedRenderers: {
              reelPlayerHeaderRenderer: {
                timestampText: { simpleText: '1 day ago' },
              },
            },
          },
        },
      }),
      false
    );

    const rawHeaderPayload = makeReelPayload('titleless1', '500 views', '1 day ago');
    (
      rawHeaderPayload as {
        overlay: {
          reelPlayerOverlayRenderer: {
            reelPlayerHeaderSupportedRenderers: {
              reelPlayerHeaderRenderer: { reelTitleText: Record<string, unknown> };
            };
          };
        };
      }
    ).overlay.reelPlayerOverlayRenderer.reelPlayerHeaderSupportedRenderers.reelPlayerHeaderRenderer.reelTitleText = {
      accessibility: { accessibilityData: { label: 'Short accessible title' } },
    };
    assert.equal(enrichShortsPlayerOverlay(rawHeaderPayload), true);

    adjustOverlayEnrichmentSuppression(1);
    try {
      assert.equal(enrichShortsPlayerOverlay(makeReelPayload('suppressed1', '500 views', '1 day ago')), false);
    } finally {
      adjustOverlayEnrichmentSuppression(-1);
    }
  });
});
