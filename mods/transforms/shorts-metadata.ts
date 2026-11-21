import pLimit from 'p-limit';
import QuickLRU from 'quick-lru';
import { setShortsOverlayStats } from '../features/return-youtube-dislike.ts';
import type { FeedItem } from '../types/innertube.ts';
import { FEED_METADATA_CACHE_MAX_SIZE, formatCompactCount, unwrapFeedItem } from '../utils/feed-helpers.ts';
import { isRecord, readRecordPath } from '../utils/type-guards.ts';
import { readFormattedText } from './feed-filter.ts';

const META_SEPARATOR = ' • ';
const PLACEHOLDER_TEXT = '\u00A0';
const INITIAL_SHELF_PREFETCH_LIMIT = 6;
const MAX_SHORTS_META_CONCURRENCY = 2;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const THUMB_VIDEO_ID_RE = /\/vi(?:_webp)?\/([A-Za-z0-9_-]{11})\//;
const COMPACT_VIEWS_RE = /^\d+(?:\.\d+)?[KMBT]\s+views?$/i;
const RAW_VIEWS_NUM_RE = /^([\d,]+)\s+views?\b/i;

const shortsMetaLimit = pLimit(MAX_SHORTS_META_CONCURRENCY);
const shortsMetadataCache = new QuickLRU<string, string>({ maxSize: FEED_METADATA_CACHE_MAX_SIZE });
const inFlightShortsMeta = new Map<string, Promise<string | null>>();
const pendingTileTextTargets = new Map<string, Set<Record<string, unknown>>>();

let activeNavigationController: AbortController | null =
  typeof AbortController === 'function' ? new AbortController() : null;
let shortsMetadataInstalled = false;
let suppressOverlayEnrichment = false;

/**
 * Normalizes a view-count string (e.g. `"12,318,166 views"`) into compact form (`"12.3M views"`).
 */
export function formatShortsViewCount(rawViews: string | null | undefined): string | null {
  if (typeof rawViews !== 'string') return null;
  const trimmed = rawViews.trim();
  if (!trimmed) return null;
  if (COMPACT_VIEWS_RE.test(trimmed)) return trimmed;

  const match = trimmed.match(RAW_VIEWS_NUM_RE);
  if (match?.[1]) {
    const count = Number(match[1].replace(/,/g, ''));
    if (Number.isFinite(count) && count > 0) {
      if (count < 1000) return `${Math.round(count)} ${count === 1 ? 'view' : 'views'}`;
      const compact = formatCompactCount(count);
      if (compact) return `${compact} views`;
    }
  }
  return trimmed;
}

/**
 * Resolves the relative timestamp (e.g. `"1 day ago"`) with a cleaned publish-date fallback.
 */
export function formatShortsUploadedAt(
  timestampText: string | null | undefined,
  publishDateText: string | null | undefined
): string | null {
  const ts = typeof timestampText === 'string' ? timestampText.trim() : '';
  if (ts) return ts;
  const pub = typeof publishDateText === 'string' ? publishDateText.trim().replace(/^Published on\s+/i, '') : '';
  return pub || null;
}

function findVideoDescriptionHeader(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const panels = Array.isArray(payload.engagementPanels) ? payload.engagementPanels : [];
  for (const panel of panels) {
    const sdcr = readRecordPath(
      panel,
      'engagementPanelSectionListRenderer',
      'content',
      'structuredDescriptionContentRenderer'
    );
    const items = Array.isArray(sdcr?.items) ? sdcr.items : [];
    for (const item of items) {
      if (isRecord(item) && isRecord(item.videoDescriptionHeaderRenderer)) {
        return item.videoDescriptionHeaderRenderer;
      }
    }
  }
  return undefined;
}

