import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { preconnectOrigins, schedulePostFirstPaint } from '../mods/core/idle-scheduler.ts';

describe('schedulePostFirstPaint', () => {
  test('runs synchronously when window is unavailable (SSR / Node)', () => {
    let called = false;
    schedulePostFirstPaint(() => {
      called = true;
    });
    assert.equal(called, true);
  });

  test('uses requestIdleCallback when provided on window', (t) => {
    let idleTimeout: number | undefined;
    let called = false;
    (globalThis as Record<string, unknown>).window = {
      requestIdleCallback: (cb: () => void, opts?: { timeout?: number }) => {
        idleTimeout = opts?.timeout;
        cb();
        return 1;
      },
    };
    t.after(() => {
      delete (globalThis as Record<string, unknown>).window;
    });

    schedulePostFirstPaint(() => {
      called = true;
    });
    assert.equal(called, true);
    assert.equal(idleTimeout, 1000);
  });

  test('falls back to setTimeout when requestIdleCallback is absent', async () => {
    const prevWindow = (globalThis as Record<string, unknown>).window;
    (globalThis as Record<string, unknown>).window = {};
    let called = false;

    try {
      await new Promise<void>((resolve) => {
        schedulePostFirstPaint(() => {
          called = true;
          resolve();
        });
        assert.equal(called, false);
      });
      assert.equal(called, true);
    } finally {
      if (prevWindow === undefined) {
        delete (globalThis as Record<string, unknown>).window;
      } else {
        (globalThis as Record<string, unknown>).window = prevWindow;
      }
    }
  });
});

describe('preconnectOrigins', () => {
  test('appends unique preconnect link tags into document.head and ignores missing DOM', () => {
    assert.doesNotThrow(() => preconnectOrigins(['https://sponsor.ajay.app'], undefined));

    const appended: Array<{ rel?: string; href?: string; crossOrigin?: string }> = [];
    const fakeDoc = {
      head: {
        appendChild: (node: { rel?: string; href?: string; crossOrigin?: string }) => {
          appended.push(node);
          return node;
        },
      },
      querySelector: (selector: string) =>
        appended.find((item) => selector === `link[rel="preconnect"][href="${item.href}"]`) ?? null,
      createElement: () => ({}),
    } as unknown as Document;

    preconnectOrigins(
      ['https://sponsor.ajay.app', 'https://returnyoutubedislikeapi.com', 'https://sponsor.ajay.app'],
      fakeDoc
    );
    assert.equal(appended.length, 2);
    assert.deepEqual(appended[0], {
      rel: 'preconnect',
      href: 'https://sponsor.ajay.app',
      crossOrigin: 'anonymous',
    });
    assert.deepEqual(appended[1], {
      rel: 'preconnect',
      href: 'https://returnyoutubedislikeapi.com',
      crossOrigin: 'anonymous',
    });
  });
});
