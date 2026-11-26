import pLimit from 'p-limit';
import { NOOP, observeShortsPage } from '../core/lifecycle.ts';
import { adjustOverlayEnrichmentSuppression, extractShortsMetadataFromReel } from '../transforms/shorts-overlay.ts';
import type { FeedItem } from '../types/innertube.ts';
import { createLruCache, unwrapFeedItem } from '../utils/feed-helpers.ts';
import { readFormattedText, VIDEO_ID_RE } from '../utils/innertube-ast.ts';
import { isRecord, readRecordPath } from '../utils/type-guards.ts';

const PLACEHOLDER_TEXT = '\u00A0';
const INITIAL_SHELF_PREFETCH_LIMIT = 6;
const MAX_SHORTS_META_CONCURRENCY = 2;
const THUMB_VIDEO_ID_RE = /\/vi(?:_webp)?\/([A-Za-z0-9_-]{11})\//;
const SHORT_CARD_SELECTOR = 'ytlr-tile-renderer, yt-lockup-view-model, ytm-shorts-lockup-view-model';
const SHORT_META_TEXT_SELECTOR =
  'ytlr-tile-metadata-renderer ytlr-line yt-formatted-string, yt-content-metadata-view-model yt-core-attributed-string, .shortsLockupViewModelHostOutsideMetadataSubhead yt-core-attributed-string';

const shortsMetaLimit = pLimit(MAX_SHORTS_META_CONCURRENCY);
const shortsMetadataCache = createLruCache<string, string>();
const inFlightShortsMeta = new Map<string, Promise<string | null>>();
const pendingTileTextTargets = new Map<string, Set<Record<string, unknown>>>();

let activeNavigationController = new AbortController();
let shortsMetadataInstalled = false;

function isShortsTileRenderer(tr: Record<string, unknown>): boolean {
  return (
    tr.style === 'TILE_STYLE_YTLR_SHORTS' ||
    tr.contentType === 'TILE_CONTENT_TYPE_SHORTS' ||
    Boolean(readRecordPath(tr, 'onSelectCommand', 'reelWatchEndpoint'))
  );
}

