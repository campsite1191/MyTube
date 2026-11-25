import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  fetchDislikeCount,
  installReturnYouTubeDislike,
  normalizeVoteCount,
  setShortsOverlayStats,
  setWatchLikeCount,
} from '../../mods/features/return-youtube-dislike.ts';

describe('return-youtube-dislike', () => {
  test('normalizeVoteCount accepts valid numeric/compact counts and rejects hidden-like or zero labels', () => {
    assert.equal(normalizeVoteCount(null), null);
    assert.equal(normalizeVoteCount(undefined), null);
    assert.equal(normalizeVoteCount(''), null);
    assert.equal(normalizeVoteCount('Like'), null);
    assert.equal(normalizeVoteCount('like this video along with 0 other people'), null);
    assert.equal(normalizeVoteCount('0'), null);
    assert.equal(normalizeVoteCount('42'), '42');
    assert.equal(normalizeVoteCount('1,250'), '1.3K');
    assert.equal(normalizeVoteCount('12.5 k'), '12.5K');
    assert.equal(normalizeVoteCount('19M'), '19M');
  });

  test('installReturnYouTubeDislike no-ops safely when window or document is absent', (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevDocument = globals.document;
    t.after(() => {
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
    });

    delete globals.window;
    assert.doesNotThrow(() => installReturnYouTubeDislike()());

    globals.window = {};
    delete globals.document;
    assert.doesNotThrow(() => installReturnYouTubeDislike()());
  });

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

    globalThis.fetch = (async () => new Response(JSON.stringify({ dislikes: 'NaN' }), { status: 200 })) as typeof fetch;
    assert.equal(await fetchDislikeCount('vidBadType'), null);

    globalThis.fetch = (async () => new Response(JSON.stringify({ dislikes: 0 }), { status: 200 })) as typeof fetch;
    assert.equal(await fetchDislikeCount('vidZero'), null);

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
    assert.match(injectedCss, /vertical-align:\s*top\s*!important/);
    assert.match(injectedCss, /gap:\s*0;/);
    assert.match(injectedCss, /\[idomkey="like-button"\]\[data-tt-count\]::after\s*\{\s*padding-right:\s*0\.75rem;/);
    assert.match(
      injectedCss,
      /ytlr-watch-default\s+\[idomkey="dislike-button"\]\[data-tt-count\]::after\s*\{\s*padding-right:\s*1rem;/
    );
    assert.doesNotMatch(injectedCss, /:last-child\s*\[idomkey="dislike-button"\]/);
    assert.match(injectedCss, /ytlr-reel-action-bar-button-view-model\[data-tt-count\]\s+yt-formatted-string/);
    assert.doesNotMatch(
      injectedCss,
      /ytlr-reel-action-bar-button-view-model\[data-tt-count\]\s+:is\(yt-icon-button,\s*yt-button-container\)/
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
    const waitObs = observers.at(-1);
    assert.equal(waitObs?.target, bodyEl);
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
    waitObs?.cb();
    assert.equal(waitObs?.disconnected, true);
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

  test('[M1] aborts in-flight Shorts RYD fetch and disconnects overlay observer when WEB_PAGE_TYPE_SHORTS is removed without hashchange', async (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevDocument = globals.document;
    const prevFetch = globals.fetch;
    const prevMutationObserver = globals.MutationObserver;
    const prevCssStyleSheet = globals.CSSStyleSheet;
    const prevRaf = globals.requestAnimationFrame;

    const observers: Array<{ target: unknown; cb: (mutations: unknown[]) => void; disconnected: boolean }> = [];
    globals.MutationObserver = class {
      private readonly rec: { target: unknown; cb: (mutations: unknown[]) => void; disconnected: boolean };
      constructor(cb: (mutations: unknown[]) => void) {
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
    globals.requestAnimationFrame = (cb: () => void) => {
      cb();
      return 1;
    };

    const bodyClasses = new Set<string>(['WEB_PAGE_TYPE_SHORTS']);
    const overlayEl = { nodeName: 'YTLR-REEL-PLAYER-OVERLAY-RENDERER' };
    const bodyEl = {
      nodeName: 'BODY',
      classList: {
        contains: (cls: string) => bodyClasses.has(cls),
        add: (cls: string) => bodyClasses.add(cls),
        remove: (cls: string) => bodyClasses.delete(cls),
      },
    };
    const fakeLocation = { hash: '#/', search: '' };
    globals.window = {
      location: fakeLocation,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    globals.document = {
      body: bodyEl,
      documentElement: bodyEl,
      adoptedStyleSheets: [],
      querySelector: (sel: string) => (sel === 'ytlr-reel-player-overlay-renderer' ? overlayEl : null),
      querySelectorAll: () => [],
    };

    let shortsSignal: AbortSignal | undefined;
    globals.fetch = ((_url: unknown, init?: RequestInit) => {
      shortsSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    }) as typeof fetch;

    const uninstallRyd = installReturnYouTubeDislike();
    t.after(() => {
      uninstallRyd();
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
      globals.fetch = prevFetch;
      if (prevMutationObserver === undefined) delete globals.MutationObserver;
      else globals.MutationObserver = prevMutationObserver;
      if (prevCssStyleSheet === undefined) delete globals.CSSStyleSheet;
      else globals.CSSStyleSheet = prevCssStyleSheet;
      if (prevRaf === undefined) delete globals.requestAnimationFrame;
      else globals.requestAnimationFrame = prevRaf;
    });

    setShortsOverlayStats('shortExit01', '15K');
    const overlayObservers = observers.filter((o) => o.target === overlayEl);
    assert.ok(overlayObservers.length >= 1);
    assert.equal(shortsSignal?.aborted, false);

    // Exiting Shorts back to Home drops WEB_PAGE_TYPE_SHORTS while location.hash stays '#/'.
    bodyClasses.delete('WEB_PAGE_TYPE_SHORTS');
    for (const obs of observers.filter(
      (o) => !o.disconnected && (o.target === bodyEl || o.target === globals.document)
    )) {
      obs.cb([{ type: 'attributes', attributeName: 'class', target: bodyEl }]);
    }

    assert.equal(shortsSignal?.aborted, true);
    assert.equal(
      overlayObservers.every((o) => o.disconnected),
      true
    );
  });

  test('covers query fallbacks, nested button containers, disjoint ancestors, transport edge cases, and Shorts rAF/DOM fallbacks', async (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevDocument = globals.document;
    const prevFetch = globals.fetch;
    const prevMutationObserver = globals.MutationObserver;
    const prevCssStyleSheet = globals.CSSStyleSheet;
    const prevRaf = globals.requestAnimationFrame;

    const winListeners = new Map<string, Set<() => void>>();
    const observers: Array<{ target: unknown; cb: (m: unknown[]) => void; disconnected: boolean }> = [];
    const rafQueue: Array<() => void> = [];
    const fakeLocation = { hash: '#/watch?v=rydEdge1', search: '' };

    globals.MutationObserver = class {
      private readonly rec: { target: unknown; cb: (m: unknown[]) => void; disconnected: boolean };
      constructor(cb: (m: unknown[]) => void) {
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
    globals.requestAnimationFrame = (cb: () => void) => {
      rafQueue.push(cb);
      return rafQueue.length;
    };

    const makeVoteNode = (hasQueryAll = false) => {
      const attrs = new Map<string, string>();
      return {
        nodeName: 'YT-BUTTON',
        inert: false,
        dataset: {} as Record<string, string>,
        parentElement: null as unknown,
        contains: undefined as ((n: unknown) => boolean) | undefined,
        getAttribute: (n: string) => attrs.get(n) ?? null,
        setAttribute: (n: string, v: string) => attrs.set(n, v),
        hasAttribute: (n: string) => attrs.has(n),
        ...(hasQueryAll
          ? {
              querySelectorAll: () => [
                {
                  hasAttribute: (n: string) => n === 'hybridnavfocusable' || n === 'tabindex',
                  getAttribute: (n: string) => (n === 'hybridnavfocusable' ? 'false' : '-1'),
                  setAttribute: () => {},
                },
              ],
            }
          : {}),
      };
    };

    const outerLike = makeVoteNode(true);
    const innerLike = makeVoteNode(false);
    outerLike.dataset.ttCount = 'stale';
    outerLike.contains = (n: unknown) => n === innerLike;

    const dislikeEl = makeVoteNode(false);
    const ancestorNoContains = { nodeName: 'ANC', parentElement: null as unknown, isConnected: true };
    const watchHost = { nodeName: 'YTLR-WATCH-DEFAULT', isConnected: true };
    outerLike.parentElement = ancestorNoContains;
    innerLike.parentElement = ancestorNoContains;
    dislikeEl.parentElement = ancestorNoContains;

    let useQueryAll = true;
    let tcEl: Record<string, unknown> | null = {
      __instance: {
        unrelated: 123,
        hasButtonsButNoMatch(this: { buttons?: unknown }) {
          return this.buttons;
        },
      },
    };
    let currentWatchHost: unknown = watchHost;
    let currentBody: unknown = { nodeName: 'BODY' };
    let currentDocEl: unknown = { nodeName: 'HTML' };
    const likesList: unknown[] = [outerLike, innerLike];
    const dislikesList: unknown[] = [dislikeEl];
    let singleQueryHit: unknown = null;
    let resolveFetch!: (resp: Response) => void;

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
      get body() {
        return currentBody;
      },
      get documentElement() {
        return currentDocEl;
      },
      adoptedStyleSheets: [],
      querySelector: (sel: string) => {
        if (sel === 'video') return { nodeName: 'VIDEO' };
        if (sel.includes('transport-controls')) return tcEl;
        if (sel === 'ytlr-watch-default') return currentWatchHost;
        return singleQueryHit;
      },
      get querySelectorAll() {
        return useQueryAll
          ? (sel: string) => {
              if (sel.includes('dislike-button')) return dislikesList;
              if (sel.includes('like-button')) return likesList;
              return [];
            }
          : undefined;
      },
    };
    globals.fetch = (() =>
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      })) as typeof fetch;

    // Seed Watch like count before matching Watch session starts, plus guard no-ops.
    setWatchLikeCount(null, '10');
    setWatchLikeCount('rydEdge1', '   ');
    setWatchLikeCount('otherVid', '99');
    setWatchLikeCount('rydEdge1', '42 K');

    const uninstall = installReturnYouTubeDislike();
    t.after(() => {
      uninstall();
      fakeLocation.hash = '#/';
      for (const fn of winListeners.get('hashchange') ?? []) fn();
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
      globals.fetch = prevFetch;
      if (prevMutationObserver === undefined) delete globals.MutationObserver;
      else globals.MutationObserver = prevMutationObserver;
      if (prevCssStyleSheet === undefined) delete globals.CSSStyleSheet;
      else globals.CSSStyleSheet = prevCssStyleSheet;
      if (prevRaf === undefined) delete globals.requestAnimationFrame;
      else globals.requestAnimationFrame = prevRaf;
    });

    // Nested outerLike dropped its stale count, innerLike received '42K', and same-ancestor target skips re-observe.
    assert.equal(outerLike.dataset.ttCount, undefined);
    assert.equal(innerLike.dataset.ttCount, '42K');
    const ancObs = observers.find((o) => o.target === ancestorNoContains);
    assert.ok(ancObs);
    ancObs.cb([]); // desiredTarget === observedTarget && isConnected !== false -> early return!

    // Disconnect ancestor, break at watchHost with disjoint parent, and fall back to watchHost -> body -> documentElement -> null.
    ancestorNoContains.isConnected = false;
    ancestorNoContains.parentElement = watchHost;
    dislikeEl.parentElement = { nodeName: 'OTHER' };
    tcEl = null;
    ancObs.cb([]);

    // Now test body fallback when watchHost = null, then documentElement when body = null, then null when both null.
    currentWatchHost = null;
    useQueryAll = false;
    singleQueryHit = innerLike;
    observers.at(-1)?.cb([]);
    currentBody = null;
    singleQueryHit = null;
    observers.at(-1)?.cb([]);
    currentDocEl = null;
    observers.at(-1)?.cb([]);
    currentBody = { nodeName: 'BODY' };
    currentDocEl = { nodeName: 'HTML' };

    // Aborting session mid-fetch exercises fetch callback's signal.aborted guard + no-dislikes guard.
    fakeLocation.hash = '#/watch?v=rydEdge2';
    for (const fn of winListeners.get('hashchange') ?? []) fn();
    const resolveFirst = resolveFetch;
    fakeLocation.hash = '#/watch?v=rydEdge3';
    for (const fn of winListeners.get('hashchange') ?? []) fn();
    resolveFirst(new Response(JSON.stringify({ dislikes: 5 }), { status: 200 }));
    await new Promise((r) => setTimeout(r, 10));
    resolveFetch(new Response(JSON.stringify({}), { status: 200 }));
    await new Promise((r) => setTimeout(r, 10));

    // Late observer callback on old session hits signal.aborted guard in syncTargetObserverAndLabels.
    ancObs.cb([]);

    // Exercise Shorts null/body=null/documentElement=null/abort-before-rAF paths + transport predicate out-of-range arg.
    const instWithPred = {
      buttons: [outerLike],
      isFocusable(i: number) {
        return this.buttons.length + 3 > i;
      },
    };
    useQueryAll = true;
    tcEl = { __instance: instWithPred };
    fakeLocation.hash = '#/watch?v=rydPred1';
    for (const fn of winListeners.get('hashchange') ?? []) fn();
    assert.equal(instWithPred.isFocusable('bad' as unknown as number), false);
    assert.equal(instWithPred.isFocusable(5), false);
    assert.equal(instWithPred.isFocusable(2), true);

    setShortsOverlayStats(null, '10');
    currentBody = null;
    currentDocEl = null;
    setShortsOverlayStats('shortNoRoot', null);
    rafQueue.shift()?.();
    currentDocEl = { nodeName: 'HTML' };
    setShortsOverlayStats('shortDocEl', '12');
    rafQueue.shift()?.();
    // Repeat updates for same Shorts videoId hit fast update branch with and without new likeCount.
    setShortsOverlayStats('shortDocEl', '14');
    setShortsOverlayStats('shortDocEl', null);
    // Abort rAF-queued attachOverlayObserver before flushing rAF.
    setShortsOverlayStats('shortAbortRaf', '15');
    const abortQueuedRaf = rafQueue.shift();
    fakeLocation.hash = '#/';
    for (const fn of winListeners.get('hashchange') ?? []) fn();
    abortQueuedRaf?.();
    while (rafQueue.length) rafQueue.shift()?.();

    // Calling setShortsOverlayStats twice without document hits typeof document === 'undefined' guards safely.
    delete globals.document;
    setShortsOverlayStats('ssrShort', '7');
    setShortsOverlayStats('ssrShort', '8');
  });

  test('patchShortsActionBarFocusSkip skips inert synthetic Dislike button in both D-pad directions and clamps at boundaries', (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevDocument = globals.document;
    const prevCssStyleSheet = globals.CSSStyleSheet;
    const prevRaf = globals.requestAnimationFrame;

    t.after(() => {
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
      if (prevCssStyleSheet === undefined) delete globals.CSSStyleSheet;
      else globals.CSSStyleSheet = prevCssStyleSheet;
      if (prevRaf === undefined) delete globals.requestAnimationFrame;
      else globals.requestAnimationFrame = prevRaf;
    });

    globals.CSSStyleSheet = class {
      replaceSync(): void {}
    };
    globals.requestAnimationFrame = (cb: () => void) => {
      cb();
      return 1;
    };

    const makeBarItem = (inert: boolean, focusable: string) => ({
      inert,
      dataset: {} as Record<string, string>,
      getAttribute: (name: string) => (name === 'hybridnavfocusable' ? focusable : null),
      hasAttribute: (name: string) => name === 'hybridnavfocusable' || name === 'tabindex',
      setAttribute: () => {},
      querySelectorAll: () => [],
    });

    let barItems = [makeBarItem(false, 'true'), makeBarItem(true, 'false'), makeBarItem(false, 'true')];
    let currentFc: { __instance: { props: { selectedIndex?: unknown; ga?: (idx: number) => void } } } | null = null;
    const initialFcProps: { selectedIndex?: unknown; ga?: (idx: number) => void } = {};
    const barInst: Record<string, unknown> = {
      state: { qQ: 0 },
      unrelated: 42,
      onSelect(idx: number) {
        if (currentFc) {
          currentFc.__instance.props = { selectedIndex: idx, ga: barInst.onSelect as (i: number) => void };
        }
      },
    };
    const origFn = barInst.onSelect as (idx: number) => void;
    initialFcProps.selectedIndex = 0;
    initialFcProps.ga = origFn;

    let currentBar: Record<string, unknown> | null = null;

    globals.document = {
      body: { isConnected: true },
      documentElement: { isConnected: true },
      adoptedStyleSheets: [],
      querySelector: (sel: string) => (sel === 'ytlr-reel-action-bar-view-model' ? currentBar : null),
      querySelectorAll: () => [],
    };

    // 1. Missing bar, missing __instance, missing yt-focus-container, and missing handler match all return cleanly.
    setShortsOverlayStats('shortSkip1', '10K');
    currentBar = { querySelector: () => currentFc, querySelectorAll: () => barItems };
    setShortsOverlayStats('shortSkip1', '11K');
    currentBar.__instance = {};
    setShortsOverlayStats('shortSkip1', '12K');
    currentFc = { __instance: { props: { selectedIndex: 0 } } };
    setShortsOverlayStats('shortSkip1', '13K');

    // 2. Matching barInst handler wraps both barInst and mounted fcProps in place, and tracks replaced props objects across re-renders.
    barInst.onSelect = origFn;
    currentBar.__instance = barInst;
    currentFc = { __instance: { props: initialFcProps } };
    setShortsOverlayStats('shortSkip1', '14K');

    const wrappedHandler = barInst.onSelect as (idx: number) => void;
    assert.notEqual(wrappedHandler, origFn);
    assert.equal(initialFcProps.ga, wrappedHandler);

    // Stepping right from Like (0 -> 1) via initial fcProps skips inert Dislike (1), lands on Comments (2), and replaces fcProps.
    initialFcProps.ga?.(1);
    assert.equal(currentFc.__instance.props.selectedIndex, 2);
    assert.notEqual(currentFc.__instance.props, initialFcProps);

    // Stepping left from Comments (2 -> 1) reads the NEW live fcProps (selectedIndex: 2), skips inert Dislike (1), and returns to Like (0).
    currentFc.__instance.props.ga?.(1);
    assert.equal(currentFc.__instance.props.selectedIndex, 0);

    // Missing numeric selectedIndex (and null liveFc) defaults prevIdx to 0; out-of-bounds inert ends clamp cleanly back to prevIdx.
    currentFc.__instance.props = { selectedIndex: undefined, ga: wrappedHandler };
    barItems = [makeBarItem(false, 'false'), makeBarItem(true, 'true'), makeBarItem(false, 'false')];
    wrappedHandler(1); // steps +1 past end -> clamps back to prevIdx 0
    assert.equal(currentFc.__instance.props.selectedIndex, 0);

    currentFc.__instance.props = { selectedIndex: 2, ga: wrappedHandler };
    wrappedHandler(1); // steps -1 past index 0 -> clamps back to prevIdx 2
    assert.equal(currentFc.__instance.props.selectedIndex, 2);

    const savedFc = currentFc;
    currentFc = null;
    wrappedHandler(1); // liveFc is null -> prevIdx defaults to 0
    currentFc = savedFc;

    // Re-running applyShortsOverlayLabels skips already-patched barInst without double-wrapping.
    setShortsOverlayStats('shortSkip1', '15K');
    assert.equal(barInst.onSelect, wrappedHandler);
  });
});
