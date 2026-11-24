import {
  filterFeedItemsSync,
  filterShelvesInPlaceSync,
  isHiddenShelf,
  isStandaloneHeaderNode,
} from '../transforms/feed-filter.ts';
import { transformGuideResponse } from '../transforms/guide.ts';
import type { AudioFormatEntry, SubscriptionTab } from '../transforms/innertube-player.ts';
import {
  dedupeAndSortSubscriptionTabs,
  disableAutoCaptionsInPayload,
  filterStreamingFormats,
  stripAdsFromPayload,
} from '../transforms/innertube-player.ts';
import { addLongPress } from '../transforms/long-press.ts';
import {
  injectChapters,
  recordTransportLikeCount,
  transformPlayerOverlays,
  transformTransportControls,
} from '../transforms/player-overlays.ts';
import { addPreviews } from '../transforms/previews.ts';
import { applyShortsFeedMetadata, enrichShortsPlayerOverlay } from '../transforms/shorts-metadata.ts';
import {
  applyDeArrowBranding,
  installThumbnailErrorFallback,
  upgradeFeedThumbnails,
} from '../transforms/thumbnails.ts';
import type { FeedItem } from '../types/innertube.ts';
import { isObjectLike, isRecord } from '../utils/type-guards.ts';
import { isPlaybackPageActive } from './lifecycle.ts';
import { whenYttvReady } from './yttv-bridge.ts';

const ITEM_LIST_KEYS = [
  'horizontalListRenderer',
  'gridRenderer',
  'expandedShelfContentsRenderer',
  'verticalListRenderer',
] as const;

const EXTERNAL_JSON_HOSTS = ['sponsor.ajay.app', 'returnyoutubedislikeapi.com'] as const;

const processedPayloads = new WeakSet<object>();
const wrappedJsonParsers = new WeakSet<typeof JSON.parse>();
let rawJsonParse: typeof JSON.parse | null = typeof JSON !== 'undefined' ? JSON.parse : null;
let interceptorInstalled = false;

function processShelfContentSync(content: unknown, shouldAddPreviews = true): void {
  if (!isRecord(content)) return;
  if (Array.isArray(content.items)) {
    content.items = processItemsListSync(content.items as FeedItem[], shouldAddPreviews);
  }
  for (const key of ITEM_LIST_KEYS) {
    const listContainer = isRecord(content[key]) ? content[key] : undefined;
    if (listContainer && Array.isArray(listContainer.items)) {
      listContainer.items = processItemsListSync(listContainer.items as FeedItem[], shouldAddPreviews);
    }
  }
}

function enrichFeedItemsSync(items: FeedItem[], shouldAddPreviews = true): FeedItem[] {
  // Fire async metadata enrichments without blocking synchronous feed rendering.
  void applyDeArrowBranding(items);
  void applyShortsFeedMetadata(items);
  upgradeFeedThumbnails(items);
  addLongPress(items);
  addPreviews(items, shouldAddPreviews);
  return items;
}

function processItemsListSync(items: FeedItem[], shouldAddPreviews = true): FeedItem[] {
  if (!Array.isArray(items)) return items;
  return enrichFeedItemsSync(filterFeedItemsSync(items), shouldAddPreviews);
}

/**
 * Unifies processing of feed content, ensuring each node is processed exactly once
 * to avoid duplicacy and conflicting in-place mutations.
 */
function processContentNodeSync(node: unknown, shouldAddPreviews = true): void {
  if (!isRecord(node)) return;

  if (isRecord(node.shelfRenderer)) {
    processShelfContentSync(node.shelfRenderer.content, shouldAddPreviews);
  } else {
    const isr = isRecord(node.itemSectionRenderer) ? node.itemSectionRenderer : undefined;
    if (isr && Array.isArray(isr.contents)) {
      processShelvesSync(isr.contents as FeedItem[], shouldAddPreviews);
    } else if (node.richSectionRenderer) {
      const richSectionRecord = isRecord(node.richSectionRenderer) ? node.richSectionRenderer : undefined;
      const richContent = isRecord(richSectionRecord?.content) ? richSectionRecord.content : undefined;
      if (
        richContent?.richShelfRenderer &&
        Array.isArray((richContent.richShelfRenderer as Record<string, unknown>).contents)
      ) {
        processShelvesSync(
          (richContent.richShelfRenderer as Record<string, unknown>).contents as FeedItem[],
          shouldAddPreviews
        );
      } else if (richContent) {
        processShelfContentSync(richContent, shouldAddPreviews);
      }
    }
  }

  for (const key of ITEM_LIST_KEYS) {
    const listContainer = isRecord(node[key]) ? node[key] : undefined;
    if (listContainer && Array.isArray(listContainer.items)) {
      listContainer.items = processItemsListSync(listContainer.items as FeedItem[], shouldAddPreviews);
    }
  }
}

