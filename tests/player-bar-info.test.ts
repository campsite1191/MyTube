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

    const uninstallPlayerBar = installPlayerBarInfo();
    try {
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
      uninstallPlayerBar();
      delete globals.window;
      if (prevWindow !== undefined) globals.window = prevWindow;
      delete globals.document;
      if (prevDocument !== undefined) globals.document = prevDocument;
      globals.requestAnimationFrame = prevRaf;
      if (prevMutationObserver === undefined) delete globals.MutationObserver;
      else globals.MutationObserver = prevMutationObserver;
      if (prevCssStyleSheet === undefined) delete globals.CSSStyleSheet;
      else globals.CSSStyleSheet = prevCssStyleSheet;
    }
  });

  test('updates on D-pad scrub and hidden speed/quality changes, supports text nodes/markers/fallback/storyboard, and clears on livestreams', (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevDocument = globals.document;
    const prevRaf = globals.requestAnimationFrame;
    const prevMutationObserver = globals.MutationObserver;
    const prevCssStyleSheet = globals.CSSStyleSheet;

    const winListeners = new Map<string, Set<() => void>>();
    const videoListeners = new Map<string, Set<(e?: Event) => void>>();
    const observerCbs: Array<() => void> = [];
    let pendingRaf: (() => void) | null = null;
    const flushRaf = () => {
      const cb = pendingRaf;
      pendingRaf = null;
      cb?.();
    };

    globals.requestAnimationFrame = (cb: () => void) => {
      pendingRaf = cb;
      return 1;
    };
    globals.CSSStyleSheet = class {
      replaceSync(): void {}
    };
    globals.MutationObserver = class {
      constructor(cb: () => void) {
        observerCbs.push(cb);
      }
      observe(): void {}
      disconnect(): void {}
    };

    const storyboardNode = {
      closest: (s: string) => (s === 'ytlr-storyboard' ? {} : null),
      querySelector: () => null,
      textContent: '9:99',
    };
    const textNode = { nodeType: 3, isConnected: true, nodeValue: '0:10' };
    const markerEl = { textContent: 'Chapter 1', dataset: {} as Record<string, string> };
    const elapsedEl = {
      nodeType: 1,
      isConnected: true,
      textContent: '0:10',
      dataset: {} as Record<string, string>,
      childNodes: [{ nodeType: 1, childNodes: [textNode] }],
      closest: () => null,
      querySelector: (sel: string) => (sel === '[idomkey="marker-title"]' ? markerEl : null),
    };
    const durationEl = {
      nodeType: 1,
      isConnected: true,
      textContent: '2:00',
      childNodes: [] as unknown[],
      closest: () => null,
    };
    const qualityLabel = '720p';
    let barVisible = true;
    let useFallbackTimeLabel = false;
    const fallbackLabelEl: {
      nodeType: number;
      isConnected: boolean;
      textContent: string;
      dataset: Record<string, string>;
      childNodes: unknown[];
      closest: () => null;
      querySelector: (sel: string) => unknown;
    } = {
      nodeType: 1,
      isConnected: true,
      textContent: '0:20 / 2:00',
      dataset: {} as Record<string, string>,
      childNodes: [] as unknown[],
      closest: () => null,
      querySelector: () => null,
    };

    const progressBar = {
      isConnected: true,
      getAttribute: (n: string) => (n === 'hybridnavfocusable' ? (barVisible ? 'true' : 'false') : null),
      classList: { contains: () => false },
      querySelectorAll: (sel: string) => {
        if (useFallbackTimeLabel) {
          if (sel.includes('[idomkey="time-label"]')) return [storyboardNode, fallbackLabelEl];
          return [];
        }
        if (sel.includes('elapsedTime')) return [storyboardNode, elapsedEl];
        if (sel.includes('duration')) return [storyboardNode, durationEl];
        return [];
      },
    };
    const videoEl = {
      duration: 120,
      currentTime: 10,
      playbackRate: 1,
      videoWidth: 1280,
      videoHeight: 720,
      addEventListener: (type: string, fn: (e?: Event) => void, opts?: { signal?: AbortSignal }) => {
        const set = videoListeners.get(type) ?? new Set();
        set.add(fn);
        videoListeners.set(type, set);
        opts?.signal?.addEventListener('abort', () => set.delete(fn), { once: true });
      },
    };
    const fakeLocation = { hash: '#/watch?v=pbAdv1', search: '' };
    globals.window = {
      location: fakeLocation,
      addEventListener: (type: string, fn: () => void) => {
        const set = winListeners.get(type) ?? new Set();
        set.add(fn);
        winListeners.set(type, set);
      },
      removeEventListener: (type: string, fn: () => void) => {
        winListeners.get(type)?.delete(fn);
      },
    };
    globals.document = {
      body: {},
      documentElement: {},
      adoptedStyleSheets: [],
      querySelector: (sel: string) => {
        if (sel === 'video') return videoEl;
        if (sel === 'ytlr-progress-bar') return progressBar;
        if (sel === '.html5-video-player') return { getPlaybackQualityLabel: () => qualityLabel };
        return null;
      },
    };

    const uninstallPlayerBar = installPlayerBarInfo();
    t.after(() => {
      uninstallPlayerBar();
      fakeLocation.hash = '#/';
      for (const fn of winListeners.get('hashchange') ?? []) fn();
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
      globals.requestAnimationFrame = prevRaf;
      if (prevMutationObserver === undefined) delete globals.MutationObserver;
      else globals.MutationObserver = prevMutationObserver;
      if (prevCssStyleSheet === undefined) delete globals.CSSStyleSheet;
      else globals.CSSStyleSheet = prevCssStyleSheet;
    });

    for (const fn of winListeners.get('hashchange') ?? []) fn();

    // Initial render writes remaining on marker-title (skipping storyboard element).
    assert.equal(markerEl.dataset.ttRemaining, '-1:50');
    assert.equal(elapsedEl.dataset.ttRemaining, undefined);

    // D-pad scrubbing changes elapsed text node while paused -> observer updates remaining time!
    textNode.nodeValue = '0:40';
    for (const cb of [...observerCbs]) cb();
    assert.equal(markerEl.dataset.ttRemaining, '-1:20');

    // Speed change while bar is hidden sets pendingForceRender; re-opening bar while paused updates right-side label.
    barVisible = false;
    videoEl.playbackRate = 1.5;
    for (const fn of videoListeners.get('ratechange') ?? []) fn({ type: 'ratechange' } as Event);
    barVisible = true;
    for (const cb of [...observerCbs]) cb();
    assert.equal(durationEl.textContent, '1.5x • 720p • 2:00');

    // Coalesces multiple timeupdates in same second into one rAF and skips same-second duplicate render.
    videoEl.currentTime = 40.2;
    for (const fn of videoListeners.get('timeupdate') ?? []) fn({ type: 'timeupdate' } as Event);
    videoEl.currentTime = 40.8;
    for (const fn of videoListeners.get('timeupdate') ?? []) fn({ type: 'timeupdate' } as Event);
    flushRaf();

    // Transition to livestream clears data-tt-remaining from both elapsed and marker,
    // and clearing marker text moves remaining attribute from marker to elapsed.
    markerEl.textContent = '';
    textNode.nodeValue = '0:30';
    videoEl.duration = 120;
    videoEl.currentTime = 30;
    for (const cb of [...observerCbs]) cb();
    assert.equal(markerEl.dataset.ttRemaining, undefined);
    assert.equal(elapsedEl.dataset.ttRemaining, '-1:30');

    videoEl.duration = Number.POSITIVE_INFINITY;
    for (const fn of videoListeners.get('durationchange') ?? []) fn({ type: 'durationchange' } as Event);
    flushRaf();
    assert.equal(markerEl.dataset.ttRemaining, undefined);
    assert.equal(elapsedEl.dataset.ttRemaining, undefined);

    // Combined time-label without child span/duration (`fallbackDur: false`): sets `data-tt-remaining`.
    fakeLocation.hash = '#/watch?v=pbFallback2';
    videoEl.duration = 120;
    videoEl.currentTime = 20;
    useFallbackTimeLabel = true;
    for (const fn of winListeners.get('hashchange') ?? []) fn();
    assert.equal(fallbackLabelEl.dataset.ttRemaining, '-1:40');

    // Time-label with duration child containing a clock text node (`fallbackDur: true`, `isText: true`): updates nodeValue.
    const durChildTextNode = { nodeType: 3, isConnected: true, nodeValue: '2:00' };
    const durChildEl = {
      nodeType: 1,
      isConnected: true,
      textContent: '2:00',
      childNodes: [durChildTextNode] as unknown[],
      closest: () => null,
    };
    fallbackLabelEl.querySelector = (sel: string) => (sel.includes('duration') ? durChildEl : null);
    fakeLocation.hash = '#/watch?v=pbFallbackDurOnly';
    for (const fn of winListeners.get('hashchange') ?? []) fn();
    assert.equal(durChildTextNode.nodeValue, '2:00 • -1:40');

    // Time-label with elapsed span and no dataset covers non-text clock target + dataset guard + null duration target.
    const spanNoDataset = {
      nodeType: 1,
      isConnected: true,
      textContent: '0:20',
      childNodes: [] as unknown[],
      closest: () => null,
    };
    fallbackLabelEl.querySelector = (sel: string) => (sel.includes('elapsedTime') ? spanNoDataset : null);
    fakeLocation.hash = '#/watch?v=pbFallbackSpanOnly';
    for (const fn of winListeners.get('hashchange') ?? []) fn();
    assert.equal(spanNoDataset.textContent, '0:20');

    // No valid clock labels in time-label returns null elapsed target gracefully.
    fallbackLabelEl.querySelector = () => null;
    fallbackLabelEl.textContent = 'no clock here';
    fakeLocation.hash = '#/watch?v=pbNoElapsed';
    for (const fn of winListeners.get('hashchange') ?? []) fn();
    assert.equal(fallbackLabelEl.textContent, 'no clock here');
  });
});
