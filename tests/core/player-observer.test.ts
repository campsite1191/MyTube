import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { onPlayer } from '../../mods/core/player-observer.ts';

describe('player-observer document-start guard', () => {
  test('defers MutationObserver until DOMContentLoaded when body and documentElement are null', (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevDocument = globals.document;
    const prevMutationObserver = globals.MutationObserver;
    const prevRaf = globals.requestAnimationFrame;

    t.after(() => {
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;

      if (prevMutationObserver === undefined) delete globals.MutationObserver;
      else globals.MutationObserver = prevMutationObserver;

      if (prevRaf === undefined) delete globals.requestAnimationFrame;
      else globals.requestAnimationFrame = prevRaf;
    });

    let domContentLoadedCb: (() => void) | undefined;
    let playerReady = false;
    const fakePlayer = { id: 'movie_player' };
    const observedTargets: unknown[] = [];
    let disconnected = 0;

    globals.requestAnimationFrame = (cb: () => void) => {
      cb();
      return 1;
    };

    globals.MutationObserver = class {
      observe(target: unknown): void {
        observedTargets.push(target);
      }
      disconnect(): void {
        disconnected++;
      }
    };

    const fakeDoc: Record<string, unknown> = {
      body: null,
      documentElement: null,
      querySelector: () => (playerReady ? fakePlayer : null),
      addEventListener: (event: string, cb: () => void) => {
        if (event === 'DOMContentLoaded') domContentLoadedCb = cb;
      },
    };
    globals.document = fakeDoc;

    let receivedPlayer: unknown = null;
    onPlayer((player) => {
      receivedPlayer = player;
    });
    // Enqueueing another waiter while body/documentElement are still null hits the domReadyListenerAttached guard.
    onPlayer(() => {});

    assert.equal(observedTargets.length, 0);
    assert.equal(typeof domContentLoadedCb, 'function');
    assert.equal(receivedPlayer, null);

    // Simulate DOM ready with player element present.
    const fakeBody = { nodeName: 'BODY' };
    fakeDoc.body = fakeBody;
    playerReady = true;
    domContentLoadedCb?.();

    assert.equal(receivedPlayer, fakePlayer);
    assert.deepEqual(observedTargets, []);
    assert.equal(disconnected, 0);

    // Synchronous hit and pre-aborted guard on onPlayer when player already exists.
    let syncPlayer: unknown = null;
    onPlayer((p) => {
      syncPlayer = p;
    });
    assert.equal(syncPlayer, fakePlayer);
    const abortedPlayer = new AbortController();
    abortedPlayer.abort();
    onPlayer(() => {
      syncPlayer = null;
    }, abortedPlayer.signal);
    assert.equal(syncPlayer, fakePlayer);
  });

  test('supports AbortSignal cancellation, deferred onVideo queues, setTimeout fallback, and waiter error isolation', async (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevDocument = globals.document;
    const prevMutationObserver = globals.MutationObserver;
    const prevRaf = globals.requestAnimationFrame;

    t.after(() => {
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
      if (prevMutationObserver === undefined) delete globals.MutationObserver;
      else globals.MutationObserver = prevMutationObserver;
      if (prevRaf === undefined) delete globals.requestAnimationFrame;
      else globals.requestAnimationFrame = prevRaf;
    });

    let observerCallback: (() => void) | null = null;
    const fireObserver = () => observerCallback?.();
    let disconnectCalls = 0;
    let videoReady = false;
    const fakeVideo = { nodeName: 'VIDEO' };

    delete globals.requestAnimationFrame;
    globals.MutationObserver = class {
      constructor(cb: () => void) {
        observerCallback = cb;
      }
      observe(): void {}
      disconnect(): void {
        disconnectCalls++;
      }
    };
    globals.document = {
      body: { nodeName: 'BODY' },
      documentElement: { nodeName: 'HTML' },
      querySelector: (sel: string) => (sel === 'video' && videoReady ? fakeVideo : null),
    };

    const { onVideo } = await import('../../mods/core/player-observer.ts');

    // Already-aborted signal is ignored immediately.
    const preAborted = new AbortController();
    preAborted.abort();
    let preAbortedCalled = false;
    onPlayer(() => {
      preAbortedCalled = true;
    }, preAborted.signal);
    onVideo(() => {
      preAbortedCalled = true;
    }, preAborted.signal);
    assert.equal(preAbortedCalled, false);

    // Aborting the sole queued waiter disconnects domObserver immediately.
    const cancelCtrl = new AbortController();
    let canceledCalled = false;
    onVideo(() => {
      canceledCalled = true;
    }, cancelCtrl.signal);
    assert.equal(disconnectCalls, 0);
    cancelCtrl.abort();
    assert.equal(disconnectCalls, 1);
    assert.equal(canceledCalled, false);

    // Error in one waiter does not prevent subsequent waiters or domObserver cleanup.
    const origError = console.error;
    const loggedErrors: unknown[] = [];
    console.error = (...args: unknown[]) => {
      loggedErrors.push(args);
    };
    try {
      const received: unknown[] = [];
      const activeCtrl = new AbortController();
      onVideo(() => {
        throw new Error('Waiter failure');
      }, activeCtrl.signal);
      onVideo((video) => {
        received.push(video);
      }, activeCtrl.signal);

      videoReady = true;
      fireObserver();
      fireObserver(); // Second mutation before setTimeout flush hits pendingFlush guard.
      await new Promise((r) => setTimeout(r, 20));

      assert.deepEqual(received, [fakeVideo]);
      assert.equal(loggedErrors.length, 1);
      assert.equal(disconnectCalls, 2);

      // Immediate synchronous path when video is already mounted.
      let syncVideo: unknown = null;
      onVideo((video) => {
        syncVideo = video;
      });
      assert.equal(syncVideo, fakeVideo);
    } finally {
      console.error = origError;
    }
  });
});
