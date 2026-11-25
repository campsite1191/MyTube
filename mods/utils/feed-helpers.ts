import type { FeedItem, WatchEndpoint } from '../types/innertube.ts';
import { isRecord } from './type-guards.ts';

/** Shared LRU capacity for per-video feed enrichment caches (DeArrow branding & Shorts metadata). */
export const FEED_METADATA_CACHE_MAX_SIZE = 2000;

/**
 * Unwraps `richItemRenderer.content` when present, or returns the plain item record itself.
 */
export function unwrapFeedItem(item: FeedItem): FeedItem;
export function unwrapFeedItem(item: FeedItem | null | undefined): FeedItem | null;
export function unwrapFeedItem(item: FeedItem | null | undefined): FeedItem | null {
  if (!isRecord(item)) return null;
  const content = item.richItemRenderer?.content;
  return isRecord(content) ? content : item;
}

export function compactInPlace<T>(items: T[], shouldRemove: (item: T) => boolean): T[] {
  if (!Array.isArray(items)) return items;

  let writeIndex = 0;
  for (let readIndex = 0; readIndex < items.length; readIndex++) {
    const item = items[readIndex] as T;
    if (shouldRemove(item)) continue;
    items[writeIndex] = item;
    writeIndex++;
  }

  items.length = writeIndex;
  return items;
}

// GO_TO_CHANNEL (requestNextAndNavigateChannel) only reads contentId and the
// watchEndpoint params, so the payload is a fresh, acyclic object.
export function buildLongPressPayload(
  item: FeedItem | null | undefined,
  videoId: string,
  watchEndpointData?: WatchEndpoint | null
): FeedItem {
  const watchEndpoint: WatchEndpoint = { params: watchEndpointData?.params };
  if (item?.tileRenderer) {
    return { tileRenderer: { contentId: videoId, onSelectCommand: { watchEndpoint } } };
  }
  return {
    lockupViewModel: {
      contentId: videoId,
      rendererContext: { commandContext: { onTap: { innertubeCommand: { watchEndpoint } } } },
    },
  };
}

const COMPACT_COUNT_FORMATTER = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

export function formatCompactCount(value: unknown): string {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0) return '';
  return COMPACT_COUNT_FORMATTER.format(Math.round(numericValue));
}
