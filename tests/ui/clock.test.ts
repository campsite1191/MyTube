import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { NOOP } from '../../mods/core/lifecycle.ts';
import { computeEndTimeLabel, formatClockTime, getNextClockDelayMs, initClock } from '../../mods/ui/clock.ts';

describe('clock helpers', () => {
  test('formatClockTime formats 24h HH:MM', () => {
    const date = new Date(2026, 0, 1, 14, 5, 9);
    assert.equal(formatClockTime(date), '14:05');

    const midnight = new Date(2026, 0, 1, 0, 7, 0);
    assert.equal(formatClockTime(midnight), '00:07');
  });

  test('computeEndTimeLabel projects end time and rounds >= 30s up', () => {
    const now = new Date(2026, 0, 1, 10, 0, 0);
    assert.equal(computeEndTimeLabel(now, 120, 0, 1), 'Ends 10:02');
    assert.equal(computeEndTimeLabel(now, 120, 0, 2), 'Ends 10:01');
    assert.equal(computeEndTimeLabel(now, 90, 0, 1), 'Ends 10:02');
    assert.equal(computeEndTimeLabel(now, 120, 0, 0), 'Ends 10:02');
    assert.equal(computeEndTimeLabel(now, Number.POSITIVE_INFINITY, 0, 1), '');
  });

  test('getNextClockDelayMs aligns to next minute boundary', () => {
    const midMinute = new Date(2026, 0, 1, 10, 0, 15, 250);
    assert.equal(getNextClockDelayMs(midMinute), 44_750);
  });

  test('initClock installs #f1f1f1 Roboto clock and updates Watch end-time via onWatchSession', (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevDocument = globals.document;
    const prevLocation = globals.location;
    const prevCssStyleSheet = globals.CSSStyleSheet;

    t.after(() => {
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
      if (prevLocation === undefined) delete globals.location;
      else globals.location = prevLocation;
      if (prevCssStyleSheet === undefined) delete globals.CSSStyleSheet;
      else globals.CSSStyleSheet = prevCssStyleSheet;
    });

    const adopted: Array<{ cssText: string }> = [];
    globals.CSSStyleSheet = class {
      cssText = '';
      replaceSync(text: string): void {
        this.cssText = text;
      }
    };

    interface MockClockEl {
      id: string;
      className: string;
      textContent: string;
      isConnected: boolean;
      style: { display: string };
      children: MockClockEl[];
      appendChild: (child: MockClockEl) => MockClockEl;
    }
    const windowListeners = new Map<string, Set<() => void>>();
    const makeEl = (): MockClockEl => ({
      id: '',
      className: '',
      textContent: '',
      isConnected: true,
      style: { display: '' },
      children: [],
      appendChild(child: MockClockEl): MockClockEl {
        this.children.push(child);
        return child;
      },
    });
    const fakeBody = makeEl();
    const fakeVideo = {
      duration: 120,
      currentTime: 0,
      playbackRate: 1,
      ended: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    const fakeLocation = { hash: '#/', search: '' };
    globals.location = fakeLocation;
    globals.window = {
      location: fakeLocation,
      addEventListener: (type: string, cb: () => void) => {
        const set = windowListeners.get(type) ?? new Set();
        set.add(cb);
        windowListeners.set(type, set);
      },
      removeEventListener: (type: string, cb: () => void) => {
        windowListeners.get(type)?.delete(cb);
      },
    };
    const createdElements: MockClockEl[] = [];
    const fakeDoc = {
      body: fakeBody,
      documentElement: fakeBody,
      hidden: true,
      adoptedStyleSheets: adopted,
      getElementById: (id: string) => createdElements.find((el) => el.id === id) ?? null,
      createElement: () => {
        const el = makeEl();
        createdElements.push(el);
        return el;
      },
      querySelector: (selector: string) => (selector === 'video' ? fakeVideo : null),
      querySelectorAll: () => [],
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    globals.document = fakeDoc;

    const uninstallClock = initClock();

    const css = fakeDoc.adoptedStyleSheets.map((s) => s.cssText).join('\n');
    assert.match(css, /color:\s*#f1f1f1/);
    assert.match(css, /font-family:\s*'Roboto'/);
    assert.doesNotMatch(css, /'YTSans'/);
    assert.doesNotMatch(css, /\.tt-clock-end\s*\{[^}]*(?:color|opacity)\s*:/);
    assert.doesNotMatch(css, /#aaaaaa/i);

    const endEl = fakeBody.children[0]?.children[0]?.children[1];
    assert.equal(endEl?.textContent, '');

    fakeLocation.hash = '#/watch?v=clockTestVid';
    for (const cb of windowListeners.get('hashchange') ?? []) cb();
    assert.ok(endEl?.textContent.startsWith('Ends '), `Expected Ends HH:MM, got ${endEl?.textContent}`);

    fakeLocation.hash = '#/';
    for (const cb of windowListeners.get('hashchange') ?? []) cb();
    assert.equal(endEl?.textContent, '');
    uninstallClock();
  });

  test('initClock schedules minute-boundary ticks when visible, pauses when hidden, and stops when disconnected', (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevDocument = globals.document;
    const prevLocation = globals.location;
    const prevCssStyleSheet = globals.CSSStyleSheet;
    const prevSetTimeout = globals.setTimeout;
    const prevClearTimeout = globals.clearTimeout;

    const scheduled: Array<{ id: number; delay: number; cb: () => void }> = [];
    const cleared: number[] = [];
    let nextId = 1;
    globals.setTimeout = ((cb: () => void, delay: number) => {
      const id = nextId++;
      scheduled.push({ id, delay, cb });
      return id;
    }) as unknown as typeof setTimeout;
    globals.clearTimeout = ((id: number) => {
      cleared.push(id);
    }) as unknown as typeof clearTimeout;
    globals.CSSStyleSheet = class {
      replaceSync(): void {}
    };

    const docListeners = new Map<string, Set<() => void>>();
    const makeEl = () => ({
      id: '',
      className: '',
      textContent: '',
      isConnected: true,
      style: { display: '' },
      children: [] as unknown[],
      appendChild(c: unknown) {
        this.children.push(c);
        return c;
      },
      remove() {
        this.isConnected = false;
      },
    });
    const fakeBody = makeEl();
    let clockNode: ReturnType<typeof makeEl> | null = null;
    const fakeDoc: {
      body: ReturnType<typeof makeEl> | null;
      documentElement: ReturnType<typeof makeEl> | null;
      hidden: boolean;
      adoptedStyleSheets: unknown[];
      getElementById: () => unknown;
      createElement: () => ReturnType<typeof makeEl>;
      addEventListener: (type: string, fn: () => void) => void;
      removeEventListener: (type: string, fn: () => void) => void;
    } = {
      body: fakeBody,
      documentElement: fakeBody,
      hidden: false,
      adoptedStyleSheets: [],
      getElementById: () => null,
      createElement: () => {
        const el = makeEl();
        if (!clockNode) clockNode = el;
        return el;
      },
      addEventListener: (type: string, fn: () => void) => {
        const set = docListeners.get(type) ?? new Set();
        set.add(fn);
        docListeners.set(type, set);
      },
      removeEventListener: (type: string, fn: () => void) => {
        docListeners.get(type)?.delete(fn);
      },
    };
    globals.location = { hash: '#/', search: '' };
    globals.window = {
      location: globals.location,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    globals.document = fakeDoc;

    let uninstall = () => {};
    t.after(() => {
      uninstall();
      globals.setTimeout = prevSetTimeout;
      globals.clearTimeout = prevClearTimeout;
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
      if (prevLocation === undefined) delete globals.location;
      else globals.location = prevLocation;
      if (prevCssStyleSheet === undefined) delete globals.CSSStyleSheet;
      else globals.CSSStyleSheet = prevCssStyleSheet;
    });

    uninstall = initClock();
    assert.equal(scheduled.length, 1);

    // Executing scheduled tick clears prior tick abort and schedules the next minute boundary.
    scheduled[0]?.cb();
    assert.equal(scheduled.length, 2);

    // Going hidden aborts pending tick without scheduling a new one; becoming visible resumes ticks.
    fakeDoc.hidden = true;
    for (const fn of docListeners.get('visibilitychange') ?? []) fn();
    const secondTickId = scheduled[1]?.id;
    assert.ok(secondTickId !== undefined && cleared.includes(secondTickId));
    assert.equal(scheduled.length, 2);

    fakeDoc.hidden = false;
    for (const fn of docListeners.get('visibilitychange') ?? []) fn();
    assert.equal(scheduled.length, 3);

    // Disconnected clock stops scheduling cleanly.
    const activeClock = clockNode as ReturnType<typeof makeEl> | null;
    assert.ok(activeClock);
    activeClock.isConnected = false;
    scheduled[2]?.cb();
    assert.equal(scheduled.length, 3);
    uninstall();

    // Early guards: missing root returns NOOP, existing #custom-clock returns NOOP, and documentElement fallback mounts when body is null.
    const docElem = makeEl();
    fakeDoc.body = null;
    fakeDoc.documentElement = null;
    assert.equal(initClock(), NOOP);

    fakeDoc.documentElement = docElem;
    const stopElemClock = initClock();
    assert.equal(docElem.children.length, 1);
    fakeDoc.getElementById = () => docElem.children[0] ?? null;
    assert.equal(initClock(), NOOP);
    stopElemClock();
  });
});