function isShortsLockupViewModel(lv: Record<string, unknown>): boolean {
  return (
    lv.contentType === 'LOCKUP_CONTENT_TYPE_SHORT' ||
    lv.contentType === 'LOCKUP_CONTENT_TYPE_SHORTS' ||
    Boolean(readRecordPath(lv, 'rendererContext', 'commandContext', 'onTap', 'innertubeCommand', 'reelWatchEndpoint'))
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

function extractShortLockupVideoId(lv: Record<string, unknown>): string | null {
  if (typeof lv.contentId === 'string' && VIDEO_ID_RE.test(lv.contentId)) return lv.contentId;
  const tapVideoId = readRecordPath(
    lv,
    'rendererContext',
    'commandContext',
    'onTap',
    'innertubeCommand',
    'reelWatchEndpoint'
  )?.videoId;
  if (typeof tapVideoId === 'string' && VIDEO_ID_RE.test(tapVideoId)) return tapVideoId;
  return extractVideoIdFromUrlList(readRecordPath(lv, 'contentImage', 'thumbnailViewModel', 'image')?.sources);
}

function extractShortsLockupViewModelVideoId(slv: Record<string, unknown>): string | null {
  const tapVideoId =
    readRecordPath(slv, 'onTap', 'innertubeCommand', 'reelWatchEndpoint')?.videoId ??
    readRecordPath(slv, 'onTap', 'reelWatchEndpoint')?.videoId;
  if (typeof tapVideoId === 'string' && VIDEO_ID_RE.test(tapVideoId)) return tapVideoId;
  return extractVideoIdFromUrlList(readRecordPath(slv, 'thumbnail')?.sources);
}

function getFirstLineItem(line: unknown): Record<string, unknown> | null {
  const items = readRecordPath(line, 'lineRenderer')?.items;
  return Array.isArray(items) && isRecord(items[0]) ? items[0] : null;
}

function ensureTileMetaLine(
  tileMeta: Record<string, unknown>,
  initialText: string
): Record<string, unknown> | undefined {
  const existingLines = Array.isArray(tileMeta.lines) ? tileMeta.lines : [];
  if (existingLines.length > 0) {
    const firstText = existingLines
      .map((l) => readFormattedText(readRecordPath(getFirstLineItem(l), 'lineItemRenderer', 'text')))
      .join('');
    if (firstText && firstText !== PLACEHOLDER_TEXT) return undefined;
    const textObj = readRecordPath(getFirstLineItem(existingLines[0]), 'lineItemRenderer', 'text');
    if (textObj) return textObj;
  }
  const textObj: Record<string, unknown> = { simpleText: initialText };
  tileMeta.lines = [{ lineRenderer: { items: [{ lineItemRenderer: { text: textObj } }] } }];
  return textObj;
}

function getFirstMetadataPartText(row: unknown): Record<string, unknown> | null {
  const parts = isRecord(row) ? row.metadataParts : undefined;
  return Array.isArray(parts) ? readRecordPath(parts[0], 'text') : null;
}

function ensureRecordChild(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  if (isRecord(parent[key])) return parent[key];
  const created: Record<string, unknown> = {};
  parent[key] = created;
  return created;
}

function ensureLockupMetaLine(
  lockupMeta: Record<string, unknown>,
  initialText: string
): Record<string, unknown> | undefined {
  const outerMeta = ensureRecordChild(lockupMeta, 'metadata');
  const contentMeta = ensureRecordChild(outerMeta, 'contentMetadataViewModel');
  const rows = Array.isArray(contentMeta.metadataRows) ? contentMeta.metadataRows : [];
  if (rows.length > 0) {
    const firstText = rows.map((row) => readFormattedText(getFirstMetadataPartText(row) ?? undefined)).join('');
    if (firstText && firstText !== PLACEHOLDER_TEXT) return undefined;
    const textObj = getFirstMetadataPartText(rows[0]);
    if (textObj) return textObj;
  }
  const textObj: Record<string, unknown> = { content: initialText };
  contentMeta.metadataRows = [{ metadataParts: [{ text: textObj }] }];
  return textObj;
}

function ensureShortsLockupOverlayText(
  overlayMeta: Record<string, unknown>,
  initialText: string
): Record<string, unknown> | undefined {
  const existingText = readFormattedText(overlayMeta.secondaryText as string | undefined);
  if (existingText && existingText !== PLACEHOLDER_TEXT) return undefined;
  if (isRecord(overlayMeta.secondaryText)) return overlayMeta.secondaryText;
  const textObj: Record<string, unknown> = { content: initialText };
  overlayMeta.secondaryText = textObj;
  return textObj;
}

type ShortCardTarget = {
  videoId: string;
  ensureTextTarget: (initialText: string) => Record<string, unknown> | undefined;
};

function resolveShortCardTarget(content: Record<string, unknown>): ShortCardTarget | null {
  if (isRecord(content.tileRenderer)) {
    const tr = content.tileRenderer;
    if (!isShortsTileRenderer(tr)) return null;
    const videoId = extractShortTileVideoId(tr);
    const meta = videoId ? readRecordPath(tr, 'metadata', 'tileMetadataRenderer') : null;
    return videoId && meta ? { videoId, ensureTextTarget: (text) => ensureTileMetaLine(meta, text) } : null;
  }
  if (isRecord(content.lockupViewModel)) {
    const lv = content.lockupViewModel;
    if (!isShortsLockupViewModel(lv)) return null;
    const videoId = extractShortLockupVideoId(lv);
    const meta = videoId ? readRecordPath(lv, 'metadata', 'lockupMetadataViewModel') : null;
    return videoId && meta ? { videoId, ensureTextTarget: (text) => ensureLockupMetaLine(meta, text) } : null;
  }
  if (isRecord(content.shortsLockupViewModel)) {
    const slv = content.shortsLockupViewModel;
    const videoId = extractShortsLockupViewModelVideoId(slv);
    const overlayMeta = videoId ? readRecordPath(slv, 'overlayMetadata') : null;
    return videoId && overlayMeta
      ? { videoId, ensureTextTarget: (text) => ensureShortsLockupOverlayText(overlayMeta, text) }
      : null;
  }
  return null;
}

function setTargetText(target: Record<string, unknown>, value: string): void {
  if ('content' in target) {
    target.content = value;
  } else {
    target.simpleText = value;
  }
}

function updateMountedTileDom(videoId: string, label: string): void {
  if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
  for (const thumb of document.querySelectorAll(
    `ytlr-tile-renderer ytlr-thumbnail-details[style*="/${videoId}/"], yt-lockup-view-model image[style*="/${videoId}/"], ytm-shorts-lockup-view-model image[style*="/${videoId}/"]`
  )) {
    const tile = thumb.closest(SHORT_CARD_SELECTOR);
    const lineTextEl = tile?.querySelector(SHORT_META_TEXT_SELECTOR);
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
      setTargetText(target, label);
    }
    pendingTileTextTargets.delete(videoId);
  }
  updateMountedTileDom(videoId, label);
}

function abortPendingShortsMetadataRequests(): void {
  activeNavigationController.abort();
  activeNavigationController = new AbortController();
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
  const rawYtcfg = (window as unknown as { ytcfg?: { data_?: unknown; d?: () => unknown } }).ytcfg;
  let ytcfg = readRecordPath(rawYtcfg, 'data_');
  if (!ytcfg && typeof rawYtcfg?.d === 'function') {
    try {
      ytcfg = readRecordPath(rawYtcfg.d());
    } catch {
      return null;
    }
  }
  if (!ytcfg || !isRecord(ytcfg.INNERTUBE_CONTEXT)) return null;
  return {
    context: ytcfg.INNERTUBE_CONTEXT,
    clientName: String(ytcfg.INNERTUBE_CONTEXT_CLIENT_NAME ?? 7),
    clientVersion: String(ytcfg.INNERTUBE_CONTEXT_CLIENT_VERSION ?? '7.20261118.19.00'),
    visitorData: typeof ytcfg.VISITOR_DATA === 'string' ? ytcfg.VISITOR_DATA : undefined,
  };
}

function fetchShortsMetadata(videoId: string, controller: AbortController): Promise<string | null> {
  const pending = inFlightShortsMeta.get(videoId);
  if (pending) return pending;

  const ytcfg = readYtcfgContext();
  if (!ytcfg || typeof fetch !== 'function') return Promise.resolve(null);

  const { signal } = controller;
  const request = shortsMetaLimit(async (): Promise<string | null> => {
    if (signal.aborted) return null;

    let label: string | null = null;
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
        signal,
      });
      if (response.ok) {
        let json: unknown;
        if (typeof response.text === 'function') {
          const rawText = await response.text();
          adjustOverlayEnrichmentSuppression(1);
          try {
            json = JSON.parse(rawText);
          } finally {
            adjustOverlayEnrichmentSuppression(-1);
          }
        } else {
          adjustOverlayEnrichmentSuppression(1);
          try {
            json = await response.json();
          } finally {
            adjustOverlayEnrichmentSuppression(-1);
          }
        }
        const resolved = extractShortsMetadataFromReel(json) ?? '';
        shortsMetadataCache.set(videoId, resolved);
        label = resolved;
      }
    } catch {
      // Ignore aborted navigations, network failures, or JSON parse errors.
    }
    if (inFlightShortsMeta.get(videoId) === request) {
      inFlightShortsMeta.delete(videoId);
    }
    return label;
  });

  inFlightShortsMeta.set(videoId, request);
  return request;
}

