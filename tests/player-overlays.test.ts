import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  injectChapters,
  recordTransportLikeCount,
  transformPlayerOverlays,
  transformTransportControls,
} from '../mods/transforms/player-overlays.ts';

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
});
