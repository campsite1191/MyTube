import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  computeRemainingText,
  formatClockTime,
  formatDurationLabel,
  formatRemainingLabel,
  installPlayerBarInfo,
  parseClockSeconds,
  readActiveQualityLabel,
} from '../mods/features/player-bar-info.ts';

describe('player-bar-info helpers', () => {
  test('parseClockSeconds parses mm:ss and h:mm:ss', () => {
    assert.equal(parseClockSeconds('1:05'), 65);
    assert.equal(parseClockSeconds('1:02:03'), 3723);
    assert.equal(parseClockSeconds('invalid'), null);
  });

  test('formatClockTime formats short and hour-long durations', () => {
    assert.equal(formatClockTime(65), '1:05');
    assert.equal(formatClockTime(3723), '1:02:03');
    assert.equal(formatClockTime(-5), '0:00');
  });

  test('computeRemainingText and formatRemainingLabel format • -remaining cleanly', () => {
    assert.equal(computeRemainingText('1:00', 180, 60, null, false), '-2:00');
    assert.equal(computeRemainingText('3:00', 180, 60, null, true), '-2:00');
    assert.equal(formatRemainingLabel('1:00', 180, 60, null, false), '1:00 • -2:00');
    assert.equal(formatRemainingLabel('1:00 (-9:99) / 3:00', 180, 60, 180, false), '1:00 • -2:00 / 3:00');
    assert.equal(formatRemainingLabel('3:00', 180, 60, null, true), '3:00 • -2:00');
  });

  test('readActiveQualityLabel and formatDurationLabel format right-side speed, quality, and total time', () => {
    assert.equal(readActiveQualityLabel({ getPlaybackQualityLabel: () => '1080p60' }, null), '1080p60');
    assert.equal(readActiveQualityLabel({ getPlaybackQualityLabel: () => 'Auto (720p)' }, null), '720p');
    assert.equal(
      readActiveQualityLabel({ getPlaybackQualityLabel: () => 'auto' }, { videoWidth: 1920, videoHeight: 1080 }),
      '1080p'
    );
    assert.equal(readActiveQualityLabel(null, { videoWidth: 720, videoHeight: 1280 }), '720p');
    assert.equal(readActiveQualityLabel(null, null), null);

    assert.equal(formatDurationLabel('25:41', 1, '720p'), '720p • 25:41');
    assert.equal(formatDurationLabel('25:41', 1.25, '1080p60'), '1.25x • 1080p60 • 25:41');
    assert.equal(formatDurationLabel('1.25x • 1080p60 • 25:41', 1, '1080p60'), '1080p60 • 25:41');
    assert.equal(formatDurationLabel('25:41', 1, null), '25:41');
    assert.equal(formatDurationLabel('25:41', 1.5, null), '1.5x • 25:41');
    assert.equal(formatDurationLabel('LIVE', 1.25, '1080p'), null);
  });
});