/**
 * Populates views & upload time on Short shelf cards (`tileRenderer`, `lockupViewModel`, and `shortsLockupViewModel`)
 * from cache immediately and prefetches the first visible row in the background without flooding the TV.
 */
export async function applyShortsFeedMetadata(items: FeedItem[]): Promise<void> {
  if (!Array.isArray(items)) return;

  const controller = activeNavigationController;
  const toFetch = new Set<string>();
  const canFetch = Boolean(readYtcfgContext() && typeof fetch === 'function');

  for (const entry of items) {
    const content = unwrapFeedItem(entry);
    if (!content) continue;
    const cardTarget = resolveShortCardTarget(content as Record<string, unknown>);
    if (!cardTarget) continue;
    const { videoId, ensureTextTarget } = cardTarget;

    const cached = shortsMetadataCache.get(videoId);
    if (cached !== undefined) {
      if (cached) {
        const target = ensureTextTarget(cached);
        if (target) setTargetText(target, cached);
      }
      continue;
    }

    if (!canFetch) continue;
    const placeholderTarget = ensureTextTarget(PLACEHOLDER_TEXT);
    if (!placeholderTarget) continue;

    if (toFetch.size < INITIAL_SHELF_PREFETCH_LIMIT) {
      toFetch.add(videoId);
    }
    if (toFetch.has(videoId)) {
      let targetSet = pendingTileTextTargets.get(videoId);
      if (!targetSet) {
        targetSet = new Set();
        pendingTileTextTargets.set(videoId, targetSet);
      }
      targetSet.add(placeholderTarget);
    }
  }

  if (toFetch.size === 0) return;

  // Yield until after the current frame paints so background lookups never delay feed card rendering.
  await yieldBeforeNetworkFetch();
  if (controller.signal.aborted) return;

  await Promise.all(
    [...toFetch].map((videoId) =>
      fetchShortsMetadata(videoId, controller).then((label) => {
        if (controller.signal.aborted) return;
        if (label !== null) {
          applyResolvedMetadata(videoId, label);
        } else {
          pendingTileTextTargets.delete(videoId);
        }
      })
    )
  );
}

