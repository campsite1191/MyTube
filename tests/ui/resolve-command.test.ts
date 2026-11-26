import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import resolveCommand, { patchResolveCommand } from '../../mods/ui/resolve-command.ts';

describe('resolve-command', () => {
  test('handles I18N_LANGUAGE, EXIT_APP, SKIP, SHOW_TOAST, NOT_INTERESTED, DONT_RECOMMEND_CHANNEL, and FEEDBACK_REASON', async (t) => {
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

    // 1. I18N_LANGUAGE sets PREF cookie and dispatches RELOAD_PAGE (direct and innertubeCommand-wrapped)
    host.instance.resolveCommand({
      setClientSettingEndpoint: {
        settingDatas: [{ clientSettingEnum: { item: 'I18N_LANGUAGE' }, stringValue: 'en-GB' }],
      },
    });
    assert.match(fakeDoc.cookie, /^PREF=hl=en-GB;/);
    assert.deepEqual(resolvedCmds.at(-1), { signalAction: { signal: 'RELOAD_PAGE' } });

    host.instance.resolveCommand({
      innertubeCommand: {
        setClientSettingEndpoint: {
          settingDatas: [{ clientSettingEnum: { item: 'I18N_LANGUAGE' }, stringValue: 'de-DE' }],
        },
      },
    });
    assert.match(fakeDoc.cookie, /^PREF=hl=de-DE;/);

    // 2. ACCOUNT_EVENT_TRIGGER_ON_EXIT dispatches EXIT_APP (direct and innertubeCommand-wrapped)
    const exitResult = host.instance.resolveCommand({
      requestAccountSelectorCommand: {
        identityActionContext: { eventTrigger: 'ACCOUNT_EVENT_TRIGGER_ON_EXIT' },
      },
    });
    assert.equal(exitResult, false);
    assert.deepEqual(resolvedCmds.at(-1), { signalAction: { signal: 'EXIT_APP' } });

    assert.equal(
      host.instance.resolveCommand({
        innertubeCommand: {
          requestAccountSelectorCommand: {
            identityActionContext: { eventTrigger: 'ACCOUNT_EVENT_TRIGGER_ON_EXIT' },
          },
        },
      }),
      false
    );
    assert.deepEqual(resolvedCmds.at(-1), { signalAction: { signal: 'EXIT_APP' } });

    // 3. Direct and innertubeCommand-wrapped customAction / nested commandExecutorCommand
    assert.equal(
      host.instance.resolveCommand({
        innertubeCommand: { customAction: { action: 'SHOW_TOAST', parameters: 'Wrapped Toast!' } },
      }),
      true
    );
    const wrappedSettingsPopup = {
      innertubeCommand: {
        openPopupAction: {
          uniqueId: 'playback-settings',
          popup: {
            menuPopupRenderer: {
              items: [
                {
                  compactLinkRenderer: {
                    icon: { iconType: 'SLOW_MOTION_VIDEO' },
                    title: { simpleText: 'Playback speed' },
                  },
                },
                { compactLinkRenderer: { icon: { iconType: 'FLAG' }, title: { simpleText: 'Report' } } },
              ],
            },
          },
        },
      },
    };
    host.instance.resolveCommand(wrappedSettingsPopup);
    assert.equal(wrappedSettingsPopup.innertubeCommand.openPopupAction.popup.menuPopupRenderer.items.length, 1);

    host.instance.resolveCommand({
      commandExecutorCommand: {
        commands: [
          null,
          { customAction: { action: 'SKIP', parameters: { time: 42 } } },
          { innertubeCommand: { customAction: { action: 'SHOW_TOAST', parameters: 'Skipped!' } } },
          {
            innertubeCommand: {
              commandExecutorCommand: {
                commands: [{ customAction: { action: 'SET_PLAYER_SPEED', parameters: 1.25 } }],
              },
            },
          },
          { signalAction: { signal: 'POPUP_BACK' } },
        ],
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(fakeVideo.currentTime, 42);
    assert.equal((fakeVideo as unknown as { playbackRate?: number }).playbackRate, 1.25);
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
        (c) =>
          (c as { openPopupAction?: { uniqueId?: string } } | null)?.openPopupAction?.uniqueId === 'tt-feedback-reasons'
      )
    );
    assert.ok(
      resolvedCmds.some(
        (c) => (c as { openPopupAction?: { popupType?: string } } | null)?.openPopupAction?.popupType === 'TOAST'
      )
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
                          { unknownRenderer: {} },
                          {
                            compactLinkRenderer: { icon: { iconType: 'INFO' }, title: { simpleText: 'Send feedback' } },
                          },
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
    assert.equal(filteredPopupItems.length, 2);

    const executorAutoTranslate = {
      commandExecutorCommand: {
        commands: [
          {
            commandExecutorCommand: {
              commands: [
                {
                  openPopupAction: {
                    uniqueId: 'CLIENT_OVERLAY_TYPE_CAPTIONS_AUTO_TRANSLATE',
                    popup: {
                      overlaySectionRenderer: {
                        overlay: {
                          overlayTwoPanelRenderer: {
                            actionPanel: {
                              overlayPanelRenderer: {
                                content: {
                                  overlayPanelItemListRenderer: {
                                    items: [],
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    };
    assert.equal(host.instance.resolveCommand(executorAutoTranslate), true);

    host.instance.resolveCommand({ customAction: { action: 'SET_PLAYER_SPEED', parameters: '1.5' } });
    assert.equal((fakeVideo as unknown as { playbackRate?: number }).playbackRate, 1.5);
    host.instance.resolveCommand({ customAction: { action: 'GO_TO_CHANNEL', parameters: { videoId: 'vid-err' } } });

    const origErr = console.error;
    let errCalls = 0;
    console.error = () => {
      errCalls++;
    };
    try {
      const prevDispatch = fakeDoc.dispatchEvent;
      fakeDoc.dispatchEvent = () => {
        throw new Error('dispatch boom');
      };
      host.instance.resolveCommand({ customAction: { action: 'SKIP', parameters: { time: 5 } } });
      await new Promise((r) => setTimeout(r, 10));
      fakeDoc.dispatchEvent = prevDispatch;

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
      assert.ok(errCalls >= 3);
    } finally {
      console.error = origErr;
    }
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

    host.instance.resolveCommand({
      commandExecutorCommand: {
        commands: [directPreview, { signalAction: { signal: 'KEEP_ALIVE' } }],
      },
    });
    assert.deepEqual(dispatched, [{ signalAction: { signal: 'KEEP_ALIVE' } }]);

    fakeLocation.hash = '#/';
    bodyClasses.add('WEB_PAGE_TYPE_SHORTS');
    dispatched.length = 0;
    assert.equal(host.instance.resolveCommand(directPreview), false);
    assert.equal(dispatched.length, 0);

    bodyClasses.clear();
    assert.equal(host.instance.resolveCommand(directPreview), true);
    assert.deepEqual(dispatched, [directPreview]);
  });

  test('[H3] patchResolveCommand blocks innertubeCommand-wrapped startInlinePlaybackCommand during Watch and Shorts playback', (t) => {
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

    const wrappedDirectPreview = {
      innertubeCommand: {
        startInlinePlaybackCommand: { playbackEndpoint: { watchEndpoint: { videoId: 'wrap1' } } },
      },
    };
    const wrappedExecutorPreview = {
      commandExecutorCommand: {
        commands: [
          {
            innertubeCommand: {
              startInlinePlaybackCommand: { playbackEndpoint: { watchEndpoint: { videoId: 'wrap2' } } },
            },
          },
          { signalAction: { signal: 'KEEP_ALIVE' } },
        ],
      },
    };

    assert.equal(host.instance.resolveCommand(wrappedDirectPreview), false);
    assert.equal(dispatched.length, 0);

    host.instance.resolveCommand(wrappedExecutorPreview);
    assert.deepEqual(dispatched, [{ signalAction: { signal: 'KEEP_ALIVE' } }]);

    fakeLocation.hash = '#/';
    bodyClasses.add('WEB_PAGE_TYPE_SHORTS');
    dispatched.length = 0;
    assert.equal(host.instance.resolveCommand(wrappedDirectPreview), false);
    assert.equal(dispatched.length, 0);
  });

  test('handles edge command shapes, non-record resolve payloads, menuPopupRenderer, and partial markFeedback results', async (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevDoc = globals.document;
    const dispatched: unknown[] = [];
    let cookieVal = '';
    const fakeDoc = {
      get cookie() {
        return cookieVal;
      },
      set cookie(v: string) {
        cookieVal = v;
      },
    };

    let mockPanelItems: unknown[] = [];
    let mockFeedbackResponse: unknown = { feedbackResponses: [] };
    const serviceMap = new Map<string, unknown>([
      [
        'KabukiInnerTubeClient',
        {
          fetch: (req: { path: string }) => ({
            subscribe: (onNext: (res: unknown) => void) => {
              if (req.path === '/youtubei/v1/get_panel') {
                onNext({
                  content: {
                    engagementPanelSectionListRenderer: {
                      content: { listViewModel: { listItems: mockPanelItems } },
                    },
                  },
                });
              } else if (req.path === '/youtubei/v1/feedback') {
                onNext(mockFeedbackResponse);
              }
            },
          }),
        },
      ],
    ]);

    const host = {
      instance: {
        resolveCommand: (cmd: unknown, arg?: unknown) => {
          dispatched.push({ cmd, arg });
          return 'native-res';
        },
      },
    };

    t.after(() => {
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevDoc === undefined) delete globals.document;
      else globals.document = prevDoc;
    });

    globals.document = fakeDoc;
    globals.window = {
      _yttv: {
        router: host,
        services: { mappings: serviceMap },
      },
    };

    // Missing-host guards before/after patching.
    delete globals.window;
    assert.equal(resolveCommand({ signalAction: { signal: 'NO_HOST' } }), undefined);
    globals.window = {
      _yttv: {
        router: host,
        services: { mappings: serviceMap },
      },
    };
    patchResolveCommand();

    // Non-record rawCmd delegates directly to original resolveCommand.
    assert.equal(host.instance.resolveCommand('plain-string', 42), 'native-res');
    assert.deepEqual(dispatched.at(-1), { cmd: 'plain-string', arg: 42 });

    // setClientSettingEndpoint without settingDatas array and with non-string I18N_LANGUAGE stringValue.
    assert.equal(host.instance.resolveCommand({ setClientSettingEndpoint: {} }), 'native-res');
    assert.equal(
      host.instance.resolveCommand({
        setClientSettingEndpoint: {
          settingDatas: [{ clientSettingEnum: { item: 'I18N_LANGUAGE' }, stringValue: 123 }],
        },
      }),
      true
    );
    assert.match(cookieVal, /PREF=hl=;/);

    // requestAccountSelectorCommand with missing identityActionContext and non-exit trigger passes through (also inside commandExecutorCommand).
    assert.equal(host.instance.resolveCommand({ requestAccountSelectorCommand: {} }), 'native-res');
    const accountPick = { requestAccountSelectorCommand: { identityActionContext: { eventTrigger: 'MANUAL' } } };
    assert.equal(host.instance.resolveCommand(accountPick), 'native-res');
    host.instance.resolveCommand({
      commandExecutorCommand: {
        commands: [
          { requestAccountSelectorCommand: {} },
          accountPick,
          {
            requestAccountSelectorCommand: { identityActionContext: { eventTrigger: 'ACCOUNT_EVENT_TRIGGER_ON_EXIT' } },
          },
        ],
      },
    });

    // Deep innertubeCommand chain (> 4 hops) exercises depth guard inside needsCommandInterception via commandExecutorCommand.
    const deepCmd = {
      commandExecutorCommand: {
        commands: [
          {
            innertubeCommand: {
              innertubeCommand: {
                innertubeCommand: {
                  innertubeCommand: {
                    innertubeCommand: {
                      openPopupAction: { uniqueId: 'playback-settings' },
                    },
                  },
                },
              },
            },
          },
          { signalAction: { signal: 'AFTER_DEEP' } },
        ],
      },
    };
    host.instance.resolveCommand(deepCmd);
    assert.equal(
      (dispatched.at(-1) as { cmd?: { commandExecutorCommand?: { commands?: unknown[] } } }).cmd?.commandExecutorCommand
        ?.commands?.length,
      2
    );

    // menuPopupRenderer fallback + missing listContainer + null popup item + non-compactLinkRenderer in playback-settings.
    host.instance.resolveCommand({ openPopupAction: { uniqueId: 'settings-overlay', popup: {} } });
    const menuPopupCmd = {
      openPopupAction: {
        uniqueId: 'playback-settings',
        popup: {
          menuPopupRenderer: {
            items: [
              null,
              { compactToggleRenderer: { title: { simpleText: 'Toggle' } } },
              { menuNavigationItemRenderer: { icon: { iconType: 'FLAG' } } },
            ],
          },
        },
      },
    };
    host.instance.resolveCommand(menuPopupCmd);
    assert.equal(menuPopupCmd.openPopupAction.popup.menuPopupRenderer.items.length, 2);

    // markFeedback guards: missing params/panelId, missing token at index, non-record response, and empty/missing reasons.
    host.instance.resolveCommand({ customAction: { action: 'NOT_INTERESTED' } });
    await new Promise((r) => setTimeout(r, 10));

    mockPanelItems = [];
    host.instance.resolveCommand({
      customAction: { action: 'NOT_INTERESTED', parameters: { panelId: 'p', params: 'x' } },
    });
    await new Promise((r) => setTimeout(r, 10));

    mockPanelItems = [{ listItemViewModel: { rendererContext: { commandContext: { feedbackToken: 'tok-1' } } } }];
    mockFeedbackResponse = null;
    host.instance.resolveCommand({
      customAction: { action: 'NOT_INTERESTED', parameters: { panelId: 'p', params: 'x' } },
    });
    await new Promise((r) => setTimeout(r, 10));

    mockFeedbackResponse = { noResponses: true };
    host.instance.resolveCommand({
      customAction: { action: 'NOT_INTERESTED', parameters: { panelId: 'p', params: 'x' } },
    });
    await new Promise((r) => setTimeout(r, 10));

    mockFeedbackResponse = {
      feedbackResponses: [{ followUpDialog: { dismissalFollowUpRenderer: {} } }],
    };
    host.instance.resolveCommand({
      customAction: { action: 'NOT_INTERESTED', parameters: { panelId: 'p', params: 'x' } },
    });
    await new Promise((r) => setTimeout(r, 10));

    mockFeedbackResponse = {
      feedbackResponses: [{ followUpDialog: { dismissalFollowUpRenderer: { reasons: [] } } }],
    };
    host.instance.resolveCommand({
      customAction: { action: 'NOT_INTERESTED', parameters: { panelId: 'p', params: 'x' } },
    });
    await new Promise((r) => setTimeout(r, 15));
  });
});
