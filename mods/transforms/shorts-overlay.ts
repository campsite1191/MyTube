import { setShortsOverlayStats } from '../features/return-youtube-dislike.ts';
import { formatCompactCount } from '../utils/feed-helpers.ts';
import { META_SEPARATOR, readFormattedText, VIDEO_ID_RE } from '../utils/innertube-ast.ts';
import { isRecord, readRecordPath } from '../utils/type-guards.ts';

const COMPACT_VIEWS_RE = /^\d+(?:\.\d+)?[KMBT]\s+views?$/i;
const RAW_VIEWS_NUM_RE = /^([\d,]+)\s+views?\b/i;

let suppressOverlayEnrichmentCount = 0;

/**
 * Increments or decrements the re-entrancy guard used when internal Shorts
 * metadata prefetches parse `/youtubei/v1/reel/reel_item_watch` responses.
 */
export function adjustOverlayEnrichmentSuppression(delta: 1 | -1): void {
  suppressOverlayEnrichmentCount += delta;
}

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
      return `${formatCompactCount(count)} views`;
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
    const factoid = readRecordPath(entry, 'factoidRenderer');
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
        delete toggleBtn.title;
      }
      const toggledBtn = readRecordPath(
        btn,
        'likeButtonViewModel',
        'toggleButtonViewModel',
        'toggleButtonViewModel',
        'toggledButtonViewModel',
        'buttonViewModel'
      );
      if (toggledBtn && 'title' in toggledBtn) {
        delete toggledBtn.title;
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
  if (suppressOverlayEnrichmentCount > 0 || !isRecord(payload)) return false;
  const barUpdated = enrichShortsActionBar(payload);

  const hdr = readHeaderRenderer(payload);
  if (!hdr) return barUpdated;
  const metaText = extractShortsMetadataFromReel(payload);
  if (!metaText) return barUpdated;

  const titleObj = readRecordPath(hdr, 'reelTitleText');
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
