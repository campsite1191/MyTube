import pLimit from 'p-limit';
import QuickLRU from 'quick-lru';
import type { FeedItem, FormattedText, Thumbnail } from '../types/innertube.ts';
import { FEED_METADATA_CACHE_MAX_SIZE, unwrapFeedItem } from '../utils/feed-helpers.ts';
import { clearShortsMetadataCache } from './shorts-metadata.ts';

const HQ_THUMBNAIL_WIDTH = 1280;
const HQ_THUMBNAIL_HEIGHT = 720;
const DEARROW_THUMBNAIL_HEIGHT = 640;

const CUSTOM_THUMBNAIL_URL_PATTERN = /_custom_/;
const YOUTUBE_HQ720_URL_PATTERN = /\/vi\/([^/?]+)\/hq720\.jpg/;
const DEARROW_THUMBNAIL_URL_PATTERN = /dearrow-thumb\.ajay\.app\/.*?[?&]videoID=([^&]+)/;

const NON_VIDEO_TILE_CONTENT_TYPES = new Set([
  'TILE_CONTENT_TYPE_SHORTS',
  'TILE_CONTENT_TYPE_CHANNEL',
  'TILE_CONTENT_TYPE_PLAYLIST',
  'TILE_CONTENT_TYPE_VIDEO_AD',
]);

interface DeArrowTitleEntry {
  title: string;
  votes: number;
}

interface DeArrowThumbnailEntry {
  timestamp?: number;
  votes: number;
}

export interface DeArrowBrandingResponse {
  titles?: DeArrowTitleEntry[];
  thumbnails?: DeArrowThumbnailEntry[];
}

interface ThumbnailListHandle {
  getThumbnails: () => Thumbnail[] | undefined;
  setThumbnails: (thumbnails: Thumbnail[]) => void;
}

function getThumbnailListHandle(feedItem: FeedItem): ThumbnailListHandle | null {
  const thumbnailContainer = feedItem.tileRenderer?.header?.tileHeaderRenderer?.thumbnail;
  if (thumbnailContainer) {
    return {
      getThumbnails: () => thumbnailContainer.thumbnails,
      setThumbnails: (thumbnails) => {
        thumbnailContainer.thumbnails = thumbnails;
      },
    };
  }

  const imageContainer = feedItem.lockupViewModel?.contentImage?.thumbnailViewModel?.image;
  if (imageContainer) {
    return {
      getThumbnails: () => imageContainer.sources,
      setThumbnails: (thumbnails) => {
        imageContainer.sources = thumbnails;
      },
    };
  }

  return null;
}

/**
 * Prepends an `hq720.jpg` thumbnail entry unless the item already has an HD or custom thumbnail.
 */
export function applyThumbnailUpgrade(thumbnails: Thumbnail[], videoId: string): Thumbnail[] {
  if (!Array.isArray(thumbnails) || !videoId) return thumbnails;

  const alreadyHighQuality = thumbnails.some(
    (thumbnail) =>
      thumbnail &&
      (thumbnail.width >= HQ_THUMBNAIL_WIDTH || CUSTOM_THUMBNAIL_URL_PATTERN.test(String(thumbnail.url || '')))
  );
  if (alreadyHighQuality) return thumbnails;

  const highQualityThumbnail: Thumbnail = {
    url: `https://i.ytimg.com/vi/${videoId}/hq720.jpg`,
    width: HQ_THUMBNAIL_WIDTH,
    height: HQ_THUMBNAIL_HEIGHT,
  };

  return [highQualityThumbnail, ...thumbnails];
}

