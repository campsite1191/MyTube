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

  test('filters to preferred video codec and arranges all audio tracks in recommended order with best selected initially', () => {
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

    const filtered = filterStreamingFormats(formats, 'vp9');
    assert.deepEqual(
      filtered.map((f) => f.itag),
      [248, 258, 140, 143, 141, 142]
    );
    assert.equal(filtered[1]?.audioTrack?.audioIsDefault, true);
    assert.equal(filtered[2]?.audioTrack?.audioIsDefault, true);
    assert.equal(filtered[3]?.audioTrack?.audioIsDefault, false);
    assert.equal(filtered[4]?.audioTrack?.audioIsDefault, false);
    assert.equal(filtered[5]?.audioTrack?.audioIsDefault, false);
  });

  test('keeps all video formats when preferred codec is absent', () => {
    const formats: AudioFormatEntry[] = [
      { itag: 137, mimeType: 'video/mp4; codecs="avc1.640028"' },
      { itag: 140, mimeType: 'audio/mp4', audioChannels: 2 },
    ];
    const filtered = filterStreamingFormats(formats, 'av01');
    assert.deepEqual(
      filtered.map((f) => f.itag),
      [137, 140]
    );
  });

  test('arranges DRC ahead of Voice Boost / Stereo when preferDrcAudio is enabled while keeping surround first', () => {
    const drc: AudioFormatEntry = { itag: 140, mimeType: 'audio/mp4', xtags: 'drc=1', audioChannels: 2 };
    const stereo: AudioFormatEntry = { itag: 251, mimeType: 'audio/webm', audioChannels: 2 };
    const voiceBoost: AudioFormatEntry = { itag: 250, mimeType: 'audio/webm', xtags: 'vb=1', audioChannels: 2 };
    const surround51: AudioFormatEntry = { itag: 258, mimeType: 'audio/mp4; codecs="ec-3"', audioChannels: 6 };

    assert.equal(getAudioTier(surround51, true), 2);
    assert.equal(getAudioTier(drc, true), 3);
    assert.equal(getAudioTier(voiceBoost, true), 4);
    assert.equal(getAudioTier(stereo, true), 5);

    const video: AudioFormatEntry = { itag: 248, mimeType: 'video/webm; codecs="vp9"' };
    const orderedStereoDrc = filterStreamingFormats([video, stereo, voiceBoost, drc], 'any', true);
    assert.deepEqual(
      orderedStereoDrc.map((f) => f.itag),
      [248, 140, 250, 251]
    );

    const orderedWithSurround = filterStreamingFormats([video, stereo, drc, surround51], 'any', true);
    assert.deepEqual(
      orderedWithSurround.map((f) => f.itag),
      [248, 258, 140, 251]
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

    const result = dedupeAndSortSubscriptionTabs(tabs, new Set<string>(), true);
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
  });
});
