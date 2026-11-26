import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { AudioFormatEntry, SubscriptionTab } from '../../mods/transforms/innertube-player.ts';
import {
  dedupeAndSortSubscriptionTabs,
  disableAutoCaptionsInPayload,
  filterStreamingFormats,
  getAudioTier,
  parseXtags,
  stripAdsFromPayload,
} from '../../mods/transforms/innertube-player.ts';

const encodeXtagEntry = (key: string, val: string): string => {
  const inner = `\x0a${String.fromCharCode(key.length)}${key}\x12${String.fromCharCode(val.length)}${val}`;
  return Buffer.from(`\x0a${String.fromCharCode(inner.length)}${inner}`, 'latin1').toString('base64url');
};

describe('parseXtags', () => {
  test('decodes plain-text key=value strings and base64url protobuf xtags safely', () => {
    assert.deepEqual(parseXtags(undefined), {});
    assert.deepEqual(parseXtags(''), {});

    assert.deepEqual(parseXtags('acont=original:drc=0:vb=1;noequals;=missingkey;emptyval= ; =1;lang=en-US'), {
      acont: 'original',
      drc: '0',
      vb: '1',
      lang: 'en-us',
    });

    // Real YouTube base64url protobuf captured from /youtubei/v1/player
    assert.deepEqual(parseXtags('ChEKBWFjb250EghvcmlnaW5hbAoICgNkcmMSATEKDQoEbGFuZxIFZW4tVVM'), {
      acont: 'original',
      drc: '1',
      lang: 'en-us',
    });

    // Handles base64url -/_ chars, skipped non-0x0a outer tags, unknown inner tags, missing key/value, truncated lengths, and invalid base64
    const withSkippedOuter = Buffer.from([
      0x12, 0x03, 0xfb, 0xff, 0xef, 0x0a, 0x0a, 0x0a, 0x02, 0x76, 0x62, 0x18, 0x01, 0x31, 0x12, 0x01, 0x31, 0x0a, 0x04,
      0x12, 0x02, 0x78, 0x79,
    ]).toString('base64url');
    assert.deepEqual(parseXtags(withSkippedOuter), { vb: '1' });

    const onlyKeyNoVal = Buffer.from([0x0a, 0x04, 0x0a, 0x02, 0x76, 0x62]).toString('base64url');
    assert.deepEqual(parseXtags(onlyKeyNoVal), {});

    const truncatedOuter = Buffer.from([0x0a, 0x20, 0x0a, 0x01, 0x61]).toString('base64url');
    assert.deepEqual(parseXtags(truncatedOuter), {});

    const truncatedInner = Buffer.from([0x0a, 0x03, 0x0a, 0x05, 0x61]).toString('base64url');
    assert.deepEqual(parseXtags(truncatedInner), {});

    assert.deepEqual(parseXtags('!!!'), {});
  });
});