function isStandaloneHiddenHeader(entry: FeedItem): boolean {
  return isStandaloneHeaderNode(entry) && isHiddenShelf(entry);
}

function isUntitledShelfRenderer(entry: FeedItem): boolean {
  const sr = isRecord(entry.shelfRenderer) ? entry.shelfRenderer : undefined;
  if (!sr) return false;
  return !sr.title && !sr.headerRenderer && !sr.header;
}

function processShelvesSync(shelves: FeedItem[], shouldAddPreviews = true): void {
  if (!Array.isArray(shelves)) return;

  // Drop paired untitled shelves immediately following a hidden standalone header item.
  let skipNextShelf = false;
  for (let i = 0; i < shelves.length; i++) {
    const entry = shelves[i];
    if (!isRecord(entry)) continue;
    if (skipNextShelf && isUntitledShelfRenderer(entry)) {
      skipNextShelf = false;
      shelves[i] = { adSlotRenderer: {} };
      continue;
    }
    skipNextShelf = isStandaloneHiddenHeader(entry);
  }

  filterShelvesInPlaceSync(shelves);

  const directItems: FeedItem[] = [];
  const emptySections = new Set<FeedItem>();

  for (const entry of shelves) {
    if (!isRecord(entry)) continue;

    if (entry.shelfRenderer || entry.itemSectionRenderer || entry.richSectionRenderer) {
      const isr = isRecord(entry.itemSectionRenderer) ? entry.itemSectionRenderer : undefined;
      const isrContents = Array.isArray(isr?.contents) ? isr.contents : undefined;
      const prevLen = isrContents ? isrContents.length : 0;
      processContentNodeSync(entry, shouldAddPreviews);
      if (isrContents && prevLen > 0 && isrContents.length === 0) {
        emptySections.add(entry);
      }
    } else if (entry.sectionListRenderer || entry.richGridRenderer) {
      processBrowseContentSync(entry, shouldAddPreviews);
    } else if (ITEM_LIST_KEYS.some((k) => entry[k])) {
      processContentNodeSync(entry, shouldAddPreviews);
    } else if (
      entry.tileRenderer ||
      entry.lockupViewModel ||
      entry.shortsLockupViewModel ||
      entry.richItemRenderer?.content
    ) {
      directItems.push((entry.richItemRenderer?.content ?? entry) as FeedItem);
    }
  }

  if (emptySections.size > 0) {
    for (let i = shelves.length - 1; i >= 0; i--) {
      const entry = shelves[i];
      if (entry && emptySections.has(entry)) {
        shelves.splice(i, 1);
      }
    }
  }

  if (directItems.length > 0) {
    enrichFeedItemsSync(directItems, shouldAddPreviews);
  }
}

function processContinuationItemsListSync(items: FeedItem[], shouldAddPreviews = true): void {
  processShelvesSync(items, shouldAddPreviews);
  for (const entry of items) {
    if (!isRecord(entry)) continue;
    for (const key of ['sectionListContinuation', 'itemSectionContinuation', 'richGridContinuation'] as const) {
      const cont = isRecord(entry[key]) ? entry[key] : undefined;
      if (Array.isArray(cont?.contents)) {
        processShelvesSync(cont.contents as FeedItem[], shouldAddPreviews);
      }
    }
    const surfaceCont = isRecord(entry.tvSurfaceContentContinuation) ? entry.tvSurfaceContentContinuation : undefined;
    if (surfaceCont?.content) {
      processBrowseContentSync(surfaceCont.content, shouldAddPreviews);
    }
  }
}

