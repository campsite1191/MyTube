import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { computeRewindTime, installRewindOnPause } from '../mods/features/rewind-on-pause.ts';

describe('computeRewindTime', () => {
  test('rewinds by 5 seconds after >= 30s pause and clamps at 0', () => {
    assert.equal(computeRewindTime(10_000, 45_000, 600, 120), 115);
    assert.equal(computeRewindTime(10_000, 45_000, 600, 3), 0);
  });

  test('returns null for short pauses, unset pause timestamp, invalid duration, or near start', () => {
    assert.equal(computeRewindTime(10_000, 39_999, 600, 120), null);
    assert.equal(computeRewindTime(0, 45_000, 600, 120), null);
    assert.equal(computeRewindTime(10_000, 45_000, Number.POSITIVE_INFINITY, 120), null);
    assert.equal(computeRewindTime(10_000, 45_000, 600, 1), null);
  });
});

describe('installRewindOnPause Watch session lifecycle', () => {
  test('attaches listeners only on active watch session, survives playing overwrite, and detaches on exit', () => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevDocument = globals.document;
    const prevDateNow = Date.now;

    const winListeners = new Map<string, Set<(ev: unknown) => void>>();
    const videoListeners = new Map<string, Set<(ev: unknown) => void>>();

    const addTo = (
      map: Map<string, Set<(ev: unknown) => void>>,
      type: string,
      fn: (ev: unknown) => void,
      opts?: boolean | { once?: boolean; signal?: AbortSignal }
    ) => {
      const o = typeof opts === 'object' ? opts : undefined;
      if (o?.signal?.aborted) return;
      let set = map.get(type);
      if (!set) {
        set = new Set();
        map.set(type, set);
      }
      const wrapped = o?.once
        ? (ev: unknown) => {
            set?.delete(wrapped);
            fn(ev);
          }
        : fn;
      set.add(wrapped);
      o?.signal?.addEventListener('abort', () => set.delete(wrapped), { once: true });
    };

    let fakeNow = 100_000;
    Date.now = () => fakeNow;

    const videoEl = {
      tagName: 'VIDEO',
      duration: 600,
      currentTime: 90,
      paused: true,
      ended: false,
      addEventListener: (
        type: string,
        fn: (ev: unknown) => void,
        opts?: boolean | { once?: boolean; signal?: AbortSignal }
      ) => addTo(videoListeners, type, fn, opts),
      dispatch: (type: string) => {
        for (const fn of [...(videoListeners.get(type) ?? [])]) fn({ type, target: videoEl });
      },
    };

    const fakeLocation = { hash: '#/', search: '' };
    globals.window = {
      location: fakeLocation,
      addEventListener: (type: string, fn: (ev: unknown) => void) => addTo(winListeners, type, fn),
    };
    globals.document = {
      querySelector: (sel: string) => (sel === 'video' ? videoEl : null),
    };

    try {
      installRewindOnPause();
      // Outside Watch route, zero <video> listeners are attached
      assert.equal(videoListeners.get('pause')?.size ?? 0, 0);

      // Entering Watch (#/?v=vid123) attaches directly to <video>
      fakeLocation.hash = '#/?v=vid123';
      for (const fn of [...(winListeners.get('hashchange') ?? [])]) fn({ type: 'hashchange' });
      assert.equal(videoListeners.get('pause')?.size ?? 0, 1);

      // Pause at 90s; minor keyframe seeking (<5s) does not cancel state; playing re-applies if overwritten
      videoEl.dispatch('pause');
      videoEl.currentTime = 88.5;
      videoEl.dispatch('seeking');
      fakeNow += 35_000;
      videoEl.currentTime = 90;
      videoEl.paused = false;

      videoEl.dispatch('play');
      assert.equal(videoEl.currentTime, 85);
      videoEl.currentTime = 90;
      videoEl.dispatch('playing');
      assert.equal(videoEl.currentTime, 85);

      // Leaving Watch route removes all <video> listeners automatically
      fakeLocation.hash = '#/';
      for (const fn of [...(winListeners.get('hashchange') ?? [])]) fn({ type: 'hashchange' });
      assert.equal(videoListeners.get('pause')?.size ?? 0, 0);
      assert.equal(videoListeners.get('play')?.size ?? 0, 0);
    } finally {
      Date.now = prevDateNow;
      globals.window = prevWindow;
      globals.document = prevDocument;
    }
  });
});
