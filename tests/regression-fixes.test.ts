import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  findFeedbackToken,
  getFeedbackPanelTokens,
  requestNextAndNavigateChannel,
  sendFeedbackToken,
} from '../mods/core/innertube-calls.ts';
import {
  extractCustomAction,
  hasReportOrFeedbackEndpointNode,
  isReportOrFeedbackIcon,
  isReportOrFeedbackText,
  patchResolveCommand,
} from '../mods/core/resolve-command.ts';
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

  test('resolveCommand handles I18N_LANGUAGE, EXIT_APP, SKIP, SHOW_TOAST, NOT_INTERESTED, DONT_RECOMMEND_CHANNEL, and FEEDBACK_REASON', async (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevDocument = globals.document;
    const prevKeyboardEvent = globals.KeyboardEvent;

    class MockKeyboardEvent {
      readonly type: string;
      readonly init?: Record<string, unknown>;
      constructor(type: string, init?: Record<string, unknown>) {
        this.type = type;
        this.init = init;
      }
    }
    globals.KeyboardEvent = MockKeyboardEvent;

    const resolvedCmds: unknown[] = [];
    const fakeVideo = { currentTime: 10 };
    const dispatchedEvents: unknown[] = [];
    const fakeDoc = {
      cookie: '',
      dispatchEvent: (ev: unknown) => {
        dispatchedEvents.push(ev);
        return true;
      },
      querySelector: (sel: string) => (sel === 'video' ? fakeVideo : null),
    };
    globals.document = fakeDoc;

    const serviceMap = new Map<string, unknown>([
      [
        'KabukiInnerTubeClient',
        {
          fetch: (req: { path: string; payload?: { feedbackTokens?: string[] } }) => ({
            subscribe: (onNext: (res: unknown) => void) => {
              if (req.path === '/youtubei/v1/get_panel') {
                onNext({
                  content: {
                    engagementPanelSectionListRenderer: {
                      content: {
                        listViewModel: {
                          listItems: [
                            { listItemViewModel: { feedbackToken: 'tok-not-interested' } },
                            { listItemViewModel: { feedbackToken: 'tok-dont-recommend' } },
                          ],
                        },
                      },
                    },
                  },
                });
              } else if (req.path === '/youtubei/v1/feedback') {
                onNext({
                  feedbackResponses: [
                    {
                      followUpDialog: {
                        dismissalFollowUpRenderer: {
                          dismissalReasonsPrompt: { simpleText: 'Tell us why' },
                          reasons: [{ title: { simpleText: 'Already watched' }, token: 'tok-reason-1' }],
                        },
                      },
                    },
                  ],
                });
              }
            },
          }),
        },
      ],
    ]);

    const host = {
      instance: {
        resolveCommand: (cmd: unknown) => {
          resolvedCmds.push(cmd);
          return true;
        },
      },
    };
    globals.window = {
      _yttv: {
        services: { mappings: serviceMap },
        router: host,
      },
    };

    t.after(() => {
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
      if (prevKeyboardEvent === undefined) delete globals.KeyboardEvent;
      else globals.KeyboardEvent = prevKeyboardEvent;
    });

    patchResolveCommand();

    // 1. I18N_LANGUAGE sets PREF cookie and dispatches RELOAD_PAGE
    host.instance.resolveCommand({
      setClientSettingEndpoint: {
        settingDatas: [{ clientSettingEnum: { item: 'I18N_LANGUAGE' }, stringValue: 'en-GB' }],
      },
    });
    assert.match(fakeDoc.cookie, /^PREF=hl=en-GB;/);
    assert.deepEqual(resolvedCmds.at(-1), { signalAction: { signal: 'RELOAD_PAGE' } });

    // 2. ACCOUNT_EVENT_TRIGGER_ON_EXIT dispatches EXIT_APP
    const exitResult = host.instance.resolveCommand({
      requestAccountSelectorCommand: {
        identityActionContext: { eventTrigger: 'ACCOUNT_EVENT_TRIGGER_ON_EXIT' },
      },
    });
    assert.equal(exitResult, false);
    assert.deepEqual(resolvedCmds.at(-1), { signalAction: { signal: 'EXIT_APP' } });

    // 3. commandExecutorCommand with SKIP and SHOW_TOAST
    host.instance.resolveCommand({
      commandExecutorCommand: {
        commands: [
          { customAction: { action: 'SKIP', parameters: { time: 42 } } },
          { customAction: { action: 'SHOW_TOAST', parameters: 'Skipped!' } },
          { signalAction: { signal: 'POPUP_BACK' } },
        ],
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(fakeVideo.currentTime, 42);
    assert.equal(dispatchedEvents.length, 1);

    // 4. NOT_INTERESTED, DONT_RECOMMEND_CHANNEL, and FEEDBACK_REASON
    host.instance.resolveCommand({
      customAction: { action: 'NOT_INTERESTED', parameters: { panelId: 'p1', params: 'par1' } },
    });
    host.instance.resolveCommand({
      customAction: { action: 'DONT_RECOMMEND_CHANNEL', parameters: { panelId: 'p1', params: 'par1' } },
    });
    host.instance.resolveCommand({
      customAction: { action: 'FEEDBACK_REASON', parameters: { token: 'tok-reason-1' } },
    });
    await new Promise((r) => setTimeout(r, 20));

    assert.ok(
      resolvedCmds.some(
        (c) => (c as { openPopupAction?: { uniqueId?: string } }).openPopupAction?.uniqueId === 'tt-feedback-reasons'
      )
    );
    assert.ok(
      resolvedCmds.some(
        (c) => (c as { openPopupAction?: { popupType?: string } }).openPopupAction?.popupType === 'TOAST'
      )
    );

    // 5. Coverage for helper guards, PREF merging, SET_PLAYER_SPEED, GO_TO_CHANNEL, report filtering, and native passthrough.
    assert.equal(isReportOrFeedbackIcon('BUG_REPORT'), false);
    assert.equal(isReportOrFeedbackIcon('FLAG'), true);
    assert.equal(isReportOrFeedbackText('Send Feedback'), true);
    assert.equal(hasReportOrFeedbackEndpointNode({ getReportFormEndpoint: {} }), true);
    assert.equal(
      extractCustomAction({ signalAction: { customAction: { action: 'PING', parameters: 1 } } })?.action,
      'PING'
    );

    fakeDoc.cookie = 'PREF=tz=America.Los_Angeles&hl=fr&f6=8; OTHER=1';
    host.instance.resolveCommand({
      setClientSettingEndpoint: {
        settingDatas: [
          { clientSettingEnum: { item: 'OTHER' } },
          { clientSettingEnum: { item: 'I18N_LANGUAGE' }, stringValue: 'ja JP' },
        ],
      },
    });
    assert.match(fakeDoc.cookie, /PREF=hl=ja%20JP&tz=America\.Los_Angeles&f6=8;/);

    // Unknown setting enum falls through cleanly; native commandExecutorCommand is NOT unpacked.
    host.instance.resolveCommand({
      setClientSettingEndpoint: { settingDatas: [{ clientSettingEnum: { item: 'UNKNOWN' } }] },
    });
    const nativeBatch = {
      commandExecutorCommand: {
        commands: [{ signalAction: { signal: 'KEEP_NATIVE' } }],
      },
    };
    host.instance.resolveCommand(nativeBatch);
    assert.ok(resolvedCmds.includes(nativeBatch));

    // Playback popup and non-tt settings popup strip report/feedback items.
    const settingsPopup = {
      openPopupAction: {
        uniqueId: 'settings-overlay',
        popup: {
          overlaySectionRenderer: {
            overlay: {
              overlayTwoPanelRenderer: {
                actionPanel: {
                  overlayPanelRenderer: {
                    content: {
                      overlayPanelItemListRenderer: {
                        items: [
                          { compactLinkRenderer: { command: { openClientOverlayAction: { type: 'FEEDBACK' } } } },
                          {
                            menuNavigationItemRenderer: {
                              navigationEndpoint: { openPopupAction: { uniqueId: 'report-dialog' } },
                            },
                          },
                          {
                            menuServiceItemRenderer: { serviceEndpoint: { signalAction: { signal: 'send feedback' } } },
                          },
                          { compactLinkRenderer: { title: { simpleText: 'Keep Setting' } } },
                        ],
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    host.instance.resolveCommand(settingsPopup);
    const filteredPopupItems =
      settingsPopup.openPopupAction.popup.overlaySectionRenderer.overlay.overlayTwoPanelRenderer.actionPanel
        .overlayPanelRenderer.content.overlayPanelItemListRenderer.items;
    assert.equal(filteredPopupItems.length, 1);

    // SET_PLAYER_SPEED, GO_TO_CHANNEL, and error paths for FEEDBACK_REASON / markFeedback.
    host.instance.resolveCommand({ customAction: { action: 'SET_PLAYER_SPEED', parameters: '1.5' } });
    assert.equal((fakeVideo as unknown as { playbackRate?: number }).playbackRate, 1.5);
    host.instance.resolveCommand({ customAction: { action: 'GO_TO_CHANNEL', parameters: { videoId: 'vid-err' } } });

    const origErr = console.error;
    let errCalls = 0;
    console.error = () => {
      errCalls++;
    };
    try {
      serviceMap.set('KabukiInnerTubeClient', {
        fetch: () => ({
          subscribe: (_onNext: unknown, onError?: (err: unknown) => void) => {
            onError?.(new Error('network boom'));
          },
        }),
      });
      host.instance.resolveCommand({ customAction: { action: 'FEEDBACK_REASON', parameters: { token: 't1' } } });
      host.instance.resolveCommand({
        customAction: { action: 'NOT_INTERESTED', parameters: { panelId: 'p', params: 'q' } },
      });
      await new Promise((r) => setTimeout(r, 20));
      assert.ok(errCalls >= 2);
    } finally {
      console.error = origErr;
    }

    // addLongPress edge cases: non-video tile, missing/plain text menu normalization, menu without showMenuCommand.
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
    addLongPress([nonVideoTile, menuNoShowCmd, plainTextTile]);
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

  test('patchResolveCommand blocks direct and nested startInlinePlaybackCommand during Watch/Shorts playback only', (t) => {
    const globals = globalThis as Record<string, unknown>;
    const origWindow = globals.window;
    const origDoc = globals.document;
    t.after(() => {
      if (origWindow === undefined) delete globals.window;
      else globals.window = origWindow;
      if (origDoc === undefined) delete globals.document;
      else globals.document = origDoc;
    });

    const dispatched: unknown[] = [];
    const bodyClasses = new Set<string>();
    const fakeLocation = { hash: '#/watch?v=mainVid', search: '' };
    const host = {
      instance: {
        resolveCommand: (cmd: unknown) => {
          dispatched.push(cmd);
          return true;
        },
      },
    };

    globals.document = { body: { classList: { contains: (cls: string) => bodyClasses.has(cls) } } };
    globals.window = {
      location: fakeLocation,
      _yttv: { router: host },
    };

    patchResolveCommand();

    const directPreview = {
      startInlinePlaybackCommand: { playbackEndpoint: { watchEndpoint: { videoId: 'sug1' } } },
    };
    assert.equal(host.instance.resolveCommand(directPreview), false);
    assert.equal(dispatched.length, 0);

    // Nested preview inside commandExecutorCommand is dropped while sibling non-preview commands execute.
    host.instance.resolveCommand({
      commandExecutorCommand: {
        commands: [directPreview, { signalAction: { signal: 'KEEP_ALIVE' } }],
      },
    });
    assert.deepEqual(dispatched, [{ signalAction: { signal: 'KEEP_ALIVE' } }]);

    // Shorts body class also blocks startInlinePlaybackCommand when location.hash stays at #/.
    fakeLocation.hash = '#/';
    bodyClasses.add('WEB_PAGE_TYPE_SHORTS');
    dispatched.length = 0;
    assert.equal(host.instance.resolveCommand(directPreview), false);
    assert.equal(dispatched.length, 0);

    // On Home (#/), startInlinePlaybackCommand passes through normally.
    bodyClasses.clear();
    assert.equal(host.instance.resolveCommand(directPreview), true);
    assert.deepEqual(dispatched, [directPreview]);
  });
});
