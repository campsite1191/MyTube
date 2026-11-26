import { isPlaybackPageActive } from '../core/lifecycle.ts';
import { applyDeArrowBranding } from '../features/dearrow.ts';
import { applyShortsFeedMetadata } from '../features/shorts-metadata.ts';
import type { FeedItem } from '../types/innertube.ts';
import { isRecord, readRecordPath } from '../utils/type-guards.ts';
import { filterFeedItemsSync, filterShelvesInPlaceSync, isHiddenShelf, isStandaloneHeaderNode } from './feed-filter.ts';
import { transformGuideResponse } from './guide.ts';
import type { AudioFormatEntry, SubscriptionTab } from './innertube-player.ts';
import {
  dedupeAndSortSubscriptionTabs,
  disableAutoCaptionsInPayload,
  filterStreamingFormats,
  stripAdsFromPayload,
} from './innertube-player.ts';
import { addLongPress } from './long-press.ts';
import {
  injectChapters,
  recordTransportLikeCount,
  transformPlayerOverlays,
  transformTransportControls,
} from './player-overlays.ts';
import { addPreviews } from './previews.ts';
import { enrichShortsPlayerOverlay } from './shorts-overlay.ts';
import { upgradeFeedThumbnails } from './thumbnails.ts';

const ITEM_LIST_KEYS = ['horizontalListRenderer', 'gridRenderer', 'shelfListRenderer', 'verticalListRenderer'] as const;

const processedPayloads = new WeakSet<object>();

function processShelfContentSync(content: unknown, shouldAddPreviews = true): void {
  if (!isRecord(content)) return;
  if (Array.isArray(content.items)) {
    content.items = processItemsListSync(content.items as FeedItem[], shouldAddPreviews);
  }
  for (const key of ITEM_LIST_KEYS) {
    const listContainer = readRecordPath(content, key);
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
  return enrichFeedItemsSync(filterFeedItemsSync(items), shouldAddPreviews);
}

/**
 * Unifies processing of feed content, ensuring each node is processed exactly once
 * to avoid duplicacy and conflicting in-place mutations.
 */
function processContentNodeSync(node: Record<string, unknown>, shouldAddPreviews = true): void {
  if (isRecord(node.shelfRenderer)) {
    processShelfContentSync(node.shelfRenderer.content, shouldAddPreviews);
  } else {
    const isr = readRecordPath(node, 'itemSectionRenderer');
    if (isr && Array.isArray(isr.contents)) {
      processShelvesSync(isr.contents as FeedItem[], shouldAddPreviews);
    } else if (node.richSectionRenderer) {
      const richContent = readRecordPath(node, 'richSectionRenderer', 'content');
      const richShelf = readRecordPath(richContent, 'richShelfRenderer');
      if (richShelf && Array.isArray(richShelf.contents)) {
        processShelvesSync(richShelf.contents as FeedItem[], shouldAddPreviews);
      } else if (richContent) {
        processShelfContentSync(richContent, shouldAddPreviews);
      }
    }
  }

  for (const key of ITEM_LIST_KEYS) {
    const listContainer = readRecordPath(node, key);
    if (listContainer && Array.isArray(listContainer.items)) {
      listContainer.items = processItemsListSync(listContainer.items as FeedItem[], shouldAddPreviews);
    }
  }
}

function isStandaloneHiddenHeader(entry: FeedItem): boolean {
  return isStandaloneHeaderNode(entry) && isHiddenShelf(entry);
}

function isUntitledShelfRenderer(entry: FeedItem): boolean {
  const sr = readRecordPath(entry, 'shelfRenderer');
  if (!sr) return false;
  return !sr.title && !sr.headerRenderer && !sr.header;
}

function processShelvesSync(shelves: FeedItem[], shouldAddPreviews = true): void {
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
      const isr = readRecordPath(entry, 'itemSectionRenderer');
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
      const cont = readRecordPath(entry, key);
      if (Array.isArray(cont?.contents)) {
        processShelvesSync(cont.contents as FeedItem[], shouldAddPreviews);
      }
    }
    const surfaceCont = readRecordPath(entry, 'tvSurfaceContentContinuation');
    if (surfaceCont?.content) {
      processBrowseContentSync(surfaceCont.content, shouldAddPreviews);
    }
  }
}

