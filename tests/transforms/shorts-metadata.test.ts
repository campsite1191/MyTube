import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { installInnertubeInterceptor } from '../../mods/core/innertube-interceptor.ts';
import {
  applyShortsFeedMetadata,
  clearShortsMetadataCache,
  enrichShortsPlayerOverlay,
  extractShortsMetadataFromReel,
  formatShortsUploadedAt,
  formatShortsViewCount,
  installShortsMetadata,
} from '../../mods/transforms/shorts-metadata.ts';
import type { FeedItem } from '../../mods/types/innertube.ts';

function makeReelPayload(
  videoId: string,
  views: string,
  timestamp: string,
  title = 'Cool Short'
): Record<string, unknown> {
  return {
    overlay: {
      reelPlayerOverlayRenderer: {
        reelPlayerHeaderSupportedRenderers: {
          reelPlayerHeaderRenderer: {
            reelTitleText: { runs: [{ text: title }] },
            timestampText: { simpleText: timestamp },
            channelTitleText: { runs: [{ text: '@Creator' }] },
          },
        },
        buttonBar: {
          reelActionBarViewModel: {
            buttonViewModels: [
              {
                reelActionBarButtonViewModel: {
                  buttonViewModel: {
                    likeButtonViewModel: {
                      toggleButtonViewModel: {
                        toggleButtonViewModel: {
                          defaultButtonViewModel: {
                            buttonViewModel: {
                              iconName: 'EMPTY_HEART',
                              title: '385K',
                              onTap: {
                                innertubeCommand: {
                                  likeEndpoint: { target: { videoId } },
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
              {
                reelActionBarButtonViewModel: {
                  buttonViewModel: {
                    buttonViewModel: { iconName: 'COMMENT', title: '6,238' },
                  },
                },
              },
            ],
          },
        },
      },
    },
    engagementPanels: [
      {
        engagementPanelSectionListRenderer: {
          content: {
            structuredDescriptionContentRenderer: {
              items: [
                {
                  videoDescriptionHeaderRenderer: {
                    views: { simpleText: views },
                    publishDate: { simpleText: 'Published on Nov 20, 2026' },
                  },
                },
              ],
            },
          },
        },
      },
    ],
    __videoId: videoId,
  };
}

describe('shorts-metadata', () => {
  test('formats view counts and upload timestamps cleanly', () => {
    assert.equal(formatShortsViewCount('12,318,166 views'), '12.3M views');
    assert.equal(formatShortsViewCount('842 views'), '842 views');
    assert.equal(formatShortsViewCount('1 view'), '1 view');
    assert.equal(formatShortsViewCount('93M views'), '93M views');
    assert.equal(formatShortsViewCount('No views'), 'No views');
    assert.equal(formatShortsViewCount(''), null);

    assert.equal(formatShortsUploadedAt('1 day ago', 'Published on Nov 20, 2026'), '1 day ago');
    assert.equal(formatShortsUploadedAt('', 'Published on Nov 20, 2026'), 'Nov 20, 2026');
    assert.equal(formatShortsUploadedAt('', ''), null);
  });

  test('extractShortsMetadataFromReel and enrichShortsPlayerOverlay append metadata idempotently', () => {
    const payload = makeReelPayload('WjCH5JUNzao', '12,318,166 views', '1 day ago', 'Can I Beat Magnus?');
    assert.equal(extractShortsMetadataFromReel(payload), '12.3M views • 1 day ago');

    assert.equal(enrichShortsPlayerOverlay(payload), true);
    const hdr = (
      payload.overlay as {
        reelPlayerOverlayRenderer: {
          reelPlayerHeaderSupportedRenderers: {
            reelPlayerHeaderRenderer: { reelTitleText: { runs: Array<{ text: string }> } };
          };
          buttonBar: {
            reelActionBarViewModel: {
              buttonViewModels: Array<{
                reelActionBarButtonViewModel?: {
                  buttonViewModel?: { buttonViewModel?: { iconName?: string; accessibilityText?: string } };
                };
              }>;
            };
          };
        };
      }
    ).reelPlayerOverlayRenderer;

    assert.deepEqual(hdr.reelPlayerHeaderSupportedRenderers.reelPlayerHeaderRenderer.reelTitleText.runs, [
      { text: 'Can I Beat Magnus?' },
      { text: '\n12.3M views • 1 day ago' },
    ]);
    assert.equal(hdr.buttonBar.reelActionBarViewModel.buttonViewModels.length, 3);
    assert.equal(
      hdr.buttonBar.reelActionBarViewModel.buttonViewModels[1]?.reelActionBarButtonViewModel?.buttonViewModel
        ?.buttonViewModel?.iconName,
      'DISLIKE'
    );

    // Second call is idempotent
    assert.equal(enrichShortsPlayerOverlay(payload), false);
    assert.equal(hdr.reelPlayerHeaderSupportedRenderers.reelPlayerHeaderRenderer.reelTitleText.runs.length, 2);
    assert.equal(hdr.buttonBar.reelActionBarViewModel.buttonViewModels.length, 3);

    // Also supports simpleText titles
    const simplePayload: Record<string, unknown> = {
      overlay: {
        reelPlayerOverlayRenderer: {
          reelPlayerHeaderSupportedRenderers: {
            reelPlayerHeaderRenderer: {
              reelTitleText: { simpleText: 'Simple Title' },
              timestampText: { simpleText: '3 hours ago' },
            },
          },
        },
      },
      engagementPanels: [
        {
          engagementPanelSectionListRenderer: {
            content: {
              structuredDescriptionContentRenderer: {
                items: [
                  {
                    videoDescriptionHeaderRenderer: {
                      factoid: [
                        { factoidRenderer: { label: { simpleText: 'Views' }, value: { simpleText: '4,500' } } },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    };
    assert.equal(enrichShortsPlayerOverlay(simplePayload), true);
    const simpleHdr = (
      simplePayload.overlay as {
        reelPlayerOverlayRenderer: {
          reelPlayerHeaderSupportedRenderers: {
            reelPlayerHeaderRenderer: { reelTitleText: { simpleText?: string; runs?: Array<{ text: string }> } };
          };
        };
      }
    ).reelPlayerOverlayRenderer.reelPlayerHeaderSupportedRenderers.reelPlayerHeaderRenderer;
    assert.equal(simpleHdr.reelTitleText.simpleText, undefined);
    assert.deepEqual(simpleHdr.reelTitleText.runs, [{ text: 'Simple Title' }, { text: '\n4.5K views • 3 hours ago' }]);
  });

  test('applyShortsFeedMetadata prefetches visible Short shelf tiles and ignores regular videos', async (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevFetch = globals.fetch;

    const fetchedIds: string[] = [];
    globals.window = {
      ytcfg: {
        data_: {
          INNERTUBE_CONTEXT: { client: { clientName: 'TVHTML5' } },
          INNERTUBE_CONTEXT_CLIENT_NAME: 7,
          INNERTUBE_CONTEXT_CLIENT_VERSION: '7.2026',
        },
      },
    };
    globals.fetch = async (_url: unknown, init?: { body?: string }) => {
      const parsed = init?.body ? (JSON.parse(init.body) as { playerRequest?: { videoId?: string } }) : {};
      const vid = parsed.playerRequest?.videoId ?? '';
      fetchedIds.push(vid);
      return {
        ok: true,
        json: async () => makeReelPayload(vid, '2,500,000 views', '2 weeks ago'),
      };
    };

    const uninstallShortsMeta = installShortsMetadata();
    t.after(() => {
      uninstallShortsMeta();
      clearShortsMetadataCache();
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      globals.fetch = prevFetch;
    });

    const regularVideo: FeedItem = {
      tileRenderer: {
        contentId: 'regVid00001',
        contentType: 'TILE_CONTENT_TYPE_VIDEO',
        metadata: { tileMetadataRenderer: { title: { simpleText: 'Regular' } } },
      },
    };
    const shortTile: FeedItem = {
      tileRenderer: {
        style: 'TILE_STYLE_YTLR_SHORTS',
        contentId: 'shortVid001',
        contentType: 'TILE_CONTENT_TYPE_SHORTS',
        metadata: { tileMetadataRenderer: { title: { simpleText: 'My Short' } } },
      },
    };

    await applyShortsFeedMetadata([regularVideo, shortTile]);
    assert.deepEqual(fetchedIds, ['shortVid001']);
    assert.equal(regularVideo.tileRenderer?.metadata?.tileMetadataRenderer?.lines, undefined);
    const shortLines = shortTile.tileRenderer?.metadata?.tileMetadataRenderer?.lines as Array<{
      lineRenderer: { items: Array<{ lineItemRenderer: { text: { simpleText: string } } }> };
    }>;
    assert.equal(
      shortLines?.[0]?.lineRenderer?.items?.[0]?.lineItemRenderer?.text?.simpleText,
      '2.5M views • 2 weeks ago'
    );

    // Subsequent call uses cache without another fetch
    const shortTileCached: FeedItem = {
      tileRenderer: {
        style: 'TILE_STYLE_YTLR_SHORTS',
        contentId: 'shortVid001',
        metadata: { tileMetadataRenderer: { title: { simpleText: 'My Short Again' } } },
      },
    };
    await applyShortsFeedMetadata([shortTileCached]);
    assert.deepEqual(fetchedIds, ['shortVid001']);
    const cachedLines = shortTileCached.tileRenderer?.metadata?.tileMetadataRenderer?.lines as typeof shortLines;
    assert.equal(
      cachedLines?.[0]?.lineRenderer?.items?.[0]?.lineItemRenderer?.text?.simpleText,
      '2.5M views • 2 weeks ago'
    );
  });

  test('installShortsMetadata lazily fetches off-screen Short metadata on focusin and updates mounted DOM tiles', async (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevDocument = globals.document;
    const prevFetch = globals.fetch;
    const prevElement = globals.Element;

    class MockElement {}
    globals.Element = MockElement;

    let focusInHandler: ((ev: { target: unknown }) => void) | undefined;
    let hashChangeHandler: (() => void) | undefined;
    const lineTextEl = { textContent: '\u00A0' };
    const thumbDetailsEl = {
      style: { backgroundImage: 'url("https://i.ytimg.com/vi/focusShort1/oar2.jpg")' },
      closest: (sel: string) => (sel === 'ytlr-tile-renderer' ? tileEl : null),
    };
    const tileEl = Object.assign(new MockElement(), {
      closest: (sel: string) => (sel === 'ytlr-tile-renderer' ? tileEl : null),
      querySelector: (sel: string) => {
        if (sel === 'ytlr-thumbnail-details') return thumbDetailsEl;
        if (sel.includes('yt-formatted-string')) return lineTextEl;
        return null;
      },
    });

    globals.window = {
      addEventListener: (type: string, cb: () => void) => {
        if (type === 'hashchange') hashChangeHandler = cb;
      },
      ytcfg: {
        data_: {
          INNERTUBE_CONTEXT: { client: { clientName: 'TVHTML5' } },
          INNERTUBE_CONTEXT_CLIENT_NAME: 7,
          INNERTUBE_CONTEXT_CLIENT_VERSION: '7.2026',
          VISITOR_DATA: 'vis-123',
        },
      },
    };
    globals.document = {
      addEventListener: (type: string, cb: (ev: { target: unknown }) => void) => {
        if (type === 'focusin') focusInHandler = cb;
      },
      querySelectorAll: (sel: string) => (sel.includes('/focusShort1/') ? [thumbDetailsEl] : []),
    };
    let fetchCount = 0;
    globals.fetch = async () => {
      fetchCount++;
      return {
        ok: true,
        text: async () => JSON.stringify(makeReelPayload('focusShort1', '98,400 views', '5 hours ago')),
      };
    };

    const uninstallShortsMeta = installShortsMetadata();
    t.after(() => {
      uninstallShortsMeta();
      clearShortsMetadataCache();
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
      if (prevElement === undefined) delete globals.Element;
      else globals.Element = prevElement;
      globals.fetch = prevFetch;
    });

    assert.equal(typeof focusInHandler, 'function');
    assert.equal(typeof hashChangeHandler, 'function');

    focusInHandler?.({ target: tileEl });
    await new Promise((r) => setTimeout(r, 25));

    assert.equal(fetchCount, 1);
    assert.equal(lineTextEl.textContent, '98.4K views • 5 hours ago');

    // Focusing again uses cached label immediately without re-fetching
    lineTextEl.textContent = '';
    focusInHandler?.({ target: tileEl });
    assert.equal(fetchCount, 1);
    assert.equal(lineTextEl.textContent, '98.4K views • 5 hours ago');

    // Focusing a regular video tile with empty text must NOT call reel_item_watch.
    const regularTile = Object.assign(new MockElement(), {
      classList: { contains: () => false },
      closest: () => regularTile,
      querySelector: (sel: string) => {
        if (sel === 'ytlr-thumbnail-details') {
          return { style: { backgroundImage: 'url("https://i.ytimg.com/vi/regVideo123/hq720.jpg")' } };
        }
        if (sel.includes('yt-formatted-string')) return { textContent: '' };
        return null;
      },
    });
    focusInHandler?.({ target: regularTile });
    assert.equal(fetchCount, 1);

    hashChangeHandler?.();
  });

  test('suppresses overlay enrichment during response.json() with interceptor active, enforces 6-item cap, deduplicates in-flight, and handles rAF/errors', async (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevFetch = globals.fetch;
    const prevRaf = globals.requestAnimationFrame;

    const fetchedIds: string[] = [];
    let overlayTriggeredDuringPrefetch = false;

    globals.requestAnimationFrame = (cb: () => void) => {
      cb();
      return 1;
    };
    globals.window = {
      addEventListener: () => {},
      removeEventListener: () => {},
      ytcfg: {
        d: () => ({
          INNERTUBE_CONTEXT: { client: { clientName: 'TVHTML5' } },
          INNERTUBE_CONTEXT_CLIENT_NAME: 7,
          INNERTUBE_CONTEXT_CLIENT_VERSION: '7.2026',
        }),
      },
    };
    globals.fetch = async (_url: unknown, init?: { body?: string }) => {
      const parsed = init?.body ? (JSON.parse(init.body) as { playerRequest?: { videoId?: string } }) : {};
      const vid = parsed.playerRequest?.videoId ?? '';
      fetchedIds.push(vid);
      if (vid === 'errShort001') {
        return { ok: false, status: 500 };
      }
      // Deliberately expose only .json() (not .text()) while Response.prototype.json is intercepted.
      const resp = new Response(JSON.stringify(makeReelPayload(vid, '10,000 views', '1 day ago')), { status: 200 });
      const origJson = resp.json.bind(resp);
      Object.defineProperty(resp, 'text', { value: undefined });
      resp.json = async () => {
        const data = (await origJson()) as Record<string, unknown>;
        if (enrichShortsPlayerOverlay(data)) {
          overlayTriggeredDuringPrefetch = true;
        }
        return data;
      };
      return resp;
    };

    const restoreInterceptor = installInnertubeInterceptor();
    t.after(() => {
      restoreInterceptor();
      clearShortsMetadataCache();
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      globals.fetch = prevFetch;
      if (prevRaf === undefined) delete globals.requestAnimationFrame;
      else globals.requestAnimationFrame = prevRaf;
    });

    const shortsBatch: FeedItem[] = [];
    for (let i = 1; i <= 8; i++) {
      const id = i === 1 ? 'errShort001' : `capShort00${i}`;
      shortsBatch.push({
        tileRenderer: {
          style: 'TILE_STYLE_YTLR_SHORTS',
          contentId: id,
          metadata: { tileMetadataRenderer: { title: { simpleText: `Short ${i}` } } },
        },
      });
    }
    // Add duplicate videoId to exercise inFlightShortsMeta dedup and pre-populated line skip.
    shortsBatch.push(
      {
        tileRenderer: {
          style: 'TILE_STYLE_YTLR_SHORTS',
          contentId: 'capShort002',
          metadata: { tileMetadataRenderer: { title: { simpleText: 'Dup Short 2' } } },
        },
      },
      {
        tileRenderer: {
          style: 'TILE_STYLE_YTLR_SHORTS',
          contentId: 'alreadyFull1',
          metadata: {
            tileMetadataRenderer: {
              lines: [{ lineRenderer: { items: [{ lineItemRenderer: { text: { simpleText: '1K views' } } }] } }],
            },
          },
        },
      }
    );

    await applyShortsFeedMetadata(shortsBatch);
    assert.equal(fetchedIds.length, 6);
    assert.equal(overlayTriggeredDuringPrefetch, false);

    // Calling ytcfg.d() throwing returns null safely; aborting mid-yield skips fetches cleanly.
    (globals.window as { ytcfg: { d: () => unknown } }).ytcfg = {
      d: () => {
        throw new Error('broken ytcfg');
      },
    };
    const sixthShort = shortsBatch[6];
    assert.ok(sixthShort);
    await applyShortsFeedMetadata([sixthShort]);

    globals.window = {
      ytcfg: {
        data_: { INNERTUBE_CONTEXT: {} },
      },
    };
    const abortBatch = applyShortsFeedMetadata([sixthShort]);
    clearShortsMetadataCache();
    await abortBatch;

    // Missing engagement panel description header & factoids without Views return null; reelTitle without runs/simpleText skips title mutation.
    assert.equal(
      extractShortsMetadataFromReel({
        engagementPanels: [
          {
            engagementPanelSectionListRenderer: {
              content: { structuredDescriptionContentRenderer: { items: [{ unrelated: {} }] } },
            },
          },
        ],
      }),
      null
    );
    assert.equal(
      extractShortsMetadataFromReel({
        engagementPanels: [
          {
            engagementPanelSectionListRenderer: {
              content: {
                structuredDescriptionContentRenderer: {
                  items: [
                    {
                      videoDescriptionHeaderRenderer: {
                        factoid: [{ factoidRenderer: { label: { simpleText: 'Likes' }, value: { simpleText: '5K' } } }],
                      },
                    },
                  ],
                },
              },
            },
          },
        ],
      }),
      null
    );
    const rawHeaderPayload = makeReelPayload('titleless1', '500 views', '1 day ago');
    (
      rawHeaderPayload as {
        overlay: {
          reelPlayerOverlayRenderer: {
            reelPlayerHeaderSupportedRenderers: {
              reelPlayerHeaderRenderer: { reelTitleText: Record<string, unknown> };
            };
          };
        };
      }
    ).overlay.reelPlayerOverlayRenderer.reelPlayerHeaderSupportedRenderers.reelPlayerHeaderRenderer.reelTitleText = {
      accessibility: { accessibilityData: { label: 'Short accessible title' } },
    };
    assert.equal(enrichShortsPlayerOverlay(rawHeaderPayload), true);

    // Thumbnail-URL videoId fallback, non-YT URL miss, existing PLACEHOLDER_TEXT line replacement, setTimeout yield (no rAF), fetch error & empty metadata cleanup.
    delete globals.requestAnimationFrame;
    const unidentifiableShortTile: FeedItem = {
      tileRenderer: {
        style: 'TILE_STYLE_YTLR_SHORTS',
        header: {
          tileHeaderRenderer: {
            thumbnail: { thumbnails: [{ url: 'https://example.com/no-video-id.jpg', width: 100, height: 100 }] },
          },
        },
      },
    };
    const shortPlaceholderTile: FeedItem = {
      tileRenderer: {
        style: 'TILE_STYLE_YTLR_SHORTS',
        header: {
          tileHeaderRenderer: {
            thumbnail: {
              thumbnails: [{ url: 'https://i.ytimg.com/vi/thumbShort1/oar2.jpg', width: 720, height: 1280 }],
            },
          },
        },
        metadata: {
          tileMetadataRenderer: {
            lines: [{ lineRenderer: { items: [{ lineItemRenderer: { text: { simpleText: '\u00A0' } } }] } }],
          },
        },
      },
    };
    globals.fetch = async () => {
      throw new Error('network down');
    };
    await applyShortsFeedMetadata([unidentifiableShortTile, shortPlaceholderTile]);
    // Empty metadata payload deletes pending targets cleanly; missing INNERTUBE_CONTEXT returns null.
    const emptyPayloadTile: FeedItem = {
      tileRenderer: {
        style: 'TILE_STYLE_YTLR_SHORTS',
        contentId: 'emptyShort2',
        metadata: { tileMetadataRenderer: {} },
      },
    };
    globals.fetch = async () => ({
      ok: true,
      text: async () => JSON.stringify({}),
    });
    await applyShortsFeedMetadata([emptyPayloadTile]);
    globals.window = { ytcfg: { data_: {} } };
    await applyShortsFeedMetadata([emptyPayloadTile]);
  });

  test('[M1] aborts in-flight Home shelf reel_item_watch fetches when entering WEB_PAGE_TYPE_SHORTS without hashchange', async (t) => {
    clearShortsMetadataCache();
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevDocument = globals.document;
    const prevFetch = globals.fetch;
    const prevRaf = globals.requestAnimationFrame;
    const prevMutationObserver = globals.MutationObserver;

    const observers: Array<{ target: unknown; cb: (mutations: unknown[]) => void; disconnected: boolean }> = [];
    globals.MutationObserver = class {
      private readonly rec: { target: unknown; cb: (mutations: unknown[]) => void; disconnected: boolean };
      constructor(cb: (mutations: unknown[]) => void) {
        this.rec = { target: null, cb, disconnected: false };
      }
      observe(target: unknown): void {
        this.rec.target = target;
        observers.push(this.rec);
      }
      disconnect(): void {
        this.rec.disconnected = true;
      }
    };
    globals.requestAnimationFrame = (cb: () => void) => {
      cb();
      return 1;
    };

    const bodyClasses = new Set<string>();
    const bodyEl = {
      classList: {
        contains: (cls: string) => bodyClasses.has(cls),
      },
    };
    globals.window = {
      location: { hash: '#/', search: '' },
      addEventListener: () => {},
      removeEventListener: () => {},
      ytcfg: {
        d: () => ({
          INNERTUBE_CONTEXT: { client: { clientName: 'TVHTML5' } },
          INNERTUBE_CONTEXT_CLIENT_NAME: 7,
          INNERTUBE_CONTEXT_CLIENT_VERSION: '7.2026',
        }),
      },
    };
    globals.document = {
      body: bodyEl,
      documentElement: bodyEl,
      addEventListener: () => {},
      removeEventListener: () => {},
      querySelectorAll: () => [],
    };

    let fetchSignal: AbortSignal | undefined;
    let notifyStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    globals.fetch = ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        fetchSignal = init?.signal ?? undefined;
        notifyStarted();
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      })) as typeof fetch;

    const uninstallShortsMeta = installShortsMetadata();
    t.after(() => {
      uninstallShortsMeta();
      clearShortsMetadataCache();
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
      globals.fetch = prevFetch;
      if (prevRaf === undefined) delete globals.requestAnimationFrame;
      else globals.requestAnimationFrame = prevRaf;
      if (prevMutationObserver === undefined) delete globals.MutationObserver;
      else globals.MutationObserver = prevMutationObserver;
    });

    const pending = applyShortsFeedMetadata([
      {
        tileRenderer: {
          style: 'TILE_STYLE_YTLR_SHORTS',
          contentId: 'homeShortM1',
          metadata: { tileMetadataRenderer: { title: { simpleText: 'Short M1' } } },
        },
      },
    ]);
    await fetchStarted;

    // Opening Shorts toggles body.WEB_PAGE_TYPE_SHORTS while location.hash stays '#/'.
    bodyClasses.add('WEB_PAGE_TYPE_SHORTS');
    for (const obs of observers.filter(
      (o) => !o.disconnected && (o.target === bodyEl || o.target === globals.document)
    )) {
      obs.cb([{ type: 'attributes', attributeName: 'class', target: bodyEl }]);
    }

    assert.equal(fetchSignal?.aborted, true);
    await pending;
  });

  test('[M4] negative-caches empty 200 OK reel_item_watch responses and clears placeholder so focusin does not re-fetch', async (t) => {
    clearShortsMetadataCache();
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevDocument = globals.document;
    const prevFetch = globals.fetch;
    const prevElement = globals.Element;
    const prevRaf = globals.requestAnimationFrame;

    class MockElement {}
    globals.Element = MockElement;
    globals.requestAnimationFrame = (cb: () => void) => {
      cb();
      return 1;
    };

    let focusInHandler: ((ev: { target: unknown }) => void) | undefined;
    const lineTextEl = { textContent: '\u00A0' };
    const thumbDetailsEl = {
      style: { backgroundImage: 'url("https://i.ytimg.com/vi/emptyMeta01/oar2.jpg")' },
      closest: (sel: string) => (sel === 'ytlr-tile-renderer' ? tileEl : null),
    };
    const tileEl = Object.assign(new MockElement(), {
      classList: { contains: () => true },
      closest: (sel: string) => (sel === 'ytlr-tile-renderer' ? tileEl : null),
      querySelector: (sel: string) => {
        if (sel === 'ytlr-thumbnail-details') return thumbDetailsEl;
        if (sel.includes('yt-formatted-string')) return lineTextEl;
        return null;
      },
    });

    globals.window = {
      addEventListener: () => {},
      removeEventListener: () => {},
      ytcfg: {
        data_: {
          INNERTUBE_CONTEXT: { client: { clientName: 'TVHTML5' } },
          INNERTUBE_CONTEXT_CLIENT_NAME: 7,
          INNERTUBE_CONTEXT_CLIENT_VERSION: '7.2026',
        },
      },
    };
    globals.document = {
      addEventListener: (type: string, cb: (ev: { target: unknown }) => void) => {
        if (type === 'focusin') focusInHandler = cb;
      },
      removeEventListener: () => {},
      querySelectorAll: (sel: string) => (sel.includes('/emptyMeta01/') ? [thumbDetailsEl] : []),
    };

    let fetchCount = 0;
    globals.fetch = async () => {
      fetchCount++;
      return {
        ok: true,
        text: async () => JSON.stringify({}),
      };
    };

    const uninstallShortsMeta = installShortsMetadata();
    t.after(() => {
      uninstallShortsMeta();
      clearShortsMetadataCache();
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
      if (prevElement === undefined) delete globals.Element;
      else globals.Element = prevElement;
      globals.fetch = prevFetch;
      if (prevRaf === undefined) delete globals.requestAnimationFrame;
      else globals.requestAnimationFrame = prevRaf;
    });

    await applyShortsFeedMetadata([
      {
        tileRenderer: {
          style: 'TILE_STYLE_YTLR_SHORTS',
          contentId: 'emptyMeta01',
          metadata: {
            tileMetadataRenderer: {
              lines: [{ lineRenderer: { items: [{ lineItemRenderer: { text: { simpleText: '\u00A0' } } }] } }],
            },
          },
        },
      },
    ]);

    focusInHandler?.({ target: tileEl });
    focusInHandler?.({ target: tileEl });
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(fetchCount, 1);
    assert.equal(lineTextEl.textContent, '');
  });

  test('covers helper fallbacks, overlay edges, tile videoId resolution, concurrency/cache/abort paths, and missing DOM guards', async (t) => {
    clearShortsMetadataCache();
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevDocument = globals.document;
    const prevFetch = globals.fetch;
    const prevElement = globals.Element;
    const prevRaf = globals.requestAnimationFrame;

    // 1. installShortsMetadata no-ops when window or document is absent.
    delete globals.window;
    assert.doesNotThrow(() => installShortsMetadata()());
    globals.window = {};
    delete globals.document;
    assert.doesNotThrow(() => installShortsMetadata()());

    // 2. Helper fallbacks.
    assert.equal(formatShortsViewCount(null), null);
    assert.equal(formatShortsUploadedAt(null, null), null);
    assert.equal(formatShortsUploadedAt('   ', null), null);
    assert.equal(extractShortsMetadataFromReel(null), null);
    assert.equal(
      extractShortsMetadataFromReel({
        engagementPanels: [
          { engagementPanelSectionListRenderer: { content: { structuredDescriptionContentRenderer: {} } } },
          {
            engagementPanelSectionListRenderer: {
              content: {
                structuredDescriptionContentRenderer: {
                  items: [null, { videoDescriptionHeaderRenderer: {} }],
                },
              },
            },
          },
        ],
      }),
      null
    );
    assert.equal(
      extractShortsMetadataFromReel({
        engagementPanels: [
          {
            engagementPanelSectionListRenderer: {
              content: {
                structuredDescriptionContentRenderer: {
                  items: [
                    {
                      videoDescriptionHeaderRenderer: {
                        factoid: [
                          { other: {} },
                          { factoidRenderer: { label: { simpleText: 'Likes' }, value: { simpleText: '5' } } },
                          { factoidRenderer: { label: { simpleText: 'Views' }, value: {} } },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        ],
      }),
      null
    );

    // 3. enrichShortsActionBar / enrichShortsPlayerOverlay edge cases:
    // null button item, authDeterminedCommand videoId fallback, missing metaText, missing reelTitleText.
    const authOverlayPayload: Record<string, unknown> = {
      overlay: {
        reelPlayerOverlayRenderer: {
          reelPlayerHeaderSupportedRenderers: {
            reelPlayerHeaderRenderer: {
              timestampText: { simpleText: '' },
            },
          },
          buttonBar: {
            reelActionBarViewModel: {
              buttonViewModels: [
                null,
                {
                  reelActionBarButtonViewModel: {
                    buttonViewModel: {
                      likeButtonViewModel: {
                        toggleButtonViewModel: {
                          toggleButtonViewModel: {
                            defaultButtonViewModel: {
                              buttonViewModel: {
                                title: '99',
                                onTap: {
                                  innertubeCommand: {
                                    authDeterminedCommand: {
                                      authenticatedCommand: {
                                        likeEndpoint: { target: { videoId: 'authShort01' } },
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
                  },
                },
              ],
            },
          },
        },
      },
    };
    assert.equal(enrichShortsPlayerOverlay(authOverlayPayload), true);
    assert.equal(
      enrichShortsPlayerOverlay({
        ...makeReelPayload('noTitle0001', '500 views', '1 day ago'),
        overlay: {
          reelPlayerOverlayRenderer: {
            reelPlayerHeaderSupportedRenderers: {
              reelPlayerHeaderRenderer: {
                timestampText: { simpleText: '1 day ago' },
              },
            },
          },
        },
      }),
      false
    );

    // 4. DOM focusin edge cases, inFlight dedup, network reject, and aborted navigation after yield.
    class MockElement {}
    globals.Element = MockElement;
    delete globals.requestAnimationFrame;

    let focusInHandler: ((ev: { target: unknown }) => void) | undefined;
    const resolvers = new Map<string, { resolve: (v: Response) => void; reject: (e: unknown) => void }>();
    let ytcfgMode: 'valid' | 'missing' = 'valid';
    globals.window = {
      addEventListener: () => {},
      removeEventListener: () => {},
      get ytcfg() {
        return ytcfgMode === 'valid'
          ? {
              data_: {
                INNERTUBE_CONTEXT: { client: { clientName: 'TVHTML5' } },
                INNERTUBE_CONTEXT_CLIENT_NAME: 7,
                INNERTUBE_CONTEXT_CLIENT_VERSION: '7.2026',
              },
            }
          : undefined;
      },
    };
    globals.document = {
      addEventListener: (type: string, cb: (ev: { target: unknown }) => void) => {
        if (type === 'focusin') focusInHandler = cb;
      },
      removeEventListener: () => {},
      querySelectorAll: () => [],
    };
    globals.fetch = ((_url: unknown, init?: { body?: string }) => {
      const parsed = init?.body ? (JSON.parse(init.body) as { playerRequest?: { videoId?: string } }) : {};
      const vid = parsed.playerRequest?.videoId ?? '';
      return new Promise((resolve, reject) => {
        resolvers.set(vid, { resolve, reject });
      });
    }) as typeof fetch;

    const uninstall = installShortsMetadata();
    t.after(() => {
      uninstall();
      clearShortsMetadataCache();
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
      globals.fetch = prevFetch;
      if (prevElement === undefined) delete globals.Element;
      else globals.Element = prevElement;
      if (prevRaf === undefined) delete globals.requestAnimationFrame;
      else globals.requestAnimationFrame = prevRaf;
    });

    // Trigger focusin with non-Element, detached element, invalid videoId, missing lineEl, missing ytcfg, and duplicate inFlight.
    focusInHandler?.({ target: {} });
    const detachedEl = Object.assign(new MockElement(), { closest: () => null });
    focusInHandler?.({ target: detachedEl });

    const badBgTile = Object.assign(new MockElement(), {
      closest: () => badBgTile,
      querySelector: () => ({ style: { backgroundImage: 'none' } }),
    });
    focusInHandler?.({ target: badBgTile });

    const noThumbTile = Object.assign(new MockElement(), {
      closest: () => noThumbTile,
      querySelector: () => null,
    });
    focusInHandler?.({ target: noThumbTile });

    const noLineTile = Object.assign(new MockElement(), {
      closest: () => noLineTile,
      classList: { contains: () => false },
      querySelector: (sel: string) =>
        sel === 'ytlr-thumbnail-details'
          ? { style: { backgroundImage: 'url("https://i.ytimg.com/vi/noLineSh001/hq720.jpg")' } }
          : null,
    });
    focusInHandler?.({ target: noLineTile });

    const emptyPlaceholderTile = Object.assign(new MockElement(), {
      closest: () => emptyPlaceholderTile,
      classList: { contains: () => false },
      querySelector: (sel: string) =>
        sel === 'ytlr-thumbnail-details'
          ? { style: { backgroundImage: 'url("https://i.ytimg.com/vi/inFlySh0001/hq720.jpg")' } }
          : { textContent: '\u00A0' },
    });
    ytcfgMode = 'missing';
    focusInHandler?.({ target: emptyPlaceholderTile }); // missing ytcfg -> returns null cleanly
    ytcfgMode = 'valid';
    focusInHandler?.({ target: emptyPlaceholderTile }); // starts fetch
    focusInHandler?.({ target: emptyPlaceholderTile }); // hits inFlightShortsMeta dedup (line 335)!
    resolvers.get('inFlySh0001')?.reject(new Error('network boom'));
    await new Promise((r) => setTimeout(r, 15));

    // Cached hit directly in focusInHandler (line 333 + updateMountedTileDom path via focusin cache hit) -> already tested via applyShortsFeedMetadata + cache.
    // Feed batch with: non-record, missing tileMetadataRenderer, endpoint/thumb videoId fallback, pre-populated line, and placeholder with missing lineItemRenderer.text!
    await applyShortsFeedMetadata(null as unknown as FeedItem[]);
    const abortBatch = applyShortsFeedMetadata([
      null as unknown as FeedItem,
      { tileRenderer: { style: 'TILE_STYLE_YTLR_SHORTS', contentId: 'noMetaSh001' } },
      {
        tileRenderer: {
          style: 'TILE_STYLE_YTLR_SHORTS',
          onSelectCommand: { reelWatchEndpoint: { videoId: 'epShort0001' } },
          metadata: {
            tileMetadataRenderer: {
              lines: [{ lineRenderer: { items: [{ lineItemRenderer: { text: { simpleText: '5K views' } } }] } }],
            },
          },
        },
      },
      {
        tileRenderer: {
          style: 'TILE_STYLE_YTLR_SHORTS',
          contentId: 'badItemsSh1',
          metadata: { tileMetadataRenderer: { lines: [{ lineRenderer: { items: 'invalid' } }] } },
        },
      },
      {
        tileRenderer: {
          style: 'TILE_STYLE_YTLR_SHORTS',
          contentId: 'emptyItems1',
          metadata: { tileMetadataRenderer: { lines: [{ lineRenderer: { items: [] } }] } },
        },
      },
      {
        tileRenderer: {
          style: 'TILE_STYLE_YTLR_SHORTS',
          header: {
            tileHeaderRenderer: {
              thumbnail: {
                thumbnails: [
                  null as unknown as { url: string; width: number; height: number },
                  { url: 123 as unknown as string, width: 1080, height: 1920 },
                  { url: 'https://i.ytimg.com/vi/thShort0001/oar2.jpg', width: 1080, height: 1920 },
                ],
              },
            },
          },
          metadata: { tileMetadataRenderer: { lines: [{ lineRenderer: { items: [{ lineItemRenderer: {} }] } }] } },
        },
      },
    ]);
    // Clear cache/abort BEFORE post-yield fetch starts so controller.signal.aborted paths fire cleanly.
    clearShortsMetadataCache();
    await abortBatch;

    // Ensure uncached batch with ytcfg missing skips cleanly (line 430), and 3-item concurrency queue aborts mid-flight cleanly.
    ytcfgMode = 'missing';
    await applyShortsFeedMetadata([
      {
        tileRenderer: {
          style: 'TILE_STYLE_YTLR_SHORTS',
          contentId: 'noCfgSh0001',
          metadata: { tileMetadataRenderer: { title: { simpleText: 'No Config' } } },
        },
      },
    ]);

    ytcfgMode = 'valid';
    const abortMidQueue = applyShortsFeedMetadata([
      {
        tileRenderer: {
          style: 'TILE_STYLE_YTLR_SHORTS',
          contentId: 'queueSh0001',
          metadata: {
            tileMetadataRenderer: {
              lines: [{ lineRenderer: { items: [{ lineItemRenderer: { text: { simpleText: '\u00A0' } } }] } }],
            },
          },
        },
      },
      {
        tileRenderer: {
          style: 'TILE_STYLE_YTLR_SHORTS',
          contentId: 'queueSh0002',
          metadata: {
            tileMetadataRenderer: {
              lines: [{ lineRenderer: { items: [{ lineItemRenderer: { text: { simpleText: '\u00A0' } } }] } }],
            },
          },
        },
      },
      {
        tileRenderer: {
          style: 'TILE_STYLE_YTLR_SHORTS',
          contentId: 'queueSh0003',
          metadata: {
            tileMetadataRenderer: {
              lines: [{ lineRenderer: { items: [{ lineItemRenderer: { text: { simpleText: '\u00A0' } } }] } }],
            },
          },
        },
      },
    ]);
    await new Promise((r) => setTimeout(r, 15));
    // Abort navigation while 1 & 2 are awaiting fetch and 3 is queued in shortsMetaLimit, then settle 1 & 2.
    clearShortsMetadataCache();
    resolvers.get('queueSh0001')?.resolve({ ok: false } as Response);
    resolvers.get('queueSh0002')?.resolve({ ok: false } as Response);
    await abortMidQueue;

    // Ensure post-yield rejection path in applyShortsFeedMetadata clears pendingTileTextTargets.
    const rejBatch = applyShortsFeedMetadata([
      {
        tileRenderer: {
          style: 'TILE_STYLE_YTLR_SHORTS',
          contentId: 'rejShort001',
          metadata: {
            tileMetadataRenderer: {
              lines: [{ lineRenderer: { items: [{ lineItemRenderer: { text: { simpleText: '\u00A0' } } }] } }],
            },
          },
        },
      },
    ]);
    await new Promise((r) => setTimeout(r, 15));
    resolvers.get('rejShort001')?.reject(new Error('boom'));
    await rejBatch;
  });
});
