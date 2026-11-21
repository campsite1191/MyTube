import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { observeDom, onAbort, onWatchSession, scheduleAbortableTimeout } from '../mods/core/lifecycle.ts';

describe('AbortSignal lifecycle helpers', () => {
  test('onAbort runs cleanup on abort or immediately when already aborted', () => {
    const controller = new AbortController();
    let count = 0;

    onAbort(controller.signal, () => {
      count++;
    });
    assert.equal(count, 0);

    controller.abort();
    assert.equal(count, 1);

    // Already aborted signals execute synchronously once and undefined signals no-op.
    onAbort(controller.signal, () => {
      count++;
    });
    onAbort(undefined, () => {
      count++;
    });
    assert.equal(count, 2);
  });

  test('observeDom disconnects automatically on abort and returns null when already aborted', () => {
    const globals = globalThis as Record<string, unknown>;
    const prevObserver = globals.MutationObserver;
    let disconnectCount = 0;

    globals.MutationObserver = class {
      observe(): void {}
      disconnect(): void {
        disconnectCount++;
      }
    };

    try {
      const controller = new AbortController();
      const target = {} as Node;
      const obs = observeDom(target, () => {}, { childList: true }, controller.signal);
      assert.ok(obs !== null);
      assert.equal(disconnectCount, 0);

      controller.abort();
      assert.equal(disconnectCount, 1);

      const skipped = observeDom(target, () => {}, { childList: true }, controller.signal);
      assert.equal(skipped, null);
    } finally {
      globals.MutationObserver = prevObserver;
    }
  });

  test('scheduleAbortableTimeout cancels pending callback on abort and fires normally otherwise', async () => {
    const abortController = new AbortController();
    let abortedRan = false;
    scheduleAbortableTimeout(
      () => {
        abortedRan = true;
      },
      10,
      abortController.signal
    );
    abortController.abort();

    const activeController = new AbortController();
    let completed = false;
    scheduleAbortableTimeout(
      () => {
        completed = true;
      },
      10,
      activeController.signal
    );

    await new Promise((r) => setTimeout(r, 35));
    assert.equal(abortedRan, false);
    assert.equal(completed, true);
  });
});

describe('onWatchSession helper', () => {
  test('starts scoped sessions for active videoIds and aborts on navigation or video switch', () => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const winListeners = new Map<string, Set<() => void>>();
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

    const events: string[] = [];
    const unsubscribe = onWatchSession((videoId, signal) => {
      events.push(`start:${videoId}`);
      onAbort(signal, () => {
        events.push(`abort:${videoId}`);
      });
    });

    try {
      assert.deepEqual(events, []);

      fakeLocation.hash = '#/watch?v=firstVid';
      for (const fn of winListeners.get('hashchange') ?? []) fn();
      assert.deepEqual(events, ['start:firstVid']);

      fakeLocation.hash = '#/?v=secondVid';
      for (const fn of winListeners.get('hashchange') ?? []) fn();
      assert.deepEqual(events, ['start:firstVid', 'abort:firstVid', 'start:secondVid']);

      fakeLocation.hash = '#/';
      for (const fn of winListeners.get('hashchange') ?? []) fn();
      assert.deepEqual(events, ['start:firstVid', 'abort:firstVid', 'start:secondVid', 'abort:secondVid']);
    } finally {
      unsubscribe();
      globals.window = prevWindow;
    }
  });
});
