import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  fetchDislikeCount,
  installReturnYouTubeDislike,
  setWatchLikeCount,
} from '../mods/features/return-youtube-dislike.ts';

describe('return-youtube-dislike', () => {
  test('fetchDislikeCount formats dislikes and handles aborted/non-OK responses', async (t) => {
    const origFetch = globalThis.fetch;
    t.after(() => {
      globalThis.fetch = origFetch;
    });

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ likes: 5000, dislikes: 1250 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    assert.equal(await fetchDislikeCount('vid1'), '1.3K');

    globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
    assert.equal(await fetchDislikeCount('vid404'), null);

    const abort = new AbortController();
    abort.abort();
    assert.equal(await fetchDislikeCount('vidAborted', abort.signal), null);
  });

  test('installReturnYouTubeDislike renders live likeCountText alongside RYD dislikes under ytlr-watch-default', async (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevDocument = globals.document;
    const prevLocation = globals.location;
    const prevFetch = globals.fetch;
    const prevMutationObserver = globals.MutationObserver;
    const prevCssStyleSheet = globals.CSSStyleSheet;

    t.after(() => {
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
      if (prevLocation === undefined) delete globals.location;
      else globals.location = prevLocation;
      globals.fetch = prevFetch;
      if (prevMutationObserver === undefined) delete globals.MutationObserver;
      else globals.MutationObserver = prevMutationObserver;
      if (prevCssStyleSheet === undefined) delete globals.CSSStyleSheet;
      else globals.CSSStyleSheet = prevCssStyleSheet;
    });

    const controlsStrip = { nodeName: 'DIV', isConnected: true };
    const makeButton = () => {
      const attrs: Record<string, string> = { hybridnavfocusable: 'true' };
      return {
        dataset: {} as Record<string, string>,
        inert: false,
        parentElement: controlsStrip,
        getAttribute: (name: string) => attrs[name] ?? null,
        setAttribute: (name: string, value: string) => {
          attrs[name] = value;
        },
        querySelectorAll: () => [],
        attrs,
      };
    };

    const likeButton = makeButton();
    const dislikeButton = makeButton();
    const watchHost = { nodeName: 'YTLR-WATCH-DEFAULT', isConnected: true };
    const observerCbs: Array<() => void> = [];
    let controlsMounted = false;
    let disconnected = false;
    const winListeners = new Map<string, Set<() => void>>();

    globals.MutationObserver = class {
      constructor(cb: () => void) {
        observerCbs.push(cb);
      }
      observe(): void {}
      disconnect(): void {
        disconnected = true;
      }
    };

    let fetchSettled: Promise<void> | undefined;
    globals.fetch = (() => {
      const respPromise = Promise.resolve(
        new Response(JSON.stringify({ likes: 999999, dislikes: 420 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
      fetchSettled = respPromise.then(() => undefined);
      return respPromise;
    }) as typeof fetch;

    globals.CSSStyleSheet = class {
      cssText = '';
      replaceSync(text: string): void {
        this.cssText = text;
      }
    };

    const fakeLocation = { hash: '#/watch?v=testVid123', search: '' };
    globals.location = fakeLocation;
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
      removeEventListener: () => {},
    };
    const fakeDoc = {
      body: { isConnected: true },
      documentElement: { isConnected: true },
      adoptedStyleSheets: [] as Array<{ cssText: string }>,
      addEventListener: () => {},
      querySelector: (selector: string) => {
        if (selector === 'video') return {};
        if (selector === 'ytlr-watch-default') return watchHost;
        if (!controlsMounted) return null;
        if (selector.includes('dislike-button')) return dislikeButton;
        if (selector.includes('like-button')) return likeButton;
        return null;
      },
    };
    globals.document = fakeDoc;

    // Live YouTube likeCountText takes precedence and never falls back to RYD likes (999999).
    setWatchLikeCount('testVid123', '12.5 K');
    installReturnYouTubeDislike();
    await fetchSettled;
    await new Promise((resolve) => setTimeout(resolve, 10));

    controlsMounted = true;
    for (const cb of [...observerCbs]) cb();

    assert.equal(likeButton.dataset.ttCount, '12.5K');
    assert.equal(dislikeButton.dataset.ttCount, '420');
    assert.equal(likeButton.inert, true);
    assert.equal(dislikeButton.inert, true);
    assert.equal(likeButton.attrs.hybridnavfocusable, 'false');
    assert.equal(dislikeButton.attrs.hybridnavfocusable, 'false');

    const injectedCss = fakeDoc.adoptedStyleSheets.map((s) => s.cssText).join('\n');
    assert.match(injectedCss, /ytlr-watch-default/);
    assert.match(injectedCss, /pointer-events:\s*none\s*!important/);

    fakeLocation.hash = '#/';
    for (const fn of winListeners.get('hashchange') ?? []) fn();
    assert.equal(disconnected, true);
  });
});