function processBrowseActionsSync(actions: readonly unknown[], shouldAddPreviews = true): void {
  for (const action of actions) {
    if (!isRecord(action)) continue;
    const reload = readRecordPath(action, 'reloadContinuationItemsCommand');
    if (Array.isArray(reload?.continuationItems)) {
      processContinuationItemsListSync(reload.continuationItems as FeedItem[], shouldAddPreviews);
    }
    const append = readRecordPath(action, 'appendContinuationItemsAction');
    if (Array.isArray(append?.continuationItems)) {
      processContinuationItemsListSync(append.continuationItems as FeedItem[], shouldAddPreviews);
    }
    const operationsWrapper = readRecordPath(action, 'listMutationCommand', 'operations');
    if (Array.isArray(operationsWrapper?.operations)) {
      for (const op of operationsWrapper.operations) {
        const insertSection = readRecordPath(op, 'insertItemSectionContent');
        if (Array.isArray(insertSection?.contents)) {
          processShelvesSync(insertSection.contents as FeedItem[], shouldAddPreviews);
        }
      }
    }
    const replaceContainer = readRecordPath(action, 'replaceEnclosingAction');
    const replace = readRecordPath(replaceContainer, 'item');
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
    const section = readRecordPath(rawSection, 'tvSecondaryNavSectionRenderer');
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
    const container = readRecordPath(node, key);
    if (container && Array.isArray(container.contents)) {
      processShelvesSync(container.contents as FeedItem[], shouldAddPreviews);
    }
  }

  for (const surfaceKey of ['tvSurfaceContentRenderer', 'tvSurfaceRenderer'] as const) {
    const surface = readRecordPath(node, surfaceKey);
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

    const playerResponse = readRecordPath(r, 'playerResponse');
    stripPlayerNoise(r);
    if (playerResponse) {
      stripPlayerNoise(playerResponse);
    }

    const streamingData =
      readRecordPath(r, 'streamingData') ?? readRecordPath(playerResponse, 'streamingData') ?? undefined;
    if (Array.isArray(streamingData?.adaptiveFormats)) {
      streamingData.adaptiveFormats = filterStreamingFormats(streamingData.adaptiveFormats as AudioFormatEntry[]);
    }

    disableAutoCaptionsInPayload(r);

    if (r.overlay) {
      enrichShortsPlayerOverlay(r);
    }

    const contents = readRecordPath(r, 'contents');
    const isWatchNextPayload = Boolean(
      contents?.singleColumnWatchNextResults || r.playerOverlays || r.transportControls || r.overlay
    );
    const allowPreviews = !isWatchNextPayload && !isPlaybackPageActive();

    if (contents) {
      processBrowseContentSync(contents, allowPreviews);

      const tvBrowseInner = readRecordPath(contents, 'tvBrowseRenderer', 'content');
      if (tvBrowseInner) {
        processBrowseContentSync(tvBrowseInner, allowPreviews);
      }
      processSecondaryNavSync(readRecordPath(tvBrowseInner, 'tvSecondaryNavRenderer') ?? undefined, allowPreviews);

      const singleColTabs = readRecordPath(contents, 'singleColumnBrowseResultsRenderer')?.tabs;
      if (Array.isArray(singleColTabs)) {
        for (const tab of singleColTabs) {
          const tabRenderer = readRecordPath(tab, 'tabRenderer');
          if (tabRenderer?.content) {
            processBrowseContentSync(tabRenderer.content, allowPreviews);
          }
        }
      }
    }

    const tvBrowseContent = readRecordPath(r, 'tvBrowseContent');
    if (tvBrowseContent) {
      processBrowseContentSync(tvBrowseContent, allowPreviews);
      processSecondaryNavSync(readRecordPath(tvBrowseContent, 'tvSecondaryNavRenderer') ?? undefined, allowPreviews);
    }

    const cont = readRecordPath(r, 'continuationContents');
    if (cont) {
      for (const key of ['sectionListContinuation', 'itemSectionContinuation', 'richGridContinuation'] as const) {
        const listCont = readRecordPath(cont, key);
        if (Array.isArray(listCont?.contents)) {
          processShelvesSync(listCont.contents as FeedItem[], allowPreviews);
        }
      }
      const horizCont = readRecordPath(cont, 'horizontalListContinuation');
      if (Array.isArray(horizCont?.items)) {
        horizCont.items = processItemsListSync(horizCont.items as FeedItem[], allowPreviews);
      }
      const gridCont = readRecordPath(cont, 'gridContinuation');
      if (Array.isArray(gridCont?.items)) {
        gridCont.items = processItemsListSync(gridCont.items as FeedItem[], allowPreviews);
      }
      const surfaceCont = readRecordPath(cont, 'tvSurfaceContentContinuation');
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

    const pivotSectionList = readRecordPath(contents, 'singleColumnWatchNextResults', 'pivot', 'sectionListRenderer');
    if (pivotSectionList && Array.isArray(pivotSectionList.contents)) {
      const pivotContents = pivotSectionList.contents.filter((elm) => !isRecord(elm) || !elm.alertWithActionsRenderer);
      pivotSectionList.contents = pivotContents;
      processShelvesSync(pivotContents as FeedItem[], false);
    }

    if (isWatchNextPayload || r.videoDetails || playerResponse) {
      injectChapters(r);
    }
    transformPlayerOverlays(r);
    recordTransportLikeCount(r);
    transformTransportControls(r);
  } catch (error) {
    console.error('[InnertubeInterceptor] Failed to process JSON payload:', error);
  }

  return r;
}