export function extractVideoIdForThumbnail(entry: FeedItem | null | undefined): string | null {
  const feedItem = unwrapFeedItem(entry);
  if (!feedItem) return null;

  const lockup = feedItem.lockupViewModel;
  if (lockup) {
    if (lockup.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') return null;
    return (
      lockup.contentId ||
      lockup.rendererContext?.commandContext?.onTap?.innertubeCommand?.watchEndpoint?.videoId ||
      null
    );
  }

  const tile = feedItem.tileRenderer;
  if (tile) {
    if (tile.style === 'TILE_STYLE_YTLR_SHORTS') return null;
    if (tile.contentType && NON_VIDEO_TILE_CONTENT_TYPES.has(tile.contentType)) return null;
    if (tile.onSelectCommand?.reelWatchEndpoint) return null;
    if (tile.style !== 'TILE_STYLE_YTLR_DEFAULT' && tile.contentType !== 'TILE_CONTENT_TYPE_VIDEO') {
      return null;
    }
    return tile.onSelectCommand?.watchEndpoint?.videoId || tile.contentId || null;
  }

  return null;
}

export function upgradeFeedItemThumbnails(entry: FeedItem | null | undefined): boolean {
  const videoId = extractVideoIdForThumbnail(entry);
  if (!videoId) return false;

  const feedItem = unwrapFeedItem(entry);
  if (!feedItem) return false;

  const thumbnailHandle = getThumbnailListHandle(feedItem);
  if (!thumbnailHandle) return false;

  const existingThumbnails = thumbnailHandle.getThumbnails();
  if (!Array.isArray(existingThumbnails) || existingThumbnails.length === 0 || !existingThumbnails[0]?.url) {
    return false;
  }

  const upgradedThumbnails = applyThumbnailUpgrade(existingThumbnails, videoId);
  if (upgradedThumbnails === existingThumbnails) return false;

  thumbnailHandle.setThumbnails(upgradedThumbnails);
  return true;
}

/**
 * Upgrades video thumbnails in place across a batch of feed items.
 */
export function upgradeFeedThumbnails(items: FeedItem[]): void {
  if (!Array.isArray(items)) return;
  for (const entry of items) {
    upgradeFeedItemThumbnails(entry);
  }
}

export function selectHighestVotedEntry<T extends { votes: number }>(entries: readonly T[]): T | null {
  let highestVotedEntry: T | null = null;
  for (const entry of entries) {
    if (entry.votes < 0) continue;
    if (!highestVotedEntry || entry.votes > highestVotedEntry.votes) {
      highestVotedEntry = entry;
    }
  }
  return highestVotedEntry;
}

function setFormattedTitle(
  titleContainer: FormattedText | undefined,
  replacementTitle: string,
  preferContentProperty = false
): void {
  if (!titleContainer || !replacementTitle) return;

  if (
    preferContentProperty &&
    ('content' in titleContainer || (!('simpleText' in titleContainer) && !Array.isArray(titleContainer.runs)))
  ) {
    titleContainer.content = replacementTitle;
  } else if ('simpleText' in titleContainer || !Array.isArray(titleContainer.runs)) {
    titleContainer.simpleText = replacementTitle;
  } else {
    titleContainer.runs = [{ text: replacementTitle }];
  }
}

function updateMountedDeArrowDom(videoId: string, title: string | null, thumbnailUrl: string | null): void {
  if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
  if (!title && !thumbnailUrl) return;

  for (const thumb of document.querySelectorAll<HTMLElement>(
    `ytlr-tile-renderer ytlr-thumbnail-details[style*="/${videoId}/"], ytlr-tile-renderer img[src*="/${videoId}/"]`
  )) {
    const tile = thumb.closest?.('ytlr-tile-renderer') ?? null;
    if (title && tile) {
      const titleEl = tile.querySelector<HTMLElement>(
        'ytlr-tile-metadata-renderer [idomkey="title"], ytlr-tile-metadata-renderer .ytLrTileMetadataRendererTitle'
      );
      if (titleEl && titleEl.textContent !== title) {
        titleEl.textContent = title;
      }
    }
    if (thumbnailUrl) {
      if (thumb.tagName === 'IMG') {
        const img = thumb as HTMLImageElement;
        if (img.src !== thumbnailUrl) img.src = thumbnailUrl;
      } else if (thumb.style?.backgroundImage) {
        thumb.style.backgroundImage = `url("${thumbnailUrl}")`;
      }
    }
  }
}

export function applyDeArrowBrandingToItem(entry: FeedItem, videoId: string, branding: DeArrowBrandingResponse): void {
  const feedItem = unwrapFeedItem(entry);
  if (!feedItem) return;

  let resolvedTitle: string | null = null;
  if (Array.isArray(branding.titles) && branding.titles.length > 0) {
    const highestVotedTitle = selectHighestVotedEntry(branding.titles);
    if (highestVotedTitle?.title) {
      resolvedTitle = highestVotedTitle.title;
      if (feedItem.tileRenderer) {
        setFormattedTitle(feedItem.tileRenderer.metadata?.tileMetadataRenderer?.title, resolvedTitle);
      } else if (feedItem.lockupViewModel) {
        setFormattedTitle(feedItem.lockupViewModel.metadata?.lockupMetadataViewModel?.title, resolvedTitle, true);
      }
    }
  }

  let resolvedThumbnailUrl: string | null = null;
  if (Array.isArray(branding.thumbnails) && branding.thumbnails.length > 0) {
    const highestVotedThumbnail = selectHighestVotedEntry(branding.thumbnails);
    const ts = highestVotedThumbnail?.timestamp;
    if (typeof ts === 'number' && Number.isFinite(ts) && ts >= 0) {
      const url = `https://dearrow-thumb.ajay.app/api/v1/getThumbnail?videoID=${encodeURIComponent(videoId)}&time=${ts}`;
      resolvedThumbnailUrl = url;
      const thumbnailHandle = getThumbnailListHandle(feedItem);
      if (thumbnailHandle) {
        const existingThumbnails = thumbnailHandle.getThumbnails();
        const fallbackThumbnails = Array.isArray(existingThumbnails) ? existingThumbnails : [];
        if (fallbackThumbnails[0]?.url !== url) {
          thumbnailHandle.setThumbnails([
            {
              url,
              width: HQ_THUMBNAIL_WIDTH,
              height: DEARROW_THUMBNAIL_HEIGHT,
            },
            ...fallbackThumbnails,
          ]);
        }
      }
    }
  }

  updateMountedDeArrowDom(videoId, resolvedTitle, resolvedThumbnailUrl);
}

const MAX_DEARROW_CONCURRENCY = 6;
const EMPTY_DEARROW_BRANDING: DeArrowBrandingResponse = { titles: [], thumbnails: [] };

const deArrowLimit = pLimit(MAX_DEARROW_CONCURRENCY);
const deArrowCache = new QuickLRU<string, DeArrowBrandingResponse>({ maxSize: FEED_METADATA_CACHE_MAX_SIZE });
const inFlightDeArrow = new Map<string, Promise<DeArrowBrandingResponse | null>>();
let activeNavigationController: AbortController | null =
  typeof AbortController === 'function' ? new AbortController() : null;

function hasDeArrowBrandingContent(branding: DeArrowBrandingResponse | null | undefined): boolean {
  return Boolean(branding && (branding.titles?.length || branding.thumbnails?.length));
}

/** Aborts in-flight and queued DeArrow requests (e.g. on navigation or memory pressure). */
export function abortPendingDeArrowRequests(): void {
  activeNavigationController?.abort();
  activeNavigationController = typeof AbortController === 'function' ? new AbortController() : null;
  inFlightDeArrow.clear();
}

/** Clears cached DeArrow branding entries under memory pressure. */
export function clearDeArrowCache(): void {
  deArrowCache.clear();
  abortPendingDeArrowRequests();
}

/** Registers Cobalt's `h5vcc.system.onMemoryPressure` listener to evict the DeArrow cache cleanly. */
export function setupMemoryPressureListener(): void {
  const onMemoryPressure = typeof window !== 'undefined' ? window.h5vcc?.system?.onMemoryPressure : undefined;
  if (typeof onMemoryPressure?.addListener === 'function') {
    onMemoryPressure.addListener(() => {
      console.warn('Memory pressure detected, clearing caches...');
      clearDeArrowCache();
      clearShortsMetadataCache();
    });
  }
}

function fetchBrandingForVideo(
  videoId: string,
  controller: AbortController | null
): Promise<DeArrowBrandingResponse | null> {
  const cached = deArrowCache.get(videoId);
  if (cached) return Promise.resolve(cached);

  const pending = inFlightDeArrow.get(videoId);
  if (pending) return pending;

  const signal = controller?.signal;
  const request = deArrowLimit(async (): Promise<DeArrowBrandingResponse | null> => {
    if (signal?.aborted) return null;
    const cachedWhileQueued = deArrowCache.get(videoId);
    if (cachedWhileQueued) return cachedWhileQueued;

    try {
      const response = await fetch(
        `https://sponsor.ajay.app/api/branding?videoID=${encodeURIComponent(videoId)}`,
        signal ? { signal } : undefined
      );
      if (response.status === 404) {
        deArrowCache.set(videoId, EMPTY_DEARROW_BRANDING);
        return EMPTY_DEARROW_BRANDING;
      }
      if (!response.ok) return null;
      const branding = (await response.json()) as DeArrowBrandingResponse | null;
      if (!branding) return null;
      deArrowCache.set(videoId, branding);
      return branding;
    } catch {
      // Ignore aborted navigations, transient network errors, or JSON parse errors.
      return null;
    } finally {
      if (inFlightDeArrow.get(videoId) === request) {
        inFlightDeArrow.delete(videoId);
      }
    }
  });

  inFlightDeArrow.set(videoId, request);
  return request;
}

/**
 * Fetches and applies DeArrow replacement titles and thumbnails across a batch of feed items.
 */
export async function applyDeArrowBranding(items: FeedItem[]): Promise<void> {
  if (!Array.isArray(items)) return;

  const requestController = activeNavigationController;
  const tasks: Array<{ entry: FeedItem; videoId: string }> = [];
  for (const entry of items) {
    const videoId = extractVideoIdForThumbnail(entry);
    if (!videoId) continue;

    const cached = deArrowCache.get(videoId);
    if (cached) {
      if (hasDeArrowBrandingContent(cached)) {
        applyDeArrowBrandingToItem(entry, videoId, cached);
      }
    } else {
      tasks.push({ entry, videoId });
    }
  }
  if (tasks.length === 0) return;

  await Promise.all(
    tasks.map((task) =>
      fetchBrandingForVideo(task.videoId, requestController).then((branding) => {
        if (!requestController?.signal.aborted && branding && hasDeArrowBrandingContent(branding)) {
          applyDeArrowBrandingToItem(task.entry, task.videoId, branding);
        }
      })
    )
  );
}

/**
 * Resolves the next step-down thumbnail URL when an image fails to load:
 * `DeArrow -> hq720.jpg -> hqdefault.jpg -> null`.
 */
export function resolveFallbackThumbnailUrl(failedUrl: string): string | null {
  if (!failedUrl) return null;
  const deArrowMatch = failedUrl.match(DEARROW_THUMBNAIL_URL_PATTERN);
  if (deArrowMatch?.[1]) {
    return `https://i.ytimg.com/vi/${deArrowMatch[1]}/hq720.jpg`;
  }
  const hq720Match = failedUrl.match(YOUTUBE_HQ720_URL_PATTERN);
  return hq720Match?.[1] ? `https://i.ytimg.com/vi/${hq720Match[1]}/hqdefault.jpg` : null;
}

let isFallbackListenerInstalled = false;

/**
 * Installs capture-phase thumbnail error recovery (`DeArrow -> hq720.jpg -> hqdefault.jpg`)
 * and aborts queued DeArrow fetches on route navigation.
 */
export function installThumbnailErrorFallback(): void {
  if (isFallbackListenerInstalled || typeof document === 'undefined') return;
  isFallbackListenerInstalled = true;

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('hashchange', abortPendingDeArrowRequests, false);
  }

  document.addEventListener(
    'error',
    (event: Event) => {
      const imageElement = event.target;
      if (typeof HTMLImageElement === 'undefined' || !(imageElement instanceof HTMLImageElement)) return;

      const failedSourceUrl = imageElement.src || '';
      const fallbackUrl = resolveFallbackThumbnailUrl(failedSourceUrl);
      if (fallbackUrl && fallbackUrl !== failedSourceUrl) {
        imageElement.src = fallbackUrl;
      }
    },
    true
  );
}
