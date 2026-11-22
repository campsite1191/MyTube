import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { installInnertubeInterceptor, transformInnertubeResponseSync } from '../mods/core/innertube-interceptor.ts';
import type { AudioFormatEntry, SubscriptionTab } from '../mods/transforms/innertube-player.ts';
import {
  dedupeAndSortSubscriptionTabs,
  disableAutoCaptionsInPayload,
  filterStreamingFormats,
  getAudioTier,
  stripAdsFromPayload,
} from '../mods/transforms/innertube-player.ts';
import { installTransportControlsStyles } from '../mods/transforms/player-overlays.ts';

describe('getAudioTier and filterStreamingFormats', () => {
  test('ranks 7.1 > 5.1 > Voice Boost > Original Stereo > DRC', () => {
    const drc: AudioFormatEntry = { mimeType: 'audio/mp4', isDrc: true, audioChannels: 2 };
    const stereo: AudioFormatEntry = { mimeType: 'audio/mp4', audioChannels: 2 };
    const voiceBoost: AudioFormatEntry = { mimeType: 'audio/mp4', xtags: 'vb=1', audioChannels: 2 };
    const surround51: AudioFormatEntry = { mimeType: 'audio/mp4; codecs="ec-3"', audioChannels: 6 };
    const surround71: AudioFormatEntry = { mimeType: 'audio/mp4', audioChannels: 8 };

    assert.equal(getAudioTier(surround71), 1);
    assert.equal(getAudioTier(surround51), 2);
    assert.equal(getAudioTier(voiceBoost), 3);
    assert.equal(getAudioTier(stereo), 4);
    assert.equal(getAudioTier(drc), 5);
  });

  test('preserves all video/audio formats and ranks Original > Surround > Voice Boost > Stereo > DRC', () => {
    const formats: AudioFormatEntry[] = [
      { itag: 137, mimeType: 'video/mp4; codecs="avc1.640028"' },
      { itag: 248, mimeType: 'video/webm; codecs="vp9"' },
      {
        itag: 142,
        mimeType: 'audio/mp4',
        xtags: 'drc=1',
        audioChannels: 2,
        audioTrack: { id: 'es.1', displayName: 'Spanish', audioIsDefault: true },
      },
      {
        itag: 141,
        mimeType: 'audio/mp4',
        audioChannels: 2,
        audioTrack: { id: 'es.1', displayName: 'Spanish', audioIsDefault: true },
      },
      {
        itag: 140,
        mimeType: 'audio/mp4',
        audioChannels: 2,
        bitrate: 128000,
        audioTrack: { id: 'en.4', displayName: 'English original', audioIsDefault: false },
      },
      {
        itag: 258,
        mimeType: 'audio/mp4; codecs="ec-3"',
        audioChannels: 6,
        bitrate: 384000,
        audioTrack: { id: 'en.4', displayName: 'English original', audioIsDefault: false },
      },
      {
        itag: 143,
        mimeType: 'audio/mp4',
        audioChannels: 2,
        audioTrack: { id: 'fr.1', displayName: 'French', audioIsDefault: false },
      },
    ];

    const filtered = filterStreamingFormats(formats);
    assert.deepEqual(
      filtered.map((f) => f.itag),
      [137, 248, 258, 140, 143, 141, 142]
    );
    assert.equal(filtered[2]?.audioTrack?.audioIsDefault, true);
    assert.equal(filtered[3]?.audioTrack?.audioIsDefault, true);
    assert.equal(filtered[4]?.audioTrack?.audioIsDefault, false);
    assert.equal(filtered[5]?.audioTrack?.audioIsDefault, false);
    assert.equal(filtered[6]?.audioTrack?.audioIsDefault, false);
  });
});

