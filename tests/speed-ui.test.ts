import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { installSpeedControls, setPlaybackSpeed, speedSettings } from '../mods/ui/speed-ui.ts';

interface ModalItem {
  compactLinkRenderer?: {
    title?: { simpleText?: string };
    serviceEndpoint?: {
      commandExecutorCommand?: {
        commands?: Array<{ customAction?: { action?: string; parameters?: string } }>;
      };
    };
  };
}

describe('speed-ui', () => {
  test('setPlaybackSpeed validates range, updates video without redundant writes, and speedSettings highlights 1.0001x cleanly', (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevDocument = globals.document;

    let rateWrites = 0;
    let playbackRateValue = 1;
    const fakeVideo = {
      get playbackRate() {
        return playbackRateValue;
      },
      set playbackRate(val: number) {
        rateWrites++;
        playbackRateValue = val;
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    };

    const resolvedCmds: unknown[] = [];
    globals.window = {
      location: { hash: '#/', search: '' },
      addEventListener: () => {},
      removeEventListener: () => {},
      _yttv: {
        router: {
          instance: {
            resolveCommand: (cmd: unknown) => {
              resolvedCmds.push(cmd);
              return true;
            },
          },
        },
      },
    };
    globals.document = {
      querySelector: (sel: string) => (sel === 'video' ? fakeVideo : null),
    };

    t.after(() => {
      setPlaybackSpeed(1);
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
    });

    // Rejects invalid speeds
    setPlaybackSpeed(0);
    setPlaybackSpeed(-1);
    setPlaybackSpeed(Number.NaN);
    setPlaybackSpeed(6);
    assert.equal(rateWrites, 0);

    // Selecting 1x when already 1 avoids redundant playbackRate write
    setPlaybackSpeed(1);
    assert.equal(rateWrites, 0);

    // Highlights Fix Stuttering (1.0001x) at the end of the modal list
    setPlaybackSpeed(1.0001);
    assert.equal(playbackRateValue, 1.0001);
    assert.equal(rateWrites, 1);

    speedSettings();
    const lastCmd = resolvedCmds.at(-1) as {
      openPopupAction?: {
        uniqueId?: string;
        popup?: {
          overlaySectionRenderer?: {
            overlay?: {
              overlayTwoPanelRenderer?: {
                actionPanel?: {
                  overlayPanelRenderer?: {
                    content?: {
                      overlayPanelItemListRenderer?: {
                        items?: ModalItem[];
                        selectedIndex?: number;
                      };
                    };
                  };
                };
              };
            };
          };
        };
      };
    };

    assert.equal(lastCmd.openPopupAction?.uniqueId, 'tt-speed');
    const list =
      lastCmd.openPopupAction?.popup?.overlaySectionRenderer?.overlay?.overlayTwoPanelRenderer?.actionPanel
        ?.overlayPanelRenderer?.content?.overlayPanelItemListRenderer;
    assert.equal(list?.items?.length, 21);
    assert.equal(list?.selectedIndex, 20);
    assert.equal(
      list?.items?.[20]?.compactLinkRenderer?.serviceEndpoint?.commandExecutorCommand?.commands?.[1]?.customAction
        ?.parameters,
      '1.0001'
    );
  });

  test('installSpeedControls applies playback speed on Watch sessions and ignores Home previews', (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevDocument = globals.document;

    const winListeners = new Map<string, Set<() => void>>();
    const videoListeners = new Map<string, Set<() => void>>();
    let playbackRateValue = 1;
    let rateWrites = 0;
    const fakeVideo = {
      get playbackRate() {
        return playbackRateValue;
      },
      set playbackRate(val: number) {
        rateWrites++;
        playbackRateValue = val;
      },
      addEventListener: (type: string, cb: () => void, options?: { signal?: AbortSignal }) => {
        if (options?.signal?.aborted) return;
        const set = videoListeners.get(type) ?? new Set();
        set.add(cb);
        videoListeners.set(type, set);
        options?.signal?.addEventListener('abort', () => set.delete(cb), { once: true });
      },
      removeEventListener: (type: string, cb: () => void) => {
        videoListeners.get(type)?.delete(cb);
      },
    };

    const fakeLocation = { hash: '#/', search: '' };
    globals.window = {
      location: fakeLocation,
      addEventListener: (type: string, cb: () => void) => {
        const set = winListeners.get(type) ?? new Set();
        set.add(cb);
        winListeners.set(type, set);
      },
      removeEventListener: (type: string, cb: () => void) => {
        winListeners.get(type)?.delete(cb);
      },
    };
    globals.document = {
      querySelector: (sel: string) => (sel === 'video' ? fakeVideo : null),
    };

    t.after(() => {
      setPlaybackSpeed(1);
      fakeLocation.hash = '#/';
      for (const cb of winListeners.get('hashchange') ?? []) cb();
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
    });

    setPlaybackSpeed(1.5);
    assert.equal(playbackRateValue, 1.5);

    installSpeedControls();
    // Calling a second time is a no-op
    installSpeedControls();

    // Still on Home (#/) -> no listeners bound to video, preview resetting to 1x stays untouched
    assert.equal(videoListeners.get('canplay')?.size ?? 0, 0);
    playbackRateValue = 1;
    rateWrites = 0;

    // Entering Watch binds loadedmetadata & canplay and restores 1.5x
    fakeLocation.hash = '#/watch?v=speedVid1';
    for (const cb of winListeners.get('hashchange') ?? []) cb();
    assert.equal(playbackRateValue, 1.5);
    assert.equal(rateWrites, 1);
    assert.equal(videoListeners.get('canplay')?.size, 1);

    // Repeating canplay when already 1.5x performs zero redundant writes
    for (const cb of videoListeners.get('canplay') ?? []) cb();
    assert.equal(rateWrites, 1);

    // Leaving Watch cleans up listeners automatically via AbortSignal
    fakeLocation.hash = '#/';
    for (const cb of winListeners.get('hashchange') ?? []) cb();
    assert.equal(videoListeners.get('canplay')?.size, 0);
  });
});
