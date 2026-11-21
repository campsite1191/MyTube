import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { patchResolveCommand } from '../mods/core/resolve-command.ts';
import { injectCss } from '../mods/core/styles.ts';
import { whenYttvReady } from '../mods/core/yttv-bridge.ts';
import { applyDeArrowBranding, clearDeArrowCache } from '../mods/transforms/thumbnails.ts';
import { transformGuideResponse } from '../mods/ui/custom-guide-action.ts';

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

      // Player settings popups strip Report and Feedback entries regardless of icon/endpoint/title variation.
      const settingsMenuItems = [
        { compactLinkRenderer: { title: { runs: [{ text: 'Quality' }] }, icon: { iconType: 'SETTINGS' } } },
        { compactLinkRenderer: { title: { simpleText: 'Report video' }, icon: { iconType: 'OUTLINED_FLAG' } } },
        { compactLinkRenderer: { title: { simpleText: 'Bug' }, serviceEndpoint: { sendFeedbackEndpoint: {} } } },
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
                          selectedIndex: 2,
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
      assert.equal(settingsMenuItems.length, 1);
      assert.equal(
        (settingsMenuItems[0]?.compactLinkRenderer.title as { runs?: Array<{ text?: string }> }).runs?.[0]?.text,
        'Quality'
      );
    } finally {
      (globalThis as { window?: unknown }).window = origWindow;
      (globalThis as { document?: unknown }).document = origDoc;
    }
  });
});