function processBrowseActionsSync(actions: unknown, shouldAddPreviews = true): void {
  if (!Array.isArray(actions)) return;
  for (const action of actions) {
    if (!isRecord(action)) continue;
    const reload = isRecord(action.reloadContinuationItemsCommand) ? action.reloadContinuationItemsCommand : undefined;
    if (Array.isArray(reload?.continuationItems)) {
      processContinuationItemsListSync(reload.continuationItems as FeedItem[], shouldAddPreviews);
    }
    const append = isRecord(action.appendContinuationItemsAction) ? action.appendContinuationItemsAction : undefined;
    if (Array.isArray(append?.continuationItems)) {
      processContinuationItemsListSync(append.continuationItems as FeedItem[], shouldAddPreviews);
    }
    const listMutation = isRecord(action.listMutationCommand) ? action.listMutationCommand : undefined;
    const operationsWrapper = isRecord(listMutation?.operations) ? listMutation.operations : undefined;
    if (Array.isArray(operationsWrapper?.operations)) {
      for (const op of operationsWrapper.operations) {
        const insertSection =
          isRecord(op) && isRecord(op.insertItemSectionContent) ? op.insertItemSectionContent : undefined;
        if (Array.isArray(insertSection?.contents)) {
          processShelvesSync(insertSection.contents as FeedItem[], shouldAddPreviews);
        }
      }
    }
    const replaceContainer = isRecord(action.replaceEnclosingAction) ? action.replaceEnclosingAction : undefined;
    const replace = isRecord(replaceContainer?.item) ? replaceContainer.item : undefined;
    if (replace && replaceContainer) {
      if (
        replace.tileRenderer ||
        replace.lockupViewModel ||
        replace.shortsLockupViewModel ||
        (isRecord(replace.richItemRenderer) && replace.richItemRenderer.content)
      ) {
        const kept = processItemsListSync([replace as FeedItem], shouldAddPreviews);
        if (kept.length === 0) {
          delete replaceContainer.item;
        }
      } else {
        const arr = [replace as FeedItem];
        processShelvesSync(arr, shouldAddPreviews);
        if (arr.length === 0) {
          delete replaceContainer.item;
        }
      }
    }
  }
}

function isSubscriptionNavSection(tabs: readonly SubscriptionTab[]): boolean {
  return tabs.some((tab) => {
    const browseId = tab.tabRenderer?.endpoint?.browseEndpoint?.browseId;
    return typeof browseId === 'string' && (browseId.startsWith('UC') || browseId === 'FEsubscriptions');
  });
}

function processSecondaryNavSync(secondaryNav: Record<string, unknown> | undefined, shouldAddPreviews = true): void {
  if (!Array.isArray(secondaryNav?.sections)) return;
  const seenTabs = new Set<string>();
  for (const rawSection of secondaryNav.sections) {
    if (!isRecord(rawSection)) continue;
    const section = isRecord(rawSection.tvSecondaryNavSectionRenderer)
      ? rawSection.tvSecondaryNavSectionRenderer
      : undefined;
    if (!section || !Array.isArray(section.tabs)) continue;

    if (isSubscriptionNavSection(section.tabs as SubscriptionTab[])) {
      section.tabs = dedupeAndSortSubscriptionTabs(section.tabs as SubscriptionTab[], seenTabs);
    }
    for (const tab of section.tabs as SubscriptionTab[]) {
      const content = tab.tabRenderer?.content?.tvSurfaceContentRenderer?.content;
      if (content) processBrowseContentSync(content, shouldAddPreviews);
    }
  }
}

function processBrowseContentSync(node: unknown, shouldAddPreviews = true): void {
  if (!isRecord(node)) return;
  processContentNodeSync(node, shouldAddPreviews);

  for (const key of [
    'sectionListRenderer',
    'richGridRenderer',
    'sectionListContinuation',
    'itemSectionContinuation',
    'richGridContinuation',
  ] as const) {
    const container = isRecord(node[key]) ? node[key] : undefined;
    if (container && Array.isArray(container.contents)) {
      processShelvesSync(container.contents as FeedItem[], shouldAddPreviews);
    }
  }

  for (const surfaceKey of ['tvSurfaceContentRenderer', 'tvSurfaceRenderer'] as const) {
    const surface = isRecord(node[surfaceKey]) ? node[surfaceKey] : undefined;
    if (surface?.content) {
      processBrowseContentSync(surface.content, shouldAddPreviews);
    }
  }
}

