import pLimit from 'p-limit';
import QuickLRU from 'quick-lru';
import { NOOP, observeShortsPage } from '../core/lifecycle.ts';
import {
  buildStackedTvBackground,
  extractVideoIdForThumbnail,
  getThumbnailListHandle,
} from '../transforms/thumbnails.ts';
import type { FeedItem, FormattedText } from '../types/innertube.ts';
import { FEED_METADATA_CACHE_MAX_SIZE, unwrapFeedItem } from '../utils/feed-helpers.ts';
import { VIDEO_ID_RE } from '../utils/innertube-ast.ts';
import { clearShortsMetadataCache } from './shorts-metadata.ts';

const DEARROW_THUMBNAIL_WIDTH = 1280;
const DEARROW_THUMBNAIL_HEIGHT = 640;
const MAX_DEARROW_CONCURRENCY = 6;

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

const EMPTY_DEARROW_BRANDING: DeArrowBrandingResponse = { titles: [], thumbnails: [] };

const deArrowLimit = pLimit(MAX_DEARROW_CONCURRENCY);
const deArrowCache = new QuickLRU<string, DeArrowBrandingResponse>({ maxSize: FEED_METADATA_CACHE_MAX_SIZE });
const inFlightDeArrow = new Map<string, Promise<DeArrowBrandingResponse | null>>();
let activeNavigationController = new AbortController();

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
  if (!titleContainer) return;

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
  if ((!title && !thumbnailUrl) || !VIDEO_ID_RE.test(videoId)) return;

  for (const thumb of document.querySelectorAll<HTMLElement>(
    `ytlr-tile-renderer ytlr-thumbnail-details[style*="/${videoId}/"]`
  )) {
    const card = thumb.closest?.('ytlr-tile-renderer') ?? null;
    if (title && card) {
      const titleEl = card.querySelector<HTMLElement>(
        'ytlr-tile-metadata-renderer [idomkey="title"], ytlr-tile-metadata-renderer .ytLrTileMetadataRendererTitle'
      );
      if (titleEl && titleEl.textContent !== title) {
        titleEl.textContent = title;
      }
    }
    if (thumbnailUrl && thumb.style?.backgroundImage) {
      thumb.style.backgroundImage = buildStackedTvBackground(videoId, thumbnailUrl);
    }
  }
}

export function applyDeArrowBrandingToItem(
  entry: FeedItem,
  videoId: string,
  branding: DeArrowBrandingResponse,
  updateDom = true
): void {
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
              width: DEARROW_THUMBNAIL_WIDTH,
              height: DEARROW_THUMBNAIL_HEIGHT,
            },
            ...fallbackThumbnails,
          ]);
        }
      }
    }
  }

  if (updateDom) {
    updateMountedDeArrowDom(videoId, resolvedTitle, resolvedThumbnailUrl);
  }
}

function hasDeArrowBrandingContent(branding: DeArrowBrandingResponse | null | undefined): boolean {
  return Boolean(branding && (branding.titles?.length || branding.thumbnails?.length));
}

/** Aborts in-flight and queued DeArrow requests (e.g. on navigation or memory pressure). */
export function abortPendingDeArrowRequests(): void {
  activeNavigationController.abort();
  activeNavigationController = new AbortController();
  inFlightDeArrow.clear();
}

/** Clears cached DeArrow branding entries under memory pressure. */
export function clearDeArrowCache(): void {
  deArrowCache.clear();
  abortPendingDeArrowRequests();
}

/** Registers Cobalt's `h5vcc.system.onMemoryPressure` listener to evict DeArrow and Shorts caches cleanly. */
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

function fetchBrandingForVideo(videoId: string, controller: AbortController): Promise<DeArrowBrandingResponse | null> {
  const pending = inFlightDeArrow.get(videoId);
  if (pending) return pending;

  const { signal } = controller;
  const request = deArrowLimit(async (): Promise<DeArrowBrandingResponse | null> => {
    if (signal.aborted) return null;

    let branding: DeArrowBrandingResponse | null = null;
    try {
      const response = await fetch(`https://sponsor.ajay.app/api/branding?videoID=${encodeURIComponent(videoId)}`, {
        signal,
      });
      if (!signal.aborted) {
        if (response.status === 404) {
          deArrowCache.set(videoId, EMPTY_DEARROW_BRANDING);
          branding = EMPTY_DEARROW_BRANDING;
        } else if (response.ok) {
          const parsed = (await response.json()) as DeArrowBrandingResponse | null;
          if (!signal.aborted && parsed) {
            deArrowCache.set(videoId, parsed);
            branding = parsed;
          }
        }
      }
    } catch {
      // Ignore aborted navigations, transient network errors, or JSON parse errors.
    }
    if (inFlightDeArrow.get(videoId) === request) {
      inFlightDeArrow.delete(videoId);
    }
    return branding;
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
        applyDeArrowBrandingToItem(entry, videoId, cached, false);
      }
    } else {
      tasks.push({ entry, videoId });
    }
  }
  if (tasks.length === 0) return;

  await Promise.all(
    tasks.map((task) =>
      fetchBrandingForVideo(task.videoId, requestController).then((branding) => {
        if (!requestController.signal.aborted && branding && hasDeArrowBrandingContent(branding)) {
          applyDeArrowBrandingToItem(task.entry, task.videoId, branding, true);
        }
      })
    )
  );
}

let deArrowInstalled = false;

/**
 * Installs DeArrow lifecycle hooks: memory pressure cache eviction and aborting
 * pending requests on hash navigation or Shorts entry.
 */
export function installDeArrow(): () => void {
  if (deArrowInstalled || typeof document === 'undefined') return NOOP;
  deArrowInstalled = true;

  setupMemoryPressureListener();

  const stopShortsObserver = observeShortsPage((active) => {
    if (active) abortPendingDeArrowRequests();
  });
  const win = typeof window !== 'undefined' && typeof window.addEventListener === 'function' ? window : null;
  if (win) {
    win.addEventListener('hashchange', abortPendingDeArrowRequests, false);
  }

  return () => {
    if (win && typeof win.removeEventListener === 'function') {
      win.removeEventListener('hashchange', abortPendingDeArrowRequests, false);
    }
    stopShortsObserver();
    deArrowInstalled = false;
  };
}
