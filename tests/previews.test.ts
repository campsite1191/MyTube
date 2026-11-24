import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { addPreviews } from '../mods/transforms/previews.ts';
import type { FeedItem } from '../mods/types/innertube.ts';

describe('addPreviews', () => {
  test('ignores non-array inputs and non-record entries safely', () => {
    addPreviews(null as unknown as FeedItem[]);
    const items = [null, 'invalid'] as unknown as FeedItem[];
    addPreviews(items);
    assert.deepEqual(items, [null, 'invalid']);
  });

  test('injects muted inline previews for tileRenderer, lockupViewModel, and shortsLockupViewModel', () => {
    const items = [
      {
        tileRenderer: {
          onSelectCommand: {
            watchEndpoint: { videoId: 'tile123', endTimeSeconds: 42, params: 'keep' },
          },
        },
      },
      {
        richItemRenderer: {
          content: {
            lockupViewModel: {
              rendererContext: {
                commandContext: {
                  onTap: {
                    innertubeCommand: {
                      watchEndpoint: { videoId: 'lockup456', startTimeSeconds: 5 },
                    },
                  },
                },
              },
            },
          },
        },
      },
      {
        shortsLockupViewModel: {
          onTap: {
            reelWatchEndpoint: { videoId: 'short789' },
          },
        },
      },
    ] as unknown as FeedItem[];

    addPreviews(items, true);

    const tilePreview = (
      items[0] as { tileRenderer: { onFocusCommand: { startInlinePlaybackCommand: Record<string, unknown> } } }
    ).tileRenderer.onFocusCommand.startInlinePlaybackCommand;
    assert.equal(tilePreview.muted, true);
    assert.equal(tilePreview.caption, false);
    assert.equal(tilePreview.blockAdoption, true);
    assert.equal(tilePreview.autotransitionDelayMs, -1);
    assert.equal(tilePreview.forceSeamlessAutotransition, false);
    assert.equal(tilePreview.delayMs, 2500);
    assert.equal(tilePreview.durationMs, 3600000);
    assert.equal(tilePreview.restartPlaybackBeforeSeconds, 10);
    assert.equal(tilePreview.resumeVideo, false);
    assert.deepEqual(tilePreview.playbackEndpoint, {
      watchEndpoint: { videoId: 'tile123', params: 'keep' },
    });

    const lockupPreview = (
      items[1] as {
        richItemRenderer: {
          content: {
            lockupViewModel: {
              itemPlayback: { playbackCommand: { startInlinePlaybackCommand: Record<string, unknown> } };
            };
          };
        };
      }
    ).richItemRenderer.content.lockupViewModel.itemPlayback.playbackCommand.startInlinePlaybackCommand;
    assert.equal(lockupPreview.muted, true);
    assert.deepEqual(lockupPreview.playbackEndpoint, {
      watchEndpoint: { videoId: 'lockup456', startTimeSeconds: 5 },
    });

    const shortsPreview = (
      items[2] as { shortsLockupViewModel: { onFocusCommand: { startInlinePlaybackCommand: Record<string, unknown> } } }
    ).shortsLockupViewModel.onFocusCommand.startInlinePlaybackCommand;
    assert.equal(shortsPreview.muted, true);
    assert.deepEqual(shortsPreview.playbackEndpoint, {
      watchEndpoint: { videoId: 'short789' },
    });
  });

  test('tunes existing inline previews (including when shouldInject is false) and preserves existing focus commands', () => {
    const existingPreviewCmd = {
      startInlinePlaybackCommand: {
        muted: false,
        caption: true,
        resumeVideo: true,
        delayMs: 100,
        playbackEndpoint: {
          watchEndpoint: { videoId: 'native1', endTimeSeconds: 99, list: 'PL1' },
        },
      },
    };
    const executorFocusTile = {
      tileRenderer: {
        onFocusCommand: {
          innertubeCommand: {
            commandExecutorCommand: {
              commands: [{ logActionCommand: { id: 1 } }],
            },
          },
        },
        onSelectCommand: { watchEndpoint: { videoId: 'exec1' } },
      },
    };
    const singleFocusTile = {
      tileRenderer: {
        onFocusCommand: { someFocusAction: true },
        onSelectCommand: { watchEndpoint: { videoId: 'single1' } },
      },
    };
    const mastheadItem = {
      tvMastheadRenderer: {
        companionVideos: [
          {
            tileRenderer: {
              onSelectCommand: { watchEndpoint: { videoId: 'comp1' } },
            },
          },
        ],
      },
    };
    const bareEndpointLockup = {
      lockupViewModel: {
        itemPlayback: {
          playbackCommand: { playbackEndpoint: { watchEndpoint: { videoId: 'bare1' } } },
        },
        rendererContext: {
          commandContext: {
            onFocus: {
              startInlinePlaybackCommand: {
                muted: false,
                playbackEndpoint: { watchEndpoint: { videoId: 'focus1' } },
              },
            },
            onTap: { watchEndpoint: { videoId: 'tap1' } },
          },
        },
      },
    };
    const injectBlockedTile = {
      tileRenderer: {
        onSelectCommand: { watchEndpoint: { videoId: 'skipInject' } },
      },
    };

    const tuneOnlyItems = [
      { tileRenderer: { onFocusCommand: existingPreviewCmd } },
      injectBlockedTile,
    ] as unknown as FeedItem[];
    addPreviews(tuneOnlyItems, false);

    assert.equal(existingPreviewCmd.startInlinePlaybackCommand.muted, true);
    assert.equal(existingPreviewCmd.startInlinePlaybackCommand.caption, false);
    assert.equal(existingPreviewCmd.startInlinePlaybackCommand.resumeVideo, false);
    assert.equal(existingPreviewCmd.startInlinePlaybackCommand.delayMs, 2500);
    assert.deepEqual(existingPreviewCmd.startInlinePlaybackCommand.playbackEndpoint, {
      watchEndpoint: { videoId: 'native1', list: 'PL1' },
    });
    assert.equal((injectBlockedTile.tileRenderer as Record<string, unknown>).onFocusCommand, undefined);

    addPreviews([executorFocusTile, singleFocusTile, mastheadItem, bareEndpointLockup] as unknown as FeedItem[], true);

    assert.equal(
      executorFocusTile.tileRenderer.onFocusCommand.innertubeCommand.commandExecutorCommand.commands.length,
      2
    );
    assert.ok(
      'startInlinePlaybackCommand' in
        (executorFocusTile.tileRenderer.onFocusCommand.innertubeCommand.commandExecutorCommand.commands[1] as Record<
          string,
          unknown
        >)
    );

    const wrappedFocus = singleFocusTile.tileRenderer.onFocusCommand as unknown as {
      commandExecutorCommand: { commands: Record<string, unknown>[] };
    };
    const [firstWrappedCmd, secondWrappedCmd] = wrappedFocus.commandExecutorCommand.commands;
    assert.equal(wrappedFocus.commandExecutorCommand.commands.length, 2);
    assert.deepEqual(firstWrappedCmd, { someFocusAction: true });
    assert.ok(secondWrappedCmd && 'startInlinePlaybackCommand' in secondWrappedCmd);

    const [firstCompanion] = mastheadItem.tvMastheadRenderer.companionVideos;
    assert.ok(
      firstCompanion &&
        'startInlinePlaybackCommand' in
          ((firstCompanion.tileRenderer as Record<string, unknown>).onFocusCommand as Record<string, unknown>)
    );
    assert.equal(
      bareEndpointLockup.lockupViewModel.rendererContext.commandContext.onFocus.startInlinePlaybackCommand.muted,
      true
    );
  });

  test('[TDD Red: H3] addPreviews strips server-supplied startInlinePlaybackCommand when allowInject is false while keeping non-preview focus commands', () => {
    const directTile = {
      tileRenderer: {
        onFocusCommand: {
          startInlinePlaybackCommand: { playbackEndpoint: { watchEndpoint: { videoId: 'srv1' } } },
        },
        onSelectCommand: { watchEndpoint: { videoId: 'srv1' } },
      },
    };
    const wrappedTile = {
      tileRenderer: {
        onFocusCommand: {
          innertubeCommand: {
            commandExecutorCommand: {
              commands: [
                { logActionCommand: { id: 1 } },
                { startInlinePlaybackCommand: { playbackEndpoint: { watchEndpoint: { videoId: 'srv2' } } } },
              ],
            },
          },
        },
      },
    };
    const lockup = {
      lockupViewModel: {
        itemPlayback: {
          playbackCommand: {
            startInlinePlaybackCommand: { playbackEndpoint: { watchEndpoint: { videoId: 'srv3' } } },
          },
        },
        rendererContext: {
          commandContext: {
            onFocus: {
              innertubeCommand: {
                startInlinePlaybackCommand: { playbackEndpoint: { watchEndpoint: { videoId: 'srv3' } } },
              },
            },
          },
        },
      },
    };

    addPreviews([directTile, wrappedTile, lockup] as unknown as FeedItem[], false);

    assert.equal('startInlinePlaybackCommand' in directTile.tileRenderer.onFocusCommand, false);
    assert.deepEqual(wrappedTile.tileRenderer.onFocusCommand.innertubeCommand.commandExecutorCommand.commands, [
      { logActionCommand: { id: 1 } },
    ]);
    assert.equal('startInlinePlaybackCommand' in lockup.lockupViewModel.itemPlayback.playbackCommand, false);
    assert.equal(
      'startInlinePlaybackCommand' in lockup.lockupViewModel.rendererContext.commandContext.onFocus.innertubeCommand,
      false
    );
  });
});
