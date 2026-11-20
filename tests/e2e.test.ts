import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, test } from 'node:test';
import vm from 'node:vm';

const requireFromMods = createRequire(new URL('../mods/package.json', import.meta.url));
const { IDBFactory, IDBKeyRange } = requireFromMods('fake-indexeddb') as {
  IDBFactory: typeof globalThis.IDBFactory;
  IDBKeyRange: typeof globalThis.IDBKeyRange;
};
const { createStore, get: idbGet } = requireFromMods('idb-keyval') as {
  createStore: (dbName: string, storeName: string) => unknown;
  get: <T>(key: string, customStore?: unknown) => Promise<T | undefined>;
};

const BUNDLE_PATH = path.resolve(import.meta.dirname, '..', 'mods', 'dist', 'userscript.js');

interface MockElement {
  tagName: string;
  nodeName: string;
  nodeType: number;
  id: string;
  className: string;
  classList: {
    add: (...cls: string[]) => void;
    contains: (cls: string) => boolean;
    [Symbol.iterator]: () => IterableIterator<string>;
  };
  style: Record<string, string> & { setProperty: (k: string, v: string) => void };
  dataset: Record<string, string>;
  attributes: Record<string, string>;
  children: MockElement[];
  childNodes: MockElement[];
  parentElement: MockElement | null;
  textContent: string;
  nodeValue?: string;
  nonce?: string;
  rel?: string;
  href?: string;
  crossOrigin?: string;
  isConnected: boolean;
  addEventListener: (type: string, fn: (ev?: unknown) => void) => void;
  removeEventListener: (type: string, fn: (ev?: unknown) => void) => void;
  dispatchEvent: (ev: { type: string; target?: unknown }) => boolean;
  appendChild: (child: MockElement) => MockElement;
  querySelector: (selector: string) => MockElement | null;
  querySelectorAll: (selector: string) => MockElement[];
  getAttribute: (name: string) => string | null;
  getBoundingClientRect: () => { top: number; bottom: number; height: number };
  closest: () => MockElement | null;
  remove: () => void;
  duration?: number;
  currentTime?: number;
  playbackRate?: number;
  paused?: boolean;
  ended?: boolean;
  readyState?: number;
  currentSrc?: string;
  src?: string;
}

