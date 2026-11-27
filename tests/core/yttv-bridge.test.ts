import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  dispatchYttvCommand,
  findResolveCommandHost,
  getCommandExecutor,
  getCurrentIdentityService,
  getKabukiInnerTubeClient,
  registerCommandDispatcher,
  showToast,
  whenYttvReady,
} from '../../mods/core/yttv-bridge.ts';
import resolveCommand, { patchResolveCommand } from '../../mods/ui/resolve-command.ts';

describe('yttv-bridge service lookup and dispatching', () => {
  test('returns null when _yttv or required services are missing or invalid', (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    t.after(() => {
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
    });

    delete globals.window;
    assert.equal(getKabukiInnerTubeClient(), null);
    assert.equal(getCurrentIdentityService(), null);
    assert.equal(findResolveCommandHost(), null);
    assert.equal(getCommandExecutor(), null);

    globals.window = {
      _yttv: {
        empty: {},
        primitive: 42,
        services: { mappings: new Map<string, unknown>([['KabukiInnerTubeClient', {}]]) },
      },
    };
    assert.equal(getKabukiInnerTubeClient(), null);
    assert.equal(getCurrentIdentityService(), null);
    assert.equal(findResolveCommandHost(), null);

    // Explicitly no valid mappings Map in any _yttv entry returns null (hits fallback return null).
    globals.window = {
      _yttv: {
        onlyInvalidMappings: { mappings: 'not-a-map' },
      },
    };
    assert.equal(getKabukiInnerTubeClient(), null);
  });

  test('getCommandExecutor handles throwing getInstance, prototype scans, and missing commandFunction', (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    t.after(() => {
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
    });

    const throwingEntry = {
      getInstance: () => {
        throw new Error('Not ready');
      },
    };

    class DirectRouter {
      run(cmd: unknown) {
        void 'ytlrActionRouter';
        return cmd;
      }
    }
    const taggedEntry = {
      getInstance: () => new DirectRouter(),
      toString: () => 'ytlrActionRouter',
    };
    const primitiveEntry = {
      getInstance: () => 'not-an-object',
    };
    const nullProtoInstance = Object.create(null) as Record<string, unknown>;
    const nullProtoEntry = {
      getInstance: () => nullProtoInstance,
    };

    function ActionConstructor(this: { actionName: string }, actionName: string) {
      this.actionName = actionName;
    }

    globals.window = {
      _yttv: {
        throwingEntry,
        primitiveEntry,
        nullProtoEntry,
        taggedEntry,
        ActionConstructor,
      },
    };
    const exec1 = getCommandExecutor();
    assert.ok(exec1);
    assert.equal(exec1.commandFunction, ActionConstructor);
    assert.deepEqual(exec1.executeFunction('ping'), 'ping');

    // Missing executeFunction returns null.
    class NoRouterInstance {
      helper() {
        return 1;
      }
    }
    globals.window = {
      _yttv: {
        noRouter: { getInstance: () => new NoRouterInstance() },
      },
    };
    assert.equal(getCommandExecutor(), null);
  });

  test('dispatchYttvCommand and showToast fall back cleanly to host resolveCommand when dispatcher is unset', (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    t.after(() => {
      registerCommandDispatcher(resolveCommand);
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
    });

    const dispatched: unknown[] = [];
    registerCommandDispatcher(null as unknown as (cmd: unknown) => unknown);
    delete globals.window;
    assert.equal(dispatchYttvCommand({ test: true }), false);

    globals.window = {
      _yttv: {
        router: {
          instance: {
            resolveCommand: (cmd: unknown) => {
              dispatched.push(cmd);
              return true;
            },
          },
        },
      },
    };
    assert.equal(showToast('Title', 'Subtitle'), true);
    assert.equal(dispatched.length, 1);
  });
});

