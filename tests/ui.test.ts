import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ensureResolveHooksOnActionKey, initUi, installUiHooks } from '../mods/ui/ui.ts';

describe('ui bootstrap and event hooks', () => {
  test('installUiHooks registers and cleans up document/window listeners and handles whenYttvReady callback', (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevDocument = globals.document;
    const prevLocation = globals.location;

    const winListeners = new Map<string, Set<() => void>>();
    const docListeners = new Map<string, Set<(e: unknown) => void>>();
    const resolvedCommands: unknown[] = [];

    const host = {
      instance: {
        resolveCommand: (cmd: unknown) => {
          resolvedCommands.push(cmd);
          return true;
        },
      },
    };
    globals.location = { hash: '#/' };
    globals.window = {
      _yttv: { host },
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
      addEventListener: (type: string, fn: (e: unknown) => void) => {
        const set = docListeners.get(type) ?? new Set();
        set.add(fn);
        docListeners.set(type, set);
      },
      removeEventListener: (type: string, fn: (e: unknown) => void) => {
        docListeners.get(type)?.delete(fn);
      },
    };

    let cleanup: (() => void) | undefined;
    t.after(() => {
      cleanup?.();
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
      if (prevLocation === undefined) delete globals.location;
      else globals.location = prevLocation;
    });

    cleanup = installUiHooks();
    assert.deepEqual(resolvedCommands, [{ browseEndpoint: { browseId: 'FEtopics' } }]);
    assert.equal(winListeners.get('hashchange')?.size, 1);
    assert.equal(docListeners.get('keydown')?.size, 1);
    assert.equal(docListeners.get('click')?.size, 1);

    // Calling installUiHooks again while installed returns a no-op.
    const noopCleanup = installUiHooks();
    noopCleanup();
    assert.equal(docListeners.get('click')?.size, 1);

    cleanup();
    cleanup = undefined;
    assert.equal(winListeners.get('hashchange')?.size, 0);
    assert.equal(docListeners.get('keydown')?.size, 0);
    assert.equal(docListeners.get('click')?.size, 0);
  });

  test('initUi dispatches FEtopics only on home startup routes and executes reloadGuideAction', (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevLocation = globals.location;

    const resolvedCommands: unknown[] = [];
    const executedActions: string[] = [];

    function ActionFn(this: { actionName: string }, actionName: string) {
      this.actionName = actionName;
    }
    class RouterInstance {
      execute(action: { actionName: string }) {
        void 'ytlrActionRouter';
        executedActions.push(action.actionName);
      }
    }
    const executorEntry = {
      getInstance: () => new RouterInstance(),
    };

    const fakeLocation = { hash: '#/' };
    globals.location = fakeLocation;
    globals.window = {
      _yttv: {
        router: {
          instance: {
            resolveCommand: (cmd: unknown) => {
              resolvedCommands.push(cmd);
              return true;
            },
          },
        },
        ActionFn,
        executorEntry,
      },
    };

    t.after(() => {
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevLocation === undefined) delete globals.location;
      else globals.location = prevLocation;
    });

    // Empty / '#' / '#/' all trigger startup FEtopics command.
    fakeLocation.hash = '';
    initUi(true);
    assert.deepEqual(resolvedCommands.at(-1), { browseEndpoint: { browseId: 'FEtopics' } });
    assert.deepEqual(executedActions, ['reloadGuideAction']);

    // Repeated call without force is a no-op.
    initUi(false);
    assert.equal(resolvedCommands.length, 1);

    fakeLocation.hash = '#';
    initUi(true);
    assert.equal(resolvedCommands.length, 2);

    // Deep links (watch, shorts, channels, search) must NOT be clobbered by FEtopics.
    for (const deepHash of ['#/watch?v=vid1', '#/shorts/short1', '#/browse?c=UC123', '#/results?search_query=test']) {
      fakeLocation.hash = deepHash;
      initUi(true);
    }
    assert.equal(resolvedCommands.length, 2);
    assert.equal(executedActions.length, 6);

    // Missing location defaults to Home startup; missing commandExecutor skips reloadGuideAction cleanly.
    delete globals.location;
    globals.window = {
      _yttv: {
        router: {
          instance: {
            resolveCommand: (cmd: unknown) => {
              resolvedCommands.push(cmd);
              return true;
            },
          },
        },
      },
    };
    initUi(true);
    assert.equal(resolvedCommands.length, 3);
  });

  test('ensureResolveHooksOnActionKey patches resolveCommand only on action keys', (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const origCalls: unknown[] = [];
    const origResolve = (cmd: unknown) => {
      origCalls.push(cmd);
      return true;
    };
    const host = { instance: { resolveCommand: origResolve } };
    globals.window = { _yttv: { host } };

    t.after(() => {
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
    });

    // Non-action key leaves resolveCommand unpatched.
    ensureResolveHooksOnActionKey({ key: 'ArrowDown', keyCode: 40 } as KeyboardEvent);
    assert.equal(host.instance.resolveCommand, origResolve);

    for (const keyEvent of [
      { key: 'Enter' },
      { key: ' ' },
      { keyCode: 13 },
      { keyCode: 23 },
      { keyCode: 32 },
    ] as unknown as KeyboardEvent[]) {
      host.instance.resolveCommand = origResolve;
      ensureResolveHooksOnActionKey(keyEvent);
      assert.notEqual(host.instance.resolveCommand, origResolve);
    }
  });
});
