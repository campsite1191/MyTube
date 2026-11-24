import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  applyDeArrowBranding,
  clearDeArrowCache,
  installThumbnailErrorFallback,
} from '../mods/transforms/thumbnails.ts';
import type { FeedItem } from '../mods/types/innertube.ts';

describe('TV thumbnail lifecycle & Shorts entry cancellation', () => {
  test('[H2] stacks CSS fallback layers on mounted TV ytlr-thumbnail-details for hq720.jpg without DOM error events', (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevDocument = globals.document;
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

    const mountedThumb = {
      tagName: 'YTLR-THUMBNAIL-DETAILS',
      style: { backgroundImage: 'url("https://i.ytimg.com/vi/sdUpload001/hq720.jpg")' },
    };
    const deArrowThumb = {
      tagName: 'YTLR-THUMBNAIL-DETAILS',
      style: {
        backgroundImage: 'url("https://dearrow-thumb.ajay.app/api/v1/getThumbnail?videoID=deCard00001&time=5")',
      },
    };
    const invalidBgThumb = {
      tagName: 'YTLR-THUMBNAIL-DETAILS',
      style: { backgroundImage: 'none' },
    };
    const invalidIdThumb = {
      tagName: 'YTLR-THUMBNAIL-DETAILS',
      style: { backgroundImage: 'url("https://i.ytimg.com/vi/bad/hq720.jpg")' },
    };
    const bodyClasses = new Set<string>();
    const bodyEl = {
      classList: {
        add: (cls: string) => bodyClasses.add(cls),
        remove: (cls: string) => bodyClasses.delete(cls),
        contains: (cls: string) => bodyClasses.has(cls),
      },
    };

    globals.window = {
      location: { hash: '#/', search: '' },
      addEventListener: () => {},
    };
    globals.document = {
      body: bodyEl,
      documentElement: bodyEl,
      addEventListener: () => {},
      querySelectorAll: (sel: string) =>
        sel.includes('hq720.jpg') || sel.includes('ytlr-thumbnail-details')
          ? [mountedThumb, deArrowThumb, invalidBgThumb, invalidIdThumb]
          : [],
    };

    t.after(() => {
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
      if (prevMutationObserver === undefined) delete globals.MutationObserver;
      else globals.MutationObserver = prevMutationObserver;
    });

    installThumbnailErrorFallback();
    for (const obs of observers.filter((o) => !o.disconnected)) {
      obs.cb([{ type: 'childList', target: bodyEl, addedNodes: [], removedNodes: [] }]);
      obs.cb([{ type: 'childList', target: bodyEl, addedNodes: [mountedThumb], removedNodes: [] }]);
      obs.cb([{ type: 'attributes', target: mountedThumb }]);
    }

    assert.equal(
      mountedThumb.style.backgroundImage,
      'url("https://i.ytimg.com/vi/sdUpload001/hq720.jpg"), url("https://i.ytimg.com/vi/sdUpload001/hqdefault.jpg")'
    );
    assert.equal(
      deArrowThumb.style.backgroundImage,
      'url("https://dearrow-thumb.ajay.app/api/v1/getThumbnail?videoID=deCard00001&time=5"), url("https://i.ytimg.com/vi/deCard00001/hq720.jpg"), url("https://i.ytimg.com/vi/deCard00001/hqdefault.jpg")'
    );
  });

  test('[M1] aborts in-flight Home shelf DeArrow fetches when entering WEB_PAGE_TYPE_SHORTS without hashchange', async (t) => {
    clearDeArrowCache();
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevDocument = globals.document;
    const prevFetch = globals.fetch;
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

    const bodyClasses = new Set<string>();
    const bodyEl = {
      classList: {
        add: (cls: string) => bodyClasses.add(cls),
        remove: (cls: string) => bodyClasses.delete(cls),
        contains: (cls: string) => bodyClasses.has(cls),
      },
    };
    globals.window = {
      location: { hash: '#/', search: '' },
      addEventListener: () => {},
    };
    globals.document = {
      body: bodyEl,
      documentElement: bodyEl,
      addEventListener: () => {},
      querySelectorAll: () => [],
    };

    let fetchSignal: AbortSignal | undefined;
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    globals.fetch = ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        fetchSignal = init?.signal ?? undefined;
        notifyStarted();
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      })) as typeof fetch;

    t.after(() => {
      clearDeArrowCache();
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
      globals.fetch = prevFetch;
      if (prevMutationObserver === undefined) delete globals.MutationObserver;
      else globals.MutationObserver = prevMutationObserver;
    });

    installThumbnailErrorFallback();

    const item: FeedItem = {
      tileRenderer: {
        contentId: 'homeCardDe1',
        style: 'TILE_STYLE_YTLR_DEFAULT',
        onSelectCommand: { watchEndpoint: { videoId: 'homeCardDe1' } },
      },
    };
    const pending = applyDeArrowBranding([item]);
    await started;

    // Entering Shorts via reelWatchEndpoint toggles body.WEB_PAGE_TYPE_SHORTS without changing location.hash.
    bodyClasses.add('WEB_PAGE_TYPE_SHORTS');
    for (const obs of observers.filter(
      (o) => !o.disconnected && (o.target === bodyEl || o.target === globals.document)
    )) {
      obs.cb([{ type: 'attributes', attributeName: 'class', target: bodyEl }]);
    }

    assert.equal(fetchSignal?.aborted, true);
    await pending;
  });
});