function createMockElement(tagName: string, docRef: { root: MockElement | null }): MockElement {
  const classes = new Set<string>();
  const listeners = new Map<string, Set<(ev?: unknown) => void>>();
  const attrs: Record<string, string> = {};
  const styleObj: Record<string, unknown> = {
    setProperty: (k: string, v: string) => {
      styleObj[k] = v;
    },
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
    },
    classList: {
      add: (...cls: string[]) => {
        for (const c of cls) classes.add(c);
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
    textContent: '',
    isConnected: true,
    addEventListener: (type: string, fn: (ev?: unknown) => void) => {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(fn);
    },
    removeEventListener: (type: string, fn: (ev?: unknown) => void) => {
      listeners.get(type)?.delete(fn);
    },
    dispatchEvent: (ev: { type: string; target?: unknown }) => {
      for (const fn of listeners.get(ev.type) ?? []) fn({ ...ev, target: ev.target ?? el });
      return true;
    },
    appendChild: (child: MockElement) => {
      child.parentElement = el;
      child.isConnected = el.isConnected;
      el.children.push(child);
      el.childNodes.push(child);
      return child;
    },
    querySelector: (selector: string) => el.querySelectorAll(selector)[0] ?? null,
    querySelectorAll: (selector: string) => {
      const results: MockElement[] = [];
      const selectors = selector.split(',').map((s) => s.trim());
      const matchesOne = (node: MockElement, sel: string): boolean => {
        if (sel === 'div') return node.tagName === 'DIV';
        if (sel === 'video') return node.tagName === 'VIDEO';
        if (sel === 'div[idomkey="slider"]') return node.tagName === 'DIV' && node.attributes.idomkey === 'slider';
        if (sel === 'ytlr-progress-bar') return node.tagName === 'YTLR-PROGRESS-BAR';
        if (sel === 'ytlr-watch-default') return node.tagName === 'YTLR-WATCH-DEFAULT';
        if (sel === 'ytlr-redux-connect-ytlr-progress-bar') {
          return node.tagName === 'YTLR-REDUX-CONNECT-YTLR-PROGRESS-BAR';
        }
        if (sel.includes('[idomkey="elapsedTime"]')) return node.attributes.idomkey === 'elapsedTime';
        if (sel.includes('[idomkey="dislike-button"]')) return node.attributes.idomkey === 'dislike-button';
        if (sel.includes('[idomkey="like-button"]')) return node.attributes.idomkey === 'like-button';
        if (sel.startsWith('link[rel="preconnect"]')) {
          return node.tagName === 'LINK' && sel.includes(`href="${node.href}"`);
        }
        return false;
      };
      const walk = (node: MockElement): void => {
        for (const s of selectors) {
          if (matchesOne(node, s)) {
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
    getAttribute: (name: string) => attrs[name] ?? null,
    getBoundingClientRect: () => ({ top: 10, bottom: 20, height: 10 }),
    closest: () => null,
    remove: () => {
      if (el.parentElement) {
        const idx = el.parentElement.children.indexOf(el);
        if (idx !== -1) el.parentElement.children.splice(idx, 1);
      }
      el.isConnected = false;
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

describe('End-to-end userscript bundle lifecycle', () => {
  test('executes bundled userscript from document-start through Home feeds, Settings, Watch overlays, and cleanup', async (t) => {
    const activeTimers = new Set<ReturnType<typeof setTimeout>>();
    t.after(() => {
      for (const id of activeTimers) clearTimeout(id);
    });
    const bundleSource = fs.readFileSync(BUNDLE_PATH, 'utf8');

    const windowListeners = new Map<string, Set<(ev?: unknown) => void>>();
    const docListeners = new Map<string, Set<(ev?: unknown) => void>>();
    const observers: Array<{ target: unknown; cb: () => void }> = [];
    const fetchCalls: Array<{ url: string; body?: string }> = [];
    const xhrCalls: Array<{ body: unknown }> = [];
    const resolvedCommands: unknown[] = [];
    const executedActions: string[] = [];
    const pressureListeners: Array<() => void> = [];
    const fakeIdb = new IDBFactory();
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
    const fakeDocument: Record<string, unknown> = {
      readyState: 'loading',
      hidden: false,
      body: null,
      head: null,
      documentElement: null,
      adoptedStyleSheets: [],
      createElement: (tag: string) => createMockElement(tag, docRef),
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
      addEventListener: (type: string, fn: (ev?: unknown) => void) => {
        let set = docListeners.get(type);
        if (!set) {
          set = new Set();
          docListeners.set(type, set);
        }
        set.add(fn);
      },
      removeEventListener: (type: string, fn: (ev?: unknown) => void) => {
        docListeners.get(type)?.delete(fn);
      },
      dispatchEvent: (ev: { type: string; target?: unknown }) => {
        for (const fn of [...(docListeners.get(ev.type) ?? [])]) fn(ev);
        return true;
      },
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
      async json(): Promise<unknown> {
        return JSON.parse(this.rawBody);
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
      addEventListener: (type: string, fn: (ev?: unknown) => void) => {
        let set = windowListeners.get(type);
        if (!set) {
          set = new Set();
          windowListeners.set(type, set);
        }
        set.add(fn);
      },
      removeEventListener: (type: string, fn: (ev?: unknown) => void) => {
        windowListeners.get(type)?.delete(fn);
      },
      dispatchEvent: (ev: { type: string }) => {
        for (const fn of [...(windowListeners.get(ev.type) ?? [])]) fn(ev);
        return true;
      },
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
      private readonly cb: () => void;
      constructor(cb: () => void) {
        this.cb = cb;
      }
      observe(target: unknown): void {
        observers.push({ target, cb: this.cb });
      }
      disconnect(): void {}
    }

    const sandbox: Record<string, unknown> = {
      window: fakeWindow,
      document: fakeDocument,
      location: fakeLocation,
      localStorage: fakeLocalStorage,
      indexedDB: fakeIdb,
      IDBKeyRange,
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

    // 1. Run bundled userscript at true document-start (null body/head/_yttv)
    assert.doesNotThrow(() => vm.runInContext(bundleSource, context));
    assert.equal(pressureListeners.length, 1);

    // 2. Mount DOM + fire DOMContentLoaded
    const htmlEl = createMockElement('html', docRef);
    const headEl = createMockElement('head', docRef);
    const bodyEl = createMockElement('body', docRef);
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
    for (const obs of [...observers]) obs.cb();
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

    // 4. Test JSON.parse (Settings + Guide) and Response.prototype.json (Home Browse)
    const vmJson = sandbox.JSON as typeof JSON;
    const settingsParsed = vmJson.parse(
      JSON.stringify({
        title: { runs: [{ text: 'Settings' }] },
        items: [{ settingCategoryCollectionRenderer: { categoryId: 'ABOUT', items: [] } }],
      })
    ) as {
      items: Array<{
        settingCategoryCollectionRenderer: {
          categoryId: string;
          items?: Array<{ settingActionRenderer?: { serviceEndpoint?: unknown } }>;
        };
      }>;
    };
    assert.equal(settingsParsed.items[0]?.settingCategoryCollectionRenderer.categoryId, 'custom_settings_category');
    const customSettingsEndpoint =
      settingsParsed.items[0]?.settingCategoryCollectionRenderer.items?.[0]?.settingActionRenderer?.serviceEndpoint;
    assert.ok(customSettingsEndpoint, 'Custom settings item exposes serviceEndpoint');

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

    // 5. Test resolveCommand user actions (Custom Settings modal via injected SettingActionRenderer, toggle setting, speed menu, captions auto-translate)
    resolvedCommands.length = 0;
    resolveHost.instance.resolveCommand(customSettingsEndpoint);
    assert.equal(
      (resolvedCommands.at(-1) as { openPopupAction?: { uniqueId?: string } }).openPopupAction?.uniqueId,
      'tt-settings'
    );

    // Late-loaded _yttv command host (registered after startup) must still be patched via Settings parse / action key
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
    lateHost.instance.resolveCommand(customSettingsEndpoint);
    assert.equal(
      (lateResolvedCommands.at(-1) as { openPopupAction?: { uniqueId?: string } })?.openPopupAction?.uniqueId,
      'tt-settings'
    );

    resolveHost.instance.resolveCommand({
      setClientSettingEndpoint: {
        settingDatas: [
          { clientSettingEnum: { item: 'enableAdBlock' }, boolValue: false },
          { clientSettingEnum: { item: 'sponsorBlockManualSkips' }, arrayValue: 'outro' },
        ],
      },
    });
    // Non-string customAction must fall through cleanly rather than recursing infinitely.
    assert.doesNotThrow(() => resolveHost.instance.resolveCommand({ customAction: { action: 123 } }));
    const prevIdb = (globalThis as { indexedDB?: unknown }).indexedDB;
    (globalThis as { indexedDB?: unknown }).indexedDB = fakeIdb;
    let storedConfig: { enableAdBlock?: boolean; sponsorBlockManualSkips?: string[] } | undefined;
    try {
      await waitFor(async () => {
        storedConfig = await idbGet<{ enableAdBlock?: boolean; sponsorBlockManualSkips?: string[] }>(
          'ytaf-configuration',
          createStore('MyTubeDB', 'settings')
        );
        return (
          storedConfig?.enableAdBlock === false && storedConfig?.sponsorBlockManualSkips?.includes('outro') === false
        );
      });
    } finally {
      (globalThis as { indexedDB?: unknown }).indexedDB = prevIdb;
    }
    assert.equal(storedConfig?.enableAdBlock, false);
    assert.equal(storedConfig?.sponsorBlockManualSkips?.includes('outro'), false);

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
                            icon: { iconType: string };
                            subtitle: { simpleText: string };
                            serviceEndpoint?: {
                              signalAction?: { customAction?: { action?: string } };
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
                              icon: { iconType: 'SPEEDOMETER' },
                              subtitle: { simpleText: 'Normal' },
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
    assert.equal(
      playbackCmd.openPopupAction.popup.overlaySectionRenderer.overlay.overlayTwoPanelRenderer.actionPanel
        .overlayPanelRenderer.content.overlayPanelItemListRenderer.items[0]?.compactLinkRenderer.serviceEndpoint
        ?.signalAction?.customAction?.action,
      'TT_SPEED_SETTINGS_SHOW'
    );

    // 6. Navigate to watch page & mount player DOM -> verify Clock End Time, Remaining Time, RYD badges, SponsorBlock, Rewind
    const watchDefault = createMockElement('ytlr-watch-default', docRef);
    const progressBar = createMockElement('ytlr-progress-bar', docRef);
    const elapsedEl = createMockElement('span', docRef);
    elapsedEl.attributes.idomkey = 'elapsedTime';
    elapsedEl.textContent = '0:30 / 2:00';
    progressBar.appendChild(elapsedEl);

    const likeBtn = createMockElement('yt-button-container', docRef);
    likeBtn.attributes.idomkey = 'like-button';
    const dislikeBtn = createMockElement('yt-button-container', docRef);
    dislikeBtn.attributes.idomkey = 'dislike-button';

    const videoEl = createMockElement('video', docRef);
    videoEl.duration = 120;
    videoEl.currentTime = 30;
    videoEl.playbackRate = 1;
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
    for (const obs of [...observers]) obs.cb();

    await waitFor(
      () =>
        elapsedEl.textContent === '0:30 (-1:30) / 2:00' &&
        Boolean(clockEl.children[0]?.children[1]?.textContent.startsWith('Ends ')) &&
        likeBtn.dataset.ttCount === '5K' &&
        dislikeBtn.dataset.ttCount === '120' &&
        fetchCalls.some((c) => c.url.includes('sponsor.ajay.app/api/skipSegments'))
    );

    assert.equal(elapsedEl.textContent, '0:30 (-1:30) / 2:00');
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
                        items: [{ overlayMessageRenderer: { subtitle: { simpleText: 'Recommended languages' } } }],
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
    assert.equal(captionItems.length, 3);

    // Verify Rewind on Pause (-5s after >= 30s pause)
    vm.runInContext('var __origDateNow = Date.now; var __fakeNow = 1000000; Date.now = () => __fakeNow;', context);
    (fakeDocument.dispatchEvent as (e: { type: string; target?: unknown }) => void)({ type: 'pause', target: videoEl });
    vm.runInContext('__fakeNow += 35000;', context);
    (fakeDocument.dispatchEvent as (e: { type: string; target?: unknown }) => void)({ type: 'play', target: videoEl });
    assert.equal(videoEl.currentTime, 25);
    vm.runInContext('Date.now = __origDateNow;', context);

    // Verify leaving watch page clears clock Ends display cleanly
    fakeLocation.hash = '#/';
    fakeLocation.href = 'https://www.youtube.com/tv#/';
    (fakeWindow.dispatchEvent as (e: { type: string }) => void)({ type: 'hashchange' });
    assert.equal(endEl?.textContent, '');

    // Verify Memory pressure listener executes cleanly
    assert.doesNotThrow(() => pressureListeners[0]?.());
  });
});
