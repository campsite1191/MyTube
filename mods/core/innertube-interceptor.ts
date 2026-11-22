import { filterFeedItemsSync, filterShelvesInPlaceSync, isHiddenShelf } from '../transforms/feed-filter.ts';
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

function processItemsListSync(items: FeedItem[], shouldAddPreviews = true): FeedItem[] {
  if (!Array.isArray(items)) return items;
  const filtered = filterFeedItemsSync(items);
  // Fire async metadata enrichments without blocking synchronous feed rendering.
  void applyDeArrowBranding(filtered);
  void applyShortsFeedMetadata(filtered);
  upgradeFeedThumbnails(filtered);
  addLongPress(filtered);
  addPreviews(filtered, shouldAddPreviews);
  return filtered;
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
  return Boolean((entry.shelfHeaderRenderer || entry.sectionHeaderViewModel) && isHiddenShelf(entry));
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
    } else if (entry.sectionListRenderer || entry.richGridRenderer || ITEM_LIST_KEYS.some((k) => entry[k])) {
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
    processItemsListSync(directItems, shouldAddPreviews);
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
    if (replace) {
      if (
        replace.tileRenderer ||
        replace.lockupViewModel ||
        replace.shortsLockupViewModel ||
        (isRecord(replace.richItemRenderer) && replace.richItemRenderer.content)
      ) {
        processItemsListSync([replace as FeedItem], shouldAddPreviews);
      } else {
        processShelvesSync([replace as FeedItem], shouldAddPreviews);
      }
    }
  }
}

