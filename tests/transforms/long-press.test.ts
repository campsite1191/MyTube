import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { addLongPress } from '../../mods/transforms/long-press.ts';
import type { FeedItem } from '../../mods/types/innertube.ts';

describe('addLongPress', () => {
  test('prunes playlist/queue clutter, normalizes text, restores feedback actions, and generates fallback menus', () => {
    const existingMenuTile: FeedItem = {
      tileRenderer: {
        contentId: 'menuVid1',
        style: 'TILE_STYLE_YTLR_DEFAULT',
        menu: {
          menuRenderer: {
            items: [
              { menuNavigationItemRenderer: { text: { simpleText: 'Save to playlist' } } },
              {
                menuServiceItemRenderer: {
                  text: { runs: [{ text: 'Add to queue' }] },
                  serviceEndpoint: { customAction: { action: 'ADD_TO_QUEUE' } },
                },
              },
              { menuServiceItemRenderer: { text: { simpleText: 'save to watch later' } } },
            ],
          },
        },
        onLongPressCommand: {
          showEngagementPanelEndpoint: {
            identifier: { tag: 'panel-1' },
            globalConfiguration: { params: 'params-1' },
          },
        },
      },
    };

    const fallbackTile: FeedItem = {
      tileRenderer: {
        contentId: 'fallbackVid2',
        style: 'TILE_STYLE_YTLR_DEFAULT',
        header: {
          tileHeaderRenderer: {
            thumbnail: {
              thumbnails: [{ url: 'https://i.ytimg.com/vi/fallbackVid2/hq720.jpg', width: 1280, height: 720 }],
            },
          },
        },
        metadata: {
          tileMetadataRenderer: {
            title: { simpleText: 'Fallback Video' },
            lines: [{ lineRenderer: { items: [{ lineItemRenderer: { text: { simpleText: 'My Channel' } } }] } }],
          },
        },
        onSelectCommand: { watchEndpoint: { videoId: 'fallbackVid2', params: 'wParams' } },
      },
    };

    const fallbackLockup: FeedItem = {
      lockupViewModel: {
        contentId: 'lockupVid3',
        contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
        contentImage: {
          thumbnailViewModel: {
            image: { sources: [{ url: 'https://i.ytimg.com/vi/lockupVid3/hq720.jpg', width: 1280, height: 720 }] },
          },
        },
        metadata: {
          lockupMetadataViewModel: {
            title: { content: 'Lockup Title' },
          },
        },
        rendererContext: {
          commandContext: {
            onTap: { innertubeCommand: { watchEndpoint: { videoId: 'lockupVid3' } } },
          },
        },
      },
    };

    addLongPress([existingMenuTile, fallbackTile, fallbackLockup]);

    const menuItems = existingMenuTile.tileRenderer?.menu?.menuRenderer?.items ?? [];
    assert.equal(menuItems.length, 3);
    assert.equal(
      (menuItems[0] as { menuServiceItemRenderer?: { text?: { simpleText?: string } } })?.menuServiceItemRenderer?.text
        ?.simpleText,
      'Save to Watch Later'
    );
    assert.equal(
      (menuItems[1] as { menuServiceItemRenderer?: { text?: { runs?: Array<{ text?: string }> } } })
        ?.menuServiceItemRenderer?.text?.runs?.[0]?.text,
      'Not Interested'
    );
    assert.equal(
      (menuItems[2] as { menuServiceItemRenderer?: { text?: { runs?: Array<{ text?: string }> } } })
        ?.menuServiceItemRenderer?.text?.runs?.[0]?.text,
      "Don't Recommend Channel"
    );

    assert.ok(fallbackTile.tileRenderer?.onLongPressCommand?.showMenuCommand);
    assert.ok(fallbackLockup.lockupViewModel?.rendererContext?.commandContext?.onLongPress?.innertubeCommand);
  });

  test('handles non-video tiles, existing showMenuCommand, missing showMenuCommand, and accessibility text normalization', () => {
    const existingShowMenuTile: FeedItem = {
      tileRenderer: {
        contentType: 'TILE_CONTENT_TYPE_VIDEO',
        contentId: 'v-has-show',
        onLongPressCommand: {
          showMenuCommand: { menu: { menuRenderer: { items: [{ keepExisting: true }] } } },
        },
        menu: {
          menuRenderer: {
            items: [{ menuServiceItemRenderer: { text: { simpleText: 'keep menu' } } }],
          },
        },
      },
    };
    const nonVideoTile: FeedItem = {
      tileRenderer: { contentType: 'TILE_CONTENT_TYPE_CHANNEL', contentId: 'chan1' },
    };
    const menuNoShowCmd: FeedItem = {
      tileRenderer: {
        contentType: 'TILE_CONTENT_TYPE_VIDEO',
        contentId: 'v-menu-no-show',
        onLongPressCommand: {
          signalAction: { signal: 'OTHER' },
        },
        menu: {
          menuRenderer: {
            items: [
              { menuServiceItemRenderer: { text: { runs: [{ text: 'save to watch later' }] } } },
              { menuNavigationItemRenderer: { text: { runs: [{ text: 'add to queue' }] }, navigationEndpoint: {} } },
              { menuServiceItemRenderer: { text: { fallback: true } } },
            ],
          },
        },
      },
    };
    const plainTextTile: FeedItem = {
      tileRenderer: {
        contentType: 'TILE_CONTENT_TYPE_VIDEO',
        contentId: 'v-plain-text',
        menu: {
          menuRenderer: {
            items: [
              {
                menuServiceItemRenderer: {
                  text: { accessibility: { accessibilityData: { label: 'not interested' } } },
                },
              },
            ],
          },
        },
      },
    };
    addLongPress(null as unknown as Parameters<typeof addLongPress>[0]);
    const emptyItem = {};
    const shortsStyledTile = { tileRenderer: { style: 'TILE_STYLE_YTLR_SHORTS' } };
    const navMenuTile = {
      tileRenderer: {
        contentId: 'navMenu1',
        style: 'TILE_STYLE_YTLR_DEFAULT',
        onLongPressCommand: {
          showMenuCommand: {},
          showEngagementPanelEndpoint: {
            identifier: { tag: 'fb-panel' },
            globalConfiguration: { params: 'fb-params' },
          },
        },
        menu: {
          menuRenderer: {
            items: [
              null as unknown as Record<string, unknown>,
              { menuNavigationItemRenderer: { text: 'Go to channel' } },
              {
                menuNavigationItemRenderer: {
                  text: { simpleText: 'Go to channel' },
                  navigationEndpoint: { feedbackToken: 'nav-fb' },
                },
              },
              {
                menuNavigationItemRenderer: {
                  text: { simpleText: 'Save to playlist' },
                  navigationEndpoint: { addToPlaylistEndpoint: {} },
                },
              },
            ],
          },
        },
      },
    };
    const collectionLockup: FeedItem = {
      lockupViewModel: {
        contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
        contentId: 'collVid1',
        contentImage: {
          collectionThumbnailViewModel: {
            primaryThumbnail: {
              thumbnailViewModel: {
                image: { sources: [{ url: 'https://i.ytimg.com/vi/collVid1/hq720.jpg', width: 1280, height: 720 }] },
              },
            },
          },
        },
        metadata: { lockupMetadataViewModel: { title: { content: 'Collection Video' } } },
        rendererContext: {
          commandContext: { onTap: { innertubeCommand: { watchEndpoint: { videoId: 'collVid1' } } } },
        },
      },
    };
    const incompleteLockup: FeedItem = {
      lockupViewModel: { contentType: 'LOCKUP_CONTENT_TYPE_VIDEO', contentId: 'noThumb' },
    };
    addLongPress([
      existingShowMenuTile,
      nonVideoTile,
      menuNoShowCmd,
      plainTextTile,
      emptyItem,
      shortsStyledTile,
      navMenuTile,
      collectionLockup,
      incompleteLockup,
    ]);
    assert.equal(navMenuTile.tileRenderer.menu.menuRenderer.items.length, 3);
    assert.ok(collectionLockup.lockupViewModel?.rendererContext?.commandContext?.onLongPress?.innertubeCommand);
    assert.deepEqual(existingShowMenuTile.tileRenderer?.onLongPressCommand?.showMenuCommand?.menu, {
      menuRenderer: { items: [{ keepExisting: true }] },
    });
    assert.ok(menuNoShowCmd.tileRenderer?.onLongPressCommand?.showMenuCommand);
    assert.equal(
      (
        menuNoShowCmd.tileRenderer?.menu?.menuRenderer?.items?.[0] as {
          menuServiceItemRenderer?: { text?: { runs?: Array<{ text?: string }> } };
        }
      )?.menuServiceItemRenderer?.text?.runs?.[0]?.text,
      'Save to Watch Later'
    );
    assert.equal(
      (
        plainTextTile.tileRenderer?.menu?.menuRenderer?.items?.[0] as {
          menuServiceItemRenderer?: { text?: { runs?: Array<{ text?: string }> } };
        }
      )?.menuServiceItemRenderer?.text?.runs?.[0]?.text,
      'Not Interested'
    );
  });
});
