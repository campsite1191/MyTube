import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  formatClockTime,
  formatRemainingLabel,
  installRemainingTime,
  parseClockSeconds,
} from '../mods/features/remaining-time.ts';

describe('remaining-time helpers', () => {
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

  test('formatRemainingLabel appends remaining time and preserves suffix', () => {
    assert.equal(formatRemainingLabel('1:00', 180, 60, null, false), '1:00 (-2:00)');
    assert.equal(formatRemainingLabel('1:00 (-9:99) / 3:00', 180, 60, 180, false), '1:00 (-2:00) / 3:00');
    assert.equal(formatRemainingLabel('3:00', 180, 60, null, true), '3:00 (-2:00)');
  });
});

describe('installRemainingTime Watch session lifecycle', () => {
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
      childNodes: [] as Node[],
      parentElement: null,
      closest: () => null,
    };
    let barFocusable = 'false';
    const progressBar = {
      isConnected: true,
      getAttribute: (name: string) => (name === 'hybridnavfocusable' ? barFocusable : null),
      querySelectorAll: (selector: string) => (selector.includes('elapsedTime') ? [elapsedEl] : []),
    };
    const videoEl = {
      duration: 120,
      currentTime: 30,
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
        return null;
      },
    };

    try {
      installRemainingTime();
      assert.equal(videoListeners.get('timeupdate')?.size ?? 0, 0);

      fakeLocation.hash = '#/watch?v=remVid1';
      for (const fn of winListeners.get('hashchange') ?? []) fn();
      assert.equal(videoListeners.get('timeupdate')?.size ?? 0, 1);

      // Player bar hidden via hybridnavfocusable or zylon-hidden -> timeupdate does not touch DOM.
      for (const fn of videoListeners.get('timeupdate') ?? []) fn({ type: 'timeupdate' } as Event);
      assert.equal(elapsedEl.textContent, '0:30 / 2:00');

      barFocusable = 'true';
      const classes = new Set(['zylon-hidden']);
      (progressBar as { classList?: { contains: (cls: string) => boolean } }).classList = {
        contains: (cls: string) => classes.has(cls),
      };
      for (const cb of [...observerCbs]) cb();
      assert.equal(elapsedEl.textContent, '0:30 / 2:00');

      // Player bar becomes visible -> observer refreshes elapsed text.
      classes.delete('zylon-hidden');
      for (const cb of [...observerCbs]) cb();
      assert.equal(elapsedEl.textContent, '0:30 (-1:30) / 2:00');

      fakeLocation.hash = '#/';
      for (const fn of winListeners.get('hashchange') ?? []) fn();
      assert.equal(videoListeners.get('timeupdate')?.size ?? 0, 0);
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