function processSecondaryNavSync(secondaryNav: Record<string, unknown> | undefined): void {
  if (!Array.isArray(secondaryNav?.sections)) return;
  const seenTabs = new Set<string>();
  for (const rawSection of secondaryNav.sections) {
    if (!isRecord(rawSection)) continue;
    const section = isRecord(rawSection.tvSecondaryNavSectionRenderer)
      ? rawSection.tvSecondaryNavSectionRenderer
      : undefined;
    if (!section || !Array.isArray(section.tabs)) continue;

    section.tabs = dedupeAndSortSubscriptionTabs(section.tabs as SubscriptionTab[], seenTabs);
    for (const tab of section.tabs as SubscriptionTab[]) {
      const content = tab.tabRenderer?.content?.tvSurfaceContentRenderer?.content;
      if (content) processBrowseContentSync(content, true);
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

    if (r.adPlacements || r.playerAds || r.adSlots || r.entries) {
      stripAdsFromPayload(r);
    }

    const playerResponse = isRecord(r.playerResponse) ? r.playerResponse : undefined;
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

    if (r.endscreen) {
      r.endscreen = null;
    }

    if (Array.isArray(r.messages)) {
      r.messages = r.messages.filter((msg) => !isRecord(msg) || !msg.youThereRenderer);
    }

    const contents = isRecord(r.contents) ? r.contents : undefined;
    if (contents) {
      processBrowseContentSync(contents, true);

      const tvBrowse = isRecord(contents.tvBrowseRenderer) ? contents.tvBrowseRenderer : undefined;
      const tvBrowseInner = isRecord(tvBrowse?.content) ? tvBrowse.content : undefined;
      if (tvBrowseInner) {
        processBrowseContentSync(tvBrowseInner, true);
      }
      processSecondaryNavSync(
        isRecord(tvBrowseInner?.tvSecondaryNavRenderer) ? tvBrowseInner.tvSecondaryNavRenderer : undefined
      );

      const singleColTabs = isRecord(contents.singleColumnBrowseResultsRenderer)
        ? contents.singleColumnBrowseResultsRenderer.tabs
        : undefined;
      if (Array.isArray(singleColTabs)) {
        for (const tab of singleColTabs) {
          const tabRenderer = isRecord(tab) && isRecord(tab.tabRenderer) ? tab.tabRenderer : undefined;
          if (tabRenderer?.content) {
            processBrowseContentSync(tabRenderer.content, true);
          }
        }
      }
    }

    const tvBrowseContent = isRecord(r.tvBrowseContent) ? r.tvBrowseContent : undefined;
    if (tvBrowseContent) {
      processBrowseContentSync(tvBrowseContent, true);
      processSecondaryNavSync(
        isRecord(tvBrowseContent.tvSecondaryNavRenderer) ? tvBrowseContent.tvSecondaryNavRenderer : undefined
      );
    }

    const cont = isRecord(r.continuationContents) ? r.continuationContents : undefined;
    if (cont) {
      for (const key of ['sectionListContinuation', 'itemSectionContinuation', 'richGridContinuation'] as const) {
        const listCont = isRecord(cont[key]) ? cont[key] : undefined;
        if (Array.isArray(listCont?.contents)) {
          processShelvesSync(listCont.contents as FeedItem[], true);
        }
      }
      const horizCont = isRecord(cont.horizontalListContinuation) ? cont.horizontalListContinuation : undefined;
      if (Array.isArray(horizCont?.items)) {
        horizCont.items = processItemsListSync(horizCont.items as FeedItem[], true);
      }
      const gridCont = isRecord(cont.gridContinuation) ? cont.gridContinuation : undefined;
      if (Array.isArray(gridCont?.items)) {
        gridCont.items = processItemsListSync(gridCont.items as FeedItem[], true);
      }
      const surfaceCont = isRecord(cont.tvSurfaceContentContinuation) ? cont.tvSurfaceContentContinuation : undefined;
      if (surfaceCont?.content) {
        processBrowseContentSync(surfaceCont.content, true);
      }
    }

    for (const actionsKey of [
      'onResponseReceivedActions',
      'onResponseReceivedCommands',
      'onResponseReceivedEndpoints',
    ] as const) {
      if (Array.isArray(r[actionsKey])) {
        processBrowseActionsSync(r[actionsKey], true);
      }
    }
    if (isRecord(r.onResponseReceivedCommand)) {
      processBrowseActionsSync([r.onResponseReceivedCommand], true);
    }
    if (isRecord(r.listMutationCommand)) {
      processBrowseActionsSync([{ listMutationCommand: r.listMutationCommand }], true);
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

function patchPlaybackContextBody(rawBody: string): string | null {
  if (!rawBody.includes('playbackContext')) return null;
  try {
    const body = JSON.parse(rawBody);
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

function syncYttvPreviewAndJson(): void {
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

export function installInnertubeInterceptor(): void {
  if (interceptorInstalled) return;
  interceptorInstalled = true;

  // 1. Wrap JSON.parse so XHR, Response.text(), and inline XSSI-stripped payloads transform synchronously.
  if (typeof JSON !== 'undefined' && typeof JSON.parse === 'function') {
    JSON.parse = wrapJsonParseFn(JSON.parse);
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
  }

  // 3. Intercept fetch() & XMLHttpRequest.send() for outgoing playbackContext modifications.
  if (typeof window !== 'undefined' && typeof window.fetch === 'function') {
    const origFetch = window.fetch;
    window.fetch = (resource, init) => {
      if (init && typeof init.body === 'string') {
        const patchedBody = patchPlaybackContextBody(init.body);
        if (patchedBody !== null) init.body = patchedBody;
      }
      return origFetch(resource, init);
    };
  }

  if (typeof XMLHttpRequest !== 'undefined' && typeof XMLHttpRequest.prototype?.send === 'function') {
    const origXhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (
      this: XMLHttpRequest,
      body?: Document | XMLHttpRequestBodyInit | null
    ): void {
      if (typeof body === 'string') {
        const patchedBody = patchPlaybackContextBody(body);
        if (patchedBody !== null) {
          origXhrSend.call(this, patchedBody);
          return;
        }
      }
      origXhrSend.call(this, body);
    };
  }

  // 4. Sync feature flags & _yttv-scoped JSON.parse once YouTube TV runtime initializes.
  whenYttvReady(syncYttvPreviewAndJson);

  installThumbnailErrorFallback();
}

if (typeof window !== 'undefined') {
  installInnertubeInterceptor();
}
