import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  buttonItem,
  buttonRenderer,
  longPressData,
  menuServiceItemRenderer,
  overlayPanelItemListRenderer,
  showModal,
  timelyAction,
} from '../../mods/ui/yt-ui.ts';

describe('yt-ui builders', () => {
  test('showModal dispatches a modal command via the live _yttv host', (t) => {
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

    const content = overlayPanelItemListRenderer([buttonItem('1.5x', [{ signalAction: { signal: 'POPUP_BACK' } }])], 2);
    showModal('Playback speed', content, 'tt-speed');

    assert.equal(dispatched.length, 1);
    const cmd = dispatched[0] as {
      openPopupAction?: {
        popupType?: string;
        uniqueId?: string;
        popup?: {
          overlaySectionRenderer?: {
            overlay?: {
              overlayTwoPanelRenderer?: {
                actionPanel?: {
                  overlayPanelRenderer?: {
                    header?: { overlayPanelHeaderRenderer?: { title?: { simpleText?: string } } };
                    content?: { overlayPanelItemListRenderer?: { selectedIndex?: number; items?: unknown[] } };
                  };
                };
              };
            };
          };
        };
      };
    };
    assert.equal(cmd.openPopupAction?.popupType, 'MODAL');
    assert.equal(cmd.openPopupAction?.uniqueId, 'tt-speed');
    const panel =
      cmd.openPopupAction?.popup?.overlaySectionRenderer?.overlay?.overlayTwoPanelRenderer?.actionPanel
        ?.overlayPanelRenderer;
    assert.equal(panel?.header?.overlayPanelHeaderRenderer?.title?.simpleText, 'Playback speed');
    assert.equal(panel?.content?.overlayPanelItemListRenderer?.selectedIndex, 2);
    assert.equal(panel?.content?.overlayPanelItemListRenderer?.items?.length, 1);
  });

  test('longPressData builds Watch Later add vs remove actions and native menu items', () => {
    const normalMenu = longPressData({
      videoId: 'vid1',
      thumbnails: [{ url: 'https://i.ytimg.com/vi/vid1/hq720.jpg', width: 1280, height: 720 }],
      title: 'Title',
      subtitle: 'Channel',
      watchEndpointData: { videoId: 'vid1' },
      item: { videoId: 'vid1' },
    });
    const normalItems = normalMenu.showMenuCommand.menu.menuRenderer.items as Array<{
      menuServiceItemRenderer?: { text?: { runs?: Array<{ text?: string }> }; serviceEndpoint?: unknown };
    }>;
    assert.equal(normalItems[1]?.menuServiceItemRenderer?.text?.runs?.[0]?.text, 'Save to Watch later');
    assert.equal(normalItems[2]?.menuServiceItemRenderer?.text?.runs?.[0]?.text, 'Go to channel');

    const wlMenu = longPressData({
      videoId: 'vid2',
      thumbnails: [],
      title: 'WL Video',
      subtitle: 'Channel',
      watchEndpointData: { videoId: 'vid2', playlistId: 'WL' },
      item: {},
    });
    const wlItems = wlMenu.showMenuCommand.menu.menuRenderer.items as Array<{
      menuServiceItemRenderer?: {
        text?: { runs?: Array<{ text?: string }> };
        serviceEndpoint?: { playlistEditEndpoint?: { actions?: Array<{ action?: string; removedVideoId?: string }> } };
      };
    }>;
    assert.equal(wlItems[1]?.menuServiceItemRenderer?.text?.runs?.[0]?.text, 'Remove from Watch later');
    assert.equal(
      wlItems[1]?.menuServiceItemRenderer?.serviceEndpoint?.playlistEditEndpoint?.actions?.[0]?.action,
      'ACTION_REMOVE_VIDEO_BY_VIDEO_ID'
    );
  });

  test('timelyAction, menuServiceItemRenderer, and buttonRenderer match expected schemas', () => {
    const timely = timelyAction('Skip intro', 'SKIP_NEXT', { customAction: { action: 'SKIP' } }, 1000, 5000);
    assert.equal(timely.timelyActionRenderer.triggerTimeMs, 1000);
    assert.equal(timely.timelyActionRenderer.timeoutMs, 5000);

    const menu = menuServiceItemRenderer('Item', { customAction: { action: 'ACT' } });
    assert.equal(menu.menuServiceItemRenderer.text.runs[0]?.text, 'Item');

    const btn = buttonRenderer('Highlight', 'SKIP_NEXT', { customAction: { action: 'SKIP' } });
    assert.equal(btn.isDisabled, false);
    assert.equal(btn.icon.iconType, 'SKIP_NEXT');
  });
});
