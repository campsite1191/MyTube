import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  extractWatchVideoId,
  isPlaybackPageActive,
  isPlayerBarVisible,
  NOOP,
  observeDom,
  observePlayerBar,
  onAbort,
  onWatchSession,
  scheduleAbortableTimeout,
} from '../../mods/core/lifecycle.ts';

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

    const preAborted = new AbortController();
    preAborted.abort();
    assert.equal(
      scheduleAbortableTimeout(() => {}, 5, preAborted.signal),
      null
    );

    let unsignaledCompleted = false;
    scheduleAbortableTimeout(() => {
      unsignaledCompleted = true;
    }, 5);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(unsignaledCompleted, true);
    assert.equal(extractWatchVideoId(null), null);
    NOOP();
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
      removeEventListener: (type: string, fn: () => void) => {
        winListeners.get(type)?.delete(fn);
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

      // Adding another handler mid-Watch receives active session immediately; throwing handler is isolated.
      const origError = console.error;
      let loggedErrors = 0;
      console.error = () => {
        loggedErrors++;
      };
      const lateEvents: string[] = [];
      const unsubLate = onWatchSession((videoId) => {
        lateEvents.push(videoId);
      });
      const unsubThrowing = onWatchSession((videoId) => {
        if (videoId === 'secondVid') throw new Error('session error');
      });
      assert.deepEqual(lateEvents, ['firstVid']);

      fakeLocation.hash = '#/?v=secondVid';
      for (const fn of winListeners.get('hashchange') ?? []) fn();
      console.error = origError;
      assert.equal(loggedErrors, 1);
      assert.deepEqual(events, ['start:firstVid', 'abort:firstVid', 'start:secondVid']);
      assert.deepEqual(lateEvents, ['firstVid', 'secondVid']);

      unsubLate();
      unsubThrowing();

      fakeLocation.hash = '#/';
      for (const fn of winListeners.get('hashchange') ?? []) fn();
      assert.deepEqual(events, ['start:firstVid', 'abort:firstVid', 'start:secondVid', 'abort:secondVid']);
    } finally {
      unsubscribe();
      assert.equal(winListeners.get('hashchange')?.size ?? 0, 0);
      delete globals.window;
      if (prevWindow !== undefined) globals.window = prevWindow;
    }
  });

  test('observePlayerBar waits for late mount, re-binds on parent detachment or manual getter, and cleans up on abort', (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevDocument = globals.document;
    const prevMutationObserver = globals.MutationObserver;

    t.after(() => {
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
      if (prevMutationObserver === undefined) delete globals.MutationObserver;
      else globals.MutationObserver = prevMutationObserver;
    });

    const observers: Array<{ target: unknown; cb: () => void; disconnected: boolean }> = [];
    globals.MutationObserver = class {
      private readonly entry: { target: unknown; cb: () => void; disconnected: boolean };
      constructor(cb: () => void) {
        this.entry = { target: null, cb, disconnected: false };
      }
      observe(target: unknown): void {
        this.entry.target = target;
        observers.push(this.entry);
      }
      disconnect(): void {
        this.entry.disconnected = true;
      }
    };

    const parentNode = { nodeName: 'YTLR-WATCH' };
    let activeBar: {
      isConnected: boolean;
      parentNode: unknown;
      getAttribute: () => string | null;
      classList: { contains: () => boolean };
    } | null = null;

    globals.document = {
      body: { nodeName: 'BODY' },
      documentElement: { nodeName: 'HTML' },
      querySelector: (sel: string) => (sel === 'ytlr-progress-bar' ? activeBar : null),
    };

    const controller = new AbortController();
    const seenBars: unknown[] = [];
    const getBar = observePlayerBar(controller.signal, (bar) => {
      seenBars.push(bar);
    });

    // Not yet mounted: getBar returns null and wait observer watches body.
    assert.equal(getBar(), null);
    assert.equal(observers.length, 1);

    // Mount first bar and trigger wait observer.
    const bar1 = {
      isConnected: true,
      parentNode,
      getAttribute: () => 'true',
      classList: { contains: () => false },
    };
    activeBar = bar1;
    assert.equal(isPlayerBarVisible(bar1 as unknown as Element), true);
    observers[0]?.cb();
    assert.deepEqual(seenBars, [bar1]);
    assert.equal(observers[0]?.disconnected, true);
    assert.equal(getBar(), bar1);

    // Trigger normal bar mutation while connected -> invokes onBar again.
    const barObs = observers.find((o) => o.target === bar1 && !o.disconnected);
    const parentObs = observers.find((o) => o.target === parentNode && !o.disconnected);
    assert.ok(barObs && parentObs);
    barObs.cb();
    assert.equal(seenBars.length, 2);

    // Detach bar1 -> parent observer immediately triggers re-bind to bar2.
    const bar2 = {
      isConnected: true,
      parentNode,
      getAttribute: () => 'true',
      classList: { contains: () => false },
    };
    bar1.isConnected = false;
    activeBar = bar2;
    parentObs.cb();
    assert.equal(seenBars.at(-1), bar2);

    // Detach bar2 without parent callback -> manual getBar() rebinds or returns null cleanly.
    const bar2Obs = observers.find((o) => o.target === bar2 && !o.disconnected);
    bar2.isConnected = false;
    activeBar = null;
    assert.equal(getBar(), null);
    bar2Obs?.cb();

    controller.abort();
    assert.equal(getBar(), null);
    assert.equal(
      observers.every((o) => o.disconnected),
      true
    );
  });

  test('isPlaybackPageActive detects Watch routes and active Shorts playback without matching browse routes', (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevDocument = globals.document;
    t.after(() => {
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
    });

    const bodyClasses = new Set<string>();
    const fakeLocation = { hash: '#/', search: '' };
    globals.window = { location: fakeLocation };
    globals.document = { body: { classList: { contains: (cls: string) => bodyClasses.has(cls) } } };

    assert.equal(isPlaybackPageActive(), false);

    fakeLocation.hash = '#/browse?c=FEtopics';
    assert.equal(isPlaybackPageActive(), false);

    fakeLocation.hash = '#/watch?v=abc123XYZ';
    assert.equal(isPlaybackPageActive(), true);

    fakeLocation.hash = '#/watch';
    assert.equal(isPlaybackPageActive(), true);

    fakeLocation.hash = '#/';
    bodyClasses.add('WEB_PAGE_TYPE_SHORTS');
    assert.equal(isPlaybackPageActive(), true);

    bodyClasses.delete('WEB_PAGE_TYPE_SHORTS');
    globals.window = {};
    assert.equal(isPlaybackPageActive(), false);
  });

  test('[M3] onWatchSession isolates synchronous exceptions when joining an already-active Watch session', (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const origError = console.error;

    let loggedErrors = 0;
    console.error = () => {
      loggedErrors++;
    };

    const unsubscribers: Array<() => void> = [];
    globals.window = {
      location: { hash: '#/watch?v=deepLinkVid', search: '' },
      addEventListener: () => {},
      removeEventListener: () => {},
    };

    t.after(() => {
      for (const unsub of [...unsubscribers].reverse()) unsub();
      console.error = origError;
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
    });

    const healthy: string[] = [];
    unsubscribers.push(onWatchSession(() => {}));
    assert.doesNotThrow(() => {
      unsubscribers.push(
        onWatchSession(() => {
          throw new Error('late join boom');
        })
      );
    });
    unsubscribers.push(onWatchSession((vid) => healthy.push(vid)));

    assert.equal(loggedErrors, 1);
    assert.deepEqual(healthy, ['deepLinkVid']);
  });
});

