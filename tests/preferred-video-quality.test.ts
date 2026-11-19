import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { configChangeEmitter } from '../mods/core/config.ts';
import type { ConfigChangeDetail } from '../mods/core/config.ts';
import {
  applyPreferredQualityToPlayer,
  attachPreferredQualityController,
  isShortsPlayback,
  parseResolutionHeight,
  selectPlaybackQuality,
} from '../mods/features/preferred-video-quality.ts';
import type { QualityControllablePlayer } from '../mods/features/preferred-video-quality.ts';
import type { YtPlayerStateObject, YtQualityData, YtVideoData } from '../mods/types/yttv.ts';

interface MockPlayerOptions {
  availableQualities?: YtQualityData[];
  playerState?: YtPlayerStateObject;
  videoData?: YtVideoData;
  videoStats?: Record<string, unknown> | null;
  throwOnSet?: boolean;
}

function createMockPlayer(options: MockPlayerOptions = {}): {
  player: QualityControllablePlayer;
  appliedRanges: Array<[string, string]>;
  setState: (state: YtPlayerStateObject, videoData?: YtVideoData, videoStats?: Record<string, unknown> | null) => void;
  emitStateChange: () => void;
  listenerCount: () => number;
} {
  let currentState: YtPlayerStateObject = options.playerState ?? {};
  let currentVideoData: YtVideoData = options.videoData ?? { video_id: 'video-1' };
  let currentStats: Record<string, unknown> | null = options.videoStats ?? {};
  const availableQualities = options.availableQualities ?? [
    { quality: 'hd2160', qualityLabel: '2160p' },
    { quality: 'hd1080', qualityLabel: '1080p' },
    { quality: 'hd720', qualityLabel: '720p' },
    { quality: 'large', qualityLabel: '480p' },
  ];

  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  const appliedRanges: Array<[string, string]> = [];

  const player: QualityControllablePlayer = {
    addEventListener(type, listener) {
      let typeListeners = listeners.get(type);
      if (!typeListeners) {
        typeListeners = new Set();
        listeners.set(type, typeListeners);
      }
      typeListeners.add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    getPlayerStateObject: () => currentState,
    getVideoData: () => currentVideoData,
    getVideoStats: () => currentStats,
    getAvailableQualityData: () => availableQualities,
    setPlaybackQualityRange(minQuality, maxQuality) {
      if (options.throwOnSet) {
        throw new Error('Player quality range unavailable');
      }
      appliedRanges.push([minQuality, maxQuality]);
    },
  };

  const emitStateChange = (): void => {
    const stateListeners = listeners.get('onStateChange');
    if (!stateListeners) return;
    const event = new Event('onStateChange');
    for (const listener of stateListeners) {
      if (typeof listener === 'function') {
        listener(event);
      } else {
        listener.handleEvent(event);
      }
    }
  };

  return {
    player,
    appliedRanges,
    setState(state, videoData, videoStats) {
      currentState = state;
      if (videoData !== undefined) currentVideoData = videoData;
      if (videoStats !== undefined) currentStats = videoStats;
      emitStateChange();
    },
    emitStateChange,
    listenerCount: () => listeners.get('onStateChange')?.size ?? 0,
  };
}

describe('parseResolutionHeight', () => {
  test('parses numeric resolution labels and rejects non-numeric inputs', () => {
    assert.equal(parseResolutionHeight('2160p'), 2160);
    assert.equal(parseResolutionHeight('1080p60'), 1080);
    assert.equal(parseResolutionHeight('720p HDR'), 720);
    assert.equal(parseResolutionHeight('auto'), 0);
    assert.equal(parseResolutionHeight(''), 0);
    assert.equal(parseResolutionHeight(null), 0);
    assert.equal(parseResolutionHeight(undefined), 0);
  });
});

describe('selectPlaybackQuality', () => {
  const standardQualities: YtQualityData[] = [
    { quality: 'hd2160', qualityLabel: '2160p' },
    { quality: 'hd1080', qualityLabel: '1080p' },
    { quality: 'hd720', qualityLabel: '720p' },
    { quality: 'large', qualityLabel: '480p' },
  ];

  test('returns null for auto or invalid preferences', () => {
    assert.equal(selectPlaybackQuality(standardQualities, 'auto'), null);
    assert.equal(selectPlaybackQuality(standardQualities, ''), null);
    assert.equal(selectPlaybackQuality(standardQualities, null), null);
    assert.equal(selectPlaybackQuality(standardQualities, 'invalid'), null);
  });

  test('falls back to highres when available qualities are missing or unlabeled', () => {
    assert.equal(selectPlaybackQuality([], '1080p'), 'highres');
    assert.equal(selectPlaybackQuality(null, '1080p'), 'highres');
    assert.equal(selectPlaybackQuality([{ quality: 'auto', qualityLabel: 'Auto' }], '1080p'), 'highres');
  });

  test('selects exact match when present', () => {
    assert.equal(selectPlaybackQuality(standardQualities, '1080p'), 'hd1080');
    assert.equal(selectPlaybackQuality(standardQualities, '2160p'), 'hd2160');
  });

  test('falls back to highest available tier at or below target instead of overshooting to highres', () => {
    assert.equal(selectPlaybackQuality(standardQualities, '1440p'), 'hd1080');
    assert.equal(selectPlaybackQuality(standardQualities, '900p'), 'hd720');
  });

  test('falls back to lowest available tier when all tiers exceed target', () => {
    assert.equal(selectPlaybackQuality(standardQualities, '240p'), 'large');
  });
});

describe('isShortsPlayback', () => {
  test('detects shortspage stats and handles null or missing getVideoStats', () => {
    assert.equal(isShortsPlayback(null), false);
    assert.equal(isShortsPlayback({ addEventListener() {} }), false);
    assert.equal(isShortsPlayback(createMockPlayer({ videoStats: null }).player), false);
    assert.equal(isShortsPlayback(createMockPlayer({ videoStats: { fmt: '248' } }).player), false);
    assert.equal(
      isShortsPlayback(createMockPlayer({ videoStats: { origin: 'shortspage' } }).player),
      true
    );
  });
});

describe('applyPreferredQualityToPlayer', () => {
  test('applies selected quality range and catches player exceptions cleanly', () => {
    const { player, appliedRanges } = createMockPlayer();
    assert.equal(applyPreferredQualityToPlayer(player, '1080p'), true);
    assert.deepEqual(appliedRanges, [['hd1080', 'hd1080']]);

    assert.equal(applyPreferredQualityToPlayer(player, 'auto'), false);
    assert.deepEqual(appliedRanges, [['hd1080', 'hd1080']]);

    const throwingMock = createMockPlayer({ throwOnSet: true });
    assert.equal(applyPreferredQualityToPlayer(throwingMock.player, '1080p'), false);
  });
});

describe('attachPreferredQualityController', () => {
  test('applies once per video on play, re-applies on video change, and skips Shorts', () => {
    let configuredQuality = '1080p';
    const mock = createMockPlayer({
      playerState: { isPlaying: false },
      videoData: { video_id: 'video-1' },
    });

    const controller = attachPreferredQualityController(mock.player, () => configuredQuality);

    try {
      assert.deepEqual(mock.appliedRanges, []);

      mock.setState({ isPlaying: true }, { video_id: 'video-1' });
      assert.deepEqual(mock.appliedRanges, [['hd1080', 'hd1080']]);

      mock.emitStateChange();
      assert.deepEqual(mock.appliedRanges, [['hd1080', 'hd1080']]);

      mock.setState({ isPlaying: true }, { video_id: 'video-2' });
      assert.deepEqual(mock.appliedRanges, [
        ['hd1080', 'hd1080'],
        ['hd1080', 'hd1080'],
      ]);

      mock.setState({ isPlaying: true }, { video_id: 'short-3' }, { origin: 'shortspage' });
      assert.equal(mock.appliedRanges.length, 2);

      configuredQuality = '720p';
      configChangeEmitter.dispatchEvent(
        new CustomEvent<ConfigChangeDetail<'preferredVideoQuality'>>('configChange', {
          detail: { key: 'preferredVideoQuality', value: '720p' },
        })
      );
      assert.equal(mock.appliedRanges.length, 2);

      mock.setState({ isPlaying: true }, { video_id: 'video-4' }, {});
      assert.deepEqual(mock.appliedRanges[2], ['hd720', 'hd720']);

      configuredQuality = '2160p';
      configChangeEmitter.dispatchEvent(
        new CustomEvent<ConfigChangeDetail<'preferredVideoQuality'>>('configChange', {
          detail: { key: 'preferredVideoQuality', value: '2160p' },
        })
      );
      assert.deepEqual(mock.appliedRanges[3], ['hd2160', 'hd2160']);
    } finally {
      controller.dispose();
    }

    assert.equal(mock.listenerCount(), 0);
  });
});
