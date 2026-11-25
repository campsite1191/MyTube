import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { installSponsorBlock } from '../../mods/features/sponsorblock.ts';
import {
  injectChapters,
  installTransportControlsStyles,
  recordTransportLikeCount,
  transformPlayerOverlays,
  transformTransportControls,
} from '../../mods/transforms/player-overlays.ts';

describe('player-overlays transforms', () => {
  test('injectChapters inserts synthetic macroMarkersListEntity and defers loadMarkersCommand', async (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const dispatched: unknown[] = [];

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

    t.after(() => {
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
    });

    // No chapters -> no-op.
    const noChapters: Record<string, unknown> = { videoDetails: { videoId: 'v0', shortDescription: 'plain text' } };
    injectChapters(noChapters);
    assert.equal('frameworkUpdates' in noChapters, false);

    // Valid description chapters -> injects mutation and schedules loadMarkersCommand via microtask.
    const withChapters: Record<string, unknown> = {
      videoDetails: {
        videoId: 'chapVid1',
        lengthSeconds: '180',
        shortDescription: '0:00 Intro\n1:00 Main\n2:00 Outro',
      },
    };
    injectChapters(withChapters);
    const mutations = (
      withChapters.frameworkUpdates as { entityBatchUpdate: { mutations: Array<{ entityKey: string }> } }
    ).entityBatchUpdate.mutations;
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0]?.entityKey, 'chapVid1-key');
    // Deferred via microtask so payload returns before loadMarkersCommand executes.
    assert.equal(dispatched.length, 0);

    await Promise.resolve();
    assert.deepEqual(dispatched, [
      {
        clickTrackingParams: null,
        loadMarkersCommand: {
          visibleOnLoadKeys: ['chapVid1-key'],
          entityKeys: ['chapVid1-key'],
        },
      },
    ]);
  });

  test('transformPlayerOverlays strips shopping/watermark items and initializes missing timelyActionRenderers', () => {
    const missingList: Record<string, unknown> = {
      playerOverlays: { playerOverlayRenderer: {} },
    };
    transformPlayerOverlays(missingList);
    assert.deepEqual(
      (missingList.playerOverlays as { playerOverlayRenderer: { timelyActionRenderers: unknown[] } })
        .playerOverlayRenderer.timelyActionRenderers,
      []
    );

    const withAds: Record<string, unknown> = {
      playerOverlays: {
        playerOverlayRenderer: {
          timelyActionRenderers: [
            { timelyActionRenderer: { type: 'TIMELY_ACTION_TYPE_SHOPPING' } },
            { timelyActionRenderer: { type: 'TIMELY_ACTION_TYPE_NFL_WATERMARK' } },
            { timelyActionRenderer: { type: 'TIMELY_ACTION_TYPE_INFO' } },
          ],
        },
      },
    };
    transformPlayerOverlays(withAds);
    const kept = (withAds.playerOverlays as { playerOverlayRenderer: { timelyActionRenderers: unknown[] } })
      .playerOverlayRenderer.timelyActionRenderers;
    assert.equal(kept.length, 1);
  });

  test('recordTransportLikeCount extracts likes across direct and nested renderers and skips missing fields', (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    globals.window = { location: { hash: '#/', search: '' } };
    t.after(() => {
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
    });

    // Missing tc or videoId -> no-op.
    assert.doesNotThrow(() => recordTransportLikeCount({}));
    assert.doesNotThrow(() =>
      recordTransportLikeCount({ transportControls: { transportControlsRenderer: { actions: [] } } })
    );

    // Direct likeButtonRenderer and alternate likeCountWithLikeText / likeCountWithUnlikeText fields.
    assert.doesNotThrow(() =>
      recordTransportLikeCount({
        playerResponse: { videoDetails: { videoId: 'likeVid1' } },
        transportControls: {
          transportControlsRenderer: {
            promotedActions: [null, { button: { buttonRenderer: {} } }],
            actions: [{ likeButtonRenderer: { likeCountWithLikeText: { simpleText: '4.2K' } } }],
          },
        },
      })
    );
    assert.doesNotThrow(() =>
      recordTransportLikeCount({
        videoDetails: { videoId: 'likeVid2' },
        transportControls: {
          transportControlsRenderer: {
            buttons: [{ likeButtonRenderer: { likeCountWithUnlikeText: { simpleText: '900' } } }],
          },
        },
      })
    );
  });

  test('transformTransportControls strips subscribe, prev/next, and report/feedback buttons across variants', () => {
    const payload: Record<string, unknown> = {
      playerOverlays: {
        playerOverlayRenderer: {
          transportControls: {
            transportControlsRenderer: {
              promotedActions: [
                null,
                { type: 'TRANSPORT_CONTROLS_BUTTON_TYPE_SUBSCRIBE' },
                { subscribeButton: {} },
                { subscribeButtonRenderer: {} },
                { button: { subscribeButtonRenderer: {} } },
                { previousButtonRenderer: {} },
                { button: { nextButtonRenderer: {} } },
                { button: { buttonRenderer: { navigationEndpoint: { subscribeEndpoint: {} } } } },
                { button: { buttonRenderer: { command: { unsubscribeEndpoint: {} } } } },
                { button: { buttonRenderer: { navigationEndpoint: { subscribeCommand: {} } } } },
                { button: { buttonRenderer: { icon: { iconType: 'SUBSCRIBE' } } } },
                {
                  button: {
                    buttonRenderer: { navigationEndpoint: { signalAction: { signal: 'PLAYER_PLAY_PREVIOUS' } } },
                  },
                },
                { button: { buttonRenderer: { icon: { iconType: 'SKIP_NEXT' } } } },
                { type: 'TRANSPORT_CONTROLS_BUTTON_TYPE_REPORT' },
                { button: { buttonRenderer: { icon: { iconType: 'FLAG' } } } },
                { buttonRenderer: { text: { simpleText: 'Report video' } } },
                { button: { buttonRenderer: { navigationEndpoint: { sendFeedbackEndpoint: {} } } } },
                { button: { buttonRenderer: { icon: { iconType: 'CAPTIONS' } } } },
              ],
            },
          },
        },
      },
    };

    transformTransportControls(payload);
    const kept = (
      payload.playerOverlays as {
        playerOverlayRenderer: { transportControls: { transportControlsRenderer: { promotedActions: unknown[] } } };
      }
    ).playerOverlayRenderer.transportControls.transportControlsRenderer.promotedActions;
    assert.deepEqual(kept, [null, { button: { buttonRenderer: { icon: { iconType: 'CAPTIONS' } } } }]);
  });

  test('reuses existing frameworkUpdates, handles missing promotedActions/like text, and skips duplicate or missing POI highlight', async (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevDocument = globals.document;
    const prevFetch = globals.fetch;
    const prevMutationObserver = globals.MutationObserver;
    const prevCssStyleSheet = globals.CSSStyleSheet;

    const winListeners = new Map<string, Set<() => void>>();
    const fakeLocation = { hash: '#/watch?v=poEdgeVid', search: '' };
    const existingMutations: unknown[] = [{ existing: true }];
    const existingFwPayload: Record<string, unknown> = {
      videoDetails: {
        videoId: 'poEdgeVid',
        lengthSeconds: '120',
        shortDescription: '0:00 Start\n1:00 End',
      },
      frameworkUpdates: {
        entityBatchUpdate: {
          mutations: existingMutations,
        },
      },
    };
    injectChapters(existingFwPayload);
    assert.equal(existingMutations.length, 2);

    // recordTransportLikeCount traverses empty buttons and returns cleanly when no text exists.
    recordTransportLikeCount({
      currentVideoEndpoint: { watchEndpoint: { videoId: 'poEdgeVid' } },
      transportControls: {
        transportControlsRenderer: {
          actions: [{ button: { likeButtonRenderer: {} } }],
        },
      },
    });

    // transformTransportControls returns early when promotedActions is absent.
    transformTransportControls({
      transportControls: {
        transportControlsRenderer: {
          actions: [{ button: { buttonRenderer: { icon: { iconType: 'CAPTIONS' } } } }],
        },
      },
    });

    // SponsorBlock skip-only segments cover duplicate highlight short-circuit and missing POI fallback.
    globals.CSSStyleSheet = class {
      replaceSync(): void {}
    };
    globals.MutationObserver = class {
      observe(): void {}
      disconnect(): void {}
    };
    globals.window = {
      location: fakeLocation,
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
      body: {},
      documentElement: {},
      adoptedStyleSheets: [],
      querySelector: () => null,
    };
    globals.fetch = (async () =>
      new Response(
        JSON.stringify([
          {
            videoID: 'poEdgeVid',
            segments: [{ UUID: 'skip1', category: 'sponsor', actionType: 'skip', segment: [5, 15] }],
          },
        ]),
        { status: 200 }
      )) as typeof fetch;

    const uninstall = installSponsorBlock();
    t.after(() => {
      uninstall();
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
      globals.fetch = prevFetch;
      if (prevMutationObserver === undefined) delete globals.MutationObserver;
      else globals.MutationObserver = prevMutationObserver;
      if (prevCssStyleSheet === undefined) delete globals.CSSStyleSheet;
      else globals.CSSStyleSheet = prevCssStyleSheet;
    });

    await new Promise((r) => setTimeout(r, 20));
    const dupHighlightPayload: Record<string, unknown> = {
      currentVideoEndpoint: { watchEndpoint: { videoId: 'poEdgeVid' } },
      transportControls: {
        transportControlsRenderer: {
          promotedActions: [{ type: 'TRANSPORT_CONTROLS_BUTTON_TYPE_SPONSORBLOCK_HIGHLIGHT' }],
        },
      },
    };
    transformTransportControls(dupHighlightPayload);

    const noHighlightPayload: Record<string, unknown> = {
      currentVideoEndpoint: { watchEndpoint: { videoId: 'poEdgeVid' } },
      transportControls: {
        transportControlsRenderer: {
          promotedActions: [null, { type: 'OTHER_BUTTON' }],
        },
      },
    };
    transformTransportControls(noHighlightPayload);
    assert.equal(
      (
        noHighlightPayload.transportControls as {
          transportControlsRenderer: { promotedActions: unknown[] };
        }
      ).transportControlsRenderer.promotedActions.length,
      2
    );
  });

  test('installTransportControlsStyles injects static display:none CSS once and no-ops without document', (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevDocument = globals.document;
    const prevCssStyleSheet = globals.CSSStyleSheet;
    t.after(() => {
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
      if (prevCssStyleSheet === undefined) delete globals.CSSStyleSheet;
      else globals.CSSStyleSheet = prevCssStyleSheet;
    });

    delete globals.document;
    installTransportControlsStyles();

    globals.CSSStyleSheet = class {
      cssText = '';
      replaceSync(text: string): void {
        this.cssText = text;
      }
    };
    const fakeDoc = { adoptedStyleSheets: [] as Array<{ cssText: string }> };
    globals.document = fakeDoc;

    installTransportControlsStyles();
    installTransportControlsStyles();

    assert.equal(fakeDoc.adoptedStyleSheets.length, 1);
    const css = fakeDoc.adoptedStyleSheets[0]?.cssText ?? '';
    assert.match(css, /\[idomkey="skipPrevious"\]/);
    assert.match(css, /\[idomkey="skipNext"\]/);
    assert.doesNotMatch(css, /WEB_PAGE_TYPE_SHORTS/);
    assert.match(css, /display:\s*none\s*!important/);
  });
});