function readViewsFromDescription(descHeader: Record<string, unknown> | undefined): string | null {
  if (!descHeader) return null;
  const directViews = readFormattedText(descHeader.views);
  if (directViews) return formatShortsViewCount(directViews);

  const factoids = Array.isArray(descHeader.factoid) ? descHeader.factoid : [];
  for (const entry of factoids) {
    const factoid = isRecord(entry) && isRecord(entry.factoidRenderer) ? entry.factoidRenderer : undefined;
    if (!factoid) continue;
    const label = readFormattedText(factoid.label);
    if (!/^views?$/i.test(label)) continue;
    const val = readFormattedText(factoid.value);
    if (val) return formatShortsViewCount(`${val} views`);
  }
  return null;
}

function readHeaderRenderer(payload: unknown): Record<string, unknown> | null {
  return readRecordPath(
    payload,
    'overlay',
    'reelPlayerOverlayRenderer',
    'reelPlayerHeaderSupportedRenderers',
    'reelPlayerHeaderRenderer'
  );
}

/**
 * Extracts formatted `"views • uploaded"` metadata from a `/youtubei/v1/reel/reel_item_watch` payload.
 */
export function extractShortsMetadataFromReel(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const hdr = readHeaderRenderer(payload);
  const desc = findVideoDescriptionHeader(payload);
  const views = readViewsFromDescription(desc);
  const uploaded = formatShortsUploadedAt(readFormattedText(hdr?.timestampText), readFormattedText(desc?.publishDate));
  const combined = [views, uploaded].filter(Boolean).join(META_SEPARATOR);
  return combined || null;
}

function enrichShortsActionBar(payload: Record<string, unknown>): boolean {
  const bar = readRecordPath(payload, 'overlay', 'reelPlayerOverlayRenderer', 'buttonBar', 'reelActionBarViewModel');
  const buttons = bar && Array.isArray(bar.buttonViewModels) ? bar.buttonViewModels : undefined;
  if (!buttons) return false;

  let videoId: string | null = null;
  let likeCount: string | null = null;
  let likeIndex = -1;
  let hasDislike = false;

  for (let i = 0; i < buttons.length; i++) {
    const btn = readRecordPath(buttons[i], 'reelActionBarButtonViewModel', 'buttonViewModel');
    if (!btn) continue;
    const inner = readRecordPath(btn, 'buttonViewModel');
    if (inner?.accessibilityText === 'Dislike' || inner?.iconName === 'DISLIKE') {
      hasDislike = true;
    }
    const toggleBtn = readRecordPath(
      btn,
      'likeButtonViewModel',
      'toggleButtonViewModel',
      'toggleButtonViewModel',
      'defaultButtonViewModel',
      'buttonViewModel'
    );
    if (toggleBtn) {
      likeIndex = i;
      if (typeof toggleBtn.title === 'string' && toggleBtn.title.trim()) {
        likeCount = toggleBtn.title.trim();
      }
      const onTap = readRecordPath(toggleBtn, 'onTap', 'innertubeCommand');
      const authTarget = readRecordPath(
        onTap,
        'authDeterminedCommand',
        'authenticatedCommand',
        'likeEndpoint',
        'target'
      );
      const directTarget = readRecordPath(onTap, 'likeEndpoint', 'target');
      const idVal = authTarget?.videoId ?? directTarget?.videoId;
      if (typeof idVal === 'string' && VIDEO_ID_RE.test(idVal)) {
        videoId = idVal;
      }
    }
  }

  let updated = false;
  if (!hasDislike && likeIndex >= 0) {
    buttons.splice(likeIndex + 1, 0, {
      reelActionBarButtonViewModel: {
        buttonViewModel: {
          buttonViewModel: {
            iconName: 'DISLIKE',
            accessibilityText: 'Dislike',
            style: 'BUTTON_VIEW_MODEL_STYLE_UNKNOWN',
            type: 'BUTTON_VIEW_MODEL_TYPE_UNKNOWN',
          },
        },
        shouldHideInLandscape: false,
      },
    });
    updated = true;
  }

  if (videoId) {
    setShortsOverlayStats(videoId, likeCount);
  }
  return updated;
}