describe('getAudioTier and filterStreamingFormats', () => {
  test('ranks 7.1 > 5.1 > Clean Stereo > Voice Boost > DRC across boolean, plain, and protobuf tags', () => {
    const drc: AudioFormatEntry = { mimeType: 'audio/mp4', isDrc: true, audioChannels: 2 };
    const drcDisabledTag: AudioFormatEntry = { mimeType: 'audio/mp4', xtags: 'drc=0', audioChannels: 2 };
    const drcProto: AudioFormatEntry = { mimeType: 'audio/mp4', xtags: encodeXtagEntry('drc', '1') };
    const stereo: AudioFormatEntry = { mimeType: 'audio/mp4', audioChannels: 2 };
    const voiceBoost: AudioFormatEntry = { mimeType: 'audio/mp4', xtags: 'vb=1', audioChannels: 2 };
    const voiceBoostProto: AudioFormatEntry = { mimeType: 'audio/mp4', xtags: encodeXtagEntry('vb', '1') };
    const voiceBoostProp: AudioFormatEntry = { mimeType: 'audio/mp4', isVb: true, audioChannels: 2 };
    const voiceBoostLegacyProp: AudioFormatEntry = { mimeType: 'audio/mp4', isVoiceBoost: true, audioChannels: 2 };
    const voiceBoostDisabled: AudioFormatEntry = { mimeType: 'audio/mp4', xtags: 'vb=0', audioChannels: 2 };
    const voiceBoostName: AudioFormatEntry = {
      mimeType: 'audio/mp4',
      audioTrack: { id: 'en.4', displayName: 'English Voice Boost' },
    };
    const surround51: AudioFormatEntry = { mimeType: 'audio/mp4; codecs="ec-3"', audioChannels: 6 };
    const surround71: AudioFormatEntry = { mimeType: 'audio/mp4', audioChannels: 8 };

    assert.equal(getAudioTier(surround71), 1);
    assert.equal(getAudioTier(surround51), 2);
    assert.equal(getAudioTier(stereo), 3);
    assert.equal(getAudioTier(drcDisabledTag), 3);
    assert.equal(getAudioTier(voiceBoostDisabled), 3);
    assert.equal(getAudioTier(voiceBoost), 4);
    assert.equal(getAudioTier(voiceBoostProto), 4);
    assert.equal(getAudioTier(voiceBoostProp), 4);
    assert.equal(getAudioTier(voiceBoostLegacyProp), 4);
    assert.equal(getAudioTier(voiceBoostName), 4);
    assert.equal(getAudioTier(drc), 5);
    assert.equal(getAudioTier(drcProto), 5);
  });

  test('preserves all video/audio formats and ranks Original > Surround > Clean Stereo > Voice Boost > DRC', () => {
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
        itag: 144,
        mimeType: 'audio/mp4',
        isVb: true,
        audioChannels: 2,
        bitrate: 128000,
        audioTrack: { id: 'en.4', displayName: 'English original', audioIsDefault: false },
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
      [137, 248, 258, 140, 144, 141, 142, 143]
    );
    assert.equal(filtered[2]?.audioTrack?.audioIsDefault, true);
    assert.equal(filtered[3]?.audioTrack?.audioIsDefault, true);
    assert.equal(filtered[4]?.audioTrack?.audioIsDefault, true);
    assert.equal(filtered[5]?.audioTrack?.audioIsDefault, false);
    assert.equal(filtered[6]?.audioTrack?.audioIsDefault, false);
    assert.equal(filtered[7]?.audioTrack?.audioIsDefault, false);

    // Covers missing mimeType/audioTrack/channels/bitrate, bestChannels track tie-break, multiple original tracks, and video-only fallback.
    assert.equal(getAudioTier({} as AudioFormatEntry), 3);
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
        xtags: encodeXtagEntry('drc', '1'),
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

  test('detects acont protobuf tags, deprioritizes descriptive and auto-dubbed tracks, and preserves non-original sourceDefault', () => {
    const ranked = filterStreamingFormats([
      // Descriptive 5.1 even with ".4 original" must rank last (rank 3).
      {
        itag: 701,
        mimeType: 'audio/mp4; codecs="ec-3"',
        audioChannels: 6,
        audioTrack: { id: 'desc.4', displayName: 'English (descriptive) original', audioIsDefault: true },
      },
      // Auto-dubbed track flagged via isAutoDubbed must rank below standard tracks (rank 2).
      {
        itag: 702,
        mimeType: 'audio/mp4',
        audioChannels: 2,
        audioTrack: { id: 'es-auto.3', displayName: 'Spanish', audioIsDefault: true, isAutoDubbed: true },
      },
      // Standard track without original marker in id/displayName, only via protobuf xtags acont=original.
      {
        itag: 703,
        mimeType: 'audio/mp4',
        audioChannels: 2,
        xtags: encodeXtagEntry('acont', 'original'),
        audioTrack: { id: 'ja.1', displayName: 'Japanese', audioIsDefault: false },
      },
      // Auto-dubbed via xtags acont=dubbed-auto.
      {
        itag: 704,
        mimeType: 'audio/mp4',
        audioChannels: 2,
        xtags: encodeXtagEntry('acont', 'dubbed-auto'),
        audioTrack: { id: 'fr.3', displayName: 'French', audioIsDefault: false },
      },
      // Human dub.
      {
        itag: 705,
        mimeType: 'audio/mp4',
        audioChannels: 2,
        audioTrack: { id: 'de.3', displayName: 'German', audioIsDefault: false },
      },
    ]);

    assert.deepEqual(
      ranked.map((f) => f.audioTrack?.id),
      ['ja.1', 'de.3', 'es-auto.3', 'fr.3', 'desc.4']
    );
    assert.equal(ranked[0]?.audioTrack?.audioIsDefault, true);
    assert.equal(ranked[1]?.audioTrack?.audioIsDefault, false);

    // Non-original sourceDefault beats higher-tier dubbed 5.1 track in both input orders.
    const defaultVsSurroundA = filterStreamingFormats([
      {
        itag: 801,
        mimeType: 'audio/mp4',
        audioChannels: 2,
        audioTrack: { id: 'hi.1', displayName: 'Hindi', audioIsDefault: true },
      },
      {
        itag: 802,
        mimeType: 'audio/mp4; codecs="ec-3"',
        audioChannels: 6,
        audioTrack: { id: 'es.1', displayName: 'Spanish', audioIsDefault: false },
      },
    ]);
    assert.equal(defaultVsSurroundA[0]?.audioTrack?.id, 'hi.1');

    const defaultVsSurroundB = filterStreamingFormats([
      {
        itag: 802,
        mimeType: 'audio/mp4; codecs="ec-3"',
        audioChannels: 6,
        audioTrack: { id: 'es.1', displayName: 'Spanish', audioIsDefault: false },
      },
      {
        itag: 801,
        mimeType: 'audio/mp4',
        audioChannels: 2,
        audioTrack: { id: 'hi.1', displayName: 'Hindi', audioIsDefault: true },
      },
    ]);
    assert.equal(defaultVsSurroundB[0]?.audioTrack?.id, 'hi.1');

    // Multiple original tracks of equal tier/channels break ties by sourceDefault regardless of input order,
    // plus later formats in the same track propagating isDescriptive / isAutoDubbed / isOriginal.
    const origTieA = filterStreamingFormats([
      {
        itag: 810,
        mimeType: 'audio/mp4',
        audioChannels: 2,
        audioTrack: { id: 'orig-a.4', displayName: 'Same', audioIsDefault: true },
      },
      {
        itag: 811,
        mimeType: 'audio/mp4',
        audioChannels: 2,
        audioTrack: { id: 'orig-b.4', displayName: 'Same', audioIsDefault: false },
      },
    ]);
    assert.equal(origTieA[0]?.audioTrack?.id, 'orig-a.4');

    const origTieB = filterStreamingFormats([
      {
        itag: 811,
        mimeType: 'audio/mp4',
        audioChannels: 2,
        audioTrack: { id: 'orig-b.4', displayName: 'Same', audioIsDefault: false },
      },
      {
        itag: 810,
        mimeType: 'audio/mp4',
        audioChannels: 2,
        audioTrack: { id: 'orig-a.4', displayName: 'Same', audioIsDefault: true },
      },
    ]);
    assert.equal(origTieB[0]?.audioTrack?.id, 'orig-a.4');

    const aggregatedFlags = filterStreamingFormats([
      { itag: 901, mimeType: 'audio/mp4', audioTrack: { id: 'agg-desc', displayName: 'English' } },
      {
        itag: 902,
        mimeType: 'audio/mp4',
        xtags: encodeXtagEntry('acont', 'descriptive'),
        audioTrack: { id: 'agg-desc', displayName: 'English' },
      },
      { itag: 903, mimeType: 'audio/mp4', audioTrack: { id: 'agg-auto', displayName: 'Auto-dubbed Audio' } },
      {
        itag: 904,
        mimeType: 'audio/mp4',
        audioTrack: { id: 'agg-auto', displayName: 'Auto-dubbed Audio', isAutoDubbed: true },
      },
      { itag: 905, mimeType: 'audio/mp4', audioTrack: { id: 'agg-orig', displayName: 'Studio' } },
      {
        itag: 906,
        mimeType: 'audio/mp4',
        xtags: encodeXtagEntry('acont', 'original'),
        audioTrack: { id: 'agg-orig', displayName: 'Studio' },
      },
    ]);
    assert.equal(aggregatedFlags[0]?.audioTrack?.id, 'agg-orig');
    assert.equal(aggregatedFlags.at(-1)?.audioTrack?.id, 'agg-desc');
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
    assert.equal(ranked[0]?.audioTrack?.id, 'b.1');
    assert.equal(ranked[0]?.audioTrack?.audioIsDefault, true);

    const noDefaultTie = filterStreamingFormats(
      tieFormats.map((fmt) => ({
        ...fmt,
        audioTrack: { ...fmt.audioTrack, audioIsDefault: false },
      }))
    );
    assert.equal(noDefaultTie[0]?.audioTrack?.id, 'a.1');
    assert.deepEqual(
      noDefaultTie.filter((f) => f.audioTrack?.id === 'a.1').map((f) => f.itag),
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
        audioTrack: { id: 'dup.1', displayName: 'Alt', audioIsDefault: false },
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