test('[M1] observeShortsPage handles pre-aborted signals and defers to DOMContentLoaded when document.body is null', async (t) => {
  const { observeShortsPage } = await import('../../mods/core/lifecycle.ts');
  const abortedController = new AbortController();
  abortedController.abort();
  const noopCleanup = observeShortsPage(() => {}, abortedController.signal);
  noopCleanup();

  const origDoc = (globalThis as { document?: unknown }).document;
  const origMutationObserver = (globalThis as { MutationObserver?: unknown }).MutationObserver;
  t.after(() => {
    if (origDoc === undefined) delete (globalThis as { document?: unknown }).document;
    else (globalThis as { document?: unknown }).document = origDoc;
    if (origMutationObserver === undefined) delete (globalThis as { MutationObserver?: unknown }).MutationObserver;
    else (globalThis as { MutationObserver?: unknown }).MutationObserver = origMutationObserver;
  });

  const docListeners = new Map<string, Set<EventListener>>();
  const bodyClasses = new Set<string>();
  let observerCount = 0;
  let disconnectedCount = 0;

  class LocalMockObserver {
    constructor(_cb: MutationCallback) {
      observerCount++;
    }
    observe(): void {}
    disconnect(): void {
      disconnectedCount++;
    }
    takeRecords(): MutationRecord[] {
      return [];
    }
  }
  (globalThis as { MutationObserver?: unknown }).MutationObserver = LocalMockObserver;

  const fakeDoc: {
    body: { classList: { contains: (cls: string) => boolean } } | null;
    addEventListener: (type: string, fn: EventListener) => void;
    removeEventListener: (type: string, fn: EventListener) => void;
  } = {
    body: null,
    addEventListener(type, fn) {
      let set = docListeners.get(type);
      if (!set) {
        set = new Set();
        docListeners.set(type, set);
      }
      set.add(fn);
    },
    removeEventListener(type, fn) {
      docListeners.get(type)?.delete(fn);
    },
  };
  (globalThis as { document?: unknown }).document = fakeDoc;

  const states: boolean[] = [];
  const controller = new AbortController();
  const cleanup = observeShortsPage((active) => {
    states.push(active);
  }, controller.signal);

  assert.equal(docListeners.get('DOMContentLoaded')?.size, 1);
  assert.equal(observerCount, 0);

  bodyClasses.add('WEB_PAGE_TYPE_SHORTS');
  fakeDoc.body = {
    classList: {
      contains: (cls: string) => bodyClasses.has(cls),
    },
  };
  for (const listener of [...(docListeners.get('DOMContentLoaded') ?? [])]) {
    listener(new Event('DOMContentLoaded'));
  }

  assert.deepEqual(states, [true]);
  assert.equal(observerCount, 1);

  controller.abort();
  cleanup();
  assert.equal(disconnectedCount, 1);
  assert.equal(docListeners.get('DOMContentLoaded')?.size, 0);

  // When document.body is already present, observeShortsPage attaches immediately and fires only on transitions.
  const capture: { cb: MutationCallback | null } = { cb: null };
  class CapturingObserver extends LocalMockObserver {
    constructor(cb: MutationCallback) {
      super(cb);
      capture.cb = cb;
    }
  }
  (globalThis as { MutationObserver?: unknown }).MutationObserver = CapturingObserver;
  const directStates: boolean[] = [];
  const cleanupDirect = observeShortsPage((active) => {
    directStates.push(active);
  });
  capture.cb?.([], {} as MutationObserver);
  bodyClasses.delete('WEB_PAGE_TYPE_SHORTS');
  capture.cb?.([], {} as MutationObserver);
  assert.deepEqual(directStates, [false]);
  cleanupDirect();

  // DOMContentLoaded firing while doc.body is still null is ignored safely, and syncWatchSession stops if aborted mid-loop.
  fakeDoc.body = null;
  const nullBodyCleanup = observeShortsPage(() => {});
  for (const listener of [...(docListeners.get('DOMContentLoaded') ?? [])]) {
    listener(new Event('DOMContentLoaded'));
  }
  nullBodyCleanup();

  const origWindow = (globalThis as { window?: unknown }).window;
  try {
    const winListeners = new Map<string, Set<() => void>>();
    const fakeLocation = { hash: '#/', search: '' };
    (globalThis as { window?: unknown }).window = {
      location: fakeLocation,
      addEventListener: (type: string, fn: () => void) => {
        const set = winListeners.get(type) ?? new Set();
        set.add(fn);
        winListeners.set(type, set);
      },
      removeEventListener: (type: string, fn: () => void) => winListeners.get(type)?.delete(fn),
    };
    let secondRan = false;
    const unsubA = onWatchSession(() => {
      fakeLocation.hash = '#/';
      for (const fn of winListeners.get('hashchange') ?? []) fn();
    });
    const unsubB = onWatchSession(() => {
      secondRan = true;
    });
    fakeLocation.hash = '#/watch?v=midLoopAbort';
    for (const fn of winListeners.get('hashchange') ?? []) fn();
    assert.equal(secondRan, false);
    unsubA();
    unsubB();
  } finally {
    if (origWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = origWindow;
  }
});
