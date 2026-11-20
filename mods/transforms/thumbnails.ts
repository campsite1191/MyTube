import { configRead } from '../core/config.ts';
import type { FeedItem, FormattedText, Thumbnail } from '../types/innertube.ts';

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

export interface DeArrowOptions {
  enableDeArrow?: boolean;
  enableDeArrowThumbnails?: boolean;
}

interface ThumbnailListHandle {
  getThumbnails: () => Thumbnail[] | undefined;
  setThumbnails: (thumbnails: Thumbnail[]) => void;
}

function unwrapFeedItem(entry: FeedItem | null | undefined): FeedItem | null {
  const feedItem = entry?.richItemRenderer?.content ?? entry;
  return feedItem && typeof feedItem === 'object' ? feedItem : null;
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

export function upgradeFeedThumbnails(
  items: FeedItem[],
  isEnabled: boolean = configRead('enableHqThumbnails')
): void {
  if (!isEnabled || !Array.isArray(items)) return;
  for (const entry of items) {
    upgradeFeedItemThumbnails(entry);
  }
}

export function selectHighestVotedEntry<T extends { votes: number }>(entries: readonly T[]): T | null {
  let highestVotedEntry: T | null = null;
  for (const entry of entries) {
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

export function applyDeArrowBrandingToItem(
  entry: FeedItem,
  videoId: string,
  branding: DeArrowBrandingResponse,
  shouldUpdateThumbnails: boolean
): void {
  const feedItem = unwrapFeedItem(entry);
  if (!feedItem) return;

  if (Array.isArray(branding.titles) && branding.titles.length > 0) {
    const highestVotedTitle = selectHighestVotedEntry(branding.titles);
    if (highestVotedTitle?.title) {
      if (feedItem.tileRenderer) {
        setFormattedTitle(feedItem.tileRenderer.metadata?.tileMetadataRenderer?.title, highestVotedTitle.title);
      } else if (feedItem.lockupViewModel) {
        setFormattedTitle(
          feedItem.lockupViewModel.metadata?.lockupMetadataViewModel?.title,
          highestVotedTitle.title,
          true
        );
      }
    }
  }

  if (shouldUpdateThumbnails && Array.isArray(branding.thumbnails) && branding.thumbnails.length > 0) {
    const highestVotedThumbnail = selectHighestVotedEntry(branding.thumbnails);
    if (typeof highestVotedThumbnail?.timestamp === 'number') {
      const deArrowThumbnail: Thumbnail = {
        url: `https://dearrow-thumb.ajay.app/api/v1/getThumbnail?videoID=${encodeURIComponent(videoId)}&time=${highestVotedThumbnail.timestamp}`,
        width: HQ_THUMBNAIL_WIDTH,
        height: DEARROW_THUMBNAIL_HEIGHT,
      };
      const thumbnailHandle = getThumbnailListHandle(feedItem);
      if (thumbnailHandle) {
        const existingThumbnails = thumbnailHandle.getThumbnails();
        const fallbackThumbnails = Array.isArray(existingThumbnails) ? existingThumbnails : [];
        thumbnailHandle.setThumbnails([deArrowThumbnail, ...fallbackThumbnails]);
      }
    }
  }
}

async function fetchAndApplyDeArrowBranding(
  entry: FeedItem,
  videoId: string,
  shouldUpdateThumbnails: boolean
): Promise<void> {
  try {
    const response = await fetch(`https://sponsor.ajay.app/api/branding?videoID=${encodeURIComponent(videoId)}`);
    if (!response.ok) return;
    const branding = (await response.json()) as DeArrowBrandingResponse | null;
    if (!branding) return;
    applyDeArrowBrandingToItem(entry, videoId, branding, shouldUpdateThumbnails);
  } catch {
    // Ignore transient network or JSON parse errors from the external DeArrow API.
  }
}

export function applyDeArrowBranding(items: FeedItem[], options: DeArrowOptions = {}): Promise<void> {
  const enableDeArrow = options.enableDeArrow ?? configRead('enableDeArrow');
  const enableDeArrowThumbnails = options.enableDeArrowThumbnails ?? configRead('enableDeArrowThumbnails');
  if (!enableDeArrow || !Array.isArray(items)) return Promise.resolve();

  const pendingUpdates: Promise<void>[] = [];
  for (const entry of items) {
    const videoId = extractVideoIdForThumbnail(entry);
    if (!videoId) continue;
    pendingUpdates.push(fetchAndApplyDeArrowBranding(entry, videoId, enableDeArrowThumbnails));
  }

  return Promise.all(pendingUpdates).then(() => undefined);
}

export function resolveFallbackThumbnailUrl(failedUrl: string): string | null {
  if (!failedUrl) return null;
  const match =
    failedUrl.match(YOUTUBE_HQ720_URL_PATTERN) ?? failedUrl.match(DEARROW_THUMBNAIL_URL_PATTERN);
  return match?.[1] ? `https://i.ytimg.com/vi/${match[1]}/hqdefault.jpg` : null;
}

let isFallbackListenerInstalled = false;

export function installThumbnailErrorFallback(): void {
  if (isFallbackListenerInstalled || typeof document === 'undefined') return;
  isFallbackListenerInstalled = true;

  document.addEventListener(
    'error',
    (event: Event) => {
      const imageElement = event.target;
      if (!(imageElement instanceof HTMLImageElement)) return;

      const failedSourceUrl = imageElement.src || '';
      if (!failedSourceUrl || imageElement.dataset.ttThumbFallback === failedSourceUrl) return;

      const fallbackUrl = resolveFallbackThumbnailUrl(failedSourceUrl);
      if (fallbackUrl) {
        imageElement.dataset.ttThumbFallback = failedSourceUrl;
        imageElement.src = fallbackUrl;
      }
    },
    true
  );
}
