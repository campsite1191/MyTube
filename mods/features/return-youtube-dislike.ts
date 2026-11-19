import { readFormattedText } from '../transforms/feed-filter.ts';
import type { FormattedText, PlayerResponse } from '../types/innertube.ts';
import { formatCompactCount } from '../utils/feed-helpers.ts';

interface RydCacheEntry {
  likes: number | null;
  dislikes: number;
}

interface ActionButtonLikeRenderer {
  likeCountText?: FormattedText | string;
  likeCountWithLikeText?: FormattedText | string;
  likeCountWithUnlikeText?: FormattedText | string;
  defaultText?: { simpleText: string };
  toggledText?: { simpleText: string };
  text?: { simpleText: string };
  tooltip?: string;
  defaultIcon?: { iconType?: string };
  icon?: { iconType?: string };
}

export interface TransportActionItem {
  type?: string;
  button?: {
    likeButtonRenderer?: ActionButtonLikeRenderer;
    dislikeButtonRenderer?: ActionButtonLikeRenderer;
    toggleButtonRenderer?: ActionButtonLikeRenderer;
    buttonRenderer?: ActionButtonLikeRenderer;
  };
}

const rydCache = new Map<string, RydCacheEntry>();
const inFlight = new Set<string>();
const likeCache = new Map<string, string>();
let stylesInstalled = false;

export function getActiveVideoId(): string | null {
  if (typeof location === 'undefined') return null;
  const m = (location.hash || '').match(/[?&]v=([^&]+)/);
  return m?.[1] ?? null;
}

function setBoundedCache<V>(cache: Map<string, V>, key: string, value: V, maxSize = 200): void {
  if (cache.size >= maxSize) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(key, value);
}

export function prefetchRyd(videoId: string): void {
  if (!videoId || rydCache.has(videoId) || inFlight.has(videoId) || typeof fetch !== 'function') return;
  inFlight.add(videoId);
  fetch(`https://returnyoutubedislikeapi.com/Votes?videoId=${encodeURIComponent(videoId)}`)
    .then((res) => (res.ok ? res.json() : null))
    .then((data: unknown) => {
      if (!data || typeof data !== 'object') return;
      const record = data as { likes?: unknown; dislikes?: unknown };
      if (typeof record.dislikes !== 'number') return;
      const entry: RydCacheEntry = {
        likes: typeof record.likes === 'number' ? record.likes : null,
        dislikes: record.dislikes,
      };
      setBoundedCache(rydCache, videoId, entry);
      if (videoId === getActiveVideoId()) {
        scheduleBadgeSync();
      }
    })
    .catch(() => {})
    .finally(() => {
      inFlight.delete(videoId);
    });
}

function isLikeAction(item: unknown): item is TransportActionItem {
  if (!item || typeof item !== 'object') return false;
  const action = item as TransportActionItem;
  if (/(?:^|_)LIKE(?:_|$)/i.test(String(action.type || ''))) return true;
  const btn = action.button;
  if (!btn) return false;
  if (btn.likeButtonRenderer) return true;
  const icon = btn.toggleButtonRenderer?.defaultIcon?.iconType || btn.buttonRenderer?.icon?.iconType || '';
  return /(?:^|_)LIKE(?:_|$)/i.test(String(icon));
}

function isDislikeAction(item: unknown): item is TransportActionItem {
  if (!item || typeof item !== 'object') return false;
  const action = item as TransportActionItem;
  if (/DISLIKE/i.test(String(action.type || ''))) return true;
  const btn = action.button;
  if (!btn) return false;
  if (btn.dislikeButtonRenderer) return true;
  const icon = btn.toggleButtonRenderer?.defaultIcon?.iconType || btn.buttonRenderer?.icon?.iconType || '';
  return /DISLIKE/i.test(String(icon));
}

function syncCountBadges(): void {
  if (typeof document === 'undefined') return;
  const activeId = getActiveVideoId();
  if (!activeId) return;
  const entry = rydCache.get(activeId);
  const likeCount = likeCache.get(activeId) || (entry && entry.likes !== null ? formatCompactCount(entry.likes) : '');
  const dislikeCount = entry ? formatCompactCount(entry.dislikes) : '';

  const likeEl = document.querySelector<HTMLElement>('ytlr-watch-default yt-button-container[idomkey="like-button"]');
  if (likeEl) {
    if (likeCount) {
      if (likeEl.dataset.ttCount !== likeCount) likeEl.dataset.ttCount = likeCount;
    } else if ('ttCount' in likeEl.dataset) {
      delete likeEl.dataset.ttCount;
    }
  }

  const dislikeEl = document.querySelector<HTMLElement>('ytlr-watch-default yt-button-container[idomkey="dislike-button"]');
  if (dislikeEl) {
    if (dislikeCount) {
      if (dislikeEl.dataset.ttCount !== dislikeCount) dislikeEl.dataset.ttCount = dislikeCount;
    } else if ('ttCount' in dislikeEl.dataset) {
      delete dislikeEl.dataset.ttCount;
    }
  }
}

