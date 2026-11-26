import { observeDom } from '../core/lifecycle.ts';
import type { FeedItem, Thumbnail } from '../types/innertube.ts';
import { unwrapFeedItem } from '../utils/feed-helpers.ts';
import { VIDEO_ID_RE } from '../utils/innertube-ast.ts';

const HQ_THUMBNAIL_WIDTH = 1280;
const HQ_THUMBNAIL_HEIGHT = 720;

const CUSTOM_THUMBNAIL_URL_PATTERN = /_custom_/;
const YOUTUBE_HQ720_URL_PATTERN = /\/vi\/([^/?&]+)\/hq720\.jpg/;
const DEARROW_THUMBNAIL_URL_PATTERN = /dearrow-thumb\.ajay\.app\/.*?[?&]videoID=([^&]+)/;
const CSS_BACKGROUND_URL_RE = /url\(["']?([^"')]+)["']?\)/;

const NON_VIDEO_TILE_CONTENT_TYPES = new Set([
  'TILE_CONTENT_TYPE_SHORTS',
  'TILE_CONTENT_TYPE_CHANNEL',
  'TILE_CONTENT_TYPE_PLAYLIST',
  'TILE_CONTENT_TYPE_VIDEO_AD',
]);

export interface ThumbnailListHandle {
  getThumbnails: () => Thumbnail[] | undefined;
  setThumbnails: (thumbnails: Thumbnail[]) => void;
}

export function getThumbnailListHandle(feedItem: FeedItem): ThumbnailListHandle | null {
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

export function buildHq720Url(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hq720.jpg?v=1`;
}

export function buildStackedTvBackground(videoId: string, primaryUrl: string, existingBackgroundImage = ''): string {
  const hq720Url = buildHq720Url(videoId);
  const hqDefaultUrl = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  const layers = YOUTUBE_HQ720_URL_PATTERN.test(primaryUrl)
    ? `url("${primaryUrl}"), url("${hqDefaultUrl}")`
    : `url("${primaryUrl}"), url("${hq720Url}"), url("${hqDefaultUrl}")`;
  const firstUrlIndex = existingBackgroundImage.indexOf('url(');
  const gradientPrefix =
    firstUrlIndex > 0 ? existingBackgroundImage.slice(0, firstUrlIndex).replace(/[\s,]+$/, '') : '';
  return gradientPrefix ? `${gradientPrefix}, ${layers}` : layers;
}

/**
 * Prepends an `hq720.jpg?v=1` thumbnail entry unless the item already has an HD or custom thumbnail.
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
    url: buildHq720Url(videoId),
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

  const feedItem = unwrapFeedItem(entry as FeedItem);

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

/**
 * Resolves the next step-down thumbnail URL when an image fails to load:
 * `DeArrow -> hq720.jpg -> hqdefault.jpg -> null`.
 */
export function resolveFallbackThumbnailUrl(failedUrl: string): string | null {
  if (!failedUrl) return null;
  const deArrowMatch = failedUrl.match(DEARROW_THUMBNAIL_URL_PATTERN);
  if (deArrowMatch?.[1]) {
    return buildHq720Url(deArrowMatch[1]);
  }
  const hq720Match = failedUrl.match(YOUTUBE_HQ720_URL_PATTERN);
  return hq720Match?.[1] ? `https://i.ytimg.com/vi/${hq720Match[1]}/hqdefault.jpg` : null;
}

const installedFallbackDocs = new WeakSet<Document>();

function upgradeSingleTvThumbnailElement(thumb: HTMLElement): void {
  const bg = thumb.style?.backgroundImage || '';
  if (!bg || bg.includes('/hqdefault.jpg')) return;
  if (!bg.includes('hq720.jpg') && !bg.includes('dearrow-thumb.ajay.app')) return;
  const primaryUrl = bg.match(CSS_BACKGROUND_URL_RE)?.[1];
  if (!primaryUrl) return;
  const videoId =
    primaryUrl.match(DEARROW_THUMBNAIL_URL_PATTERN)?.[1] ?? primaryUrl.match(YOUTUBE_HQ720_URL_PATTERN)?.[1];
  if (!videoId || !VIDEO_ID_RE.test(videoId)) return;
  thumb.style.backgroundImage = buildStackedTvBackground(videoId, primaryUrl, bg);
}

function upgradeMountedTvThumbnailFallbacks(): void {
  if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
  for (const thumb of document.querySelectorAll<HTMLElement>(
    'ytlr-thumbnail-details[style*="hq720.jpg"], ytlr-thumbnail-details[style*="dearrow-thumb.ajay.app"], image[style*="hq720.jpg"], image[style*="dearrow-thumb.ajay.app"]'
  )) {
    upgradeSingleTvThumbnailElement(thumb);
  }
}

/**
 * Installs capture-phase thumbnail error recovery (`DeArrow -> hq720.jpg -> hqdefault.jpg`)
 * and stacks CSS multi-background fallbacks on mounted TV `<ytlr-thumbnail-details>` and `<image>` elements.
 */
export function installThumbnailErrorFallback(): void {
  if (typeof document === 'undefined' || installedFallbackDocs.has(document)) return;
  installedFallbackDocs.add(document);

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

  const startTvFallbackObserver = (): void => {
    const root = document.body ?? document.documentElement;
    if (!root) return;
    upgradeMountedTvThumbnailFallbacks();
    let scanScheduled = false;
    const scheduleFullScan = (): void => {
      if (scanScheduled) return;
      if (typeof requestAnimationFrame === 'function') {
        scanScheduled = true;
        requestAnimationFrame(() => {
          scanScheduled = false;
          upgradeMountedTvThumbnailFallbacks();
        });
      } else {
        upgradeMountedTvThumbnailFallbacks();
      }
    };
    observeDom(
      root,
      (mutations) => {
        let needsTreeScan = false;
        for (const mutation of mutations) {
          if (mutation.type === 'childList' && (mutation.addedNodes?.length ?? 0) > 0) {
            needsTreeScan = true;
          } else if (mutation.type === 'attributes') {
            const target = mutation.target as Element | null;
            const tagName = target?.tagName;
            if (tagName === 'YTLR-THUMBNAIL-DETAILS' || tagName === 'IMAGE') {
              upgradeSingleTvThumbnailElement(target as HTMLElement);
            }
          }
        }
        if (needsTreeScan) {
          scheduleFullScan();
        }
      },
      { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] }
    );
  };

  if (document.body ?? document.documentElement) {
    startTvFallbackObserver();
  } else {
    document.addEventListener('DOMContentLoaded', startTvFallbackObserver, { once: true });
  }
}
