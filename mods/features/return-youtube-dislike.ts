import { getActiveWatchVideoId, observeDom, onAbort, onWatchSession } from '../core/lifecycle.ts';
import { onVideo } from '../core/player-observer.ts';
import { injectCss } from '../core/styles.ts';
import { formatCompactCount } from '../utils/feed-helpers.ts';

const LIKE_BUTTON_SELECTOR =
  'ytlr-watch-default ytlr-like-button-renderer, ytlr-watch-default yt-button-container[idomkey="like-button"], ytlr-watch-default [idomkey="like-button"], ytlr-watch-default [idomkey="like"]';
const DISLIKE_BUTTON_SELECTOR =
  'ytlr-watch-default ytlr-dislike-button-renderer, ytlr-watch-default yt-button-container[idomkey="dislike-button"], ytlr-watch-default [idomkey="dislike-button"], ytlr-watch-default [idomkey="dislike"]';
const BUTTON_WRAPPER_SELECTOR =
  'ytlr-like-button-renderer, ytlr-dislike-button-renderer, ytlr-toggle-button-renderer, yt-button-container';
const FOCUSABLE_CHILD_SELECTOR =
  '[hybridnavfocusable]:not([hybridnavfocusable="false"]), [tabindex]:not([tabindex="-1"])';

let currentLike: { videoId: string; count: string } | null = null;
let currentDislike: { videoId: string; count: string } | null = null;
let stylesInstalled = false;
let rydInstalled = false;

const VOTE_TARGET =
  ':is(ytlr-like-button-renderer, ytlr-dislike-button-renderer, [idomkey="like-button"], [idomkey="dislike-button"], [idomkey="like"], [idomkey="dislike"])';

function installVoteLabelStyles(): void {
  if (stylesInstalled || typeof document === 'undefined') return;
  stylesInstalled = true;
  injectCss(`
      ytlr-watch-default ${VOTE_TARGET} {
        pointer-events: none !important;
      }
      ytlr-watch-default ${VOTE_TARGET}:has([data-tt-count]) {
        width: auto !important;
        min-width: fit-content !important;
        max-width: none !important;
        overflow: visible !important;
      }
      ytlr-watch-default ${VOTE_TARGET}[data-tt-count] {
        display: inline-flex !important;
        flex-direction: row !important;
        align-items: center !important;
        width: auto !important;
        min-width: fit-content !important;
        max-width: none !important;
        gap: 0.375rem;
        overflow: visible !important;
      }
      ytlr-watch-default ${VOTE_TARGET}[data-tt-count]::after {
        content: attr(data-tt-count);
        flex-shrink: 0;
        padding-right: 0.25rem;
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

function queryButtonElements(selector: string): HTMLElement[] {
  if (typeof document === 'undefined') return [];
  if (typeof document.querySelectorAll === 'function') {
    const matches = Array.from(document.querySelectorAll<HTMLElement>(selector));
    if (matches.length > 0) return matches;
  }
  const single = document.querySelector?.<HTMLElement>(selector);
  return single ? [single] : [];
}

function disableFocus(node: HTMLElement): void {
  if (!node.inert) node.inert = true;
  if (node.getAttribute?.('hybridnavfocusable') !== 'false') {
    node.setAttribute?.('hybridnavfocusable', 'false');
  }
  if (node.getAttribute?.('tabindex') !== '-1') {
    node.setAttribute?.('tabindex', '-1');
  }
  for (const child of node.querySelectorAll?.(FOCUSABLE_CHILD_SELECTOR) ?? []) {
    if (child.hasAttribute?.('hybridnavfocusable') && child.getAttribute('hybridnavfocusable') !== 'false') {
      child.setAttribute('hybridnavfocusable', 'false');
    }
    if (child.hasAttribute?.('tabindex') && child.getAttribute('tabindex') !== '-1') {
      child.setAttribute('tabindex', '-1');
    }
  }
}

function applyButtonLabel(selector: string, count: string | null): void {
  const matches = queryButtonElements(selector);
  for (const el of matches) {
    // Treat like/dislike strictly as display-only count labels so D-pad skips them cleanly without tooltip overlap.
    disableFocus(el);
    const wrapper = el.closest?.<HTMLElement>(BUTTON_WRAPPER_SELECTOR);
    if (wrapper && wrapper !== el) disableFocus(wrapper);

    const hasInnerMatch = matches.some((other) => other !== el && el.contains?.(other));
    if (!hasInnerMatch && count) {
      if (el.dataset.ttCount !== count) el.dataset.ttCount = count;
    } else if ('ttCount' in el.dataset) {
      delete el.dataset.ttCount;
    }
  }
}

function findObserverTarget(
  likeEls: HTMLElement[],
  dislikeEls: HTMLElement[],
  watchHost: Element | null
): Element | null {
  const firstLike = likeEls[0];
  const firstDislike = dislikeEls[0];
  if (firstLike && firstDislike) {
    let ancestor: Element | null = firstLike.parentElement;
    while (ancestor) {
      const sharesAncestor =
        typeof ancestor.contains === 'function'
          ? ancestor.contains(firstDislike)
          : ancestor === firstDislike.parentElement;
      if (sharesAncestor) return ancestor;
      if (ancestor === watchHost) break;
      ancestor = ancestor.parentElement;
    }
  }
  return (
    document.querySelector?.('ytlr-watch-default ytlr-transport-controls-renderer') ??
    watchHost ??
    document.body ??
    document.documentElement
  );
}

/**
 * Records the live formatted like count from YouTube's InnerTube `/next` response.
 */
export function setWatchLikeCount(videoId: string | null, count: string | null): void {
  if (!videoId || !count) return;
  const compact = count.replace(/\s+/g, '');
  if (!compact) return;
  currentLike = { videoId, count: compact };
  if (videoId === getActiveWatchVideoId() && typeof document !== 'undefined') {
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
      onAbort(signal, () => {
        hostAbort?.abort();
        hostAbort = null;
      });

      const syncTargetObserverAndLabels = (): void => {
        applyForSession();
        if (signal.aborted) return;
        const watchHost = document.querySelector('ytlr-watch-default');
        const desiredTarget = findObserverTarget(
          queryButtonElements(LIKE_BUTTON_SELECTOR),
          queryButtonElements(DISLIKE_BUTTON_SELECTOR),
          watchHost
        );
        if (!desiredTarget || (desiredTarget === observedTarget && observedTarget.isConnected !== false)) return;

        hostAbort?.abort();
        observedTarget = desiredTarget;
        hostAbort = new AbortController();
        observeDom(
          desiredTarget,
          syncTargetObserverAndLabels,
          {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['hybridnavfocusable', 'tabindex', 'inert'],
          },
          hostAbort.signal
        );
      };

      syncTargetObserverAndLabels();
    });
  });
}
