import { getActiveWatchVideoId, observeDom, onAbort, onWatchSession } from '../core/lifecycle.ts';
import { onVideo } from '../core/player-observer.ts';
import { injectCss } from '../core/styles.ts';
import { formatCompactCount } from '../utils/feed-helpers.ts';

const LIKE_BUTTON_SELECTOR =
  'ytlr-watch-default yt-button-container[idomkey="like-button"], ytlr-watch-default [idomkey="like-button"]';
const DISLIKE_BUTTON_SELECTOR =
  'ytlr-watch-default yt-button-container[idomkey="dislike-button"], ytlr-watch-default [idomkey="dislike-button"]';

let currentLike: { videoId: string; count: string } | null = null;
let currentDislike: { videoId: string; count: string } | null = null;
let stylesInstalled = false;
let rydInstalled = false;

function installVoteLabelStyles(): void {
  if (stylesInstalled || typeof document === 'undefined') return;
  stylesInstalled = true;
  injectCss(`
      ytlr-watch-default :is([idomkey="like-button"], [idomkey="dislike-button"]) {
        pointer-events: none !important;
      }
      ytlr-watch-default :is([idomkey="like-button"], [idomkey="dislike-button"])[data-tt-count] {
        position: relative !important;
        overflow: visible !important;
      }
      ytlr-watch-default :is([idomkey="like-button"], [idomkey="dislike-button"])[data-tt-count]::after {
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
    `);
}

function applyButtonLabel(selector: string, count: string | null): void {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) return;

  // Treat like/dislike strictly as display-only count labels so D-pad skips them cleanly without tooltip overlap.
  el.inert = true;
  if (el.getAttribute?.('hybridnavfocusable') !== 'false') {
    el.setAttribute?.('hybridnavfocusable', 'false');
  }
  if (el.getAttribute?.('tabindex') !== '-1') {
    el.setAttribute?.('tabindex', '-1');
  }
  for (const child of el.querySelectorAll?.('[hybridnavfocusable]:not([hybridnavfocusable="false"])') ?? []) {
    child.setAttribute?.('hybridnavfocusable', 'false');
  }

  if (count) {
    if (el.dataset.ttCount !== count) el.dataset.ttCount = count;
  } else if ('ttCount' in el.dataset) {
    delete el.dataset.ttCount;
  }
}

/**
 * Records the live formatted like count from YouTube's InnerTube `/next` response.
 */
export function setWatchLikeCount(videoId: string | null, count: string | null): void {
  if (!videoId || !count) return;
  const compact = count.replace(/\s+/g, '');
  if (!compact) return;
  currentLike = { videoId, count: compact };
  if (videoId === getActiveWatchVideoId()) {
    applyButtonLabel(LIKE_BUTTON_SELECTOR, compact);
  }
}

export async function fetchDislikeCount(videoId: string, signal?: AbortSignal): Promise<string | null> {
  if (!videoId || signal?.aborted || typeof fetch !== 'function') return null;
  try {
    const resp = await fetch(`https://returnyoutubedislikeapi.com/Votes?videoId=${encodeURIComponent(videoId)}`, {
      signal,
    });
    if (!resp.ok || signal?.aborted) return null;
    const data = (await resp.json()) as { dislikes?: unknown } | null;
    return typeof data?.dislikes === 'number' ? formatCompactCount(data.dislikes) : null;
  } catch {
    return null;
  }
}

/**
 * Displays live YouTube like counts from `/next` alongside uncached RYD dislike counts as non-interactive labels.
 */
export function installReturnYouTubeDislike(): void {
  if (rydInstalled || typeof window === 'undefined' || typeof document === 'undefined') return;
  rydInstalled = true;
  installVoteLabelStyles();

  onWatchSession((videoId, signal) => {
    if (currentLike?.videoId !== videoId) currentLike = null;
    if (currentDislike?.videoId !== videoId) currentDislike = null;

    onAbort(signal, () => {
      if (currentLike?.videoId === videoId) currentLike = null;
      if (currentDislike?.videoId === videoId) currentDislike = null;
    });

    const applyForSession = (): void => {
      if (signal.aborted) return;
      applyButtonLabel(LIKE_BUTTON_SELECTOR, currentLike?.videoId === videoId ? currentLike.count : null);
      applyButtonLabel(DISLIKE_BUTTON_SELECTOR, currentDislike?.videoId === videoId ? currentDislike.count : null);
    };

    void fetchDislikeCount(videoId, signal).then((dislikes) => {
      if (!dislikes || signal.aborted) return;
      currentDislike = { videoId, count: dislikes };
      applyForSession();
    });

    onVideo(() => {
      if (signal.aborted) return;

      let observedTarget: Element | null = null;
      let hostAbort: AbortController | null = null;
      onAbort(signal, () => hostAbort?.abort());

      const syncTargetObserverAndLabels = (): void => {
        applyForSession();
        if (signal.aborted) return;
        const likeEl = document.querySelector<HTMLElement>(LIKE_BUTTON_SELECTOR);
        const dislikeEl = document.querySelector<HTMLElement>(DISLIKE_BUTTON_SELECTOR);
        const watchHost = document.querySelector('ytlr-watch-default');
        // Narrow observation from the full watch root to the action-button strip once controls mount.
        const desiredTarget = likeEl?.parentElement ?? dislikeEl?.parentElement ?? watchHost;
        if (!desiredTarget || desiredTarget === observedTarget) return;

        hostAbort?.abort();
        observedTarget = desiredTarget;
        hostAbort = new AbortController();
        observeDom(
          desiredTarget,
          syncTargetObserverAndLabels,
          { childList: true, subtree: true, attributes: true, attributeFilter: ['hybridnavfocusable'] },
          hostAbort.signal
        );
      };

      syncTargetObserverAndLabels();
    });
  });
}
