import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { TransportActionItem } from '../mods/features/return-youtube-dislike.ts';
import {
  applyDislikeCountToActions,
  clearRydCache,
  installReturnYouTubeDislike,
  processRydResponse,
} from '../mods/features/return-youtube-dislike.ts';

describe('return-youtube-dislike', () => {
  test('applies like count label onto like action button without throwing in Node', (t) => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
    t.after(() => {
      globalThis.fetch = origFetch;
    });

    const actions: TransportActionItem[] = [
      {
        type: 'LIKE',
        button: {
          likeButtonRenderer: {
            likeCountText: { simpleText: '1.2K' },
          },
        },
      },
      {
        type: 'DISLIKE',
        button: {
          dislikeButtonRenderer: {},
        },
      },
    ];

    const result = applyDislikeCountToActions(actions, 'dQw4w9WgXcQ');
    assert.equal(result[0]?.button?.likeButtonRenderer?.defaultText?.simpleText, '1.2K');
    assert.equal(result[0]?.button?.likeButtonRenderer?.tooltip, '1.2K');
  });

  test('processRydResponse handles null and non-player payloads safely', (t) => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
    t.after(() => {
      globalThis.fetch = origFetch;
    });

    assert.doesNotThrow(() => processRydResponse(null));
    assert.doesNotThrow(() => processRydResponse({}));
    assert.doesNotThrow(() =>
      processRydResponse({
        videoDetails: { videoId: 'dQw4w9WgXcQ' },
        transportControls: { transportControlsRenderer: { promotedActions: [] } },
      })
    );
    assert.doesNotThrow(() => clearRydCache());
  });

  test('installReturnYouTubeDislike populates data-tt-count when watch controls mount lazily', async (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevDocument = globals.document;
    const prevLocation = globals.location;
    const prevFetch = globals.fetch;
    const prevRaf = globals.requestAnimationFrame;
    const prevMutationObserver = globals.MutationObserver;

    clearRydCache();
    t.after(() => {
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
      if (prevLocation === undefined) delete globals.location;
      else globals.location = prevLocation;
      globals.fetch = prevFetch;
      if (prevRaf === undefined) delete globals.requestAnimationFrame;
      else globals.requestAnimationFrame = prevRaf;
      if (prevMutationObserver === undefined) delete globals.MutationObserver;
      else globals.MutationObserver = prevMutationObserver;
      clearRydCache();
    });

    const likeButton = { dataset: {} as Record<string, string> };
    const dislikeButton = { dataset: {} as Record<string, string> };
    const watchHost = { nodeName: 'YTLR-WATCH-DEFAULT' };
    let observerCb: (() => void) | undefined;
    let controlsMounted = false;

    globals.requestAnimationFrame = (cb: () => void) => {
      cb();
      return 1;
    };
    globals.MutationObserver = class {
      constructor(cb: () => void) {
        observerCb = cb;
      }
      observe(): void {}
      disconnect(): void {}
    };
    let fetchSettled: Promise<void> | undefined;
    globals.fetch = (() => {
      const respPromise = Promise.resolve(
        new Response(JSON.stringify({ likes: 12500, dislikes: 420 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
      fetchSettled = respPromise.then(() => undefined);
      return respPromise;
    }) as typeof fetch;

    globals.location = { hash: '#/watch?v=testVid123' };
    globals.window = {
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    globals.document = {
      body: {},
      documentElement: {},
      adoptedStyleSheets: [],
      addEventListener: () => {},
      querySelector: (selector: string) => {
        if (selector === 'ytlr-watch-default') return watchHost;
        if (!controlsMounted) return null;
        if (selector.includes('dislike-button')) return dislikeButton;
        if (selector.includes('like-button')) return likeButton;
        return null;
      },
    };

    installReturnYouTubeDislike();
    await fetchSettled;
    // Allow microtasks from response.json() and cache population to flush.
    await new Promise((resolve) => setTimeout(resolve, 25));

    // Simulate lazy OSD mount after RYD API response already resolved.
    controlsMounted = true;
    observerCb?.();

    const deadline = Date.now() + 2000;
    while (
      (likeButton.dataset.ttCount !== '12.5K' || dislikeButton.dataset.ttCount !== '420') &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.equal(likeButton.dataset.ttCount, '12.5K');
    assert.equal(dislikeButton.dataset.ttCount, '420');
  });

  test('caches RYD 404 misses per session until clearRydCache', async (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevFetch = globals.fetch;
    let fetchCalls = 0;

    t.after(() => {
      globals.fetch = prevFetch;
      clearRydCache();
    });

    clearRydCache();
    let resolveFetch!: Promise<void>;
    globals.fetch = (() => {
      fetchCalls++;
      const p = Promise.resolve(new Response(null, { status: 404 }));
      resolveFetch = p.then(() => undefined);
      return p;
    }) as typeof fetch;

    applyDislikeCountToActions([], 'ryd404Vid');
    await resolveFetch;
    await new Promise((resolve) => setTimeout(resolve, 10));

    applyDislikeCountToActions([], 'ryd404Vid');
    assert.equal(fetchCalls, 1);

    clearRydCache();
    applyDislikeCountToActions([], 'ryd404Vid');
    await resolveFetch;
    assert.equal(fetchCalls, 2);
  });
});
