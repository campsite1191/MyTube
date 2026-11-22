import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  findFeedbackToken,
  getFeedbackPanelTokens,
  requestNextAndNavigateChannel,
  sendFeedbackToken,
} from '../mods/core/innertube-calls.ts';
import { patchResolveCommand } from '../mods/core/resolve-command.ts';
import { injectCss } from '../mods/core/styles.ts';
import { whenYttvReady } from '../mods/core/yttv-bridge.ts';
import { transformGuideResponse } from '../mods/transforms/guide.ts';
import { addLongPress } from '../mods/transforms/long-press.ts';
import { applyDeArrowBranding, clearDeArrowCache } from '../mods/transforms/thumbnails.ts';
import type { FeedItem } from '../mods/types/innertube.ts';

describe('regression fixes', () => {
  test('transformGuideResponse keeps only Search, Home, Subscriptions, Library, News, Settings in exact order', () => {
    const payload = {
      items: [
        {
          guideSectionRenderer: {
            items: [
              { guideEntryRenderer: { navigationEndpoint: { browseEndpoint: { browseId: 'FEtopics_music' } } } },
              { guideEntryRenderer: { navigationEndpoint: { browseEndpoint: { browseId: 'FEtopics_news' } } } },
              { guideEntryRenderer: { navigationEndpoint: { reelWatchEndpoint: {} } } },
              { guideEntryRenderer: { navigationEndpoint: { browseEndpoint: { browseId: 'FElibrary' } } } },
              { guideEntryRenderer: { navigationEndpoint: { applicationSettingsEndpoint: {} } } },
              { guideEntryRenderer: { navigationEndpoint: { browseEndpoint: { browseId: 'FEsubscriptions' } } } },
              { guideEntryRenderer: { navigationEndpoint: { browseEndpoint: { browseId: 'FEtopics' } } } },
              { guideEntryRenderer: { navigationEndpoint: { searchEndpoint: {} } } },
              {
                guideEntryRenderer: {
                  thumbnail: { thumbnails: [{ url: 'https://example.com/avatar.jpg' }] },
                  navigationEndpoint: { browseEndpoint: { browseId: 'UCchannel123' } },
                },
              },
            ],
          },
        },
      ],
    };

    const result = transformGuideResponse(payload) as typeof payload;
    const sectionItems = result.items[0]?.guideSectionRenderer.items ?? [];
    const ids = sectionItems.map((entry) => {
      const ep = entry.guideEntryRenderer?.navigationEndpoint as
        | {
            browseEndpoint?: { browseId?: string };
            searchEndpoint?: unknown;
            applicationSettingsEndpoint?: unknown;
          }
        | undefined;
      if (ep?.applicationSettingsEndpoint) return 'SETTINGS';
      return ep?.browseEndpoint?.browseId ?? (ep?.searchEndpoint ? 'search' : '');
    });

    assert.deepEqual(ids, ['search', 'FEtopics', 'FEsubscriptions', 'FElibrary', 'FEtopics_news', 'SETTINGS']);
  });

  test('injectCss adopts CSSStyleSheet and falls back to nonce-tagged style elements', () => {
    const origDoc = (globalThis as { document?: unknown }).document;
    const origSheet = (globalThis as { CSSStyleSheet?: unknown }).CSSStyleSheet;

    try {
      (globalThis as { CSSStyleSheet: unknown }).CSSStyleSheet = class {
        text = '';
        replaceSync(css: string): void {
          this.text = css;
        }
      };
      const doc = {
        adoptedStyleSheets: [] as Array<{ text: string }>,
      };
      (globalThis as { document: unknown }).document = doc;

      injectCss('body{color:red}');
      assert.equal(doc.adoptedStyleSheets.length, 1);
      assert.equal(doc.adoptedStyleSheets[0]?.text, 'body{color:red}');

      // Fallback path when CSSStyleSheet throws
      const appended: Array<{ textContent: string }> = [];
      (globalThis as { CSSStyleSheet: unknown }).CSSStyleSheet = class {
        replaceSync(): void {
          throw new Error('Unsupported');
        }
      };
      (globalThis as { document: unknown }).document = {
        head: { appendChild: (el: { textContent: string }) => appended.push(el) },
        querySelector: () => null,
        createElement: () => ({ textContent: '' }),
      };

      injectCss('.fallback{display:block}', true);
      assert.equal(appended.length, 1);
      assert.equal(appended[0]?.textContent, '.fallback{display:block}');
    } finally {
      (globalThis as { document?: unknown }).document = origDoc;
      (globalThis as { CSSStyleSheet?: unknown }).CSSStyleSheet = origSheet;
    }
  });

  test('applyDeArrowBranding deduplicates, caches, and clears cache on clearDeArrowCache', async () => {
    clearDeArrowCache();
    let fetchCalls = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> => {
      fetchCalls++;
      return new Response(JSON.stringify({ titles: [{ title: 'Cached Title', votes: 10 }], thumbnails: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    const makeItem = (id: string) => ({
      tileRenderer: {
        contentId: id,
        style: 'TILE_STYLE_YTLR_DEFAULT',
        metadata: { tileMetadataRenderer: { title: { simpleText: 'Orig' } } },
        onSelectCommand: { watchEndpoint: { videoId: id } },
      },
    });

    try {
      const a = makeItem('dedupVid1');
      const b = makeItem('dedupVid1');
      await applyDeArrowBranding([a, b]);
      assert.equal(fetchCalls, 1);
      assert.equal(a.tileRenderer.metadata.tileMetadataRenderer.title.simpleText, 'Cached Title');
      assert.equal(b.tileRenderer.metadata.tileMetadataRenderer.title.simpleText, 'Cached Title');

      const c = makeItem('dedupVid1');
      await applyDeArrowBranding([c]);
      assert.equal(fetchCalls, 1);
      assert.equal(c.tileRenderer.metadata.tileMetadataRenderer.title.simpleText, 'Cached Title');

      clearDeArrowCache();
      const d = makeItem('dedupVid1');
      await applyDeArrowBranding([d]);
      assert.equal(fetchCalls, 2);
    } finally {
      clearDeArrowCache();
      globalThis.fetch = origFetch;
    }
  });

  test('whenYttvReady waits for resolveCommand host and patchResolveCommand re-patches replaced or late hosts', async () => {
    const origWindow = (globalThis as { window?: unknown }).window;
    const origDoc = (globalThis as { document?: unknown }).document;
    const listeners = new Map<string, Set<() => void>>();

    try {
      const fakeWindow: Record<string, unknown> = {
        _yttv: { bootstrapOnly: { version: 1 } },
        addEventListener: (type: string, cb: () => void) => {
          let set = listeners.get(type);
          if (!set) {
            set = new Set();
            listeners.set(type, set);
          }
          set.add(cb);
        },
        removeEventListener: (type: string, cb: () => void) => listeners.get(type)?.delete(cb),
      };
      const fakeDoc: Record<string, unknown> = {
        readyState: 'complete',
        documentElement: {},
        addEventListener: () => {},
        removeEventListener: () => {},
      };
      (globalThis as { window: unknown }).window = fakeWindow;
      (globalThis as { document: unknown }).document = fakeDoc;

      let readyCount = 0;
      whenYttvReady(() => {
        readyCount++;
        patchResolveCommand();
      });

      // Ready must not fire prematurely while _yttv only contains non-command entries.
      assert.equal(readyCount, 0);

      const firstCalls: unknown[] = [];
      function firstHost(): void {}
      firstHost.instance = {
        resolveCommand: (cmd: unknown) => {
          firstCalls.push(cmd);
          return 'orig-first';
        },
      };
      (fakeWindow._yttv as Record<string, unknown>).mainRouter = firstHost;

      await new Promise((resolve) => setTimeout(resolve, 260));
      assert.equal(readyCount, 1);

      const secondCalls: unknown[] = [];
      firstHost.instance.resolveCommand = (cmd: unknown) => {
        secondCalls.push(cmd);
        return 'replaced-first';
      };
      patchResolveCommand();

      const lateCalls: unknown[] = [];
      const lateHost = {
        instance: {
          resolveCommand: (cmd: unknown) => {
            lateCalls.push(cmd);
            return 'late';
          },
        },
      };
      (fakeWindow._yttv as Record<string, unknown>).lateRouter = lateHost;
      patchResolveCommand();

      // Replaced and late resolveCommand functions must intercept TT_SPEED_SETTINGS_SHOW cleanly.
      firstHost.instance.resolveCommand({ customAction: { action: 'TT_SPEED_SETTINGS_SHOW', parameters: [] } });
      assert.equal(secondCalls.length, 1);
      assert.equal(
        (secondCalls[0] as { openPopupAction?: { uniqueId?: string } }).openPopupAction?.uniqueId,
        'tt-speed'
      );

      lateHost.instance.resolveCommand({
        signalAction: { customAction: { action: 'TT_SPEED_SETTINGS_SHOW', parameters: [] } },
      });
      assert.equal(lateCalls.length, 1);
      assert.equal((lateCalls[0] as { openPopupAction?: { uniqueId?: string } }).openPopupAction?.uniqueId, 'tt-speed');
      assert.equal(firstCalls.length, 0);

      // Player settings popups strip Report and Feedback entries while preserving Stats for nerds and active speed label.
      const settingsMenuItems = [
        { compactLinkRenderer: { title: { runs: [{ text: 'Quality' }] }, icon: { iconType: 'SETTINGS' } } },
        {
          compactLinkRenderer: {
            title: { runs: [{ text: 'Speed' }] },
            icon: { iconType: 'SPEEDOMETER' },
            subtitle: { simpleText: 'Normal' },
          },
        },
        { compactLinkRenderer: { title: { simpleText: 'Report video' }, icon: { iconType: 'OUTLINED_FLAG' } } },
        { compactLinkRenderer: { title: { simpleText: 'Bug' }, serviceEndpoint: { sendFeedbackEndpoint: {} } } },
        {
          compactLinkRenderer: {
            title: { runs: [{ text: 'Stats for nerds' }] },
            icon: { iconType: 'BUG_REPORT' },
            serviceEndpoint: { signalAction: { signal: 'TOGGLE_VIDEO_INFO' } },
          },
        },
      ];
      lateHost.instance.resolveCommand({
        openPopupAction: {
          uniqueId: 'playback-settings',
          popup: {
            overlaySectionRenderer: {
              overlay: {
                overlayTwoPanelRenderer: {
                  actionPanel: {
                    overlayPanelRenderer: {
                      content: {
                        overlayPanelItemListRenderer: {
                          items: settingsMenuItems,
                          selectedIndex: 4,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      });
      assert.equal(settingsMenuItems.length, 3);
      assert.equal(
        (settingsMenuItems[0]?.compactLinkRenderer.title as { runs?: Array<{ text?: string }> }).runs?.[0]?.text,
        'Quality'
      );
      assert.equal(settingsMenuItems[1]?.compactLinkRenderer.subtitle?.simpleText, '1x');
      assert.equal(
        (settingsMenuItems[2]?.compactLinkRenderer.title as { runs?: Array<{ text?: string }> }).runs?.[0]?.text,
        'Stats for nerds'
      );
    } finally {
      (globalThis as { window?: unknown }).window = origWindow;
      (globalThis as { document?: unknown }).document = origDoc;
    }
  });

  test('addLongPress prunes playlist/queue clutter, normalizes text, restores feedback actions, and generates fallback menus', () => {
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

  test('innertube-calls helpers resolve channel navigation, feedback tokens, and depth-bounded token search', async () => {
    const origWindow = (globalThis as { window?: unknown }).window;
    const resolvedCmds: unknown[] = [];

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.equal(findFeedbackToken(cyclic), null);
    assert.equal(findFeedbackToken({ a: { b: { feedbackToken: 'tok-123' } } }), 'tok-123');

    const serviceMap = new Map<string, unknown>([
      [
        'CurrentIdentityService',
        {
          get: async () => ({ id: 'user-1' }),
        },
      ],
      [
        'KabukiInnerTubeClient',
        {
          fetch: (req: { path: string }) => ({
            subscribe: (onNext: (res: unknown) => void) => {
              if (req.path === '/youtubei/v1/next') {
                onNext({
                  contents: {
                    singleColumnWatchNextResults: {
                      results: {
                        results: {
                          contents: [
                            { itemSectionRenderer: { contents: [{ otherRenderer: {} }] } },
                            {
                              itemSectionRenderer: {
                                contents: [
                                  {
                                    videoMetadataRenderer: {
                                      owner: {
                                        videoOwnerRenderer: {
                                          navigationEndpoint: { browseEndpoint: { browseId: 'UC_Target' } },
                                        },
                                      },
                                    },
                                  },
                                ],
                              },
                            },
                          ],
                        },
                      },
                    },
                  },
                });
              } else if (req.path === '/youtubei/v1/get_panel') {
                onNext({
                  content: {
                    engagementPanelSectionListRenderer: {
                      content: {
                        listViewModel: {
                          listItems: [
                            { listItemViewModel: { rendererContext: { commandContext: { feedbackToken: 'fb-1' } } } },
                            { listItemViewModel: { rendererContext: { commandContext: { feedbackToken: 'fb-2' } } } },
                          ],
                        },
                      },
                    },
                  },
                });
              } else if (req.path === '/youtubei/v1/feedback') {
                onNext({ feedbackResponses: [{ isProcessed: true }] });
              }
            },
          }),
        },
      ],
    ]);

    try {
      (globalThis as { window: unknown }).window = {
        _yttv: {
          services: { mappings: serviceMap },
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

      requestNextAndNavigateChannel({
        tileRenderer: { contentId: 'vid-chan', onSelectCommand: { watchEndpoint: { params: 'p' } } },
      });
      await new Promise((r) => setTimeout(r, 10));
      assert.deepEqual(resolvedCmds.at(-1), { browseEndpoint: { browseId: 'UC_Target' } });

      const tokens = await getFeedbackPanelTokens('panel-id', 'panel-params');
      assert.deepEqual(tokens, ['fb-1', 'fb-2']);

      const fbRes = (await sendFeedbackToken('fb-1')) as { feedbackResponses?: Array<{ isProcessed?: boolean }> };
      assert.equal(fbRes?.feedbackResponses?.[0]?.isProcessed, true);
    } finally {
      (globalThis as { window?: unknown }).window = origWindow;
    }
  });
});
