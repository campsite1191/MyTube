import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, test } from 'node:test';
import { configWrite } from '../mods/core/config.ts';
import { applyWhosWatchingPolicy, installDisableWhosWatching } from '../mods/features/disable-whos-watching.ts';

const requireFromMods = createRequire(new URL('../mods/package.json', import.meta.url));
const { IDBFactory } = requireFromMods('fake-indexeddb') as { IDBFactory: typeof globalThis.IDBFactory };

function installMockLocalStorage(initial: Record<string, string> = {}): {
  map: Map<string, string>;
  restore: () => void;
} {
  const globals = globalThis as Record<string, unknown>;
  const prevStorage = globals.localStorage;
  const map = new Map<string, string>(Object.entries(initial));
  globals.localStorage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
  return {
    map,
    restore: () => {
      if (prevStorage === undefined) delete globals.localStorage;
      else globals.localStorage = prevStorage;
    },
  };
}

describe('applyWhosWatchingPolicy', () => {
  test('seeds recurring_actions synchronously on fresh install when disabled', (t) => {
    const storage = installMockLocalStorage();
    t.after(storage.restore);

    applyWhosWatchingPolicy(false, false);

    const parsed = JSON.parse(storage.map.get('yt.leanback.default::recurring_actions') || '{}');
    const data = parsed?.data?.data;
    assert.ok(data, 'Created recurring_actions structure on fresh install');
    const minExpected = Date.now() + 6 * 24 * 60 * 60 * 1000;
    assert.ok(data['startup-screen-account-selector-with-guest'].lastFired > minExpected);
    assert.ok(data.whos_watching_fullscreen_zero_accounts.lastFired > minExpected);
    assert.ok(data['startup-screen-signed-out-welcome-back'].lastFired > minExpected);
  });

  test('preserves unrelated entries while pushing all startup-screen and whos_watching keys ahead', (t) => {
    const storage = installMockLocalStorage({
      'yt.leanback.default::recurring_actions': JSON.stringify({
        creation: 12345,
        data: {
          data: {
            'startup-screen-account-selector-with-guest': { lastFired: 10 },
            'startup-screen-custom-prompt': { lastFired: 20 },
            unrelated_action: { lastFired: 99 },
          },
        },
      }),
    });
    t.after(storage.restore);

    applyWhosWatchingPolicy(false, false);

    const parsed = JSON.parse(storage.map.get('yt.leanback.default::recurring_actions') || '{}');
    assert.equal(parsed.creation, 12345);
    assert.equal(parsed.data.data.unrelated_action.lastFired, 99);
    assert.ok(parsed.data.data['startup-screen-custom-prompt'].lastFired > Date.now() + 6 * 86400_000);
    assert.ok(parsed.data.data.whos_watching_fullscreen_zero_accounts.lastFired > Date.now() + 6 * 86400_000);
  });

  test('installDisableWhosWatching applies synchronously at startup without waiting for _yttv and reacts to config', async (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevIndexedDb = globals.indexedDB;
    const storage = installMockLocalStorage();
    globals.window = {};
    globals.indexedDB = new IDBFactory();

    t.after(async () => {
      await configWrite('permanentlyEnableWhoIsWatchingMenu', false);
      await configWrite('enableWhoIsWatchingMenu', false);
      storage.restore();
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevIndexedDb === undefined) delete globals.indexedDB;
      else globals.indexedDB = prevIndexedDb;
    });

    installDisableWhosWatching();

    // Runs synchronously right at document-start without waiting for window._yttv.
    const initialParsed = JSON.parse(storage.map.get('yt.leanback.default::recurring_actions') || '{}');
    assert.ok(
      initialParsed.data.data['startup-screen-account-selector-with-guest'].lastFired > Date.now() + 6 * 86400_000
    );

    // Enabling permanent mode rewinds timestamps 7 days into the past and disabling pushes them ahead again.
    await configWrite('permanentlyEnableWhoIsWatchingMenu', true);
    await configWrite('enableWhoIsWatchingMenu', true);
    const enabledParsed = JSON.parse(storage.map.get('yt.leanback.default::recurring_actions') || '{}');
    assert.ok(
      enabledParsed.data.data['startup-screen-account-selector-with-guest'].lastFired < Date.now() - 6 * 86400_000
    );

    await configWrite('enableWhoIsWatchingMenu', false);
    const disabledParsed = JSON.parse(storage.map.get('yt.leanback.default::recurring_actions') || '{}');
    assert.ok(
      disabledParsed.data.data['startup-screen-account-selector-with-guest'].lastFired > Date.now() + 6 * 86400_000
    );
  });
});
