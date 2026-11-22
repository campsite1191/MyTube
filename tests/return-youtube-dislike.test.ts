import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  fetchDislikeCount,
  installReturnYouTubeDislike,
  setShortsOverlayStats,
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

    const controlsStrip = {
      nodeName: 'DIV',
      isConnected: true,
      parentElement: null as unknown,
      contains: (node: unknown) =>
        node === likeOuterHost || node === likeWrapper || node === likeButton || node === dislikeButton,
    };
    const makeButton = (parentElement: unknown = controlsStrip, children: Array<Record<string, unknown>> = []) => {
      const attrs: Record<string, string> = { hybridnavfocusable: 'true', tabindex: '0' };
      return {
        dataset: {} as Record<string, string>,
        inert: false,
        parentElement,
        children,
        getAttribute: (name: string) => attrs[name] ?? null,
        hasAttribute: (name: string) => Object.hasOwn(attrs, name),
        setAttribute: (name: string, value: string) => {
          attrs[name] = value;
        },
        contains: (other: unknown) => children.includes(other as Record<string, unknown>),
        closest: () => null as unknown,
        querySelectorAll: () => children,
        attrs,
      };
    };

    const nestedLikeChildAttrs: Record<string, string> = { hybridnavfocusable: 'true', tabindex: '0' };
    const nestedLikeChild = {
      getAttribute: (name: string) => nestedLikeChildAttrs[name] ?? null,
      hasAttribute: (name: string) => Object.hasOwn(nestedLikeChildAttrs, name),
      setAttribute: (name: string, value: string) => {
        nestedLikeChildAttrs[name] = value;
      },
      attrs: nestedLikeChildAttrs,
    };
    const likeOuterHost = makeButton(controlsStrip);
    likeOuterHost.querySelectorAll = () => [];
    const likeWrapper = makeButton(likeOuterHost);
    likeWrapper.querySelectorAll = () => [];
    const likeButton = makeButton(likeWrapper, [nestedLikeChild]);
    likeOuterHost.children.push(likeWrapper);
    likeWrapper.children.push(likeButton);
    likeButton.closest = () => likeWrapper;
    const dislikeButton = makeButton(controlsStrip);
    const watchHost = { nodeName: 'YTLR-WATCH-DEFAULT', isConnected: true, parentElement: null };
    const observerCbs: Array<() => void> = [];
    const observedTargets: unknown[] = [];
    let controlsMounted = false;
    let disconnected = false;
    const winListeners = new Map<string, Set<() => void>>();

    globals.MutationObserver = class {
      constructor(cb: () => void) {
        observerCbs.push(cb);
      }
      observe(target: unknown): void {
        observedTargets.push(target);
      }
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
      querySelectorAll: (selector: string) => {
        if (!controlsMounted) return [];
        if (selector.includes('like-dislike-container')) return [likeOuterHost, likeWrapper];
        if (selector.includes('dislike-button')) return [dislikeButton];
        if (selector.includes('like-button')) return [likeButton];
        return [];
      },
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
    const uninstallRyd = installReturnYouTubeDislike();
    t.after(uninstallRyd);
    await fetchSettled;
    await new Promise((resolve) => setTimeout(resolve, 10));

    controlsMounted = true;
    for (const cb of [...observerCbs]) cb();

    assert.equal(likeButton.dataset.ttCount, '12.5K');
    assert.equal(likeWrapper.dataset.ttCount, undefined);
    assert.equal(likeOuterHost.dataset.ttCount, undefined);
    assert.equal(dislikeButton.dataset.ttCount, '420');
    assert.equal(likeOuterHost.inert, true);
    assert.equal(likeOuterHost.attrs.hybridnavfocusable, 'false');
    assert.equal(likeOuterHost.attrs.tabindex, '-1');
    assert.equal(likeWrapper.inert, true);
    assert.equal(likeButton.inert, true);
    assert.equal(dislikeButton.inert, true);
    assert.equal(likeWrapper.attrs.hybridnavfocusable, 'false');
    assert.equal(likeWrapper.attrs.tabindex, '-1');
    assert.equal(likeButton.attrs.hybridnavfocusable, 'false');
    assert.equal(likeButton.attrs.tabindex, '-1');
    assert.equal(nestedLikeChildAttrs.hybridnavfocusable, 'false');
    assert.equal(nestedLikeChildAttrs.tabindex, '-1');
    assert.equal(dislikeButton.attrs.hybridnavfocusable, 'false');
    assert.equal(dislikeButton.attrs.tabindex, '-1');
    assert.equal(observedTargets.at(-1), controlsStrip);

    const injectedCss = fakeDoc.adoptedStyleSheets.map((s) => s.cssText).join('\n');
    assert.match(injectedCss, /ytlr-watch-default/);
    assert.match(injectedCss, /pointer-events:\s*none\s*!important/);
    assert.match(injectedCss, /display:\s*inline-flex\s*!important/);
    assert.match(injectedCss, /flex-direction:\s*row\s*!important/);
    assert.match(
      injectedCss,
      /:last-child\s*\[idomkey="dislike-button"\]\[data-tt-count\]::after\s*\{\s*padding-right:\s*1rem;/
    );
    assert.doesNotMatch(injectedCss, /top:\s*100%/);

    fakeLocation.hash = '#/';
    for (const fn of winListeners.get('hashchange') ?? []) fn();
    assert.equal(disconnected, true);
  });

  test('setShortsOverlayStats labels Like & RYD Dislike on Shorts action bar and aborts stale Shorts', async (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevDocument = globals.document;
    const prevFetch = globals.fetch;
    const prevMutationObserver = globals.MutationObserver;
    const prevCssStyleSheet = globals.CSSStyleSheet;

    t.after(() => {
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
      globals.fetch = prevFetch;
      if (prevMutationObserver === undefined) delete globals.MutationObserver;
      else globals.MutationObserver = prevMutationObserver;
      if (prevCssStyleSheet === undefined) delete globals.CSSStyleSheet;
      else globals.CSSStyleSheet = prevCssStyleSheet;
    });

    const makeShortsBtn = () => {
      const attrs: Record<string, string> = { hybridnavfocusable: 'true', tabindex: '0' };
      return {
        dataset: {} as Record<string, string>,
        inert: false,
        getAttribute: (name: string) => attrs[name] ?? null,
        hasAttribute: (name: string) => Object.hasOwn(attrs, name),
        setAttribute: (name: string, value: string) => {
          attrs[name] = value;
        },
        closest: () => null,
        querySelectorAll: () => [],
        attrs,
      };
    };

    const shortLikeBtn = makeShortsBtn();
    const shortDislikeBtn = makeShortsBtn();
    const overlayEl = { nodeName: 'YTLR-REEL-PLAYER-OVERLAY-RENDERER', isConnected: true };

    const signals = new Map<string, AbortSignal | undefined>();
    let resolveFirst: ((resp: Response) => void) | undefined;
    let disconnectCount = 0;

    globals.MutationObserver = class {
      observe(): void {}
      disconnect(): void {
        disconnectCount += 1;
      }
    };
    globals.CSSStyleSheet = class {
      cssText = '';
      replaceSync(text: string): void {
        this.cssText = text;
      }
    };
    globals.document = {
      body: { isConnected: true },
      documentElement: { isConnected: true },
      adoptedStyleSheets: [] as Array<{ cssText: string }>,
      querySelector: (selector: string) => {
        if (selector === 'ytlr-reel-player-overlay-renderer') return overlayEl;
        return null;
      },
      querySelectorAll: (selector: string) => {
        if (selector.includes('aria-label="Dislike"')) return [shortDislikeBtn];
        if (selector.includes('ytlr-toggle-button-view-model')) return [shortLikeBtn];
        return [];
      },
    };
    globals.fetch = ((url: string | URL | Request, init?: RequestInit) => {
      const videoId = new URL(String(url)).searchParams.get('videoId') ?? '';
      signals.set(videoId, init?.signal ?? undefined);
      if (videoId === 'shortStale') {
        return new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve(
        new Response(JSON.stringify({ dislikes: 3200 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
    }) as typeof fetch;

    setShortsOverlayStats('shortStale', '100 K');
    assert.equal(signals.get('shortStale')?.aborted, false);
    assert.equal(shortLikeBtn.dataset.ttCount, '100K');

    // Swiping to the next Short aborts the previous fetch + observer and replaces labels.
    setShortsOverlayStats('shortCurrent', '385 K');
    assert.equal(signals.get('shortStale')?.aborted, true);
    assert.ok(disconnectCount >= 1);

    // Late resolution from aborted Short must be ignored.
    resolveFirst?.(
      new Response(JSON.stringify({ dislikes: 99999 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 15));

    assert.equal(shortLikeBtn.dataset.ttCount, '385K');
    // Like button remains focusable while synthetic Dislike button has focus disabled.
    assert.equal(shortLikeBtn.inert, false);
    assert.equal(shortLikeBtn.attrs.tabindex, '0');
    assert.equal(shortDislikeBtn.dataset.ttCount, '3.2K');
    assert.equal(shortDislikeBtn.inert, true);
    assert.equal(shortDislikeBtn.attrs.hybridnavfocusable, 'false');
    assert.equal(shortDislikeBtn.attrs.tabindex, '-1');
  });

  test('patchTransportFocusSkip wraps prototype-based and own-property transport focus predicates', (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevDocument = globals.document;
    t.after(() => {
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
    });

    class ClosureTransportControls {
      buttons: Array<{ inert?: boolean; getAttribute?: (k: string) => string | null }>;
      constructor(buttons: Array<{ inert?: boolean; getAttribute?: (k: string) => string | null }>) {
        this.buttons = buttons;
      }
      navigateNext(idx: number): boolean {
        if (this.canFocusButton(idx)) {
          return Boolean(this.buttons[idx]);
        }
        return false;
      }
      canFocusButton(idx: number): boolean {
        return idx >= 0 && idx < this.buttons.length + 3;
      }
    }

    const focusableBtn = { inert: false, getAttribute: () => 'true' };
    const lockedLikeBtn = { inert: true, getAttribute: () => 'false' };
    const inst = new ClosureTransportControls([focusableBtn, lockedLikeBtn]);
    const tcEl = { __instance: inst };

    globals.window = { location: { hash: '#/watch?v=protoSkipVid', search: '' } };
    globals.document = {
      querySelector: (sel: string) => (sel.includes('transport-controls') ? tcEl : null),
      querySelectorAll: () => [],
    };

    setWatchLikeCount('protoSkipVid', '9.1K');

    assert.equal(inst.canFocusButton(0), true);
    assert.equal(inst.canFocusButton(1), false);

    // Fallback regex heuristic + multi-arg forwarding + missing predicate guard.
    class MinifiedControls {
      buttons: Array<{ inert?: boolean; getAttribute?: (k: string) => string | null }>;
      constructor(buttons: Array<{ inert?: boolean; getAttribute?: (k: string) => string | null }>) {
        this.buttons = buttons;
      }
      step(i: number) {
        if (this.checkFocus(i)) {
          return Boolean(this.buttons[i]);
        }
        return false;
      }
      checkFocus(i: number, bonus = 10) {
        return i >= 0 && bonus === 10;
      }
    }
    const minInst = new MinifiedControls([focusableBtn, lockedLikeBtn]);
    globals.document = {
      querySelector: (sel: string) => (sel.includes('transport-controls') ? { __instance: minInst } : null),
      querySelectorAll: () => [],
    };
    setWatchLikeCount('protoSkipVid', '9.2K');
    assert.equal(minInst.checkFocus(0, 10), true);
    assert.equal(minInst.checkFocus(1, 10), false);
  });

  test('handles Shorts swipe transitions without waiting on hashchange, avoids sibling Dislike fallback, and clears on exit', async (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevDocument = globals.document;
    const prevFetch = globals.fetch;
    const prevMutationObserver = globals.MutationObserver;
    const prevCssStyleSheet = globals.CSSStyleSheet;

    t.after(() => {
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
      globals.fetch = prevFetch;
      if (prevMutationObserver === undefined) delete globals.MutationObserver;
      else globals.MutationObserver = prevMutationObserver;
      if (prevCssStyleSheet === undefined) delete globals.CSSStyleSheet;
      else globals.CSSStyleSheet = prevCssStyleSheet;
    });

    const observers: Array<{ target: unknown; cb: () => void; disconnected: boolean }> = [];
    globals.MutationObserver = class {
      private readonly rec: { target: unknown; cb: () => void; disconnected: boolean };
      constructor(cb: () => void) {
        this.rec = { target: null, cb, disconnected: false };
      }
      observe(target: unknown): void {
        this.rec.target = target;
        observers.push(this.rec);
      }
      disconnect(): void {
        this.rec.disconnected = true;
      }
    };
    globals.CSSStyleSheet = class {
      replaceSync(): void {}
    };

    const makeBtn = () => {
      const attrs: Record<string, string> = {};
      return {
        dataset: {} as Record<string, string>,
        inert: false,
        getAttribute: (k: string) => attrs[k] ?? null,
        hasAttribute: (k: string) => Object.hasOwn(attrs, k),
        setAttribute: (k: string, v: string) => {
          attrs[k] = v;
        },
        querySelectorAll: () => [],
      };
    };

    const likeBtn = makeBtn();
    const dislikeBtn = makeBtn();
    let mountedOverlay: Record<string, unknown> | null = null;
    const bodyEl = { nodeName: 'BODY' };
    const winListeners = new Map<string, Set<() => void>>();
    const fakeLocation = { hash: '#/shorts', search: '' };
    const queriedSelectors: string[] = [];

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
      body: bodyEl,
      documentElement: bodyEl,
      adoptedStyleSheets: [],
      querySelector: (sel: string) => (sel === 'ytlr-reel-player-overlay-renderer' ? mountedOverlay : null),
      querySelectorAll: (sel: string) => {
        queriedSelectors.push(sel);
        if (sel.includes('aria-label="Dislike"')) return [dislikeBtn];
        if (sel.includes('ytlr-toggle-button-view-model')) return [likeBtn];
        return [];
      },
    };

    const fetchedIds: string[] = [];
    globals.fetch = (async (url: unknown) => {
      const vid = new URL(String(url)).searchParams.get('videoId') ?? '';
      fetchedIds.push(vid);
      return new Response(JSON.stringify({ dislikes: vid === 'curShort11' ? 11 : 22 }), { status: 200 });
    }) as typeof fetch;

    const uninstallRyd = installReturnYouTubeDislike();
    t.after(uninstallRyd);

    // Activate curShort11 before overlay mounts -> lightweight wait observer watches body until overlay appears.
    setShortsOverlayStats('curShort11', '500');
    assert.equal(observers[0]?.target, bodyEl);
    assert.equal(likeBtn.dataset.ttCount, '500');
    assert.ok(
      queriedSelectors.some(
        (sel) => sel.includes('aria-label="Dislike"') && !sel.includes('+ ytlr-reel-action-bar-button-view-model')
      )
    );
    assert.equal(
      queriedSelectors.some((sel) => sel.includes('+ ytlr-reel-action-bar-button-view-model')),
      false
    );

    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(fetchedIds, ['curShort11']);
    assert.equal(dislikeBtn.dataset.ttCount, '11');

    // Mounting overlay disconnects body wait observer and attaches strictly to overlay.
    mountedOverlay = { nodeName: 'YTLR-REEL-PLAYER-OVERLAY-RENDERER' };
    observers[0]?.cb();
    assert.equal(observers[0]?.disconnected, true);
    assert.equal(observers.at(-1)?.target, mountedOverlay);

    // Swiping to nextShort99 updates active Shorts stats immediately even before location.hash changes.
    setShortsOverlayStats('nextShort99', '888');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(likeBtn.dataset.ttCount, '888');
    assert.equal(dislikeBtn.dataset.ttCount, '22');

    // Stale wait-observer fires after switching away -> self-aborts cleanly.
    mountedOverlay = null;
    setShortsOverlayStats('waitShortA', '100');
    const waitObsA = observers.at(-1);
    setShortsOverlayStats('waitShortB', '200');
    waitObsA?.cb();
    assert.equal(waitObsA?.disconnected, true);

    // Network rejection in fetchDislikeCount returns null cleanly.
    globals.fetch = async () => {
      throw new Error('offline');
    };
    assert.equal(await fetchDislikeCount('errVid'), null);

    // Exiting Shorts clears state cleanly.
    fakeLocation.hash = '#/';
    for (const fn of winListeners.get('hashchange') ?? []) fn();
  });
});