describe('disableAutoCaptionsInPayload', () => {
  test('forces captionsInitialState and audioTracks visibility off', () => {
    const payload: Record<string, unknown> = {
      captions: {
        playerCaptionsTracklistRenderer: {
          captionsInitialState: 'CAPTIONS_INITIAL_STATE_ON_REQUIRED',
          audioTracks: [{ defaultCaptionTrackIndex: 0, visibility: 'ON', hasDefaultTrack: true }],
        },
      },
    };

    disableAutoCaptionsInPayload(payload);
    const tl = (payload.captions as Record<string, Record<string, unknown>>).playerCaptionsTracklistRenderer;
    assert.equal(tl?.captionsInitialState, 'CAPTIONS_INITIAL_STATE_OFF_REQUIRED');
    const track = (tl?.audioTracks as Array<Record<string, unknown>> | undefined)?.[0];
    assert.equal(track?.visibility, 'OFF');
    assert.equal(track?.hasDefaultTrack, false);
    assert.equal('defaultCaptionTrackIndex' in (track ?? {}), false);
  });
});

describe('dedupeAndSortSubscriptionTabs', () => {
  test('deduplicates tabs by browseId+params and keeps selected tab first when sorting', () => {
    const tabs: SubscriptionTab[] = [
      { tabRenderer: { title: 'Zeta', endpoint: { browseEndpoint: { browseId: 'UCz', params: 'p1' } } } },
      { tabRenderer: { title: 'Alpha', endpoint: { browseEndpoint: { browseId: 'UCa', params: 'p1' } } } },
      { tabRenderer: { title: 'Alpha Dup', endpoint: { browseEndpoint: { browseId: 'UCa', params: 'p1' } } } },
      { tabRenderer: { selected: true, title: 'Selected', endpoint: { browseEndpoint: { browseId: 'UCs' } } } },
    ];

    const result = dedupeAndSortSubscriptionTabs(tabs, new Set<string>());
    assert.deepEqual(
      result.map((t) => t.tabRenderer?.title),
      ['Selected', 'Alpha', 'Zeta']
    );
  });
});

describe('stripAdsFromPayload', () => {
  test('clears player ad fields and filters Shorts ad entries', () => {
    const payload: Record<string, unknown> = {
      adPlacements: [{ adPlacementRenderer: {} }],
      playerAds: [{ playerLegacyDesktopWatchAdsRenderer: {} }],
      adSlots: [{ adSlotRenderer: {} }],
      entries: [
        { command: { reelWatchEndpoint: { videoId: 'v1' } } },
        { command: { reelWatchEndpoint: { videoId: 'ad1', adClientParams: { isAd: true } } } },
        { command: { reelWatchEndpoint: { videoId: 'v2', adClientParams: { isAd: false } } } },
      ],
    };

    stripAdsFromPayload(payload);

    assert.deepEqual(payload.adPlacements, []);
    assert.equal(payload.playerAds, false);
    assert.deepEqual(payload.adSlots, []);
    assert.equal((payload.entries as unknown[]).length, 2);
  });
});

