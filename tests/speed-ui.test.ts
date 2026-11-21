import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  formatPlaybackSpeedLabel,
  getActivePlaybackSpeed,
  setPlaybackSpeed,
  speedSettings,
} from '../mods/ui/speed-ui.ts';

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

  test('getActivePlaybackSpeed and formatPlaybackSpeedLabel reflect the active video without carryover', (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevDocument = globals.document;

    let playbackRateValue = 1;
    const fakeVideo = {
      get playbackRate() {
        return playbackRateValue;
      },
      set playbackRate(val: number) {
        playbackRateValue = val;
      },
    };

    const resolvedCmds: unknown[] = [];
    globals.window = {
      location: { hash: '#/watch?v=speedVid1', search: '' },
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
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
    });

    assert.equal(getActivePlaybackSpeed(), 1);
    assert.equal(formatPlaybackSpeedLabel(), '1x');

    setPlaybackSpeed(1.25);
    assert.equal(playbackRateValue, 1.25);
    assert.equal(getActivePlaybackSpeed(), 1.25);
    assert.equal(formatPlaybackSpeedLabel(), '1.25x');

    speedSettings();
    const lastCmd = resolvedCmds.at(-1) as {
      openPopupAction?: {
        popup?: {
          overlaySectionRenderer?: {
            overlay?: {
              overlayTwoPanelRenderer?: {
                actionPanel?: {
                  overlayPanelRenderer?: {
                    content?: {
                      overlayPanelItemListRenderer?: {
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
    // 0.25x(0), 0.5x(1), 0.75x(2), 1x(3), 1.25x(4)
    assert.equal(
      lastCmd.openPopupAction?.popup?.overlaySectionRenderer?.overlay?.overlayTwoPanelRenderer?.actionPanel
        ?.overlayPanelRenderer?.content?.overlayPanelItemListRenderer?.selectedIndex,
      4
    );

    // Simulate switching to a new video that resets playbackRate to 1 — no carryover
    playbackRateValue = 1;
    assert.equal(getActivePlaybackSpeed(), 1);
    assert.equal(formatPlaybackSpeedLabel(), '1x');

    // Missing video element falls back cleanly to 1x
    globals.document = { querySelector: () => null };
    assert.equal(getActivePlaybackSpeed(), 1);
    assert.equal(formatPlaybackSpeedLabel(), '1x');
  });
});
