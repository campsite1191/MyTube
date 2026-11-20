import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { onPlayer } from '../mods/core/player-observer.ts';

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

    assert.equal(observedTargets.length, 0);
    assert.equal(typeof domContentLoadedCb, 'function');
    assert.equal(receivedPlayer, null);

    // Simulate DOM ready with player element present.
    const fakeBody = { nodeName: 'BODY' };
    fakeDoc.body = fakeBody;
    playerReady = true;
    domContentLoadedCb?.();

    assert.equal(receivedPlayer, fakePlayer);
    assert.deepEqual(observedTargets, [fakeBody]);
    assert.equal(disconnected, 0);
  });
});
