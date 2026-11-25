import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { AudioFormatEntry, SubscriptionTab } from '../../mods/transforms/innertube-player.ts';
import {
  dedupeAndSortSubscriptionTabs,
  disableAutoCaptionsInPayload,
  filterStreamingFormats,
  getAudioTier,
  stripAdsFromPayload,
} from '../../mods/transforms/innertube-player.ts';

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

    // Covers missing mimeType/audioTrack/channels/bitrate, bestChannels track tie-break, multiple original tracks, and video-only fallback.
    assert.equal(getAudioTier({} as AudioFormatEntry), 4);
    assert.deepEqual(filterStreamingFormats([{ itag: 137, mimeType: 'video/mp4' }]), [
      { itag: 137, mimeType: 'video/mp4' },
    ]);

    const multiEdgeFormats: AudioFormatEntry[] = [
      null as unknown as AudioFormatEntry,
      { itag: 501, mimeType: 'audio/mp4', audioTrack: { id: 'no-orig.1' } },
      { itag: 507, mimeType: 'audio/mp4', audioTrack: { id: 'no-orig.1', displayName: 'Filled Name' } },
      { itag: 502, mimeType: 'audio/mp4', audioChannels: 1, audioTrack: { id: 'mono.2', displayName: 'Mono' } },
      { itag: 508, mimeType: 'audio/mp4', audioChannels: 2, audioTrack: { id: 'mono.2', displayName: 'Mono' } },
      {
        itag: 503,
        mimeType: 'audio/mp4',
        audioChannels: 2,
        audioTrack: { id: 'best.4', displayName: 'Best original' },
      },
      {
        itag: 504,
        mimeType: 'audio/mp4',
        xtags: 'drc=1',
        audioTrack: { id: 'orig2.4', displayName: 'Alt Original', audioIsDefault: false },
      },
      {
        itag: 505,
        mimeType: 'audio/mp4',
        audioChannels: 4,
        bitrate: 192000,
        audioTrack: { id: 'orig2.4', displayName: 'Alt Original', audioIsDefault: true },
      },
      { itag: 506, mimeType: 'audio/mp4' },
    ];
    const multiOut = filterStreamingFormats(multiEdgeFormats);
    assert.equal(multiOut[0]?.audioTrack?.id, 'orig2.4');

    const noTrackIdFormats: AudioFormatEntry[] = [
      { itag: 601, mimeType: 'audio/mp4', audioChannels: 2 },
      { itag: 602, mimeType: 'audio/mp4', bitrate: 64000 },
      { itag: 603, mimeType: 'audio/mp4', audioChannels: 2, bitrate: 128000 },
    ];
    assert.deepEqual(
      filterStreamingFormats(noTrackIdFormats).map((f) => f.itag),
      [603, 601, 602]
    );
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
    assert.equal(ranked[0]?.audioTrack?.id, 'a.1');
    assert.equal(ranked[0]?.audioTrack?.audioIsDefault, true);
    assert.deepEqual(
      ranked.filter((f) => f.audioTrack?.id === 'a.1').map((f) => f.itag),
      [305, 301, 306]
    );

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

    // Non-array audioTracks, null track entries, playerResponse captions, and missing captions are handled safely.
    disableAutoCaptionsInPayload({});
    disableAutoCaptionsInPayload({
      playerResponse: {
        captions: {
          playerCaptionsTracklistRenderer: { captionsInitialState: 'CAPTIONS_INITIAL_STATE_ON_REQUIRED' },
        },
      },
    });
    const noTracksPayload: Record<string, unknown> = {
      captions: { playerCaptionsTracklistRenderer: { audioTracks: null } },
    };
    disableAutoCaptionsInPayload(noTracksPayload);
    const nullTrackPayload: Record<string, unknown> = {
      captions: { playerCaptionsTracklistRenderer: { audioTracks: [null] } },
    };
    disableAutoCaptionsInPayload(nullTrackPayload);
  });
});

describe('dedupeAndSortSubscriptionTabs', () => {
  test('deduplicates tabs by browseId+params and keeps selected tab first when sorting', () => {
    const tabs: SubscriptionTab[] = [
      {},
      { tabRenderer: {} },
      { tabRenderer: { title: 'Zeta', endpoint: { browseEndpoint: { browseId: 'UCz', params: 'p1' } } } },
      { tabRenderer: { title: 'Alpha', endpoint: { browseEndpoint: { browseId: 'UCa', params: 'p1' } } } },
      { tabRenderer: { title: 'Alpha Dup', endpoint: { browseEndpoint: { browseId: 'UCa', params: 'p1' } } } },
      { tabRenderer: { endpoint: { browseEndpoint: { browseId: 'UCnoTitle' } } } },
      { tabRenderer: { selected: false, tabIdentifier: 'TAB_VIDEOS' } },
      { tabRenderer: { selected: true } },
      { tabRenderer: { selected: true, title: 'SelectedA', endpoint: { browseEndpoint: { browseId: 'UCs' } } } },
      { tabRenderer: { selected: true, title: 'SelectedB', endpoint: { browseEndpoint: { browseId: 'UCs2' } } } },
    ];

    const result = dedupeAndSortSubscriptionTabs(tabs, new Set<string>());
    assert.deepEqual(
      result.slice(0, 3).map((t) => t.tabRenderer?.title ?? ''),
      ['', 'SelectedA', 'SelectedB']
    );
    assert.deepEqual(
      dedupeAndSortSubscriptionTabs(
        [
          { tabRenderer: { selected: true, title: 'Sel', endpoint: { browseEndpoint: { browseId: 'UCs' } } } },
          { tabRenderer: { title: 'Unselected', endpoint: { browseEndpoint: { browseId: 'UCu' } } } },
        ],
        new Set<string>()
      ).map((t) => t.tabRenderer?.title),
      ['Sel', 'Unselected']
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
        null,
        { command: { reelWatchEndpoint: { videoId: 'v1' } } },
        { command: { reelWatchEndpoint: { videoId: 'ad1', adClientParams: { isAd: true } } } },
        { command: { reelWatchEndpoint: { videoId: 'v2', adClientParams: { isAd: false } } } },
      ],
    };

    stripAdsFromPayload(payload);

    assert.deepEqual(payload.adPlacements, []);
    assert.equal(payload.playerAds, false);
    assert.deepEqual(payload.adSlots, []);
    assert.equal((payload.entries as unknown[]).length, 3);
  });
});
