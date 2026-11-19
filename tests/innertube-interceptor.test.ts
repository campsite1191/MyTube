import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  dedupeAndSortSubscriptionTabs,
  disableAutoCaptionsInPayload,
  extractBrowseIdFromResponse,
  filterStreamingFormats,
  getAudioTier,
  stripAdsFromPayload,
} from '../mods/transforms/innertube-player.ts';
import type { AudioFormatEntry, SubscriptionTab } from '../mods/transforms/innertube-player.ts';

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

  test('filters to preferred video codec and keeps highest-tier original audio track', () => {
    const formats: AudioFormatEntry[] = [
      { itag: 137, mimeType: 'video/mp4; codecs="avc1.640028"' },
      { itag: 248, mimeType: 'video/webm; codecs="vp9"' },
      { itag: 140, mimeType: 'audio/mp4', audioChannels: 2, audioTrack: { id: 'en.4', displayName: 'English original' } },
      { itag: 258, mimeType: 'audio/mp4; codecs="ec-3"', audioChannels: 6, audioTrack: { id: 'en.4', displayName: 'English original' } },
      { itag: 141, mimeType: 'audio/mp4; codecs="ec-3"', audioChannels: 6, audioTrack: { id: 'es.1', displayName: 'Spanish' } },
    ];

    const filtered = filterStreamingFormats(formats, 'vp9');
    assert.deepEqual(
      filtered.map((f) => f.itag),
      [248, 258]
    );
    assert.equal(filtered[1]?.audioTrack?.audioIsDefault, true);
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

  test('prefers DRC loudness-normalized stereo when preferDrcAudio is enabled while preserving surround', () => {
    const drc: AudioFormatEntry = { itag: 140, mimeType: 'audio/mp4', xtags: 'drc=1', audioChannels: 2 };
    const stereo: AudioFormatEntry = { itag: 251, mimeType: 'audio/webm', audioChannels: 2 };
    const voiceBoost: AudioFormatEntry = { itag: 250, mimeType: 'audio/webm', xtags: 'vb=1', audioChannels: 2 };
    const surround51: AudioFormatEntry = { itag: 258, mimeType: 'audio/mp4; codecs="ec-3"', audioChannels: 6 };

    assert.equal(getAudioTier(surround51, true), 2);
    assert.equal(getAudioTier(drc, true), 3);
    assert.equal(getAudioTier(voiceBoost, true), 4);
    assert.equal(getAudioTier(stereo, true), 5);

    const video: AudioFormatEntry = { itag: 248, mimeType: 'video/webm; codecs="vp9"' };
    const filteredStereoDrc = filterStreamingFormats([video, stereo, voiceBoost, drc], 'any', true);
    assert.deepEqual(
      filteredStereoDrc.map((f) => f.itag),
      [248, 140]
    );

    const filteredWithSurround = filterStreamingFormats([video, stereo, drc, surround51], 'any', true);
    assert.deepEqual(
      filteredWithSurround.map((f) => f.itag),
      [248, 258]
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
    const track = (tl?.audioTracks as Array<Record<string, unknown>>)[0];
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

describe('extractBrowseIdFromResponse', () => {
  test('extracts browse_id from responseContext.serviceTrackingParams', () => {
    const payload = {
      responseContext: {
        serviceTrackingParams: [
          { service: 'GUID', params: [{ key: 'foo', value: 'bar' }] },
          { service: 'BROWSE', params: [{ key: 'browse_id', value: 'UC12345' }] },
        ],
      },
    };
    assert.equal(extractBrowseIdFromResponse(payload), 'UC12345');
    assert.equal(extractBrowseIdFromResponse({}), null);
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
