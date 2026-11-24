import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  installInnertubeInterceptor,
  patchPlaybackContextBody,
  syncYttvPreviewAndJson,
  transformInnertubeResponseSync,
} from '../mods/core/innertube-interceptor.ts';
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

  test('breaks audio track ties by channels, sourceDefault, bitrate, and original input order', () => {
    const tieFormats: AudioFormatEntry[] = [
      {
        itag: 301,
        mimeType: 'audio/mp4',
        audioChannels: 2,
        bitrate: 128000,
        audioTrack: { id: 'a.1', displayName: 'Same', audioIsDefault: false },
      },
      {
        itag: 302,
        mimeType: 'audio/mp4',
        audioChannels: 2,
        bitrate: 128000,
        audioTrack: { id: 'b.1', displayName: 'Same', audioIsDefault: true },
      },
      {
        itag: 303,
        mimeType: 'audio/mp4',
        audioChannels: 2,
        bitrate: 96000,
        audioTrack: { id: 'c.1', displayName: 'Same', audioIsDefault: false },
      },
      {
        itag: 304,
        mimeType: 'audio/mp4; codecs="ec-3"',
        audioChannels: 6,
        bitrate: 256000,
        audioTrack: { id: 'c.1', displayName: 'Same', audioIsDefault: false },
      },
      {
        itag: 305,
        mimeType: 'audio/mp4; codecs="ec-3"',
        audioChannels: 6,
        bitrate: 384000,
        audioTrack: { id: 'a.1', displayName: 'Same', audioIsDefault: false },
      },
      {
        itag: 306,
        mimeType: 'audio/mp4',
        audioChannels: 2,
        bitrate: 64000,
        audioTrack: { id: 'a.1', displayName: 'Same', audioIsDefault: false },
      },
    ];

    const ranked = filterStreamingFormats(tieFormats);
    // All 3 share displayName 'Same', but a.1 & c.1 upgrade to 5.1; b.1 picks up sourceDefault after a.1/c.1.
    assert.equal(ranked[0]?.audioTrack?.id, 'a.1');
    assert.equal(ranked[0]?.audioTrack?.audioIsDefault, true);
    assert.deepEqual(
      ranked.filter((f) => f.audioTrack?.id === 'a.1').map((f) => f.itag),
      [305, 301, 306]
    );

    // Non-best tracks with identical isOriginal, bestTier, and displayName fall back to firstIndex tie-breaker.
    const sameNonBestRanked = filterStreamingFormats([
      {
        itag: 401,
        mimeType: 'audio/mp4',
        audioChannels: 2,
        audioTrack: { id: 'best.4', displayName: 'Original', audioIsDefault: false },
      },
      {
        itag: 402,
        mimeType: 'audio/mp4',
        audioChannels: 2,
        audioTrack: { id: 'dup.2', displayName: 'Alt', audioIsDefault: false },
      },
      {
        itag: 403,
        mimeType: 'audio/mp4',
        audioChannels: 2,
        audioTrack: { id: 'dup.1', displayName: 'Alt', audioIsDefault: true },
      },
    ]);
    assert.deepEqual(
      sameNonBestRanked.map((f) => f.itag),
      [401, 402, 403]
    );
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
    const restore = installInnertubeInterceptor();
    t.after(restore);

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

  test('strips nested playerResponse ads/endscreen/messages, handles direct list/action/nav/fallback paths, and hooks fetch/XHR/Response', async (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevDocument = globals.document;
    const prevXhr = globals.XMLHttpRequest;

    const sentFetchRequests: Array<{ url: string; body?: string }> = [];
    const sentXhrBodies: unknown[] = [];

    class MockXhr {
      send(body?: unknown): void {
        sentXhrBodies.push(body);
      }
    }

    const flagsMap = new Map<string, unknown>([['ENABLE_PREVIEWS_WITH_SOUND', false]]);
    const yttvParse = (s: string) => JSON.parse(s);
    const fakeWindow: Record<string, unknown> = {
      fetch: async (resource: unknown, init?: { body?: string }) => {
        sentFetchRequests.push({ url: String(resource), body: init?.body });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      _yttv: {
        flags: flagsMap,
        jsonMod: { JSON: { parse: yttvParse } },
        host: { instance: { resolveCommand: () => true } },
      },
    };
    globals.window = fakeWindow;
    globals.document = {
      addEventListener: () => {},
      removeEventListener: () => {},
      documentElement: {},
    };
    globals.XMLHttpRequest = MockXhr;

    const restore = installInnertubeInterceptor();
    // Second install returns idempotent no-op.
    installInnertubeInterceptor()();
    t.after(() => {
      restore();
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
      if (prevXhr === undefined) delete globals.XMLHttpRequest;
      else globals.XMLHttpRequest = prevXhr;
    });

    // JSON.parse array & primitive passthrough + _yttv JSON wrapper + ENABLE_PREVIEWS_WITH_SOUND sync.
    syncYttvPreviewAndJson();
    assert.equal(flagsMap.get('ENABLE_PREVIEWS_WITH_SOUND'), true);
    const wrappedYttvParse = (fakeWindow._yttv as { jsonMod: { JSON: { parse: typeof JSON.parse } } }).jsonMod.JSON
      .parse;
    assert.deepEqual(wrappedYttvParse('[1,2]'), [1, 2]);
    assert.equal(wrappedYttvParse('null'), null);
    assert.equal(wrappedYttvParse('42'), 42);
    assert.deepEqual(JSON.parse('[1,2]'), [1, 2]);
    assert.equal(JSON.parse('null'), null);
    assert.equal(JSON.parse('42'), 42);

    // Filtered tile inside replaceEnclosingAction.item is removed.
    const replacePaid = {
      onResponseReceivedCommand: {
        replaceEnclosingAction: {
          item: { tileRenderer: { onSelectCommand: { ypcGetOffersEndpoint: {} } } },
        },
      },
    };
    transformInnertubeResponseSync(replacePaid);
    assert.equal('item' in replacePaid.onResponseReceivedCommand.replaceEnclosingAction, false);

    // Outgoing fetch & XHR playbackContext body patching + malformed/already-patched cases.
    assert.equal(patchPlaybackContextBody('no-context'), null);
    assert.equal(patchPlaybackContextBody('{"playbackContext":'), null);
    assert.equal(
      patchPlaybackContextBody(
        JSON.stringify({ playbackContext: { contentPlaybackContext: { isInlinePlaybackNoAd: true } } })
      ),
      null
    );

    await (fakeWindow.fetch as typeof fetch)('https://www.youtube.com/youtubei/v1/player', {
      body: JSON.stringify({ playbackContext: { contentPlaybackContext: { vis: 0 } } }),
    });
    await (fakeWindow.fetch as typeof fetch)('https://www.youtube.com/youtubei/v1/browse', {
      body: JSON.stringify({ context: {} }),
    });
    assert.equal(
      JSON.parse(sentFetchRequests[0]?.body || '{}').playbackContext.contentPlaybackContext.isInlinePlaybackNoAd,
      true
    );
    assert.equal(JSON.parse(sentFetchRequests[1]?.body || '{}').playbackContext, undefined);

    const xhr = new MockXhr();
    xhr.send(JSON.stringify({ playbackContext: { contentPlaybackContext: { vis: 0 } } }));
    xhr.send('plain');
    assert.equal(
      JSON.parse(String(sentXhrBodies[0])).playbackContext.contentPlaybackContext.isInlinePlaybackNoAd,
      true
    );
    assert.equal(sentXhrBodies[1], 'plain');

    // Response.prototype.json skips external hosts and transforms InnerTube payloads.
    const sbResp = Object.assign(new Response(JSON.stringify({ adSlots: [1] })), {});
    Object.defineProperty(sbResp, 'url', { value: 'https://sponsor.ajay.app/api/branding' });
    assert.deepEqual(await sbResp.json(), { adSlots: [1] });

    const ytResp = new Response(
      JSON.stringify({
        playerResponse: {
          adPlacements: [{}],
          endscreen: { endscreenRenderer: {} },
          messages: [{ youThereRenderer: {} }, { mealbarPromoRenderer: {} }],
          streamingData: {
            adaptiveFormats: [{ itag: 140, mimeType: 'audio/mp4', audioTrack: { id: 'en.4', displayName: 'English' } }],
          },
        },
        overlay: {
          reelPlayerOverlayRenderer: {},
        },
      })
    );
    const ytParsed = (await ytResp.json()) as {
      playerResponse: { adPlacements: unknown[]; endscreen: unknown; messages: unknown[] };
    };
    assert.deepEqual(ytParsed.playerResponse.adPlacements, []);
    assert.equal(ytParsed.playerResponse.endscreen, null);
    assert.equal(ytParsed.playerResponse.messages.length, 1);

    // Covers non-subscription tvSecondaryNavSectionRenderer (keeps server tab order while filtering content),
    // richSectionRenderer fallback content, sectionListRenderer/horizontalListRenderer inside shelves,
    // onResponseReceivedCommand, top-level listMutationCommand, and replaceEnclosingAction removal.
    const complexPayload: Record<string, unknown> = {
      tvBrowseContent: {
        tvSecondaryNavRenderer: {
          sections: [
            {
              tvSecondaryNavSectionRenderer: {
                tabs: [
                  {
                    tabRenderer: {
                      title: 'Zebra Tab',
                      endpoint: { browseEndpoint: { browseId: 'FEhistory' } },
                      content: {
                        tvSurfaceContentRenderer: {
                          content: {
                            gridRenderer: { items: [{ adSlotRenderer: {} }, { tileRenderer: { contentId: 'h1' } }] },
                          },
                        },
                      },
                    },
                  },
                  {
                    tabRenderer: {
                      title: 'Alpha Tab',
                      endpoint: { browseEndpoint: { browseId: 'FElibrary' } },
                    },
                  },
                ],
              },
            },
          ],
        },
      },
      contents: {
        sectionListRenderer: {
          contents: [
            {
              richSectionRenderer: {
                content: {
                  horizontalListRenderer: { items: [{ adSlotRenderer: {} }, { tileRenderer: { contentId: 'rs1' } }] },
                },
              },
            },
            {
              sectionListRenderer: {
                contents: [{ adSlotRenderer: {} }, { tileRenderer: { contentId: 'nestedSl1' } }],
              },
            },
            {
              horizontalListRenderer: {
                items: [{ adSlotRenderer: {} }, { tileRenderer: { contentId: 'hl1' } }],
              },
            },
          ],
        },
      },
      onResponseReceivedCommand: {
        replaceEnclosingAction: { item: { adSlotRenderer: {} } },
      },
      listMutationCommand: {
        operations: {
          operations: [
            {
              insertItemSectionContent: {
                contents: [{ adSlotRenderer: {} }, { tileRenderer: { contentId: 'lm1' } }],
              },
            },
          ],
        },
      },
      onResponseReceivedActions: [
        {
          replaceEnclosingAction: { item: { surveyRenderer: {} } },
        },
      ],
    };

    transformInnertubeResponseSync(complexPayload);
    const navTabs =
      (
        complexPayload.tvBrowseContent as {
          tvSecondaryNavRenderer: {
            sections: Array<{ tvSecondaryNavSectionRenderer: { tabs: Array<{ tabRenderer: { title: string } }> } }>;
          };
        }
      ).tvSecondaryNavRenderer.sections[0]?.tvSecondaryNavSectionRenderer.tabs ?? [];
    assert.deepEqual(
      navTabs.map((t) => t.tabRenderer.title),
      ['Zebra Tab', 'Alpha Tab']
    );
    assert.equal(
      'item' in
        (complexPayload.onResponseReceivedCommand as { replaceEnclosingAction: Record<string, unknown> })
          .replaceEnclosingAction,
      false
    );
    const firstAction = (
      complexPayload.onResponseReceivedActions as Array<{ replaceEnclosingAction: Record<string, unknown> }>
    )[0];
    assert.equal(firstAction ? 'item' in firstAction.replaceEnclosingAction : true, false);

    // Top-level try/catch handles cyclic or throwing getters cleanly.
    const origError = console.error;
    let errorCount = 0;
    console.error = () => {
      errorCount++;
    };
    try {
      const broken = {
        adPlacements: [],
        get endscreen() {
          throw new Error('bad getter');
        },
      };
      transformInnertubeResponseSync(broken);
      assert.equal(errorCount, 1);
    } finally {
      console.error = origError;
    }
  });

  test('gates inline preview injection off during active Watch/Shorts playback and on Watch/next continuations', (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevDocument = globals.document;
    t.after(() => {
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
    });

    const fakeLocation = { hash: '#/watch?v=mainVid', search: '' };
    globals.window = { location: fakeLocation };
    globals.document = { body: { classList: { contains: () => false } } };

    const makeTile = (
      videoId: string
    ): {
      tileRenderer: {
        contentId: string;
        style: string;
        onSelectCommand: { watchEndpoint: { videoId: string } };
        onFocusCommand?: unknown;
      };
    } => ({
      tileRenderer: {
        contentId: videoId,
        style: 'TILE_STYLE_YTLR_DEFAULT',
        onSelectCommand: { watchEndpoint: { videoId } },
      },
    });

    // 1. Continuation & action items received while on #/watch?v=... must NOT inject startInlinePlaybackCommand.
    const watchContinuationPayload = {
      continuationContents: {
        horizontalListContinuation: { items: [makeTile('sugH1')] },
        sectionListContinuation: {
          contents: [{ shelfRenderer: { content: { horizontalListRenderer: { items: [makeTile('sugS1')] } } } }],
        },
      },
      onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [makeTile('sugAct1')] } }],
    };
    transformInnertubeResponseSync(watchContinuationPayload);
    assert.equal(
      watchContinuationPayload.continuationContents.horizontalListContinuation.items[0]?.tileRenderer.onFocusCommand,
      undefined
    );
    assert.equal(
      watchContinuationPayload.continuationContents.sectionListContinuation.contents[0]?.shelfRenderer.content
        .horizontalListRenderer.items[0]?.tileRenderer.onFocusCommand,
      undefined
    );
    assert.equal(
      watchContinuationPayload.onResponseReceivedActions[0]?.appendContinuationItemsAction.continuationItems[0]
        ?.tileRenderer.onFocusCommand,
      undefined
    );

    // 2. Even if location.hash is #/ (before hash updates), payloads with playerOverlays / singleColumnWatchNextResults suppress previews.
    fakeLocation.hash = '#/';
    const watchNextPayload = {
      playerOverlays: { playerOverlayRenderer: {} },
      continuationContents: {
        horizontalListContinuation: { items: [makeTile('sugOverlay1')] },
      },
    };
    transformInnertubeResponseSync(watchNextPayload);
    assert.equal(
      watchNextPayload.continuationContents.horizontalListContinuation.items[0]?.tileRenderer.onFocusCommand,
      undefined
    );

    // 3. Same continuation parsed on Home (#/) injects startInlinePlaybackCommand normally.
    const homeContinuationPayload = {
      continuationContents: {
        horizontalListContinuation: { items: [makeTile('homeSug1')] },
      },
    };
    transformInnertubeResponseSync(homeContinuationPayload);
    assert.ok(
      homeContinuationPayload.continuationContents.horizontalListContinuation.items[0]?.tileRenderer.onFocusCommand
    );
  });

  test('[TDD Red: M5] processShelvesSync filters direct browse items once instead of double-scanning badges', () => {
    let badgeReads = 0;
    const tile: Record<string, unknown> = {
      contentId: 'directOnce1',
      style: 'TILE_STYLE_YTLR_DEFAULT',
      onSelectCommand: { watchEndpoint: { videoId: 'directOnce1' } },
    };
    Object.defineProperty(tile, 'badges', {
      enumerable: true,
      get() {
        badgeReads++;
        return [{ metadataBadgeRenderer: { label: 'HD' } }];
      },
    });

    const browsePayload = {
      contents: {
        tvBrowseRenderer: {
          content: {
            tvSurfaceContentRenderer: {
              content: {
                sectionListRenderer: {
                  contents: [{ tileRenderer: tile }],
                },
              },
            },
          },
        },
      },
    };

    transformInnertubeResponseSync(browsePayload);
    assert.equal(badgeReads, 1);
  });
});
