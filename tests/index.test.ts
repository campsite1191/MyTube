import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

interface MockEl {
  tagName: string;
  id: string;
  className: string;
  rel?: string;
  href?: string;
  crossOrigin?: string;
  textContent: string;
  isConnected: boolean;
  style: Record<string, string>;
  children: MockEl[];
  appendChild: (child: MockEl) => MockEl;
  remove: () => void;
}

describe('mods/index.ts entrypoint bootstrap', () => {
  test('wires synchronous hooks, seeds preferences, and schedules post-first-paint modules on ready', async (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevDocument = globals.document;
    const prevLocalStorage = globals.localStorage;
    const prevMutationObserver = globals.MutationObserver;
    const prevCSSStyleSheet = globals.CSSStyleSheet;
    const prevJsonParse = JSON.parse;
    const prevRespJson = Response.prototype.json;
    const origSetTimeout = globalThis.setTimeout;
    const origClearTimeout = globalThis.clearTimeout;

    const headChildren: MockEl[] = [];
    const bodyChildren: MockEl[] = [];
    const storageMap = new Map<string, string>();
    const activeTimeouts = new Set<ReturnType<typeof setTimeout>>();
    const docListeners: string[] = [];

    globals.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const id = origSetTimeout(() => {
        activeTimeouts.delete(id);
        fn(...args);
      }, ms);
      activeTimeouts.add(id);
      return id;
    }) as typeof setTimeout;
    globals.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
      activeTimeouts.delete(id);
      origClearTimeout(id);
    }) as typeof clearTimeout;

    const makeEl = (tag: string): MockEl => {
      const el: MockEl = {
        tagName: tag.toUpperCase(),
        id: '',
        className: '',
        textContent: '',
        isConnected: true,
        style: {},
        children: [],
        appendChild(child: MockEl) {
          this.children.push(child);
          return child;
        },
        remove() {
          el.isConnected = false;
        },
      };
      return el;
    };

    const headEl = makeEl('head');
    headEl.children = headChildren;
    const bodyEl = makeEl('body');
    bodyEl.children = bodyChildren;
    const docEl = makeEl('html');

    const findById = (root: MockEl[], id: string): MockEl | null => {
      for (const node of root) {
        if (node.id === id) return node;
        const nested = findById(node.children, id);
        if (nested) return nested;
      }
      return null;
    };

    const idleQueue: Array<() => void> = [];
    globals.CSSStyleSheet = class {
      replaceSync(): void {}
    };
    globals.MutationObserver = class {
      observe(): void {}
      disconnect(): void {}
    };
    globals.localStorage = {
      getItem: (k: string) => storageMap.get(k) ?? null,
      setItem: (k: string, v: string) => {
        storageMap.set(k, v);
      },
    };
    globals.document = {
      readyState: 'complete',
      hidden: false,
      head: headEl,
      body: bodyEl,
      documentElement: docEl,
      adoptedStyleSheets: [],
      createElement: makeEl,
      getElementById: (id: string) => findById(bodyChildren, id),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: (type: string) => {
        docListeners.push(type);
      },
      removeEventListener: () => {},
    };
    globals.window = {
      location: { hash: '#/', search: '' },
      fetch: async () => new Response('{}', { status: 200 }),
      requestIdleCallback: (cb: () => void) => {
        idleQueue.push(cb);
        return 1;
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      _yttv: {
        host: { instance: { resolveCommand: () => true } },
      },
    };

    t.after(() => {
      for (const id of activeTimeouts) origClearTimeout(id);
      globals.setTimeout = origSetTimeout;
      globals.clearTimeout = origClearTimeout;
      JSON.parse = prevJsonParse;
      Response.prototype.json = prevRespJson;
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
      if (prevLocalStorage === undefined) delete globals.localStorage;
      else globals.localStorage = prevLocalStorage;
      if (prevMutationObserver === undefined) delete globals.MutationObserver;
      else globals.MutationObserver = prevMutationObserver;
      if (prevCSSStyleSheet === undefined) delete globals.CSSStyleSheet;
      else globals.CSSStyleSheet = prevCSSStyleSheet;
    });

    await import('../mods/index.ts');
    assert.ok(storageMap.has('yt.leanback.default::recurring_actions'));
    assert.ok(storageMap.has('yt-player-quality'));
    assert.ok(docListeners.includes('error'));
    assert.ok(docListeners.includes('keydown'));
    assert.ok(docListeners.includes('click'));

    const parsedEndscreen = JSON.parse('{"endscreen":{"endscreenRenderer":{}}}') as { endscreen: unknown };
    assert.equal(parsedEndscreen.endscreen, null);
    const respEndscreen = (await new Response(JSON.stringify({ endscreen: { endscreenRenderer: {} } })).json()) as {
      endscreen: unknown;
    };
    assert.equal(respEndscreen.endscreen, null);

    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(idleQueue.length, 1);
    idleQueue[0]?.();

    assert.equal(headChildren.length, 2);
    assert.ok(headChildren.some((el) => el.href === 'https://sponsor.ajay.app'));
    assert.ok(headChildren.some((el) => el.href === 'https://returnyoutubedislikeapi.com'));
    assert.ok(bodyChildren.some((el) => el.id === 'custom-clock'));
  });
});