/**
 * Fetches metadata when scrolling/focusing off-screen Short tiles past the initial viewport batch,
 * and aborts pending Short metadata lookups on route changes.
 */
export function installShortsMetadata(): () => void {
  if (shortsMetadataInstalled || typeof document === 'undefined' || typeof window === 'undefined') return NOOP;
  shortsMetadataInstalled = true;

  const targetWindow = window;
  const targetDoc = document;
  const onFocusIn = (event: FocusEvent): void => {
    const target = event.target instanceof Element ? event.target.closest(SHORT_CARD_SELECTOR) : null;
    if (!target) return;
    const thumbEl = target.querySelector('ytlr-thumbnail-details') ?? target.querySelector('image');
    const bg = (thumbEl as HTMLElement | null)?.style?.backgroundImage || '';
    const match = bg.match(THUMB_VIDEO_ID_RE);
    const videoId = match?.[1];
    if (!videoId || !VIDEO_ID_RE.test(videoId)) return;

    const cached = shortsMetadataCache.get(videoId);
    if (cached !== undefined) {
      updateMountedTileDom(videoId, cached);
      return;
    }
    const lineEl = target.querySelector(SHORT_META_TEXT_SELECTOR);
    const rawLine = lineEl?.textContent ?? '';
    const isPlaceholder = rawLine === PLACEHOLDER_TEXT;
    const isEmptyShortsTile = rawLine.trim() === '' && Boolean(target.classList?.contains('ytLrTileRendererShorts'));
    if (!lineEl || (!isPlaceholder && !isEmptyShortsTile)) return;

    const controller = activeNavigationController;
    void fetchShortsMetadata(videoId, controller).then((label) => {
      if (!controller.signal.aborted && label !== null) {
        applyResolvedMetadata(videoId, label);
      }
    });
  };

  targetWindow.addEventListener('hashchange', abortPendingShortsMetadataRequests);
  targetDoc.addEventListener('focusin', onFocusIn, true);
  const unobserveShorts = observeShortsPage((active) => {
    if (active) abortPendingShortsMetadataRequests();
  });

  return () => {
    targetWindow.removeEventListener?.('hashchange', abortPendingShortsMetadataRequests);
    targetDoc.removeEventListener?.('focusin', onFocusIn, true);
    unobserveShorts();
    abortPendingShortsMetadataRequests();
    shortsMetadataInstalled = false;
  };
}