/**
 * Appends views & upload time onto the Shorts player header and adds Like/Dislike counts to the Shorts action bar.
 */
export function enrichShortsPlayerOverlay(payload: unknown): boolean {
  if (suppressOverlayEnrichment || !isRecord(payload)) return false;
  const barUpdated = enrichShortsActionBar(payload);

  const hdr = readHeaderRenderer(payload);
  if (!hdr) return barUpdated;
  const metaText = extractShortsMetadataFromReel(payload);
  if (!metaText) return barUpdated;

  const titleObj = isRecord(hdr.reelTitleText) ? hdr.reelTitleText : undefined;
  if (!titleObj) return barUpdated;
  const currentText = readFormattedText(titleObj);
  if (!currentText || currentText.includes(metaText)) return barUpdated;

  const metaRun = { text: `\n${metaText}` };
  if (Array.isArray(titleObj.runs)) {
    titleObj.runs.push(metaRun);
  } else if (typeof titleObj.simpleText === 'string') {
    titleObj.runs = [{ text: titleObj.simpleText }, metaRun];
    delete titleObj.simpleText;
  } else {
    return barUpdated;
  }
  return true;
}

function isShortsTileRenderer(tr: Record<string, unknown>): boolean {
  return (
    tr.style === 'TILE_STYLE_YTLR_SHORTS' ||
    tr.contentType === 'TILE_CONTENT_TYPE_SHORTS' ||
    Boolean(readRecordPath(tr, 'onSelectCommand', 'reelWatchEndpoint'))
  );
}

function extractVideoIdFromUrlList(thumbnails: unknown): string | null {
  if (!Array.isArray(thumbnails)) return null;
  for (const thumb of thumbnails) {
    if (!isRecord(thumb) || typeof thumb.url !== 'string') continue;
    const match = thumb.url.match(THUMB_VIDEO_ID_RE);
    if (match?.[1] && VIDEO_ID_RE.test(match[1])) return match[1];
  }
  return null;
}

function extractShortTileVideoId(tr: Record<string, unknown>): string | null {
  if (typeof tr.contentId === 'string' && VIDEO_ID_RE.test(tr.contentId)) return tr.contentId;
  const endpointVideoId = readRecordPath(tr, 'onSelectCommand', 'reelWatchEndpoint')?.videoId;
  if (typeof endpointVideoId === 'string' && VIDEO_ID_RE.test(endpointVideoId)) return endpointVideoId;
  return extractVideoIdFromUrlList(readRecordPath(tr, 'header', 'tileHeaderRenderer', 'thumbnail')?.thumbnails);
}

function ensureTileMetaLine(
  tileMeta: Record<string, unknown>,
  initialText: string
): Record<string, unknown> | undefined {
  const existingLines = Array.isArray(tileMeta.lines) ? tileMeta.lines : [];
  if (existingLines.length > 0) {
    const firstText = existingLines
      .map((l) => readFormattedText(readRecordPath(l, 'lineRenderer', 'items', '0')))
      .join('');
    if (firstText && firstText !== PLACEHOLDER_TEXT) return undefined;
    const textObj = readRecordPath(existingLines[0], 'lineRenderer', 'items', '0', 'lineItemRenderer', 'text');
    if (textObj) return textObj;
  }
  const textObj: Record<string, unknown> = { simpleText: initialText };
  tileMeta.lines = [{ lineRenderer: { items: [{ lineItemRenderer: { text: textObj } }] } }];
  return textObj;
}

function updateMountedTileDom(videoId: string, label: string): void {
  if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
  for (const thumb of document.querySelectorAll(`ytlr-tile-renderer ytlr-thumbnail-details[style*="/${videoId}/"]`)) {
    const tile = thumb.closest('ytlr-tile-renderer');
    const lineTextEl = tile?.querySelector('ytlr-tile-metadata-renderer ytlr-line yt-formatted-string');
    if (lineTextEl && lineTextEl.textContent !== label) {
      lineTextEl.textContent = label;
    }
  }
}

