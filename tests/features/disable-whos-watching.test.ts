import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { installDisableWhosWatching, suppressWhosWatching } from '../../mods/features/disable-whos-watching.ts';

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

describe('suppressWhosWatching', () => {
  test('seeds recurring_actions synchronously on fresh install', (t) => {
    const storage = installMockLocalStorage();
    t.after(storage.restore);

    suppressWhosWatching();

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

    suppressWhosWatching();

    const parsed = JSON.parse(storage.map.get('yt.leanback.default::recurring_actions') || '{}');
    assert.equal(parsed.creation, 12345);
    assert.equal(parsed.data.data.unrelated_action.lastFired, 99);
    assert.ok(parsed.data.data['startup-screen-custom-prompt'].lastFired > Date.now() + 6 * 86400_000);
    assert.ok(parsed.data.data.whos_watching_fullscreen_zero_accounts.lastFired > Date.now() + 6 * 86400_000);
  });

  test('installDisableWhosWatching applies synchronously at startup without waiting for _yttv', (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const storage = installMockLocalStorage();
    globals.window = {};

    t.after(() => {
      storage.restore();
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
    });

    installDisableWhosWatching();

    // Runs synchronously right at document-start without waiting for window._yttv.
    const initialParsed = JSON.parse(storage.map.get('yt.leanback.default::recurring_actions') || '{}');
    assert.ok(
      initialParsed.data.data['startup-screen-account-selector-with-guest'].lastFired > Date.now() + 6 * 86400_000
    );
  });

  test('handles throwing localStorage, corrupt JSON, malformed nested data, and quota errors safely', (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevDesc = Object.getOwnPropertyDescriptor(globals, 'localStorage');
    t.after(() => {
      if (prevDesc) Object.defineProperty(globals, 'localStorage', prevDesc);
      else delete globals.localStorage;
    });

    // 1. Throwing localStorage getter returns cleanly.
    Object.defineProperty(globals, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError');
      },
    });
    assert.doesNotThrow(() => suppressWhosWatching());

    // 2. Corrupt JSON in storage returns early without overwriting.
    let setCalls = 0;
    Object.defineProperty(globals, 'localStorage', {
      configurable: true,
      writable: true,
      value: {
        getItem: () => '{broken-json',
        setItem: () => {
          setCalls++;
        },
      },
    });
    suppressWhosWatching();
    assert.equal(setCalls, 0);

    // 3. Non-object recurringActions.data and outerData.data are repaired, and setItem throw is ignored.
    let stored = JSON.stringify({ data: 'bad', creation: 1 });
    Object.defineProperty(globals, 'localStorage', {
      configurable: true,
      writable: true,
      value: {
        getItem: () => stored,
        setItem: (_k: string, val: string) => {
          stored = val;
        },
      },
    });
    suppressWhosWatching();
    const repairedOuter = JSON.parse(stored);
    assert.ok(repairedOuter.data.data['startup-screen-account-selector-with-guest'].lastFired > Date.now());

    stored = JSON.stringify({ data: { data: 'not-an-object' } });
    Object.defineProperty(globals, 'localStorage', {
      configurable: true,
      writable: true,
      value: {
        getItem: () => stored,
        setItem: () => {
          throw new Error('QuotaExceededError');
        },
      },
    });
    assert.doesNotThrow(() => suppressWhosWatching());

    // Missing localStorage and missing window/repeat install return early safely.
    const prevWindow = globals.window;
    Object.defineProperty(globals, 'localStorage', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    assert.doesNotThrow(() => suppressWhosWatching());

    delete globals.window;
    installDisableWhosWatching();
    globals.window = {};
    installDisableWhosWatching();
    installDisableWhosWatching();
    if (prevWindow === undefined) delete globals.window;
    else globals.window = prevWindow;
  });
});