function hasRelevantInnertubeKey(r: Record<string, unknown>): boolean {
  return Boolean(
    r.items ||
      r.adPlacements ||
      r.playerAds ||
      r.adSlots ||
      r.entries ||
      r.streamingData ||
      r.captions ||
      r.contents ||
      r.tvBrowseContent ||
      r.continuationContents ||
      r.onResponseReceivedActions ||
      r.onResponseReceivedCommands ||
      r.onResponseReceivedEndpoints ||
      r.onResponseReceivedCommand ||
      r.listMutationCommand ||
      r.endscreen ||
      r.messages ||
      r.playerOverlays ||
      r.overlay ||
      r.transportControls ||
      r.videoDetails ||
      r.playerResponse
  );
}

function stripPlayerNoise(target: Record<string, unknown>): void {
  if (target.adPlacements || target.playerAds || target.adSlots || target.entries) {
    stripAdsFromPayload(target);
  }
  if (target.endscreen) {
    target.endscreen = null;
  }
  if (Array.isArray(target.messages)) {
    target.messages = target.messages.filter((msg) => !isRecord(msg) || !msg.youThereRenderer);
  }
}

/**
 * Synchronously mutates parsed InnerTube payloads across `fetch` (`Response.json`),
 * `JSON.parse`, and `_yttv` internal JSON parsers without double-processing objects.
 */