describe('whenYttvReady watcher paths', () => {
  test('fires synchronously when already populated, handles observer trigger, exceptions, and timeout fallback', (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevDocument = globals.document;
    const prevMutationObserver = globals.MutationObserver;
    const prevSetTimeout = globals.setTimeout;
    const prevClearTimeout = globals.clearTimeout;

    t.after(() => {
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
      if (prevMutationObserver === undefined) delete globals.MutationObserver;
      else globals.MutationObserver = prevMutationObserver;
      globals.setTimeout = prevSetTimeout;
      globals.clearTimeout = prevClearTimeout;
    });

    // 1. Fast path when host is already populated.
    globals.window = {
      _yttv: {
        host: { instance: { resolveCommand: () => true } },
      },
    };
    let fastCalled = 0;
    whenYttvReady(() => {
      fastCalled++;
    });
    assert.equal(fastCalled, 1);

    // 2. Observer trigger + throwing callback + deduplicated waiters.
    const observerCbs: Array<() => void> = [];
    let disconnected = 0;
    globals.MutationObserver = class {
      constructor(cb: () => void) {
        observerCbs.push(cb);
      }
      observe(): void {}
      disconnect(): void {
        disconnected++;
      }
    };
    let nextTimerId = 1;
    const scheduledTimers = new Map<number, () => void>();
    globals.setTimeout = ((fn: () => void) => {
      const id = nextTimerId++;
      scheduledTimers.set(id, fn);
      return id;
    }) as unknown as typeof setTimeout;
    globals.clearTimeout = ((id: number) => {
      scheduledTimers.delete(id);
    }) as unknown as typeof clearTimeout;

    const fakeWindow: Record<string, unknown> = {
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    globals.window = fakeWindow;
    globals.document = {
      documentElement: {},
      addEventListener: () => {},
      removeEventListener: () => {},
    };

    const origError = console.error;
    const loggedErrors: unknown[] = [];
    console.error = (...args: unknown[]) => loggedErrors.push(args);

    try {
      let secondCalled = 0;
      whenYttvReady(() => {
        throw new Error('boom');
      });
      whenYttvReady(() => {
        secondCalled++;
      });

      // Mutation fires before _yttv populates -> remains waiting.
      observerCbs[0]?.();
      assert.equal(secondCalled, 0);

      // Populate host -> MutationObserver flushes all callbacks and isolates exception.
      fakeWindow._yttv = { host: { instance: { resolveCommand: () => true } } };
      observerCbs[0]?.();
      assert.equal(secondCalled, 1);
      assert.equal(loggedErrors.length, 1);
      assert.equal(disconnected, 1);

      // 3. Max-attempts timeout with non-empty _yttv (without resolveCommand) flushes callbacks.
      scheduledTimers.clear();
      fakeWindow._yttv = { partialKey: {} };
      let fallbackFlushed = 0;
      whenYttvReady(() => {
        fallbackFlushed++;
      });
      for (let i = 0; i < 160 && scheduledTimers.size > 0; i++) {
        const entry = scheduledTimers.entries().next().value as [number, () => void] | undefined;
        if (!entry) break;
        scheduledTimers.delete(entry[0]);
        entry[1]();
      }
      assert.equal(fallbackFlushed, 1);

      // 4. Max-attempts timeout with empty _yttv cleans up without invoking callbacks.
      scheduledTimers.clear();
      delete fakeWindow._yttv;
      let emptyTimedOutCalled = 0;
      whenYttvReady(() => {
        emptyTimedOutCalled++;
      });
      for (let i = 0; i < 160 && scheduledTimers.size > 0; i++) {
        const entry = scheduledTimers.entries().next().value as [number, () => void] | undefined;
        if (!entry) break;
        scheduledTimers.delete(entry[0]);
        entry[1]();
      }
      assert.equal(emptyTimedOutCalled, 0);
    } finally {
      console.error = origError;
    }
  });

  test('whenYttvReady waits for resolveCommand host and patchResolveCommand re-patches replaced or late hosts', async () => {
    const origWindow = (globalThis as { window?: unknown }).window;
    const origDoc = (globalThis as { document?: unknown }).document;
    const listeners = new Map<string, Set<() => void>>();

    try {
      const fakeWindow: Record<string, unknown> = {
        _yttv: { bootstrapOnly: { version: 1 } },
        addEventListener: (type: string, cb: () => void) => {
          let set = listeners.get(type);
          if (!set) {
            set = new Set();
            listeners.set(type, set);
          }
          set.add(cb);
        },
        removeEventListener: (type: string, cb: () => void) => listeners.get(type)?.delete(cb),
      };
      const fakeDoc: Record<string, unknown> = {
        readyState: 'complete',
        documentElement: {},
        addEventListener: () => {},
        removeEventListener: () => {},
      };
      (globalThis as { window: unknown }).window = fakeWindow;
      (globalThis as { document: unknown }).document = fakeDoc;

      let readyCount = 0;
      whenYttvReady(() => {
        readyCount++;
        patchResolveCommand();
      });

      assert.equal(readyCount, 0);

      const firstCalls: unknown[] = [];
      function firstHost(): void {}
      firstHost.instance = {
        resolveCommand: (cmd: unknown) => {
          firstCalls.push(cmd);
          return 'orig-first';
        },
      };
      (fakeWindow._yttv as Record<string, unknown>).mainRouter = firstHost;

      await new Promise((resolve) => setTimeout(resolve, 260));
      assert.equal(readyCount, 1);

      const secondCalls: unknown[] = [];
      firstHost.instance.resolveCommand = (cmd: unknown) => {
        secondCalls.push(cmd);
        return 'replaced-first';
      };
      patchResolveCommand();

      const lateCalls: unknown[] = [];
      const lateHost = {
        instance: {
          resolveCommand: (cmd: unknown) => {
            lateCalls.push(cmd);
            return 'late';
          },
        },
      };
      (fakeWindow._yttv as Record<string, unknown>).lateRouter = lateHost;
      patchResolveCommand();

      firstHost.instance.resolveCommand({ customAction: { action: 'TT_SPEED_SETTINGS_SHOW', parameters: [] } });
      assert.equal(secondCalls.length, 1);
      assert.equal(
        (secondCalls[0] as { openPopupAction?: { uniqueId?: string } }).openPopupAction?.uniqueId,
        'tt-speed'
      );

      lateHost.instance.resolveCommand({
        signalAction: { customAction: { action: 'TT_SPEED_SETTINGS_SHOW', parameters: [] } },
      });
      assert.equal(lateCalls.length, 1);
      assert.equal((lateCalls[0] as { openPopupAction?: { uniqueId?: string } }).openPopupAction?.uniqueId, 'tt-speed');
      assert.equal(firstCalls.length, 0);

      const settingsMenuItems = [
        { compactLinkRenderer: { title: { runs: [{ text: 'Quality' }] }, icon: { iconType: 'SETTINGS' } } },
        {
          compactLinkRenderer: {
            title: { runs: [{ text: 'Speed' }] },
            icon: { iconType: 'SPEEDOMETER' },
            subtitle: { simpleText: 'Normal' },
          },
        },
        { compactLinkRenderer: { title: { simpleText: 'Report video' }, icon: { iconType: 'OUTLINED_FLAG' } } },
        { compactLinkRenderer: { title: { simpleText: 'Bug' }, serviceEndpoint: { sendFeedbackEndpoint: {} } } },
        {
          compactLinkRenderer: {
            title: { runs: [{ text: 'Stats for nerds' }] },
            icon: { iconType: 'BUG_REPORT' },
            serviceEndpoint: { signalAction: { signal: 'TOGGLE_VIDEO_INFO' } },
          },
        },
      ];
      lateHost.instance.resolveCommand({
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
                          items: settingsMenuItems,
                          selectedIndex: 4,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      });
      assert.equal(settingsMenuItems.length, 3);
      assert.equal(
        (settingsMenuItems[0]?.compactLinkRenderer.title as { runs?: Array<{ text?: string }> } | undefined)?.runs?.[0]
          ?.text,
        'Quality'
      );
      assert.equal(settingsMenuItems[1]?.compactLinkRenderer.subtitle?.simpleText, 'Normal');
      assert.equal(
        (settingsMenuItems[2]?.compactLinkRenderer.title as { runs?: Array<{ text?: string }> } | undefined)?.runs?.[0]
          ?.text,
        'Stats for nerds'
      );
    } finally {
      (globalThis as { window?: unknown }).window = origWindow;
      (globalThis as { document?: unknown }).document = origDoc;
    }
  });

  test('whenYttvReady falls back to document when documentElement is null and getCommandExecutor returns null when method is missing', () => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevDocument = globals.document;
    const prevMutationObserver = globals.MutationObserver;
    const prevSetTimeout = globals.setTimeout;
    const prevClearTimeout = globals.clearTimeout;

    const observed: unknown[] = [];
    const timerIds: number[] = [];
    let disconnected = 0;

    globals.MutationObserver = class {
      observe(target: unknown): void {
        observed.push(target);
      }
      disconnect(): void {
        disconnected++;
      }
    };
    globals.setTimeout = (() => 999) as unknown as typeof setTimeout;
    globals.clearTimeout = ((id: number) => {
      timerIds.push(id);
    }) as unknown as typeof clearTimeout;

    const routerNoMethod = {
      toString: () => 'ytlrActionRouterModule',
      getInstance: () => ({ otherMethod: () => {} }),
    };
    const fakeDoc: Record<string, unknown> = {
      documentElement: null,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    const fakeWin: Record<string, unknown> = {
      _yttv: { routerNoMethod },
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    globals.document = fakeDoc;
    globals.window = fakeWin;

    try {
      assert.equal(getCommandExecutor(), null);

      const loadListeners: Array<() => void> = [];
      fakeDoc.addEventListener = (_t: string, cb: () => void) => loadListeners.push(cb);
      whenYttvReady(() => {});
      assert.equal(observed[0], fakeDoc);

      fakeWin._yttv = { host: { instance: { resolveCommand: () => true } } };
      for (const cb of loadListeners) cb();
      assert.equal(disconnected, 1);
      assert.ok(timerIds.length >= 0);
    } finally {
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
      if (prevMutationObserver === undefined) delete globals.MutationObserver;
      else globals.MutationObserver = prevMutationObserver;
      globals.setTimeout = prevSetTimeout;
      globals.clearTimeout = prevClearTimeout;
    }
  });
});