function scheduleBadgeSync(): void {
  if (typeof document === 'undefined') return;
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(syncCountBadges);
  else setTimeout(syncCountBadges, 0);
}

function installCountBadgeStyles(): void {
  if (stylesInstalled || typeof document === 'undefined') return;
  stylesInstalled = true;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
      ytlr-watch-default yt-button-container[data-tt-count] {
        position: relative !important;
        overflow: visible !important;
      }
      ytlr-watch-default yt-button-container[data-tt-count]::after {
        content: attr(data-tt-count);
        position: absolute;
        top: 100%;
        left: 50%;
        transform: translateX(-50%);
        margin-top: 0.5rem;
        font-family: inherit;
        font-size: 1rem;
        font-weight: 500;
        font-variant-numeric: tabular-nums;
        line-height: 1.375;
        letter-spacing: normal;
        color: #f1f1f1;
        white-space: nowrap;
        pointer-events: none;
      }
      ytlr-watch-default yt-button-container[data-tt-count]:focus::after,
      ytlr-watch-default yt-button-container[data-tt-count].zylon-focus::after {
        display: none;
      }
    `);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  } catch {
    // Ignore environments without constructable stylesheets.
  }
}

function setActionLabel(item: TransportActionItem, label: string): void {
  const btn =
    item.button?.likeButtonRenderer ||
    item.button?.dislikeButtonRenderer ||
    item.button?.toggleButtonRenderer ||
    item.button?.buttonRenderer;
  if (!btn || !label) return;
  const compact = label.replace(/\s+/g, '');
  const textObj = { simpleText: compact };
  btn.defaultText = textObj;
  btn.toggledText = textObj;
  btn.text = textObj;
  btn.tooltip = compact;
}

/**
 * Applies cached like and dislike counts onto player transport action buttons.
 */
export function applyDislikeCountToActions<T>(actions: T[], videoId: string | null = getActiveVideoId()): T[] {
  if (!videoId || !Array.isArray(actions)) return actions;
  installCountBadgeStyles();
  prefetchRyd(videoId);
  const entry = rydCache.get(videoId);
  const dislikeLabel = entry ? formatCompactCount(entry.dislikes) : '';
  let likeLabel = '';

  for (const item of actions) {
    if (isLikeAction(item)) {
      const lr = item.button?.likeButtonRenderer;
      likeLabel =
        readFormattedText((lr?.likeCountText || lr?.likeCountWithLikeText || lr?.likeCountWithUnlikeText) as FormattedText | string | undefined) ||
        (entry && entry.likes !== null ? formatCompactCount(entry.likes) : '');
      if (likeLabel) setActionLabel(item, likeLabel);
    } else if (dislikeLabel && isDislikeAction(item)) {
      setActionLabel(item, dislikeLabel);
    }
  }

  if (likeLabel) {
    setBoundedCache(likeCache, videoId, likeLabel.replace(/\s+/g, ''));
  }
  if (videoId === getActiveVideoId()) {
    scheduleBadgeSync();
  }
  return actions;
}

/**
 * Extracts video IDs and transport controls from InnerTube responses to populate RYD counts.
 */
export function processRydResponse(r: PlayerResponse | Record<string, unknown> | null | undefined): void {
  if (!r || typeof r !== 'object') return;
  const obj = r as Record<string, unknown>;
  const transportControls = obj.transportControls as { transportControlsRenderer?: Record<string, unknown> } | undefined;
  const tc = transportControls?.transportControlsRenderer;
  const videoDetails = obj.videoDetails as { videoId?: string } | undefined;
  const playerResponse = obj.playerResponse as { videoDetails?: { videoId?: string } } | undefined;
  const currentVideoEndpoint = obj.currentVideoEndpoint as { watchEndpoint?: { videoId?: string } } | undefined;

  const parsedId =
    videoDetails?.videoId ||
    playerResponse?.videoDetails?.videoId ||
    currentVideoEndpoint?.watchEndpoint?.videoId;

  if (!parsedId && !tc) return;
  const videoId = parsedId || getActiveVideoId();
  if (!videoId) return;
  prefetchRyd(videoId);
  if (!tc) return;

  for (const key of ['promotedActions', 'actions', 'buttons', 'engagementActions'] as const) {
    const list = tc[key];
    if (Array.isArray(list)) applyDislikeCountToActions(list, videoId);
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', scheduleBadgeSync, false);
}