function yieldBeforeNetworkFetch(): Promise<void> {
  if (typeof requestAnimationFrame === 'function') {
    return new Promise((resolve) => {
      requestAnimationFrame(() => setTimeout(resolve, 0));
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function applyResolvedMetadata(videoId: string, label: string): void {
  const textTargets = pendingTileTextTargets.get(videoId);
  if (textTargets) {
    for (const target of textTargets) {
      target.simpleText = label;
    }
    pendingTileTextTargets.delete(videoId);
  }
  updateMountedTileDom(videoId, label);
}

function abortPendingShortsMetadataRequests(): void {
  activeNavigationController?.abort();
  activeNavigationController = typeof AbortController === 'function' ? new AbortController() : null;
  inFlightShortsMeta.clear();
  pendingTileTextTargets.clear();
}

export function clearShortsMetadataCache(): void {
  shortsMetadataCache.clear();
  abortPendingShortsMetadataRequests();
}

function readYtcfgContext(): {
  context: Record<string, unknown>;
  clientName: string;
  clientVersion: string;
  visitorData?: string;
} | null {
  if (typeof window === 'undefined') return null;
  const ytcfg = (window as unknown as { ytcfg?: { data_?: Record<string, unknown> } }).ytcfg?.data_;
  if (!isRecord(ytcfg) || !isRecord(ytcfg.INNERTUBE_CONTEXT)) return null;
  return {
    context: ytcfg.INNERTUBE_CONTEXT,
    clientName: String(ytcfg.INNERTUBE_CONTEXT_CLIENT_NAME ?? 7),
    clientVersion: String(ytcfg.INNERTUBE_CONTEXT_CLIENT_VERSION ?? '7.20261118.19.00'),
    visitorData: typeof ytcfg.VISITOR_DATA === 'string' ? ytcfg.VISITOR_DATA : undefined,
  };
}

function fetchShortsMetadata(videoId: string, controller: AbortController | null): Promise<string | null> {
  const cached = shortsMetadataCache.get(videoId);
  if (cached !== undefined) return Promise.resolve(cached);

  const pending = inFlightShortsMeta.get(videoId);
  if (pending) return pending;

  const ytcfg = readYtcfgContext();
  if (!ytcfg || typeof fetch !== 'function') return Promise.resolve(null);

  const signal = controller?.signal;
  const request = shortsMetaLimit(async (): Promise<string | null> => {
    if (signal?.aborted) return null;
    const cachedWhileQueued = shortsMetadataCache.get(videoId);
    if (cachedWhileQueued !== undefined) return cachedWhileQueued;

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-YouTube-Client-Name': ytcfg.clientName,
        'X-YouTube-Client-Version': ytcfg.clientVersion,
      };
      if (ytcfg.visitorData) headers['X-Goog-Visitor-Id'] = ytcfg.visitorData;

      const response = await fetch('/youtubei/v1/reel/reel_item_watch?prettyPrint=false', {
        method: 'POST',
        credentials: 'same-origin',
        headers,
        body: JSON.stringify({
          context: ytcfg.context,
          playerRequest: { videoId },
          disablePlayerResponse: true,
        }),
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) return null;
      let json: unknown;
      if (typeof response.text === 'function') {
        const rawText = await response.text();
        suppressOverlayEnrichment = true;
        try {
          json = JSON.parse(rawText);
        } finally {
          suppressOverlayEnrichment = false;
        }
      } else {
        suppressOverlayEnrichment = true;
        try {
          json = await response.json();
        } finally {
          suppressOverlayEnrichment = false;
        }
      }
      const label = extractShortsMetadataFromReel(json);
      if (!label) return null;
      shortsMetadataCache.set(videoId, label);
      return label;
    } catch {
      return null;
    } finally {
      if (inFlightShortsMeta.get(videoId) === request) {
        inFlightShortsMeta.delete(videoId);
      }
    }
  });

  inFlightShortsMeta.set(videoId, request);
  return request;
}

/**
 * Populates views & upload time on `TILE_STYLE_YTLR_SHORTS` cards from cache immediately and
 * prefetches the first visible row in the background without flooding the TV.
 */
export async function applyShortsFeedMetadata(items: FeedItem[]): Promise<void> {
  if (!Array.isArray(items)) return;

  const controller = activeNavigationController;
  const toFetch = new Set<string>();
  const canFetch = Boolean(readYtcfgContext() && typeof fetch === 'function');

  for (const entry of items) {
    const content = unwrapFeedItem(entry);
    if (!content || !isRecord(content.tileRenderer)) continue;
    const tr = content.tileRenderer;
    if (!isShortsTileRenderer(tr)) continue;
    const videoId = extractShortTileVideoId(tr);
    if (!videoId) continue;

    const meta = readRecordPath(tr, 'metadata', 'tileMetadataRenderer');
    if (!meta) continue;

    const cached = shortsMetadataCache.get(videoId);
    if (cached) {
      const target = ensureTileMetaLine(meta, cached);
      if (target) target.simpleText = cached;
      continue;
    }

    if (!canFetch) continue;
    const placeholderTarget = ensureTileMetaLine(meta, PLACEHOLDER_TEXT);
    if (!placeholderTarget) continue;

    let targetSet = pendingTileTextTargets.get(videoId);
    if (!targetSet) {
      targetSet = new Set();
      pendingTileTextTargets.set(videoId, targetSet);
    }
    targetSet.add(placeholderTarget);

    if (toFetch.size < INITIAL_SHELF_PREFETCH_LIMIT) {
      toFetch.add(videoId);
    }
  }

  if (toFetch.size === 0) return;

  // Yield until after the current frame paints so background lookups never delay feed card rendering.
  await yieldBeforeNetworkFetch();
  if (controller?.signal.aborted) return;

  await Promise.all(
    [...toFetch].map((videoId) =>
      fetchShortsMetadata(videoId, controller).then((label) => {
        if (!controller?.signal.aborted && label) {
          applyResolvedMetadata(videoId, label);
        }
      })
    )
  );
}

/**
 * Fetches metadata when scrolling/focusing off-screen Short tiles past the initial viewport batch,
 * and aborts pending Short metadata lookups on route changes.
 */
export function installShortsMetadata(): void {
  if (shortsMetadataInstalled || typeof document === 'undefined' || typeof window === 'undefined') return;
  shortsMetadataInstalled = true;

  window.addEventListener('hashchange', abortPendingShortsMetadataRequests);
  document.addEventListener(
    'focusin',
    (event) => {
      const target = event.target instanceof Element ? event.target.closest('ytlr-tile-renderer') : null;
      if (!target) return;
      const bg = (target.querySelector('ytlr-thumbnail-details') as HTMLElement | null)?.style?.backgroundImage || '';
      const match = bg.match(THUMB_VIDEO_ID_RE);
      const videoId = match?.[1];
      if (!videoId || !VIDEO_ID_RE.test(videoId)) return;

      const cached = shortsMetadataCache.get(videoId);
      if (cached) {
        updateMountedTileDom(videoId, cached);
        return;
      }
      const lineEl = target.querySelector('ytlr-tile-metadata-renderer ytlr-line yt-formatted-string');
      if (!lineEl || (lineEl.textContent && lineEl.textContent.trim() !== '')) return;

      const controller = activeNavigationController;
      void fetchShortsMetadata(videoId, controller).then((label) => {
        if (!controller?.signal.aborted && label) {
          applyResolvedMetadata(videoId, label);
        }
      });
    },
    true
  );
}