export function transformInnertubeResponseSync(r: unknown): unknown {
  if (!isRecord(r) || processedPayloads.has(r) || !hasRelevantInnertubeKey(r)) return r;
  processedPayloads.add(r);

  try {
    if (Array.isArray(r.items)) {
      transformGuideResponse(r);
    }

    const playerResponse = isRecord(r.playerResponse) ? r.playerResponse : undefined;
    stripPlayerNoise(r);
    if (playerResponse) {
      stripPlayerNoise(playerResponse);
    }

    const streamingData = isRecord(r.streamingData)
      ? r.streamingData
      : isRecord(playerResponse?.streamingData)
        ? playerResponse.streamingData
        : undefined;
    if (Array.isArray(streamingData?.adaptiveFormats)) {
      streamingData.adaptiveFormats = filterStreamingFormats(streamingData.adaptiveFormats as AudioFormatEntry[]);
    }

    disableAutoCaptionsInPayload(r);

    if (r.overlay) {
      enrichShortsPlayerOverlay(r);
    }

    const contents = isRecord(r.contents) ? r.contents : undefined;
    const isWatchNextPayload = Boolean(
      contents?.singleColumnWatchNextResults || r.playerOverlays || r.transportControls || r.overlay
    );
    const allowPreviews = !isWatchNextPayload && !isPlaybackPageActive();

    if (contents) {
      processBrowseContentSync(contents, allowPreviews);

      const tvBrowse = isRecord(contents.tvBrowseRenderer) ? contents.tvBrowseRenderer : undefined;
      const tvBrowseInner = isRecord(tvBrowse?.content) ? tvBrowse.content : undefined;
      if (tvBrowseInner) {
        processBrowseContentSync(tvBrowseInner, allowPreviews);
      }
      processSecondaryNavSync(
        isRecord(tvBrowseInner?.tvSecondaryNavRenderer) ? tvBrowseInner.tvSecondaryNavRenderer : undefined,
        allowPreviews
      );

      const singleColTabs = isRecord(contents.singleColumnBrowseResultsRenderer)
        ? contents.singleColumnBrowseResultsRenderer.tabs
        : undefined;
      if (Array.isArray(singleColTabs)) {
        for (const tab of singleColTabs) {
          const tabRenderer = isRecord(tab) && isRecord(tab.tabRenderer) ? tab.tabRenderer : undefined;
          if (tabRenderer?.content) {
            processBrowseContentSync(tabRenderer.content, allowPreviews);
          }
        }
      }
    }

    const tvBrowseContent = isRecord(r.tvBrowseContent) ? r.tvBrowseContent : undefined;
    if (tvBrowseContent) {
      processBrowseContentSync(tvBrowseContent, allowPreviews);
      processSecondaryNavSync(
        isRecord(tvBrowseContent.tvSecondaryNavRenderer) ? tvBrowseContent.tvSecondaryNavRenderer : undefined,
        allowPreviews
      );
    }

    const cont = isRecord(r.continuationContents) ? r.continuationContents : undefined;
    if (cont) {
      for (const key of ['sectionListContinuation', 'itemSectionContinuation', 'richGridContinuation'] as const) {
        const listCont = isRecord(cont[key]) ? cont[key] : undefined;
        if (Array.isArray(listCont?.contents)) {
          processShelvesSync(listCont.contents as FeedItem[], allowPreviews);
        }
      }
      const horizCont = isRecord(cont.horizontalListContinuation) ? cont.horizontalListContinuation : undefined;
      if (Array.isArray(horizCont?.items)) {
        horizCont.items = processItemsListSync(horizCont.items as FeedItem[], allowPreviews);
      }
      const gridCont = isRecord(cont.gridContinuation) ? cont.gridContinuation : undefined;
      if (Array.isArray(gridCont?.items)) {
        gridCont.items = processItemsListSync(gridCont.items as FeedItem[], allowPreviews);
      }
      const surfaceCont = isRecord(cont.tvSurfaceContentContinuation) ? cont.tvSurfaceContentContinuation : undefined;
      if (surfaceCont?.content) {
        processBrowseContentSync(surfaceCont.content, allowPreviews);
      }
    }

    for (const actionsKey of [
      'onResponseReceivedActions',
      'onResponseReceivedCommands',
      'onResponseReceivedEndpoints',
    ] as const) {
      if (Array.isArray(r[actionsKey])) {
        processBrowseActionsSync(r[actionsKey], allowPreviews);
      }
    }
    if (isRecord(r.onResponseReceivedCommand)) {
      processBrowseActionsSync([r.onResponseReceivedCommand], allowPreviews);
    }
    if (isRecord(r.listMutationCommand)) {
      processBrowseActionsSync([{ listMutationCommand: r.listMutationCommand }], allowPreviews);
    }

    const watchNext = isRecord(contents?.singleColumnWatchNextResults)
      ? contents.singleColumnWatchNextResults
      : undefined;
    const pivot = isRecord(watchNext?.pivot) ? watchNext.pivot : undefined;
    const pivotSectionList = isRecord(pivot?.sectionListRenderer) ? pivot.sectionListRenderer : undefined;
    if (pivotSectionList && Array.isArray(pivotSectionList.contents)) {
      const pivotContents = pivotSectionList.contents.filter((elm) => !isRecord(elm) || !elm.alertWithActionsRenderer);
      pivotSectionList.contents = pivotContents;
      processShelvesSync(pivotContents as FeedItem[], false);
    }

    injectChapters(r);
    transformPlayerOverlays(r);
    recordTransportLikeCount(r);
    transformTransportControls(r);
  } catch (error) {
    console.error('[InnertubeInterceptor] Failed to process JSON payload:', error);
  }

  return r;
}

export function patchPlaybackContextBody(rawBody: string): string | null {
  if (!rawBody.includes('playbackContext')) return null;
  try {
    const parseFn = rawJsonParse ?? JSON.parse;
    const body = parseFn(rawBody);
    if (!isRecord(body) || !body.playbackContext) return null;
    const playbackCtx = isRecord(body.playbackContext) ? body.playbackContext : undefined;
    const contentCtx = isRecord(playbackCtx?.contentPlaybackContext) ? playbackCtx.contentPlaybackContext : undefined;
    if (!contentCtx || contentCtx.isInlinePlaybackNoAd) return null;
    return JSON.stringify({
      ...body,
      playbackContext: {
        ...playbackCtx,
        contentPlaybackContext: {
          ...contentCtx,
          isInlinePlaybackNoAd: true,
        },
      },
    });
  } catch (e) {
    console.error('[InnertubeInterceptor] Failed to patch request body:', e);
    return null;
  }
}

