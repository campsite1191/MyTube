import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { configChangeEmitter, configRead, configWrite, initConfig } from '../mods/core/config.ts';
import { injectCss } from '../mods/core/styles.ts';
import { applyDeArrowBranding, clearDeArrowCache } from '../mods/transforms/thumbnails.ts';
import { transformGuideResponse } from '../mods/ui/custom-guide-action.ts';

describe('regression fixes', () => {
  test('initConfig and configWrite recover cleanly when IndexedDB is unavailable', async () => {
    const warnings: unknown[][] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };

    try {
      await assert.doesNotReject(() => initConfig());
      assert.equal(configRead('enableAdBlock'), true);

      let eventSeen = false;
      const listener = () => {
        eventSeen = true;
      };
      configChangeEmitter.addEventListener('configChange', listener);
      try {
        await assert.doesNotReject(() => configWrite('enableAdBlock', false));
        assert.equal(configRead('enableAdBlock'), false);
        assert.equal(eventSeen, true);
      } finally {
        configChangeEmitter.removeEventListener('configChange', listener);
        await configWrite('enableAdBlock', true);
      }
      assert.ok(warnings.length >= 1);
    } finally {
      console.warn = origWarn;
    }
  });

  test('transformGuideResponse orders and filters sections synchronously even when sidebar order grows', () => {
    const payload = {
      items: [
        {
          guideSectionRenderer: {
            items: [
              { guideEntryRenderer: { navigationEndpoint: { browseEndpoint: { browseId: 'FEtopics_music' } } } },
              { guideEntryRenderer: { navigationEndpoint: { browseEndpoint: { browseId: 'FEnew_custom' } } } },
              { guideEntryRenderer: { navigationEndpoint: { browseEndpoint: { browseId: 'FEtopics' } } } },
              { guideEntryRenderer: { navigationEndpoint: { searchEndpoint: {} } } },
            ],
          },
        },
      ],
    };

    const result = transformGuideResponse(payload) as typeof payload;
    const sectionItems = result.items[0]?.guideSectionRenderer.items ?? [];
    const ids = sectionItems.map((entry) => {
      const ep = entry.guideEntryRenderer?.navigationEndpoint;
      return ep?.browseEndpoint?.browseId ?? (ep?.searchEndpoint ? 'search' : '');
    });

    // 'FEtopics_music' is disabled by default; 'search' precedes 'FEtopics' and new item 'FEnew_custom' is retained.
    assert.equal(ids.includes('FEtopics_music'), false);
    assert.deepEqual(ids, ['search', 'FEtopics', 'FEnew_custom']);
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
      return new Response(
        JSON.stringify({ titles: [{ title: 'Cached Title', votes: 10 }], thumbnails: [] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
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
      await applyDeArrowBranding([a, b], { enableDeArrow: true, enableDeArrowThumbnails: false });
      assert.equal(fetchCalls, 1);
      assert.equal(a.tileRenderer.metadata.tileMetadataRenderer.title.simpleText, 'Cached Title');
      assert.equal(b.tileRenderer.metadata.tileMetadataRenderer.title.simpleText, 'Cached Title');

      const c = makeItem('dedupVid1');
      await applyDeArrowBranding([c], { enableDeArrow: true, enableDeArrowThumbnails: false });
      assert.equal(fetchCalls, 1);
      assert.equal(c.tileRenderer.metadata.tileMetadataRenderer.title.simpleText, 'Cached Title');

      clearDeArrowCache();
      const d = makeItem('dedupVid1');
      await applyDeArrowBranding([d], { enableDeArrow: true, enableDeArrowThumbnails: false });
      assert.equal(fetchCalls, 2);
    } finally {
      clearDeArrowCache();
      globalThis.fetch = origFetch;
    }
  });
});