describe('installPlayerBarInfo Watch session lifecycle', () => {
  test('binds video and player-bar observer during Watch, skips hidden bar updates, and cleans up on exit', () => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevDocument = globals.document;
    const prevRaf = globals.requestAnimationFrame;
    const prevMutationObserver = globals.MutationObserver;
    const prevCssStyleSheet = globals.CSSStyleSheet;

    const winListeners = new Map<string, Set<() => void>>();
    const videoListeners = new Map<string, Set<(e?: Event) => void>>();
    const observerCbs: Array<() => void> = [];
    let disconnectedCount = 0;

    globals.requestAnimationFrame = (cb: () => void) => {
      cb();
      return 1;
    };
    globals.CSSStyleSheet = class {
      cssText = '';
      replaceSync(text: string): void {
        this.cssText = text;
      }
    };
    globals.MutationObserver = class {
      constructor(cb: () => void) {
        observerCbs.push(cb);
      }
      observe(): void {}
      disconnect(): void {
        disconnectedCount++;
      }
    };

    const elapsedEl = {
      nodeType: 1,
      isConnected: true,
      textContent: '0:30 / 2:00',
      dataset: {} as Record<string, string>,
      childNodes: [] as Node[],
      parentElement: null,
      closest: () => null,
    };
    const durationEl = {
      nodeType: 1,
      isConnected: true,
      textContent: '2:00',
      childNodes: [] as Node[],
      parentElement: null,
      closest: () => null,
    };
    let qualityLabel = '720p';
    const playerListeners = new Map<string, Set<() => void>>();
    const playerEl = {
      getPlaybackQualityLabel: () => qualityLabel,
      addEventListener: (type: string, fn: () => void, opts?: { signal?: AbortSignal }) => {
        if (opts?.signal?.aborted) return;
        let set = playerListeners.get(type);
        if (!set) {
          set = new Set();
          playerListeners.set(type, set);
        }
        set.add(fn);
        opts?.signal?.addEventListener('abort', () => set.delete(fn), { once: true });
      },
    };
    let barFocusable = 'false';
    const progressBar = {
      isConnected: true,
      getAttribute: (name: string) => (name === 'hybridnavfocusable' ? barFocusable : null),
      querySelectorAll: (selector: string) => {
        if (selector.includes('elapsedTime')) return [elapsedEl];
        if (selector.includes('duration')) return [durationEl];
        return [];
      },
    };
    const videoEl = {
      duration: 120,
      currentTime: 30,
      playbackRate: 1,
      videoWidth: 1280,
      videoHeight: 720,
      addEventListener: (type: string, fn: (e?: Event) => void, opts?: { signal?: AbortSignal }) => {
        if (opts?.signal?.aborted) return;
        let set = videoListeners.get(type);
        if (!set) {
          set = new Set();
          videoListeners.set(type, set);
        }
        set.add(fn);
        opts?.signal?.addEventListener('abort', () => set.delete(fn), { once: true });
      },
    };

    const fakeLocation = { hash: '#/', search: '' };
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
      adoptedStyleSheets: [],
      querySelector: (selector: string) => {
        if (selector === 'video') return videoEl;
        if (selector === 'ytlr-progress-bar') return progressBar;
        if (selector === '.html5-video-player') return playerEl;
        return null;
      },
    };

    try {
      installPlayerBarInfo();
      assert.equal(videoListeners.get('timeupdate')?.size ?? 0, 0);

      fakeLocation.hash = '#/watch?v=remVid1';
      for (const fn of winListeners.get('hashchange') ?? []) fn();
      assert.equal(videoListeners.get('timeupdate')?.size ?? 0, 1);

      // Player bar hidden via hybridnavfocusable or zylon-hidden -> timeupdate does not touch DOM.
      for (const fn of videoListeners.get('timeupdate') ?? []) fn({ type: 'timeupdate' } as Event);
      assert.equal(elapsedEl.textContent, '0:30 / 2:00');
      assert.equal(durationEl.textContent, '2:00');

      barFocusable = 'true';
      const classes = new Set(['zylon-hidden']);
      (progressBar as { classList?: { contains: (cls: string) => boolean } }).classList = {
        contains: (cls: string) => classes.has(cls),
      };
      for (const cb of [...observerCbs]) cb();
      assert.equal(elapsedEl.textContent, '0:30 / 2:00');

      // Player bar becomes visible -> observer refreshes data-tt-remaining + right-side quality • total time without mutating elapsed textContent.
      classes.delete('zylon-hidden');
      for (const cb of [...observerCbs]) cb();
      assert.equal(elapsedEl.textContent, '0:30 / 2:00');
      assert.equal(elapsedEl.dataset.ttRemaining, '-1:30');
      assert.equal(durationEl.textContent, '720p • 2:00');

      // Non-1x rate and quality changes update right-side label dynamically, omitting speed again when reset to 1x.
      videoEl.playbackRate = 1.25;
      for (const fn of videoListeners.get('ratechange') ?? []) fn({ type: 'ratechange' } as Event);
      assert.equal(durationEl.textContent, '1.25x • 720p • 2:00');

      qualityLabel = '1080p60';
      for (const fn of playerListeners.get('onPlaybackQualityChange') ?? []) fn();
      assert.equal(durationEl.textContent, '1.25x • 1080p60 • 2:00');

      videoEl.playbackRate = 1;
      for (const fn of videoListeners.get('ratechange') ?? []) fn({ type: 'ratechange' } as Event);
      assert.equal(durationEl.textContent, '1080p60 • 2:00');

      fakeLocation.hash = '#/';
      for (const fn of winListeners.get('hashchange') ?? []) fn();
      assert.equal(videoListeners.get('timeupdate')?.size ?? 0, 0);
      assert.equal(playerListeners.get('onPlaybackQualityChange')?.size ?? 0, 0);
      assert.equal(disconnectedCount >= 1, true);
    } finally {
      globals.window = prevWindow;
      globals.document = prevDocument;
      globals.requestAnimationFrame = prevRaf;
      globals.MutationObserver = prevMutationObserver;
      globals.CSSStyleSheet = prevCssStyleSheet;
    }
  });
});