function wrapJsonParseFn(origParse: typeof JSON.parse): typeof JSON.parse {
  if (wrappedJsonParsers.has(origParse)) return origParse;
  const wrappedParse = function (
    this: unknown,
    text: string,
    reviver?: (this: unknown, key: string, value: unknown) => unknown
  ): unknown {
    const parsed = origParse.call(this, text, reviver);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return transformInnertubeResponseSync(parsed);
    }
    return parsed;
  } as typeof JSON.parse;
  wrappedJsonParsers.add(origParse);
  wrappedJsonParsers.add(wrappedParse);
  return wrappedParse;
}

export function syncYttvPreviewAndJson(): void {
  if (typeof window === 'undefined' || !window._yttv) return;
  for (const entry of Object.values(window._yttv)) {
    if (entry instanceof Map && entry.has('ENABLE_PREVIEWS_WITH_SOUND')) {
      entry.set('ENABLE_PREVIEWS_WITH_SOUND', true);
    }
    if (isObjectLike(entry) && isObjectLike(entry.JSON) && typeof entry.JSON.parse === 'function') {
      entry.JSON.parse = wrapJsonParseFn(entry.JSON.parse as typeof JSON.parse);
    }
  }
}

export function installInnertubeInterceptor(): () => void {
  if (interceptorInstalled) return () => {};
  interceptorInstalled = true;
  const restorers: Array<() => void> = [];

  // 1. Wrap JSON.parse so XHR, Response.text(), and inline XSSI-stripped payloads transform synchronously.
  if (typeof JSON !== 'undefined' && typeof JSON.parse === 'function') {
    if (!rawJsonParse) rawJsonParse = JSON.parse;
    const prevJsonParse = JSON.parse;
    JSON.parse = wrapJsonParseFn(prevJsonParse);
    restorers.push(() => {
      JSON.parse = prevJsonParse;
    });
  }

  // 2. Intercept Response.json() (native V8 JSON path that bypasses JSON.parse).
  if (typeof Response !== 'undefined' && typeof Response.prototype?.json === 'function') {
    const origResponseJson = Response.prototype.json;
    Response.prototype.json = async function (this: Response) {
      const data: unknown = await origResponseJson.call(this);
      const url = typeof this.url === 'string' ? this.url : '';
      if (url && EXTERNAL_JSON_HOSTS.some((host) => url.includes(host))) {
        return data;
      }
      return transformInnertubeResponseSync(data);
    } as typeof Response.prototype.json;
    restorers.push(() => {
      Response.prototype.json = origResponseJson;
    });
  }

  // 3. Intercept fetch() & XMLHttpRequest.send() for outgoing playbackContext modifications.
  if (typeof window !== 'undefined' && typeof window.fetch === 'function') {
    const targetWindow = window;
    const origFetch = targetWindow.fetch;
    targetWindow.fetch = (resource, init) => {
      if (init && typeof init.body === 'string') {
        const patchedBody = patchPlaybackContextBody(init.body);
        if (patchedBody !== null) {
          return origFetch.call(targetWindow, resource, { ...init, body: patchedBody });
        }
      }
      return origFetch.call(targetWindow, resource, init);
    };
    restorers.push(() => {
      targetWindow.fetch = origFetch;
    });
  }

  if (typeof XMLHttpRequest !== 'undefined' && typeof XMLHttpRequest.prototype?.send === 'function') {
    const xhrProto = XMLHttpRequest.prototype;
    const origXhrSend = xhrProto.send;
    xhrProto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null): void {
      if (typeof body === 'string') {
        const patchedBody = patchPlaybackContextBody(body);
        if (patchedBody !== null) {
          origXhrSend.call(this, patchedBody);
          return;
        }
      }
      origXhrSend.call(this, body);
    };
    restorers.push(() => {
      xhrProto.send = origXhrSend;
    });
  }

  // 4. Sync feature flags & _yttv-scoped JSON.parse once YouTube TV runtime initializes.
  whenYttvReady(syncYttvPreviewAndJson);

  installThumbnailErrorFallback();

  return () => {
    for (const restore of restorers) restore();
    interceptorInstalled = false;
  };
}

if (typeof window !== 'undefined') {
  installInnertubeInterceptor();
}
