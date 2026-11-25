import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { FeedItem } from '../../mods/types/innertube.ts';
import {
  extractCustomAction,
  extractItemChannelName,
  getExistingMenuItemLists,
  hasReportOrFeedbackEndpointNode,
  isReportOrFeedbackIcon,
  isReportOrFeedbackText,
  META_SEPARATOR,
  PLAYER_SELECTOR,
  readFormattedText,
  VIDEO_ID_RE,
  walkCommands,
} from '../../mods/utils/innertube-ast.ts';

describe('shared constants', () => {
  test('exports consistent video ID pattern, separator, and player selector', () => {
    assert.equal(VIDEO_ID_RE.test('dQw4w9WgXcQ'), true);
    assert.equal(VIDEO_ID_RE.test('short'), false);
    assert.equal(META_SEPARATOR, ' • ');
    assert.equal(PLAYER_SELECTOR, '.html5-video-player');
  });
});

describe('text, command, menu, and channel extraction helpers', () => {
  test('extractItemChannelName and getExistingMenuItemLists handle tiles and lockups', () => {
    const sharedMenuItems = [{ menuServiceItemRenderer: { serviceEndpoint: { id: 1 } } }];
    const tileItem: FeedItem = {
      tileRenderer: {
        contentId: 't1',
        metadata: {
          tileMetadataRenderer: {
            lines: [{ lineRenderer: { items: [{ lineItemRenderer: { text: { simpleText: 'Tech Channel' } } }] } }],
          },
        },
        menu: {
          menuRenderer: {
            items: sharedMenuItems,
          },
        },
        onLongPressCommand: {
          showMenuCommand: {
            menu: {
              menuRenderer: {
                items: sharedMenuItems,
              },
            },
          },
        },
      },
    };
    const lockupItem: FeedItem = {
      lockupViewModel: {
        contentId: 'l1',
        metadata: {
          lockupMetadataViewModel: {
            metadata: {
              contentMetadataViewModel: {
                metadataRows: [{ metadataParts: [{ text: { content: 'Music Channel' } }] }],
              },
            },
          },
        },
        rendererContext: {
          commandContext: {
            onLongPress: {
              innertubeCommand: {
                showMenuCommand: {
                  menu: {
                    menuRenderer: {
                      items: [{ menuServiceItemRenderer: { serviceEndpoint: { id: 2 } } }],
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    assert.equal(extractItemChannelName(tileItem), 'Tech Channel');
    assert.equal(extractItemChannelName(lockupItem), 'Music Channel');
    assert.equal(getExistingMenuItemLists(tileItem).length, 1);
    assert.equal(getExistingMenuItemLists(lockupItem).length, 1);
    assert.equal(readFormattedText({ runs: [{ text: 'A' }, { text: 'B' }] }), 'AB');
    assert.equal(
      walkCommands(
        {
          commandExecutorCommand: {
            commands: [{ innertubeCommand: { targetAction: true } }],
          },
        },
        (cmd) => Boolean(cmd.targetAction)
      ),
      true
    );
  });

  test('covers formatted text, channel extraction, menu, and command depth fallbacks', () => {
    assert.equal(readFormattedText(null), '');
    assert.equal(readFormattedText(123), '');
    assert.equal(readFormattedText('plain'), 'plain');
    assert.equal(readFormattedText({ text: { simpleText: 'Nested Text' } }), 'Nested Text');
    assert.equal(readFormattedText({ attributedString: { content: 'Attributed' } }), 'Attributed');
    assert.equal(
      readFormattedText({ accessibility: { accessibilityData: { label: 'Accessible Label' } } }),
      'Accessible Label'
    );
    assert.equal(readFormattedText({ runs: [{ notText: 1 }] }), '');
    assert.equal(readFormattedText({ unknownField: 1 }), '');

    assert.equal(
      walkCommands({ commandExecutorCommand: { commands: [{ nope: 1 }] } }, (c) => Boolean(c.hit)),
      false
    );
    assert.equal(
      walkCommands({ commandExecutorCommand: { commands: [{ nope: 1 }, { hit: true }] } }, (c) => Boolean(c.hit)),
      true
    );

    assert.equal(
      extractItemChannelName({
        lockupViewModel: {
          metadata: {
            lockupMetadataViewModel: {
              metadata: {
                contentMetadataViewModel: { metadataRows: [{ metadataParts: [{ text: { content: '   ' } }] }] },
              },
            },
          },
        },
      }),
      ''
    );
    assert.equal(
      extractItemChannelName({
        lockupViewModel: {
          metadata: { lockupMetadataViewModel: { metadata: { contentMetadataViewModel: { metadataRows: 'bad' } } } },
        },
      }),
      ''
    );
    assert.equal(
      extractItemChannelName({
        lockupViewModel: {
          metadata: { lockupMetadataViewModel: { metadata: { contentMetadataViewModel: { metadataRows: [null] } } } },
        },
      }),
      ''
    );
    assert.equal(
      extractItemChannelName({
        tileRenderer: {
          metadata: {
            tileMetadataRenderer: {
              lines: [{ lineRenderer: { items: [null, { lineItemRenderer: { text: { simpleText: 'Channel A' } } }] } }],
            },
          },
        },
      }),
      'Channel A'
    );
    assert.equal(extractItemChannelName({ tileRenderer: { metadata: { tileMetadataRenderer: {} } } }), '');
    assert.equal(extractItemChannelName(null), '');
    assert.deepEqual(getExistingMenuItemLists(null), []);
  });

  test('covers extractCustomAction and report/feedback classification helpers', () => {
    assert.equal(extractCustomAction(null), null);
    assert.deepEqual(extractCustomAction({ customAction: { action: 'DIRECT', parameters: { x: 1 } } }), {
      action: 'DIRECT',
      parameters: { x: 1 },
    });
    assert.equal(
      extractCustomAction({ signalAction: { customAction: { action: 'PING', parameters: 1 } } })?.action,
      'PING'
    );
    assert.equal(extractCustomAction({ signalAction: {} }), null);

    assert.equal(isReportOrFeedbackIcon('BUG_REPORT'), false);
    assert.equal(isReportOrFeedbackIcon('FLAG'), true);
    assert.equal(isReportOrFeedbackText('Send Feedback'), true);
    assert.equal(isReportOrFeedbackText(''), false);
    assert.equal(hasReportOrFeedbackEndpointNode({ getReportFormEndpoint: {} }), true);
    assert.equal(hasReportOrFeedbackEndpointNode({}), false);
  });
});
