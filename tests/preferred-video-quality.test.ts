import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { QualityControllablePlayer, QualityVideoTarget } from '../mods/features/preferred-video-quality.ts';
import {
  applyPreferredQualityToPlayer,
  attachPreferredQualityController,
  installPreferredVideoQuality,
  parseResolutionHeight,
  selectPlaybackQuality,
} from '../mods/features/preferred-video-quality.ts';
import type { YtPlayerStateObject, YtQualityData } from '../mods/types/yttv.ts';

interface MockPlayerOptions {
  availableQualities?: YtQualityData[];
  playerState?: YtPlayerStateObject;
  throwOnSet?: boolean;
}

function createMockMedia(options: MockPlayerOptions = {}): {
  player: QualityControllablePlayer;
  video: QualityVideoTarget;
  appliedRanges: Array<[string, string]>;
  setState: (state: YtPlayerStateObject) => void;
  emitLoadStart: () => void;
  playerListenerCount: () => number;
  videoListenerCount: () => number;
} {
  let currentState: YtPlayerStateObject = options.playerState ?? {};
  const availableQualities = options.availableQualities ?? [
    { quality: 'hd2160', qualityLabel: '2160p' },
    { quality: 'hd1080', qualityLabel: '1080p' },
    { quality: 'hd720', qualityLabel: '720p' },
    { quality: 'large', qualityLabel: '480p' },
  ];

  const playerListeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  const videoListeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  const appliedRanges: Array<[string, string]> = [];

  const bindListeners = (map: Map<string, Set<EventListenerOrEventListenerObject>>) => ({
    add(type: string, listener: EventListenerOrEventListenerObject) {
      let set = map.get(type);
      if (!set) {
        set = new Set();
        map.set(type, set);
      }
      set.add(listener);
    },
    remove(type: string, listener: EventListenerOrEventListenerObject) {
      map.get(type)?.delete(listener);
    },
    emit(type: string) {
      const set = map.get(type);
      if (!set) return;
      const event = new Event(type);
      for (const listener of [...set]) {
        if (typeof listener === 'function') listener(event);
        else listener.handleEvent(event);
      }
    },
  });

  const pBus = bindListeners(playerListeners);
  const vBus = bindListeners(videoListeners);

  const player: QualityControllablePlayer = {
    addEventListener: pBus.add,
    removeEventListener: pBus.remove,
    getPlayerStateObject: () => currentState,
    getAvailableQualityData: () => availableQualities,
    setPlaybackQualityRange(minQuality, maxQuality) {
      if (options.throwOnSet) {
        throw new Error('Player quality range unavailable');
      }
      appliedRanges.push([minQuality, maxQuality]);
    },
  };

  const video: QualityVideoTarget = {
    addEventListener: vBus.add,
    removeEventListener: vBus.remove,
  };

  return {
    player,
    video,
    appliedRanges,
    setState(state) {
      currentState = state;
      pBus.emit('onStateChange');
    },
    emitLoadStart() {
      vBus.emit('loadstart');
    },
    playerListenerCount: () => playerListeners.get('onStateChange')?.size ?? 0,
    videoListenerCount: () => videoListeners.get('loadstart')?.size ?? 0,
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

  test('falls back to highres when available qualities are missing or unlabeled', () => {
    assert.equal(selectPlaybackQuality([]), 'highres');
    assert.equal(selectPlaybackQuality(null), 'highres');
    assert.equal(selectPlaybackQuality([{ quality: 'auto', qualityLabel: 'Auto' }]), 'highres');
  });

  test('selects exact 2160p match when present', () => {
    assert.equal(selectPlaybackQuality(standardQualities), 'hd2160');
  });

  test('falls back to highest available tier below 2160p without overshooting to 4320p', () => {
    const mixedQualities: YtQualityData[] = [
      { quality: 'highres', qualityLabel: '4320p' },
      { quality: 'hd1080', qualityLabel: '1080p' },
      { quality: 'hd720', qualityLabel: '720p' },
    ];
    assert.equal(selectPlaybackQuality(mixedQualities), 'hd1080');
  });

  test('falls back to lowest available tier when all tiers exceed 2160p', () => {
    const ultraQualities: YtQualityData[] = [
      { quality: 'hd2880', qualityLabel: '2880p' },
      { quality: 'highres', qualityLabel: '4320p' },
    ];
    assert.equal(selectPlaybackQuality(ultraQualities), 'hd2880');
  });
});

describe('applyPreferredQualityToPlayer', () => {
  test('applies selected quality range and catches player exceptions cleanly', () => {
    const { player, appliedRanges } = createMockMedia();
    assert.equal(applyPreferredQualityToPlayer(player), true);
    assert.deepEqual(appliedRanges, [['hd2160', 'hd2160']]);

    const throwingMock = createMockMedia({ throwOnSet: true });
    assert.equal(applyPreferredQualityToPlayer(throwingMock.player), false);
  });
});

describe('attachPreferredQualityController', () => {
  test('locks quality once on first play, detaches onStateChange, and re-arms on next loadstart (Watch/Shorts/Previews)', () => {
    const mock = createMockMedia({ playerState: { isPlaying: false } });
    const controller = attachPreferredQualityController(mock.player, mock.video);

    assert.equal(mock.videoListenerCount(), 1);
    assert.equal(mock.playerListenerCount(), 1);

    // First play locks quality and detaches onStateChange immediately.
    mock.setState({ isPlaying: true });
    assert.deepEqual(mock.appliedRanges, [['hd2160', 'hd2160']]);
    assert.equal(mock.playerListenerCount(), 0);

    // Pausing/playing later in same video fires zero callbacks.
    mock.setState({ isPlaying: false });
    mock.setState({ isPlaying: true });
    assert.equal(mock.appliedRanges.length, 1);

    // Next preview / Short / Watch video loads (loadstart) -> arms first play and locks cleanly.
    mock.setState({ isPlaying: false });
    mock.emitLoadStart();
    assert.equal(mock.playerListenerCount(), 1);
    mock.setState({ isPlaying: true });
    assert.equal(mock.appliedRanges.length, 2);
    assert.equal(mock.playerListenerCount(), 0);

    controller.dispose();
    assert.equal(mock.videoListenerCount(), 0);
  });

  test('installPreferredVideoQuality locks 2160p across player loads on Home previews and Watch videos', async (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevDocument = globals.document;

    t.after(() => {
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
    });

    const mock = createMockMedia({ playerState: { isPlaying: false } });
    globals.window = {};
    globals.document = {
      body: {},
      documentElement: {},
      querySelector: (selector: string) => {
        if (selector === '.html5-video-player') return mock.player;
        if (selector === 'video') return mock.video;
        return null;
      },
    };

    installPreferredVideoQuality();
    assert.equal(mock.videoListenerCount(), 1);
    assert.equal(mock.playerListenerCount(), 1);

    // Works on Home preview or Watch without needing URL route changes.
    mock.setState({ isPlaying: true });
    assert.deepEqual(mock.appliedRanges, [['hd2160', 'hd2160']]);
    assert.equal(mock.playerListenerCount(), 0);
  });
});
