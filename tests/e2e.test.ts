import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, type TestContext, test } from 'node:test';
import vm from 'node:vm';

const BUNDLE_PATH = path.resolve(import.meta.dirname, '..', 'mods', 'dist', 'userscript.js');

interface MockMutationRecord {
  type: 'attributes' | 'childList';
  target: MockElement;
  attributeName: string | null;
  addedNodes: MockElement[];
  removedNodes: MockElement[];
}

type MockMutateHook = (record: MockMutationRecord) => void;

interface MockElement {
  tagName: string;
  nodeName: string;
  nodeType: number;
  id: string;
  className: string;
  classList: {
    add: (...cls: string[]) => void;
    remove: (...cls: string[]) => void;
    toggle: (cls: string, force?: boolean) => boolean;
    contains: (cls: string) => boolean;
    [Symbol.iterator]: () => IterableIterator<string>;
  };
  style: Record<string, string> & { setProperty: (k: string, v: string) => void };
  dataset: Record<string, string>;
  attributes: Record<string, string>;
  children: MockElement[];
  childNodes: MockElement[];
  parentElement: MockElement | null;
  parentNode: MockElement | null;
  textContent: string;
  nodeValue?: string;
  nonce?: string;
  rel?: string;
  href?: string;
  crossOrigin?: string;
  isConnected: boolean;
  addEventListener: (
    type: string,
    fn: (ev?: unknown) => void,
    options?: boolean | { once?: boolean; signal?: AbortSignal }
  ) => void;
  removeEventListener: (type: string, fn: (ev?: unknown) => void) => void;
  dispatchEvent: (ev: { type: string; target?: unknown }) => boolean;
  appendChild: (child: MockElement) => MockElement;
  replaceChildren: (...children: MockElement[]) => void;
  querySelector: (selector: string) => MockElement | null;
  querySelectorAll: (selector: string) => MockElement[];
  getAttribute: (name: string) => string | null;
  setAttribute: (name: string, value: string) => void;
  removeAttribute: (name: string) => void;
  getBoundingClientRect: () => { top: number; bottom: number; height: number };
  closest: (selector: string) => MockElement | null;
  remove: () => void;
  duration?: number;
  currentTime?: number;
  playbackRate?: number;
  videoWidth?: number;
  videoHeight?: number;
  paused?: boolean;
  ended?: boolean;
  readyState?: number;
  currentSrc?: string;
  src?: string;
}

function createEventRegistry(getTarget?: () => unknown) {
  const listeners = new Map<string, Set<(ev?: unknown) => void>>();
  return {
    addEventListener(
      type: string,
      fn: (ev?: unknown) => void,
      options?: boolean | { once?: boolean; signal?: AbortSignal }
    ): void {
      const opts = typeof options === 'object' ? options : undefined;
      if (opts?.signal?.aborted) return;
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      const wrapped = opts?.once
        ? (ev?: unknown) => {
            set?.delete(wrapped);
            fn(ev);
          }
        : fn;
      set.add(wrapped);
      opts?.signal?.addEventListener('abort', () => set.delete(wrapped), { once: true });
    },
    removeEventListener(type: string, fn: (ev?: unknown) => void): void {
      listeners.get(type)?.delete(fn);
    },
    dispatchEvent(ev: { type: string; target?: unknown }): boolean {
      const target = getTarget?.();
      const payload = target !== undefined ? { ...ev, target: ev.target ?? target } : ev;
      for (const fn of [...(listeners.get(ev.type) ?? [])]) fn(payload);
      return true;
    },
  };
}