describe('TV browse/JSON.parse transforms', () => {
  test('transforms tvBrowseRenderer home feed shelves synchronously via JSON.parse', (t) => {
    const prevParse = JSON.parse;
    installInnertubeInterceptor();
    t.after(() => {
      JSON.parse = prevParse;
    });

    const rawHomeJson = JSON.stringify({
      contents: {
        tvBrowseRenderer: {
          content: {
            tvSurfaceContentRenderer: {
              content: {
                sectionListRenderer: {
                  contents: [
                    { feedNudgeRenderer: {} },
                    { adSlotRenderer: {} },
                    {
                      shelfRenderer: {
                        content: {
                          horizontalListRenderer: {
                            items: [
                              { adSlotRenderer: {} },
                              {
                                tileRenderer: {
                                  contentId: 'abc123',
                                  style: 'TILE_STYLE_YTLR_DEFAULT',
                                  onSelectCommand: {
                                    watchEndpoint: { videoId: 'abc123' },
                                  },
                                  header: {
                                    tileHeaderRenderer: {
                                      thumbnail: {
                                        thumbnails: [
                                          { url: 'https://i.ytimg.com/vi/abc123/hqdefault.jpg', width: 480 },
                                        ],
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
                  ],
                },
              },
            },
          },
        },
      },
    });

    const parsed = JSON.parse(rawHomeJson) as {
      contents: {
        tvBrowseRenderer: {
          content: {
            tvSurfaceContentRenderer: {
              content: {
                sectionListRenderer: {
                  contents: Array<{
                    shelfRenderer: {
                      content: {
                        horizontalListRenderer: {
                          items: Array<{
                            tileRenderer: {
                              onFocusCommand?: {
                                startInlinePlaybackCommand?: {
                                  playbackEndpoint?: { watchEndpoint?: { videoId?: string } };
                                };
                              };
                              header: {
                                tileHeaderRenderer: {
                                  thumbnail: { thumbnails: Array<{ url: string }> };
                                };
                              };
                            };
                          }>;
                        };
                      };
                    };
                  }>;
                };
              };
            };
          };
        };
      };
    };
    const shelves =
      parsed.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content.sectionListRenderer.contents;
    assert.equal(shelves.length, 1);

    const items = shelves[0]?.shelfRenderer.content.horizontalListRenderer.items;
    assert.equal(items?.length, 1);
    assert.equal(
      items?.[0]?.tileRenderer.onFocusCommand?.startInlinePlaybackCommand?.playbackEndpoint?.watchEndpoint?.videoId,
      'abc123'
    );
    assert.equal(
      items?.[0]?.tileRenderer.header.tileHeaderRenderer.thumbnail.thumbnails[0]?.url,
      'https://i.ytimg.com/vi/abc123/hq720.jpg'
    );

    // Ensure native settings payloads pass through untouched by transformInnertubeResponseSync.
    const settingsPayload = {
      title: { runs: [{ text: 'Settings' }] },
      items: [{ settingCategoryCollectionRenderer: { categoryId: 'ABOUT', items: [] } }],
    };
    transformInnertubeResponseSync(settingsPayload);
    assert.equal(settingsPayload.items.length, 1);

    // Verify Previous/Next transport controls are stripped while Like and Comments remain intact.
    const nextPayload = {
      transportControls: {
        transportControlsRenderer: {
          skipPreviousButton: { buttonRenderer: {} },
          skipNextButton: { buttonRenderer: {} },
          promotedActions: [
            {
              type: 'TRANSPORT_CONTROLS_BUTTON_TYPE_PREVIOUS',
              button: { buttonRenderer: { icon: { iconType: 'SKIP_PREVIOUS' } } },
            },
            {
              type: 'TRANSPORT_CONTROLS_BUTTON_TYPE_NEXT',
              button: {
                buttonRenderer: {
                  icon: { iconType: 'SKIP_NEXT' },
                  navigationEndpoint: { signalAction: { signal: 'PLAYER_PLAY_NEXT' } },
                },
              },
            },
            {
              type: 'TRANSPORT_CONTROLS_BUTTON_TYPE_SPONSORBLOCK_HIGHLIGHT',
              button: {
                buttonRenderer: {
                  icon: { iconType: 'SKIP_NEXT' },
                  navigationEndpoint: { customAction: { action: 'SKIP', parameters: { time: 42 } } },
                },
              },
            },
            { type: 'TRANSPORT_CONTROLS_BUTTON_TYPE_LIKE_BUTTON', button: { likeButtonRenderer: {} } },
            { type: 'TRANSPORT_CONTROLS_BUTTON_TYPE_COMMENTS', button: { buttonRenderer: {} } },
          ],
        },
      },
    };
    transformInnertubeResponseSync(nextPayload);
    const tc = nextPayload.transportControls.transportControlsRenderer;
    assert.equal('skipPreviousButton' in tc, false);
    assert.equal('skipNextButton' in tc, false);
    assert.deepEqual(
      tc.promotedActions.map((entry) => entry.type),
      [
        'TRANSPORT_CONTROLS_BUTTON_TYPE_SPONSORBLOCK_HIGHLIGHT',
        'TRANSPORT_CONTROLS_BUTTON_TYPE_LIKE_BUTTON',
        'TRANSPORT_CONTROLS_BUTTON_TYPE_COMMENTS',
      ]
    );
  });

  test('installTransportControlsStyles injects static display:none CSS for skipPrevious/skipNext controls once', (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevDocument = globals.document;
    const prevCssStyleSheet = globals.CSSStyleSheet;
    t.after(() => {
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
      if (prevCssStyleSheet === undefined) delete globals.CSSStyleSheet;
      else globals.CSSStyleSheet = prevCssStyleSheet;
    });

    globals.CSSStyleSheet = class {
      cssText = '';
      replaceSync(text: string): void {
        this.cssText = text;
      }
    };
    const fakeDoc = { adoptedStyleSheets: [] as Array<{ cssText: string }> };
    globals.document = fakeDoc;

    installTransportControlsStyles();
    installTransportControlsStyles();

    assert.equal(fakeDoc.adoptedStyleSheets.length, 1);
    const css = fakeDoc.adoptedStyleSheets[0]?.cssText ?? '';
    assert.match(css, /\[idomkey="skipPrevious"\]/);
    assert.match(css, /\[idomkey="skipNext"\]/);
    assert.doesNotMatch(css, /WEB_PAGE_TYPE_SHORTS/);
    assert.match(css, /display:\s*none\s*!important/);
  });

  test('filters Channels you watch and Explore more topics across listMutationCommand and standalone headers', () => {
    const payload = {
      onResponseReceivedCommands: [
        {
          listMutationCommand: {
            operations: {
              operations: [
                {
                  insertItemSectionContent: {
                    contents: [
                      { sectionHeaderViewModel: { headline: { text: { content: 'Channels you watch' } } } },
                      { shelfRenderer: { content: { horizontalListRenderer: { items: [] } } } },
                      {
                        shelfRenderer: {
                          headerRenderer: { shelfHeaderRenderer: { title: { simpleText: 'Explore more topics' } } },
                        },
                      },
                      {
                        shelfRenderer: {
                          headerRenderer: { shelfHeaderRenderer: { title: { simpleText: 'Recommended' } } },
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      ],
    };

    transformInnertubeResponseSync(payload);
    const contents =
      payload.onResponseReceivedCommands[0]?.listMutationCommand.operations.operations[0]?.insertItemSectionContent
        .contents ?? [];
    assert.equal(contents.length, 1);
    assert.equal(
      (
        contents[0] as {
          shelfRenderer?: { headerRenderer?: { shelfHeaderRenderer?: { title?: { simpleText?: string } } } };
        }
      )?.shelfRenderer?.headerRenderer?.shelfHeaderRenderer?.title?.simpleText,
      'Recommended'
    );
  });

  test('transforms richSectionRenderer, continuationContents, browse actions, secondary nav, and watchNext pivot', () => {
    const payload = {
      endscreen: { endscreenRenderer: {} },
      messages: [{ youThereRenderer: {} }, { mealbarPromoRenderer: {} }],
      contents: {
        singleColumnBrowseResultsRenderer: {
          tabs: [
            {
              tabRenderer: {
                content: {
                  richGridRenderer: {
                    contents: [
                      {
                        richSectionRenderer: {
                          content: {
                            richShelfRenderer: {
                              contents: [
                                { adSlotRenderer: {} },
                                {
                                  richItemRenderer: {
                                    content: {
                                      tileRenderer: {
                                        contentId: 'richVid1',
                                        style: 'TILE_STYLE_YTLR_DEFAULT',
                                        onSelectCommand: { watchEndpoint: { videoId: 'richVid1' } },
                                        header: {
                                          tileHeaderRenderer: {
                                            thumbnail: {
                                              thumbnails: [
                                                { url: 'https://i.ytimg.com/vi/richVid1/hqdefault.jpg', width: 480 },
                                              ],
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
                      {
                        itemSectionRenderer: {
                          contents: [{ adSlotRenderer: {} }],
                        },
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
        singleColumnWatchNextResults: {
          pivot: {
            sectionListRenderer: {
              contents: [
                { alertWithActionsRenderer: {} },
                {
                  shelfRenderer: {
                    content: {
                      items: [
                        { adSlotRenderer: {} },
                        {
                          tileRenderer: {
                            contentId: 'pivotVid1',
                            style: 'TILE_STYLE_YTLR_DEFAULT',
                            onSelectCommand: { watchEndpoint: { videoId: 'pivotVid1' } },
                          },
                        },
                      ],
                    },
                  },
                },
              ],
            },
          },
        },
      },
      tvBrowseContent: {
        tvSecondaryNavRenderer: {
          sections: [
            {
              tvSecondaryNavSectionRenderer: {
                tabs: [
                  {
                    tabRenderer: {
                      title: 'SubA',
                      endpoint: { browseEndpoint: { browseId: 'UC1' } },
                      content: {
                        tvSurfaceContentRenderer: {
                          content: {
                            gridRenderer: {
                              items: [{ adSlotRenderer: {} }, { tileRenderer: { contentId: 'subVid1' } }],
                            },
                          },
                        },
                      },
                    },
                  },
                ],
              },
            },
          ],
        },
      },
      continuationContents: {
        sectionListContinuation: {
          contents: [{ adSlotRenderer: {} }, { shelfRenderer: { title: { simpleText: 'ContShelf' } } }],
        },
        horizontalListContinuation: {
          items: [{ adSlotRenderer: {} }, { tileRenderer: { contentId: 'hCont1' } }],
        },
        gridContinuation: {
          items: [{ adSlotRenderer: {} }, { tileRenderer: { contentId: 'gCont1' } }],
        },
        tvSurfaceContentContinuation: {
          content: {
            sectionListRenderer: {
              contents: [{ adSlotRenderer: {} }, { shelfRenderer: { title: { simpleText: 'SurfCont' } } }],
            },
          },
        },
      },
      onResponseReceivedActions: [
        {
          reloadContinuationItemsCommand: {
            continuationItems: [
              { adSlotRenderer: {} },
              {
                sectionListContinuation: {
                  contents: [{ adSlotRenderer: {} }, { shelfRenderer: { title: { simpleText: 'ReloadCont' } } }],
                },
              },
            ],
          },
        },
        {
          appendContinuationItemsAction: {
            continuationItems: [
              {
                tvSurfaceContentContinuation: {
                  content: {
                    gridRenderer: {
                      items: [{ adSlotRenderer: {} }, { tileRenderer: { contentId: 'appendVid1' } }],
                    },
                  },
                },
              },
            ],
          },
        },
        {
          replaceEnclosingAction: {
            item: {
              tileRenderer: {
                contentId: 'repVid1',
                style: 'TILE_STYLE_YTLR_DEFAULT',
                onSelectCommand: { watchEndpoint: { videoId: 'repVid1' } },
              },
            },
          },
        },
      ],
    };

    transformInnertubeResponseSync(payload);

    assert.equal(payload.endscreen, null);
    assert.equal(payload.messages.length, 1);

    // Empty itemSectionRenderer removed after its only child adSlotRenderer was filtered
    const richGridContents =
      payload.contents.singleColumnBrowseResultsRenderer.tabs[0]?.tabRenderer.content.richGridRenderer.contents ?? [];
    assert.equal(richGridContents.length, 1);

    // Pivot strips alertWithActionsRenderer and filters adSlotRenderer without adding inline preview
    const pivotContents = payload.contents.singleColumnWatchNextResults.pivot.sectionListRenderer.contents;
    assert.equal(pivotContents.length, 1);
    const pivotItems = (
      pivotContents[0] as { shelfRenderer?: { content?: { items?: Array<Record<string, unknown>> } } }
    )?.shelfRenderer?.content?.items;
    assert.equal(pivotItems?.length, 1);
    assert.equal((pivotItems?.[0]?.tileRenderer as Record<string, unknown>)?.onFocusCommand, undefined);

    assert.equal(payload.continuationContents.sectionListContinuation.contents.length, 1);
    assert.equal(payload.continuationContents.horizontalListContinuation.items.length, 1);
    assert.equal(payload.continuationContents.gridContinuation.items.length, 1);
    assert.equal(
      payload.continuationContents.tvSurfaceContentContinuation.content.sectionListRenderer.contents.length,
      1
    );
  });
});
