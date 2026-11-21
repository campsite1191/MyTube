import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { configRead, configWrite, onConfigChange } from '../mods/core/config.ts';
import { observeDom, onAbort, scheduleAbortableTimeout } from '../mods/core/lifecycle.ts';

describe('AbortSignal lifecycle helpers', () => {
  test('onAbort runs cleanup on abort or immediately when already aborted', () => {
    const controller = new AbortController();
    let count = 0;

    onAbort(controller.signal, () => {
      count++;
    });
    assert.equal(count, 0);

    controller.abort();
    assert.equal(count, 1);

    // Already aborted signals execute synchronously once and undefined signals no-op.
    onAbort(controller.signal, () => {
      count++;
    });
    onAbort(undefined, () => {
      count++;
    });
    assert.equal(count, 2);
  });

  test('observeDom disconnects automatically on abort and returns null when already aborted', () => {
    const globals = globalThis as Record<string, unknown>;
    const prevObserver = globals.MutationObserver;
    let disconnectCount = 0;

    globals.MutationObserver = class {
      observe(): void {}
      disconnect(): void {
        disconnectCount++;
      }
    };

    try {
      const controller = new AbortController();
      const target = {} as Node;
      const obs = observeDom(target, () => {}, { childList: true }, controller.signal);
      assert.ok(obs !== null);
      assert.equal(disconnectCount, 0);

      controller.abort();
      assert.equal(disconnectCount, 1);

      const skipped = observeDom(target, () => {}, { childList: true }, controller.signal);
      assert.equal(skipped, null);
    } finally {
      globals.MutationObserver = prevObserver;
    }
  });

  test('scheduleAbortableTimeout cancels pending callback on abort and fires normally otherwise', async () => {
    const abortController = new AbortController();
    let abortedRan = false;
    scheduleAbortableTimeout(
      () => {
        abortedRan = true;
      },
      10,
      abortController.signal
    );
    abortController.abort();

    const activeController = new AbortController();
    let completed = false;
    scheduleAbortableTimeout(
      () => {
        completed = true;
      },
      10,
      activeController.signal
    );

    await new Promise((r) => setTimeout(r, 35));
    assert.equal(abortedRan, false);
    assert.equal(completed, true);
  });
});

describe('onConfigChange helper', () => {
  test('filters config change notifications by key and supports unsubscribe and AbortSignal', async () => {
    const prevClock = configRead('enableClock');
    const prev12h = configRead('isClock12HourFormat');
    const seen: string[] = [];

    const controller = new AbortController();
    const stopMulti = onConfigChange(
      ['enableClock', 'isClock12HourFormat'],
      (value, key) => {
        seen.push(`${key}:${String(value)}`);
      },
      { signal: controller.signal }
    );
    const stopSingle = onConfigChange('enableClock', (value) => {
      seen.push(`single:${String(value)}`);
    });

    try {
      await configWrite('enableShorts', configRead('enableShorts'));
      await configWrite('enableClock', !prevClock);
      await configWrite('isClock12HourFormat', !prev12h);
      assert.deepEqual(seen, [
        `enableClock:${String(!prevClock)}`,
        `single:${String(!prevClock)}`,
        `isClock12HourFormat:${String(!prev12h)}`,
      ]);

      controller.abort();
      stopSingle();
      stopMulti();
      await configWrite('enableClock', prevClock);
      assert.equal(seen.length, 3);
    } finally {
      await configWrite('enableClock', prevClock);
      await configWrite('isClock12HourFormat', prev12h);
    }
  });
});