function createMockElement(
  tagName: string,
  docRef: { root: MockElement | null },
  onMutate?: MockMutateHook
): MockElement {
  const classes = new Set<string>();
  const events = createEventRegistry(() => el);
  const attrs: Record<string, string> = {};
  const styleObj: Record<string, unknown> = {
    setProperty: (k: string, v: string) => {
      styleObj[k] = v;
    },
  };

  const matchesSimple = (node: MockElement, sel: string): boolean => {
    const s = sel.trim();
    if (!s) return false;
    if (s === 'div') return node.tagName === 'DIV';
    if (s === 'video') return node.tagName === 'VIDEO';
    if (s === 'div[idomkey="slider"]') return node.tagName === 'DIV' && node.attributes.idomkey === 'slider';
    if (s === 'ytlr-progress-bar') return node.tagName === 'YTLR-PROGRESS-BAR';
    if (s === 'ytlr-watch-default') return node.tagName === 'YTLR-WATCH-DEFAULT';
    if (s === 'ytlr-redux-connect-ytlr-progress-bar') {
      return node.tagName === 'YTLR-REDUX-CONNECT-YTLR-PROGRESS-BAR';
    }
    if (s === 'ytlr-reel-player-overlay-renderer') return node.tagName === 'YTLR-REEL-PLAYER-OVERLAY-RENDERER';
    if (s === 'ytlr-toggle-button-view-model') return node.tagName === 'YTLR-TOGGLE-BUTTON-VIEW-MODEL';
    if (s === 'ytlr-tile-renderer') return node.tagName === 'YTLR-TILE-RENDERER';
    if (s === 'ytlr-thumbnail-details') return node.tagName === 'YTLR-THUMBNAIL-DETAILS';
    if (s === 'ytlr-tile-metadata-renderer') return node.tagName === 'YTLR-TILE-METADATA-RENDERER';
    if (s.includes('[aria-label="Dislike"]')) return node.attributes['aria-label'] === 'Dislike';
    if (s.includes('[idomkey="title"]')) return node.attributes.idomkey === 'title';
    if (s.includes('[idomkey="elapsedTime"]')) return node.attributes.idomkey === 'elapsedTime';
    if (s.includes('[idomkey="duration"]')) return node.attributes.idomkey === 'duration';
    if (s.includes('[idomkey="dislike-button"]')) return node.attributes.idomkey === 'dislike-button';
    if (s.includes('[idomkey="like-button"]')) return node.attributes.idomkey === 'like-button';
    if (s.startsWith('link[rel="preconnect"]')) {
      return node.tagName === 'LINK' && s.includes(`href="${node.href}"`);
    }
    return false;
  };

  const matchesSelector = (node: MockElement, sel: string): boolean => {
    const parts = sel.trim().split(/\s+/);
    const leaf = parts.at(-1);
    if (!leaf || !matchesSimple(node, leaf)) return false;
    let cur = node.parentElement;
    for (let i = parts.length - 2; i >= 0; i--) {
      const ancestorSel = parts[i] ?? '';
      while (cur && !matchesSimple(cur, ancestorSel)) {
        cur = cur.parentElement;
      }
      if (!cur) return false;
      cur = cur.parentElement;
    }
    return true;
  };

  const setConnectedRecursive = (node: MockElement, connected: boolean): void => {
    node.isConnected = connected;
    for (const c of node.children) setConnectedRecursive(c, connected);
  };

  const emitAttr = (attributeName: string): void => {
    onMutate?.({ type: 'attributes', target: el, attributeName, addedNodes: [], removedNodes: [] });
  };

  const el: MockElement = {
    tagName: tagName.toUpperCase(),
    nodeName: tagName.toUpperCase(),
    nodeType: 1,
    id: '',
    get className() {
      return [...classes].join(' ');
    },
    set className(val: string) {
      classes.clear();
      for (const c of val.split(/\s+/).filter(Boolean)) classes.add(c);
      emitAttr('class');
    },
    classList: {
      add: (...cls: string[]) => {
        for (const c of cls) classes.add(c);
        emitAttr('class');
      },
      remove: (...cls: string[]) => {
        for (const c of cls) classes.delete(c);
        emitAttr('class');
      },
      toggle: (cls: string, force?: boolean) => {
        const shouldAdd = force ?? !classes.has(cls);
        if (shouldAdd) classes.add(cls);
        else classes.delete(cls);
        emitAttr('class');
        return shouldAdd;
      },
      contains: (cls: string) => classes.has(cls),
      [Symbol.iterator]: () => classes.values(),
    },
    style: styleObj as MockElement['style'],
    dataset: {},
    attributes: attrs,
    children: [],
    childNodes: [],
    parentElement: null,
    parentNode: null,
    textContent: '',
    isConnected: true,
    addEventListener: events.addEventListener,
    removeEventListener: events.removeEventListener,
    dispatchEvent: events.dispatchEvent,
    appendChild: (child: MockElement) => {
      child.parentElement = el;
      child.parentNode = el;
      setConnectedRecursive(child, el.isConnected);
      el.children.push(child);
      el.childNodes.push(child);
      onMutate?.({ type: 'childList', target: el, attributeName: null, addedNodes: [child], removedNodes: [] });
      return child;
    },
    replaceChildren: (...children: MockElement[]) => {
      const removedNodes = [...el.children];
      for (const oldChild of removedNodes) {
        oldChild.parentElement = null;
        oldChild.parentNode = null;
        setConnectedRecursive(oldChild, false);
      }
      el.children.length = 0;
      el.childNodes.length = 0;
      for (const child of children) {
        child.parentElement = el;
        child.parentNode = el;
        setConnectedRecursive(child, el.isConnected);
        el.children.push(child);
        el.childNodes.push(child);
      }
      onMutate?.({ type: 'childList', target: el, attributeName: null, addedNodes: children, removedNodes });
    },
    querySelector: (selector: string) => el.querySelectorAll(selector)[0] ?? null,
    querySelectorAll: (selector: string) => {
      const results: MockElement[] = [];
      const selectors = selector.split(',').map((s) => s.trim());
      const walk = (node: MockElement): void => {
        for (const s of selectors) {
          if (matchesSelector(node, s)) {
            results.push(node);
            break;
          }
        }
        for (const child of node.children) walk(child);
      };
      const start = el === docRef.root ? el : el;
      walk(start);
      return results;
    },
    getAttribute: (name: string) => (name === 'class' ? el.className : (attrs[name] ?? null)),
    setAttribute: (name: string, value: string) => {
      if (name === 'class') {
        el.className = value;
        return;
      }
      attrs[name] = value;
      emitAttr(name);
    },
    removeAttribute: (name: string) => {
      delete attrs[name];
      emitAttr(name);
    },
    getBoundingClientRect: () => ({ top: 10, bottom: 20, height: 10 }),
    closest: (selector: string) => {
      let cur: MockElement | null = el;
      while (cur) {
        if (matchesSimple(cur, selector)) return cur;
        cur = cur.parentElement;
      }
      return null;
    },
    remove: () => {
      const parent = el.parentElement;
      if (parent) {
        const idx = parent.children.indexOf(el);
        if (idx !== -1) parent.children.splice(idx, 1);
        const cIdx = parent.childNodes.indexOf(el);
        if (cIdx !== -1) parent.childNodes.splice(cIdx, 1);
      }
      el.parentElement = null;
      el.parentNode = null;
      setConnectedRecursive(el, false);
      if (parent) {
        onMutate?.({ type: 'childList', target: parent, attributeName: null, addedNodes: [], removedNodes: [el] });
      }
    },
  };
  return el;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      return;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface TrackedObserver {
  target: unknown;
  options?: MutationObserverInit;
  cb: (mutations: MockMutationRecord[], observer: unknown) => void;
  disconnected: boolean;
}

function createE2EHarness(t: TestContext) {
  const activeTimers = new Set<ReturnType<typeof setTimeout>>();
  t.after(() => {
    for (const id of activeTimers) clearTimeout(id);
  });
  const bundleSource = fs.readFileSync(BUNDLE_PATH, 'utf8');

  const windowEvents = createEventRegistry();
  const docEvents = createEventRegistry();
  const observers: TrackedObserver[] = [];
  const fetchCalls: Array<{ url: string; body?: string }> = [];
  const xhrCalls: Array<{ body: unknown }> = [];
  const resolvedCommands: unknown[] = [];
  const executedActions: string[] = [];
  const pressureListeners: Array<() => void> = [];
  const localStorageMap = new Map<string, string>([
    [
      'yt.leanback.default::recurring_actions',
      JSON.stringify({
        data: {
          data: {
            'startup-screen-account-selector-with-guest': { lastFired: 0 },
            whos_watching_fullscreen_zero_accounts: { lastFired: 0 },
            'startup-screen-signed-out-welcome-back': { lastFired: 0 },
          },
        },
      }),
    ],
  ]);

  const docRef: { root: MockElement | null } = { root: null };

  const isDescendant = (node: MockElement, ancestor: unknown): boolean => {
    let cur: MockElement | null = node;
    while (cur) {
      if (cur === ancestor) return true;
      cur = cur.parentElement;
    }
    return false;
  };

  const matchesObserver = (obs: TrackedObserver, rec: MockMutationRecord): boolean => {
    if (obs.disconnected) return false;
    const targetMatch =
      obs.target === rec.target || Boolean(obs.options?.subtree && isDescendant(rec.target, obs.target));
    if (!targetMatch) return false;
    if (rec.type === 'childList') {
      return obs.options?.childList !== false;
    }
    if (obs.options?.attributes === false) return false;
    const filter = obs.options?.attributeFilter;
    return !filter || (rec.attributeName !== null && filter.includes(rec.attributeName));
  };

  const pendingRecords: MockMutationRecord[] = [];
  let flushQueued = false;
  const flushMutations = (): void => {
    flushQueued = false;
    const batch = pendingRecords.splice(0);
    if (batch.length === 0) return;
    for (const obs of [...observers]) {
      const matched = batch.filter((rec) => matchesObserver(obs, rec));
      if (matched.length > 0) {
        obs.cb(matched, obs);
      }
    }
  };
  const onMutate: MockMutateHook = (record) => {
    pendingRecords.push(record);
    if (!flushQueued) {
      flushQueued = true;
      queueMicrotask(flushMutations);
    }
  };

  const createEl = (tag: string): MockElement => createMockElement(tag, docRef, onMutate);

  const fakeDocument: Record<string, unknown> = {
    readyState: 'loading',
    hidden: false,
    body: null,
    head: null,
    documentElement: null,
    adoptedStyleSheets: [],
    createElement: createEl,
    querySelector: (sel: string) => {
      if (!docRef.root) return null;
      if (sel.startsWith('#')) {
        const targetId = sel.slice(1);
        const findById = (n: MockElement): MockElement | null => {
          if (n.id === targetId) return n;
          for (const c of n.children) {
            const hit = findById(c);
            if (hit) return hit;
          }
          return null;
        };
        return findById(docRef.root);
      }
      return docRef.root.querySelector(sel);
    },
    querySelectorAll: (sel: string) => (docRef.root ? docRef.root.querySelectorAll(sel) : []),
    getElementById: (id: string) => {
      if (!docRef.root) return null;
      const walk = (n: MockElement): MockElement | null => {
        if (n.id === id) return n;
        for (const c of n.children) {
          const hit = walk(c);
          if (hit) return hit;
        }
        return null;
      };
      return walk(docRef.root);
    },
    addEventListener: docEvents.addEventListener,
    removeEventListener: docEvents.removeEventListener,
    dispatchEvent: docEvents.dispatchEvent,
  };

  class MockResponse {
    readonly status: number;
    readonly ok: boolean;
    readonly url: string;
    private readonly rawBody: string;
    constructor(body: string | null, init?: { status?: number; url?: string }) {
      this.rawBody = body ?? '';
      this.status = init?.status ?? 200;
      this.ok = this.status >= 200 && this.status < 300;
      this.url = init?.url ?? '';
    }
    async text(): Promise<string> {
      return this.rawBody;
    }
    async json(): Promise<unknown> {
      return JSON.parse(this.rawBody);
    }
    clone(): MockResponse {
      return new MockResponse(this.rawBody, { status: this.status, url: this.url });
    }
  }

  const mockFetch = async (resource: unknown, init?: { body?: string }) => {
    const url = typeof resource === 'string' ? resource : String(resource);
    fetchCalls.push({ url, body: init?.body });
    if (url.includes('returnyoutubedislikeapi.com')) {
      return new MockResponse(JSON.stringify({ likes: 5000, dislikes: 120 }), { status: 200, url });
    }
    if (url.includes('sponsor.ajay.app/api/skipSegments')) {
      return new MockResponse(
        JSON.stringify([
          {
            videoID: 'e2eVid123',
            segments: [{ UUID: 'seg1', category: 'sponsor', segment: [10, 25] }],
          },
        ]),
        { status: 200, url }
      );
    }
    if (url.includes('/youtubei/v1/browse')) {
      return new MockResponse(
        JSON.stringify({
          contents: {
            tvBrowseRenderer: {
              content: {
                tvSurfaceContentRenderer: {
                  content: {
                    sectionListRenderer: {
                      contents: [
                        { feedNudgeRenderer: {} },
                        {
                          shelfRenderer: {
                            content: {
                              horizontalListRenderer: {
                                items: [
                                  { adSlotRenderer: {} },
                                  {
                                    tileRenderer: {
                                      contentId: 'homeVid1',
                                      style: 'TILE_STYLE_YTLR_DEFAULT',
                                      onSelectCommand: { watchEndpoint: { videoId: 'homeVid1' } },
                                      header: {
                                        tileHeaderRenderer: {
                                          thumbnail: {
                                            thumbnails: [
                                              { url: 'https://i.ytimg.com/vi/homeVid1/hqdefault.jpg', width: 480 },
                                            ],
                                          },
                                        },
                                      },
                                    },
                                  },
                                ],
                              },
                            },
                          },
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
        }),
        { status: 200, url }
      );
    }
    return new MockResponse(null, { status: 204, url });
  };

  class MockXMLHttpRequest {
    send(body?: unknown): void {
      xhrCalls.push({ body });
    }
  }

  const fakeLocation = { hash: '#/', href: 'https://www.youtube.com/tv#/' };
  const fakeLocalStorage = {
    getItem: (k: string) => localStorageMap.get(k) ?? null,
    setItem: (k: string, v: string) => localStorageMap.set(k, v),
  };

  const fakeWindow: Record<string, unknown> = {
    location: fakeLocation,
    localStorage: fakeLocalStorage,
    fetch: mockFetch,
    requestAnimationFrame: (cb: () => void) => {
      cb();
      return 1;
    },
    requestIdleCallback: (cb: () => void) => {
      cb();
      return 1;
    },
    addEventListener: windowEvents.addEventListener,
    removeEventListener: windowEvents.removeEventListener,
    dispatchEvent: windowEvents.dispatchEvent,
    h5vcc: {
      system: {
        onMemoryPressure: {
          addListener: (cb: () => void) => pressureListeners.push(cb),
        },
      },
    },
  };

  class MockCSSStyleSheet {
    cssText = '';
    replaceSync(text: string): void {
      this.cssText = text;
    }
  }

  class MockMutationObserver {
    private readonly entry: TrackedObserver;
    constructor(cb: (mutations: MockMutationRecord[], observer: unknown) => void) {
      this.entry = { target: null, cb, disconnected: false };
    }
    observe(target: unknown, options?: MutationObserverInit): void {
      this.entry.target = target;
      this.entry.options = options;
      this.entry.disconnected = false;
      if (!observers.includes(this.entry)) {
        observers.push(this.entry);
      }
    }
    disconnect(): void {
      this.entry.disconnected = true;
    }
  }

  function MockDocument(): void {}
  MockDocument.prototype.createElement = fakeDocument.createElement;
  delete fakeDocument.createElement;
  Object.setPrototypeOf(fakeDocument, MockDocument.prototype);

  const sandbox: Record<string, unknown> = {
    window: fakeWindow,
    document: fakeDocument,
    Document: MockDocument,
    queueMicrotask,
    location: fakeLocation,
    localStorage: fakeLocalStorage,
    fetch: mockFetch,
    Response: MockResponse,
    Map: globalThis.Map,
    Set: globalThis.Set,
    WeakSet: globalThis.WeakSet,
    XMLHttpRequest: MockXMLHttpRequest,
    CSSStyleSheet: MockCSSStyleSheet,
    MutationObserver: MockMutationObserver,
    CustomEvent: globalThis.CustomEvent,
    EventTarget,
    KeyboardEvent: class {
      readonly type: string;
      constructor(type: string) {
        this.type = type;
      }
    },
    getComputedStyle: () => ({ fontFamily: 'Roboto', color: '#ffffff' }),
    requestAnimationFrame: fakeWindow.requestAnimationFrame,
    requestIdleCallback: fakeWindow.requestIdleCallback,
    JSON: { parse: JSON.parse, stringify: JSON.stringify },
    console,
    setTimeout: (fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const id = setTimeout(() => {
        activeTimers.delete(id);
        fn(...args);
      }, ms);
      activeTimers.add(id);
      return id;
    },
    clearTimeout: (id: ReturnType<typeof setTimeout>) => {
      activeTimers.delete(id);
      clearTimeout(id);
    },
    setInterval: () => 1,
    clearInterval,
    URL,
    URLSearchParams,
    TextEncoder,
    AbortController,
    DOMException,
    crypto: globalThis.crypto,
  };
  fakeWindow.document = fakeDocument;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);

  return {
    bundleSource,
    sandbox,
    context,
    fakeWindow,
    fakeDocument,
    fakeLocation,
    localStorageMap,
    docRef,
    observers,
    fetchCalls,
    xhrCalls,
    resolvedCommands,
    executedActions,
    pressureListeners,
    createEl,
    flushMutations,
    MockXMLHttpRequest,
  };
}

describe('End-to-end userscript bundle lifecycle', () => {
  test('executes bundled userscript from document-start through Home feeds, Settings, Watch overlays, and cleanup', async (t) => {
    const {
      bundleSource,
      sandbox,
      context,
      fakeWindow,
      fakeDocument,
      fakeLocation,
      localStorageMap,
      docRef,
      observers,
      fetchCalls,
      xhrCalls,
      resolvedCommands,
      executedActions,
      pressureListeners,
      createEl,
      MockXMLHttpRequest,
    } = createE2EHarness(t);

    // 1. Run bundled userscript at true document-start (null body/head/_yttv)
    assert.doesNotThrow(() => vm.runInContext(bundleSource, context));
    assert.equal(pressureListeners.length, 1);

    // YouTube inline shell config scripts run after document-start and must receive HD storyboard flags.
    vm.runInContext(
      `
      window.environment = { enable_animation: false, enable_memory_saving_mode: true };
      window.ytcfg = {
        data_: {},
        d: function() { return this.data_; },
        set: function(obj) { Object.assign(this.data_, obj); }
      };
      window.ytcfg.set({ EXPERIMENT_FLAGS: { web_l3_storyboard: false, force_memory_saving_mode: true } });
      window.tectonicConfig = { featureSwitches: { enableHdStoryboardThumbnails: false } };
      `,
      context
    );
    assert.equal((fakeWindow.environment as { enable_animation?: boolean }).enable_animation, true);
    assert.equal(
      (
        fakeWindow.ytcfg as {
          data_: { EXPERIMENT_FLAGS: { web_l3_storyboard?: boolean; force_full_animation?: boolean } };
        }
      ).data_.EXPERIMENT_FLAGS.web_l3_storyboard,
      true
    );
    assert.equal(
      (
        fakeWindow.ytcfg as {
          data_: { EXPERIMENT_FLAGS: { force_full_animation?: boolean } };
        }
      ).data_.EXPERIMENT_FLAGS.force_full_animation,
      true
    );
    assert.equal(
      (fakeWindow.tectonicConfig as { featureSwitches: { enableHdStoryboardThumbnails?: boolean } }).featureSwitches
        .enableHdStoryboardThumbnails,
      true
    );

    // 2. Mount DOM + fire DOMContentLoaded
    const htmlEl = createEl('html');
    const headEl = createEl('head');
    const bodyEl = createEl('body');
    htmlEl.appendChild(headEl);
    htmlEl.appendChild(bodyEl);
    docRef.root = htmlEl;
    fakeDocument.documentElement = htmlEl;
    fakeDocument.head = headEl;
    fakeDocument.body = bodyEl;
    fakeDocument.readyState = 'complete';
    (fakeDocument.dispatchEvent as (e: { type: string }) => void)({ type: 'DOMContentLoaded' });

    await waitFor(
      () =>
        Boolean((fakeDocument.getElementById as (id: string) => MockElement | null)('custom-clock')) &&
        headEl.children.filter((c) => c.tagName === 'LINK' && c.rel === 'preconnect').length === 2
    );

    // Clock & preconnect hints should now be installed.
    const clockEl = (fakeDocument.getElementById as (id: string) => MockElement | null)('custom-clock');
    assert.ok(clockEl, 'Clock element mounted after DOM ready');
    assert.equal(headEl.children.filter((c) => c.tagName === 'LINK' && c.rel === 'preconnect').length, 2);

    // 3. Initialize mock window._yttv and notify observers
    const flagsMap = new Map<string, unknown>([['ENABLE_PREVIEWS_WITH_SOUND', false]]);
    const yttvJsonParse = (s: string) => JSON.parse(s);
    // Real YouTube TV exports Closure singleton constructors (`typeof entry === 'function'`) on `window._yttv`.
    function resolveHost(): void {}
    resolveHost.instance = {
      resolveCommand: (cmd: unknown) => {
        resolvedCommands.push(cmd);
        return true;
      },
    };
    function ActionFn(this: { actionName: string }, actionName: string) {
      this.actionName = actionName;
    }
    class ExecutorInstance {
      runAction(action: { actionName: string }): void {
        // Includes literal marker matched by yttv-bridge.ts
        void 'ytlrActionRouter';
        executedActions.push(action.actionName);
      }
    }
    function executorHost(): void {}
    executorHost.getInstance = () => new ExecutorInstance();
    fakeWindow._yttv = {
      flagsMap,
      resolveHost,
      ActionFn,
      executorHost,
      yttvMod: { JSON: { parse: yttvJsonParse, stringify: JSON.stringify } },
    };
    for (const obs of observers.filter((o) => !o.disconnected)) obs.cb([], obs);
    await waitFor(
      () =>
        flagsMap.get('ENABLE_PREVIEWS_WITH_SOUND') === true &&
        executedActions.includes('reloadGuideAction') &&
        resolvedCommands.some(
          (c) => (c as { browseEndpoint?: { browseId?: string } }).browseEndpoint?.browseId === 'FEtopics'
        )
    );

    assert.equal(flagsMap.get('ENABLE_PREVIEWS_WITH_SOUND'), true);
    assert.ok(executedActions.includes('reloadGuideAction'));
    assert.ok(
      resolvedCommands.some(
        (c) => (c as { browseEndpoint?: { browseId?: string } }).browseEndpoint?.browseId === 'FEtopics'
      ),
      'launchToOnStartup dispatched cleanly when on Home'
    );

    // disable-whos-watching should have pushed localStorage timestamps 7 days into the future.
    const updatedRecurring = JSON.parse(localStorageMap.get('yt.leanback.default::recurring_actions') || '{}');
    assert.ok(
      updatedRecurring.data.data['startup-screen-account-selector-with-guest'].lastFired > Date.now() + 5 * 86400_000
    );

    // 4. Test JSON.parse (Guide) and Response.prototype.json (Home Browse)
    const vmJson = sandbox.JSON as typeof JSON;
    const guideParsed = vmJson.parse(
      JSON.stringify({
        items: [
          {
            guideSectionRenderer: {
              items: [
                { guideEntryRenderer: { navigationEndpoint: { browseEndpoint: { browseId: 'FEtopics_music' } } } },
                { guideEntryRenderer: { navigationEndpoint: { browseEndpoint: { browseId: 'FEtopics' } } } },
                { guideEntryRenderer: { navigationEndpoint: { searchEndpoint: {} } } },
              ],
            },
          },
        ],
      })
    ) as { items: Array<{ guideSectionRenderer: { items: unknown[]; originalItems: unknown[] } }> };
    assert.equal(guideParsed.items[0]?.guideSectionRenderer.originalItems.length, 3);
    // 'FEtopics_music' is in default disabledSidebarContents; 'search' and 'FEtopics' remain ordered.
    assert.equal(guideParsed.items[0]?.guideSectionRenderer.items.length, 2);

    const browseRes = await (fakeWindow.fetch as typeof fetch)('https://www.youtube.com/youtubei/v1/browse', {
      body: JSON.stringify({ playbackContext: { contentPlaybackContext: { vis: 0 } } }),
    });
    const sentFetch = fetchCalls.find((c) => c.url.includes('/browse'));
    assert.equal(JSON.parse(sentFetch?.body || '{}').playbackContext.contentPlaybackContext.isInlinePlaybackNoAd, true);

    const xhr = new (sandbox.XMLHttpRequest as typeof MockXMLHttpRequest)();
    xhr.send(JSON.stringify({ playbackContext: { contentPlaybackContext: { vis: 0 } } }));
    assert.equal(
      JSON.parse(String(xhrCalls[0]?.body)).playbackContext.contentPlaybackContext.isInlinePlaybackNoAd,
      true
    );

    const browseJson = (await browseRes.json()) as {
      contents: {
        tvBrowseRenderer: {
          content: {
            tvSurfaceContentRenderer: {
              content: {
                sectionListRenderer: {
                  contents: Array<{
                    shelfRenderer: {
                      content: {
                        horizontalListRenderer: {
                          items: Array<{
                            tileRenderer: {
                              onFocusCommand: { startInlinePlaybackCommand?: unknown };
                              header: {
                                tileHeaderRenderer: {
                                  thumbnail: { thumbnails: Array<{ url: string }> };
                                };
                              };
                            };
                          }>;
                        };
                      };
                    };
                  }>;
                };
              };
            };
          };
        };
      };
    };
    const shelfItems =
      browseJson.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content.sectionListRenderer.contents[0]
        ?.shelfRenderer.content.horizontalListRenderer.items;
    assert.equal(shelfItems?.length, 1);
    assert.ok(shelfItems?.[0]?.tileRenderer.onFocusCommand.startInlinePlaybackCommand);
    assert.equal(
      shelfItems?.[0]?.tileRenderer.header.tileHeaderRenderer.thumbnail.thumbnails[0]?.url,
      'https://i.ytimg.com/vi/homeVid1/hq720.jpg'
    );

    // T2: Exercise fetch -> clone().json() and Response.text() -> _yttv.JSON.parse() single-transform parity.
    const browseTextRes = await (fakeWindow.fetch as typeof fetch)('https://www.youtube.com/youtubei/v1/browse');
    const clonedBrowseJson = (await browseTextRes.clone().json()) as typeof browseJson;
    assert.equal(
      clonedBrowseJson.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content.sectionListRenderer
        .contents[0]?.shelfRenderer.content.horizontalListRenderer.items[0]?.tileRenderer.header.tileHeaderRenderer
        .thumbnail.thumbnails.length,
      2
    );
    const yttvParsedFromText = (fakeWindow._yttv as { yttvMod: { JSON: typeof JSON } }).yttvMod.JSON.parse(
      await browseTextRes.text()
    ) as typeof browseJson;
    const textShelfItems =
      yttvParsedFromText.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content.sectionListRenderer
        .contents[0]?.shelfRenderer.content.horizontalListRenderer.items;
    assert.equal(textShelfItems?.length, 1);
    assert.equal(
      textShelfItems?.[0]?.tileRenderer.header.tileHeaderRenderer.thumbnail.thumbnails.length,
      2,
      'Response.text() -> _yttv JSON.parse transforms once without duplicate hq720 entries'
    );

    // 5. Test resolveCommand user actions (late host patching via action key, speed menu, captions auto-translate)
    resolvedCommands.length = 0;

    // Late-loaded _yttv command host (registered after startup) must still be patched via action key
    const lateResolvedCommands: unknown[] = [];
    const lateHost = {
      instance: {
        resolveCommand: (cmd: unknown) => {
          lateResolvedCommands.push(cmd);
          return true;
        },
      },
    };
    (fakeWindow._yttv as Record<string, unknown>).lateSettingsHost = lateHost;
    (fakeDocument.dispatchEvent as (e: { type: string; key?: string; keyCode?: number }) => void)({
      type: 'keydown',
      key: 'Enter',
      keyCode: 13,
    });
    lateHost.instance.resolveCommand({ customAction: { action: 'TT_SPEED_SETTINGS_SHOW', parameters: [] } });
    assert.equal(
      (lateResolvedCommands.at(-1) as { openPopupAction?: { uniqueId?: string } })?.openPopupAction?.uniqueId,
      'tt-speed'
    );

    // Non-string customAction must fall through cleanly rather than recursing infinitely.
    assert.doesNotThrow(() => resolveHost.instance.resolveCommand({ customAction: { action: 123 } }));

    const playbackCmd: {
      openPopupAction: {
        uniqueId: string;
        popup: {
          overlaySectionRenderer: {
            overlay: {
              overlayTwoPanelRenderer: {
                actionPanel: {
                  overlayPanelRenderer: {
                    content: {
                      overlayPanelItemListRenderer: {
                        items: Array<{
                          compactLinkRenderer: {
                            title?: { simpleText?: string; runs?: Array<{ text?: string }> };
                            icon: { iconType: string };
                            subtitle?: { simpleText: string };
                            serviceEndpoint?: {
                              signalAction?: { signal?: string; customAction?: { action?: string } };
                              getReportVideoFormEndpoint?: Record<string, unknown>;
                              sendFeedbackEndpoint?: Record<string, unknown>;
                            };
                          };
                        }>;
                      };
                    };
                  };
                };
              };
            };
          };
        };
      };
    } = {
      openPopupAction: {
        uniqueId: 'playback-settings',
        popup: {
          overlaySectionRenderer: {
            overlay: {
              overlayTwoPanelRenderer: {
                actionPanel: {
                  overlayPanelRenderer: {
                    content: {
                      overlayPanelItemListRenderer: {
                        items: [
                          {
                            compactLinkRenderer: {
                              title: { simpleText: 'Playback speed' },
                              icon: { iconType: 'SPEEDOMETER' },
                              subtitle: { simpleText: 'Normal' },
                            },
                          },
                          {
                            compactLinkRenderer: {
                              title: { simpleText: 'Report' },
                              icon: { iconType: 'FLAG' },
                              serviceEndpoint: { getReportVideoFormEndpoint: {} },
                            },
                          },
                          {
                            compactLinkRenderer: {
                              title: { simpleText: 'Send feedback' },
                              icon: { iconType: 'FEEDBACK' },
                              serviceEndpoint: { sendFeedbackEndpoint: {} },
                            },
                          },
                          {
                            compactLinkRenderer: {
                              title: { runs: [{ text: 'Stats for nerds' }] },
                              icon: { iconType: 'BUG_REPORT' },
                              serviceEndpoint: { signalAction: { signal: 'TOGGLE_VIDEO_INFO' } },
                            },
                          },
                        ],
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    resolveHost.instance.resolveCommand(playbackCmd);
    const playbackItems =
      playbackCmd.openPopupAction.popup.overlaySectionRenderer.overlay.overlayTwoPanelRenderer.actionPanel
        .overlayPanelRenderer.content.overlayPanelItemListRenderer.items;
    assert.equal(playbackItems.length, 2);
    assert.equal(playbackItems[0]?.compactLinkRenderer.subtitle?.simpleText, '1x');
    assert.equal(
      playbackItems[0]?.compactLinkRenderer.serviceEndpoint?.signalAction?.customAction?.action,
      'TT_SPEED_SETTINGS_SHOW'
    );
    assert.equal(playbackItems[1]?.compactLinkRenderer.icon?.iconType, 'BUG_REPORT');

    // 6. Navigate to watch page & mount player DOM -> verify Clock End Time, Remaining Time, RYD badges, SponsorBlock, Rewind
    const watchDefault = createEl('ytlr-watch-default');
    const progressBar = createEl('ytlr-progress-bar');
    const elapsedEl = createEl('span');
    elapsedEl.attributes.idomkey = 'elapsedTime';
    elapsedEl.textContent = '0:30';
    const durationEl = createEl('span');
    durationEl.attributes.idomkey = 'duration';
    durationEl.textContent = '2:00';
    progressBar.appendChild(elapsedEl);
    progressBar.appendChild(durationEl);

    const likeBtn = createEl('yt-button-container');
    likeBtn.attributes.idomkey = 'like-button';
    const dislikeBtn = createEl('yt-button-container');
    dislikeBtn.attributes.idomkey = 'dislike-button';

    const videoEl = createEl('video');
    videoEl.duration = 120;
    videoEl.currentTime = 30;
    videoEl.playbackRate = 1.25;
    videoEl.videoWidth = 1920;
    videoEl.videoHeight = 1080;
    videoEl.paused = false;
    videoEl.ended = false;
    videoEl.readyState = 4;
    videoEl.currentSrc = 'blob:e2eVid123';

    watchDefault.appendChild(progressBar);
    watchDefault.appendChild(likeBtn);
    watchDefault.appendChild(dislikeBtn);
    bodyEl.appendChild(watchDefault);
    bodyEl.appendChild(videoEl);

    fakeLocation.hash = '#/watch?v=e2eVid123';
    fakeLocation.href = 'https://www.youtube.com/tv#/watch?v=e2eVid123';
    (fakeWindow.dispatchEvent as (e: { type: string }) => void)({ type: 'hashchange' });
    vm.runInContext(
      `JSON.parse(${JSON.stringify(
        JSON.stringify({
          currentVideoEndpoint: { watchEndpoint: { videoId: 'e2eVid123' } },
          transportControls: {
            transportControlsRenderer: {
              actions: [{ button: { likeButtonRenderer: { likeCountText: { simpleText: '5K' } } } }],
            },
          },
        })
      )});`,
      context
    );
    for (const obs of observers.filter((o) => !o.disconnected)) obs.cb([], obs);

    await waitFor(
      () =>
        elapsedEl.dataset.ttRemaining === '-1:30' &&
        durationEl.textContent === '1.25x • 1080p • 2:00' &&
        Boolean(clockEl.children[0]?.children[1]?.textContent.startsWith('Ends ')) &&
        likeBtn.dataset.ttCount === '5K' &&
        dislikeBtn.dataset.ttCount === '120' &&
        fetchCalls.some((c) => c.url.includes('sponsor.ajay.app/api/skipSegments'))
    );

    assert.equal(elapsedEl.textContent, '0:30');
    assert.equal(elapsedEl.dataset.ttRemaining, '-1:30');
    assert.equal(durationEl.textContent, '1.25x • 1080p • 2:00');
    assert.ok(clockEl.querySelectorAll('div').length >= 1);
    const endEl = clockEl.children[0]?.children[1];
    assert.ok(endEl?.textContent.startsWith('Ends '), `Expected Ends HH:MM, got ${endEl?.textContent}`);
    assert.equal(likeBtn.dataset.ttCount, '5K');
    assert.equal(dislikeBtn.dataset.ttCount, '120');

    // Verify SponsorBlock fetched segments for e2eVid123
    assert.ok(fetchCalls.some((c) => c.url.includes('sponsor.ajay.app/api/skipSegments')));

    // Verify auto-translate popup pins English and Hindi via single resolveCommand hook
    const autoTranslatePopup = {
      openPopupAction: {
        uniqueId: 'CLIENT_OVERLAY_TYPE_CAPTIONS_AUTO_TRANSLATE',
        popup: {
          overlaySectionRenderer: {
            overlay: {
              overlayTwoPanelRenderer: {
                actionPanel: {
                  overlayPanelRenderer: {
                    content: {
                      overlayPanelItemListRenderer: {
                        items: [
                          { overlayMessageRenderer: { subtitle: { simpleText: 'Recommended languages' } } },
                          {
                            compactLinkRenderer: {
                              title: { simpleText: 'Spanish' },
                              serviceEndpoint: {
                                commandExecutorCommand: {
                                  commands: [
                                    {
                                      selectSubtitlesTrackCommand: {
                                        translationLanguage: { languageCode: 'es', languageName: 'Spanish' },
                                      },
                                    },
                                  ],
                                },
                              },
                            },
                          },
                        ],
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    resolveHost.instance.resolveCommand(autoTranslatePopup);
    const captionItems =
      autoTranslatePopup.openPopupAction.popup.overlaySectionRenderer.overlay.overlayTwoPanelRenderer.actionPanel
        .overlayPanelRenderer.content.overlayPanelItemListRenderer.items;
    assert.equal(captionItems.length, 2);

    // Verify Rewind on Pause (-5s after >= 30s pause)
    vm.runInContext('var __origDateNow = Date.now; var __fakeNow = 1000000; Date.now = () => __fakeNow;', context);
    videoEl.dispatchEvent({ type: 'pause' });
    vm.runInContext('__fakeNow += 35000;', context);
    videoEl.dispatchEvent({ type: 'play' });
    assert.equal(videoEl.currentTime, 25);
    vm.runInContext('Date.now = __origDateNow;', context);

    // Verify leaving watch page clears clock Ends display cleanly and disconnects Watch observers
    fakeLocation.hash = '#/';
    fakeLocation.href = 'https://www.youtube.com/tv#/';
    (fakeWindow.dispatchEvent as (e: { type: string }) => void)({ type: 'hashchange' });
    assert.equal(endEl?.textContent, '');

    const watchTargets = new Set<unknown>([progressBar, watchDefault, videoEl]);
    const watchObservers = observers.filter((o) => watchTargets.has(o.target));
    assert.ok(watchObservers.length >= 1, 'Expected Watch session to register DOM observers');
    assert.equal(
      watchObservers.every((o) => o.disconnected),
      true,
      'All Watch DOM observers must disconnect cleanly on exit'
    );

    // Verify Memory pressure listener executes cleanly
    assert.doesNotThrow(() => pressureListeners[0]?.());
  });

  test('[TDD Red: M1] cleans up Shorts observers when exiting WEB_PAGE_TYPE_SHORTS back to Home without hashchange', async (t) => {
    const { bundleSource, context, fakeWindow, fakeDocument, docRef, observers, createEl, flushMutations } =
      createE2EHarness(t);

    vm.runInContext(bundleSource, context);

    const htmlEl = createEl('html');
    const headEl = createEl('head');
    const bodyEl = createEl('body');
    htmlEl.appendChild(headEl);
    htmlEl.appendChild(bodyEl);
    docRef.root = htmlEl;
    fakeDocument.documentElement = htmlEl;
    fakeDocument.head = headEl;
    fakeDocument.body = bodyEl;
    fakeDocument.readyState = 'complete';
    fakeWindow._yttv = {
      host: { instance: { resolveCommand: () => true } },
    };
    (fakeDocument.dispatchEvent as (e: { type: string }) => void)({ type: 'DOMContentLoaded' });
    await new Promise((r) => setTimeout(r, 20));

    const reelOverlay = createEl('ytlr-reel-player-overlay-renderer');
    const likeBtn = createEl('ytlr-toggle-button-view-model');
    const dislikeBtn = createEl('ytlr-reel-action-bar-button-view-model');
    dislikeBtn.setAttribute('aria-label', 'Dislike');
    reelOverlay.appendChild(likeBtn);
    reelOverlay.appendChild(dislikeBtn);
    bodyEl.appendChild(reelOverlay);

    // Enter Shorts on TV via WEB_PAGE_TYPE_SHORTS without changing location.hash (#/).
    bodyEl.classList.add('WEB_PAGE_TYPE_SHORTS');
    flushMutations();

    const reelPayload = {
      overlay: {
        reelPlayerOverlayRenderer: {
          buttonBar: {
            reelActionBarViewModel: {
              buttonViewModels: [
                {
                  reelActionBarButtonViewModel: {
                    buttonViewModel: {
                      likeButtonViewModel: {
                        toggleButtonViewModel: {
                          toggleButtonViewModel: {
                            defaultButtonViewModel: {
                              buttonViewModel: {
                                iconName: 'EMPTY_HEART',
                                title: '42K',
                                onTap: {
                                  innertubeCommand: {
                                    likeEndpoint: { target: { videoId: 'e2eShort111' } },
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      },
    };
    vm.runInContext(`JSON.parse(${JSON.stringify(JSON.stringify(reelPayload))});`, context);
    flushMutations();

    const reelObservers = observers.filter((o) => o.target === reelOverlay);
    assert.ok(reelObservers.length >= 1, 'Expected Shorts overlay observer to attach');

    // Return to Home by removing WEB_PAGE_TYPE_SHORTS without hashchange.
    bodyEl.classList.remove('WEB_PAGE_TYPE_SHORTS');
    flushMutations();

    assert.equal(
      reelObservers.every((o) => o.disconnected),
      true,
      'Shorts overlay observer must disconnect when WEB_PAGE_TYPE_SHORTS is removed'
    );
  });
});
