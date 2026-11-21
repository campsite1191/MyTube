import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { QualityControllablePlayer } from '../mods/features/preferred-video-quality.ts';
import {
  applyPreferredQualityToPlayer,
  attachPreferredQualityController,
  installPreferredVideoQuality,
  parseResolutionHeight,
  seedPreferredQualityStorage,
  selectPlaybackQuality,
} from '../mods/features/preferred-video-quality.ts';
import type { YtPlayerStateObject, YtQualityData } from '../mods/types/yttv.ts';

interface MockPlayerOptions {
  availableQualities?: YtQualityData[];
  currentQuality?: string;
  playerState?: YtPlayerStateObject;
  throwOnSet?: boolean;
}

function createMockMedia(options: MockPlayerOptions = {}): {
  player: QualityControllablePlayer;
  appliedRanges: Array<[string, string]>;
  setState: (state: YtPlayerStateObject) => void;
  setAvailableQualities: (qualities: YtQualityData[]) => void;
  setCurrentQuality: (quality: string) => void;
  playerListenerCount: () => number;
} {
  let currentState: YtPlayerStateObject = options.playerState ?? {};
  let currentQuality = options.currentQuality ?? 'unknown';
  let availableQualities = options.availableQualities ?? [
    { quality: 'hd2160', qualityLabel: '2160p' },
    { quality: 'hd1080', qualityLabel: '1080p' },
    { quality: 'hd720', qualityLabel: '720p' },
    { quality: 'large', qualityLabel: '480p' },
  ];

  const playerListeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
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

  const player: QualityControllablePlayer = {
    addEventListener: pBus.add,
    removeEventListener: pBus.remove,
    getPlayerStateObject: () => currentState,
    getPlaybackQuality: () => currentQuality,
    getAvailableQualityData: () => availableQualities,
    setPlaybackQualityRange(minQuality, maxQuality) {
      if (options.throwOnSet) {
        throw new Error('Player quality range unavailable');
      }
      appliedRanges.push([minQuality, maxQuality]);
      currentQuality = maxQuality;
    },
  };

  return {
    player,
    appliedRanges,
    setState(state) {
      currentState = state;
      pBus.emit('onStateChange');
    },
    setAvailableQualities(qualities) {
      availableQualities = qualities;
    },
    setCurrentQuality(quality) {
      currentQuality = quality;
    },
    playerListenerCount: () => playerListeners.get('onStateChange')?.size ?? 0,
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

describe('seedPreferredQualityStorage', () => {
  test('seeds missing, expired, or lower yt-player-quality entries to 2160p without overwriting valid >=2160p entries', (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevStorage = globals.localStorage;
    const store = new Map<string, string>();

    t.after(() => {
      if (prevStorage === undefined) delete globals.localStorage;
      else globals.localStorage = prevStorage;
    });

    globals.localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    };

    assert.equal(seedPreferredQualityStorage(), true);
    const seeded = JSON.parse(store.get('yt-player-quality') ?? '{}') as {
      data: string;
      expiration: number;
      creation: number;
    };
    assert.deepEqual(JSON.parse(seeded.data), { quality: 2160, previousQuality: 2160 });
    assert.ok(seeded.expiration > Date.now());

    // Valid 2160p entry should not be rewritten.
    assert.equal(seedPreferredQualityStorage(), false);

    // Lower 720p entry should be upgraded back to 2160p.
    store.set(
      'yt-player-quality',
      JSON.stringify({
        data: JSON.stringify({ quality: 720, previousQuality: 720 }),
        expiration: Date.now() + 100_000,
        creation: Date.now(),
      })
    );
    assert.equal(seedPreferredQualityStorage(), true);
    const upgraded = JSON.parse(store.get('yt-player-quality') ?? '{}') as { data: string };
    assert.deepEqual(JSON.parse(upgraded.data), { quality: 2160, previousQuality: 2160 });
  });
});

describe('applyPreferredQualityToPlayer', () => {
  test('applies selected quality range, skips redundant switches, and catches player exceptions cleanly', () => {
    const { player, appliedRanges } = createMockMedia();
    assert.equal(applyPreferredQualityToPlayer(player), true);
    assert.deepEqual(appliedRanges, [['hd2160', 'hd2160']]);

    // Second call sees currentQuality === 'hd2160' and skips setPlaybackQualityRange.
    assert.equal(applyPreferredQualityToPlayer(player), true);
    assert.deepEqual(appliedRanges, [['hd2160', 'hd2160']]);

    const throwingMock = createMockMedia({ throwOnSet: true });
    assert.equal(applyPreferredQualityToPlayer(throwingMock.player), false);
  });
});

describe('attachPreferredQualityController', () => {
  test('locks once when playback starts with populated qualities and ignores subsequent state changes', () => {
    const mock = createMockMedia({ availableQualities: [], playerState: { isOrWillBePlaying: false } });
    const controller = attachPreferredQualityController(mock.player);

    assert.equal(mock.playerListenerCount(), 1);

    // Empty quality list keeps controller armed without firing premature highres fallback.
    mock.setState({ isOrWillBePlaying: true, isPlaying: false });
    assert.deepEqual(mock.appliedRanges, []);
    assert.equal(mock.playerListenerCount(), 1);

    // Once qualities arrive and player isOrWillBePlaying, locks once and detaches immediately.
    mock.setAvailableQualities([
      { quality: 'hd2160', qualityLabel: '2160p' },
      { quality: 'hd1080', qualityLabel: '1080p' },
    ]);
    mock.setState({ isOrWillBePlaying: true, isPlaying: false });
    assert.deepEqual(mock.appliedRanges, [['hd2160', 'hd2160']]);
    assert.equal(mock.playerListenerCount(), 0);

    // Subsequent playing/seek transitions do not re-trigger setPlaybackQualityRange.
    mock.setState({ isPlaying: false });
    mock.setState({ isPlaying: true });
    controller.handleStateChange();
    assert.equal(mock.appliedRanges.length, 1);

    controller.dispose();
  });

  test('disposes listener cleanly when Watch session AbortSignal aborts before lock', () => {
    const abortController = new AbortController();
    const mock = createMockMedia({ playerState: { isOrWillBePlaying: false } });
    attachPreferredQualityController(mock.player, abortController.signal);
    assert.equal(mock.playerListenerCount(), 1);

    abortController.abort();
    assert.equal(mock.playerListenerCount(), 0);

    mock.setState({ isOrWillBePlaying: true });
    assert.deepEqual(mock.appliedRanges, []);
  });

  test('installPreferredVideoQuality seeds storage and scopes locking strictly to Watch sessions', (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevDocument = globals.document;
    const prevStorage = globals.localStorage;
    const winListeners = new Map<string, Set<() => void>>();
    const store = new Map<string, string>();
    const fakeLocation = { hash: '#/', search: '' };

    t.after(() => {
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
      if (prevStorage === undefined) delete globals.localStorage;
      else globals.localStorage = prevStorage;
    });

    const mock = createMockMedia({ playerState: { isOrWillBePlaying: false } });
    globals.localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    };
    globals.window = {
      location: fakeLocation,
      addEventListener: (type: string, fn: () => void) => {
        let set = winListeners.get(type);
        if (!set) {
          set = new Set();
          winListeners.set(type, set);
        }
        set.add(fn);
      },
    };
    globals.document = {
      body: {},
      documentElement: {},
      querySelector: (selector: string) => (selector === '.html5-video-player' ? mock.player : null),
    };

    const emitHashChange = (hash: string) => {
      fakeLocation.hash = hash;
      for (const fn of winListeners.get('hashchange') ?? []) fn();
    };

    installPreferredVideoQuality();
    assert.ok(store.get('yt-player-quality')?.includes('2160'));

    // Home inline previews and Shorts must remain untouched.
    assert.equal(mock.playerListenerCount(), 0);
    emitHashChange('#/shorts/abc123');
    assert.equal(mock.playerListenerCount(), 0);

    // Watch session attaches and locks once before playback presents.
    emitHashChange('#/watch?v=first123');
    assert.equal(mock.playerListenerCount(), 1);
    mock.setState({ isOrWillBePlaying: true, isPlaying: false });
    assert.deepEqual(mock.appliedRanges, [['hd2160', 'hd2160']]);
    assert.equal(mock.playerListenerCount(), 0);

    // Switching to another Watch video starts a fresh Watch lock.
    mock.setCurrentQuality('large');
    mock.setState({ isOrWillBePlaying: false, isPlaying: false });
    emitHashChange('#/watch?v=next456');
    assert.equal(mock.playerListenerCount(), 1);
    mock.setState({ isOrWillBePlaying: true, isPlaying: false });
    assert.deepEqual(mock.appliedRanges, [
      ['hd2160', 'hd2160'],
      ['hd2160', 'hd2160'],
    ]);
    assert.equal(mock.playerListenerCount(), 0);

    emitHashChange('#/');
    assert.equal(mock.playerListenerCount(), 0);
  });
});
