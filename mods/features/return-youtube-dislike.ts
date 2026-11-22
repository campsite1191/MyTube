import { getActiveWatchVideoId, observeDom, onAbort, onWatchSession } from '../core/lifecycle.ts';
import { onVideo } from '../core/player-observer.ts';
import { injectCss } from '../core/styles.ts';
import { formatCompactCount } from '../utils/feed-helpers.ts';

const LIKE_BUTTON_SELECTOR =
  'ytlr-watch-default yt-button-container[idomkey="like-button"], ytlr-watch-default [idomkey="like-button"]';
const DISLIKE_BUTTON_SELECTOR =
  'ytlr-watch-default yt-button-container[idomkey="dislike-button"], ytlr-watch-default [idomkey="dislike-button"]';
const VOTE_CONTAINER_SELECTOR =
  'ytlr-watch-default ytlr-like-button-renderer, ytlr-watch-default [idomkey="like-dislike-container"]';
const FOCUSABLE_CHILD_SELECTOR =
  '[hybridnavfocusable]:not([hybridnavfocusable="false"]), [tabindex]:not([tabindex="-1"])';
const TRANSPORT_CONTROLS_DOM_SELECTOR =
  'ytlr-watch-default [idomkey="transport-controls"], ytlr-watch-default ytlr-player-actions-container';

let currentLike: { videoId: string; count: string } | null = null;
let currentDislike: { videoId: string; count: string } | null = null;
let currentShorts: { videoId: string; likeCount: string | null; dislikeCount: string | null } | null = null;
let activeShortsAbort: AbortController | null = null;
let stylesInstalled = false;
let rydInstalled = false;
const patchedTransportInstances = new WeakSet<object>();

const VOTE_TARGET =
  ':is(ytlr-like-button-renderer, [idomkey="like-dislike-container"], [idomkey="like-button"], [idomkey="dislike-button"])';
const SHORTS_LIKE_SELECTOR =
  'ytlr-reel-action-bar-view-model ytlr-reel-action-bar-button-view-model:has(ytlr-toggle-button-view-model)';
const SHORTS_DISLIKE_SELECTOR =
  'ytlr-reel-action-bar-view-model ytlr-reel-action-bar-button-view-model:has(yt-button-container[aria-label="Dislike"])';
const SHORTS_COUNT_TARGET = 'ytlr-reel-action-bar-button-view-model[data-tt-count]';

function installVoteLabelStyles(): void {
  if (stylesInstalled || typeof document === 'undefined') return;
  stylesInstalled = true;
  injectCss(`
      ytlr-watch-default ${VOTE_TARGET} {
        pointer-events: none !important;
      }
      ytlr-watch-default ${VOTE_TARGET}:has([data-tt-count]),
      ${SHORTS_COUNT_TARGET},
      ${SHORTS_COUNT_TARGET} :is(yt-icon-button, yt-button-container) {
        width: auto !important;
        min-width: fit-content !important;
        max-width: none !important;
        overflow: visible !important;
      }
      ytlr-watch-default ${VOTE_TARGET}[data-tt-count],
      ${SHORTS_COUNT_TARGET} {
        display: inline-flex !important;
        flex-direction: row !important;
        align-items: center !important;
        width: auto !important;
        min-width: fit-content !important;
        max-width: none !important;
        gap: 0.375rem;
        overflow: visible !important;
      }
      ${SHORTS_COUNT_TARGET} {
        margin-right: 0.75rem !important;
      }
      ytlr-watch-default ${VOTE_TARGET}[data-tt-count]::after,
      ${SHORTS_COUNT_TARGET}::after {
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
      ytlr-watch-default :is(ytlr-redux-connect-ytlr-like-button-renderer, div > ytlr-like-button-renderer):last-child [idomkey="dislike-button"][data-tt-count]::after {
        padding-right: 1rem;
      }
    `);
}

function queryElements(selector: string): HTMLElement[] {
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

function collectInstanceMethodKeys(inst: Record<string, unknown>): string[] {
  const keys = new Set<string>(Object.getOwnPropertyNames(inst));
  let proto: unknown = Object.getPrototypeOf(inst);
  while (proto && typeof proto === 'object' && proto !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key !== 'constructor') keys.add(key);
    }
    proto = Object.getPrototypeOf(proto);
  }
  return [...keys];
}

function patchTransportFocusSkip(): void {
  if (typeof document === 'undefined') return;
  const tcEl = document.querySelector?.(TRANSPORT_CONTROLS_DOM_SELECTOR) as
    | (Element & { __instance?: Record<string, unknown> })
    | null;
  const inst = tcEl?.__instance;
  if (!inst || patchedTransportInstances.has(inst)) return;
  patchedTransportInstances.add(inst);

  let predicateKey: string | null = null;
  for (const key of collectInstanceMethodKeys(inst)) {
    const fn = inst[key];
    if (typeof fn !== 'function') continue;
    const src = Function.prototype.toString.call(fn);
    if (/\.length[\s\S]*\+\s*3\b/.test(src)) {
      predicateKey = key;
      break;
    }
    if (!predicateKey && src.includes('this.buttons')) {
      const match = src.match(/if\s*\(\s*this\.(\w+)\s*\(\s*\w+\s*\)/);
      if (match?.[1] && typeof inst[match[1]] === 'function') {
        predicateKey = match[1];
      }
    }
  }
  if (!predicateKey) return;

  const origPredicate = inst[predicateKey] as (...args: unknown[]) => boolean;
  inst[predicateKey] = function (this: { buttons?: ArrayLike<HTMLElement> }, ...args: unknown[]): boolean {
    const idx = typeof args[0] === 'number' ? args[0] : Number.NaN;
    const btn = Number.isInteger(idx) ? this.buttons?.[idx] : undefined;
    if (btn && (btn.inert || btn.getAttribute?.('hybridnavfocusable') === 'false')) {
      return false;
    }
    return origPredicate.apply(this, args);
  };
}

function applyButtonLabels(selector: string, count: string | null, lockFocus = true): HTMLElement[] {
  const matches = queryElements(selector);
  for (const el of matches) {
    if (lockFocus) {
      // Treat Watch like/dislike strictly as display-only count labels so D-pad skips them cleanly without tooltip overlap.
      disableFocus(el);
    }

    const hasInnerMatch = matches.some((other) => other !== el && el.contains?.(other));
    if (!hasInnerMatch && count) {
      if (el.dataset.ttCount !== count) el.dataset.ttCount = count;
    } else if ('ttCount' in el.dataset) {
      delete el.dataset.ttCount;
    }
  }
  return matches;
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
    document.querySelector?.(TRANSPORT_CONTROLS_DOM_SELECTOR) ?? watchHost ?? document.body ?? document.documentElement
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
    for (const container of queryElements(VOTE_CONTAINER_SELECTOR)) disableFocus(container);
    applyButtonLabels(LIKE_BUTTON_SELECTOR, compact);
    patchTransportFocusSkip();
  }
}

function clearShortsOverlayState(): void {
  activeShortsAbort?.abort();
  activeShortsAbort = null;
  currentShorts = null;
}

function applyShortsOverlayLabels(): void {
  if (!currentShorts || typeof document === 'undefined') return;
  applyButtonLabels(SHORTS_LIKE_SELECTOR, currentShorts.likeCount, false);
  applyButtonLabels(SHORTS_DISLIKE_SELECTOR, currentShorts.dislikeCount, true);
}

/**
 * Displays like counts from `reel_item_watch` and RYD dislike counts on the Shorts action bar.
 */
export function setShortsOverlayStats(videoId: string | null, likeCount: string | null): void {
  if (!videoId) return;
  const compactLikes = typeof likeCount === 'string' && likeCount.trim() ? likeCount.replace(/\s+/g, '') : null;

  if (currentShorts?.videoId === videoId) {
    if (compactLikes) currentShorts.likeCount = compactLikes;
    applyShortsOverlayLabels();
    return;
  }

  activeShortsAbort?.abort();
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  activeShortsAbort = controller;
  currentShorts = { videoId, likeCount: compactLikes, dislikeCount: null };

  if (typeof document === 'undefined') return;
  installVoteLabelStyles();

  const sync = (): void => {
    if (!controller?.signal.aborted && currentShorts?.videoId === videoId) {
      applyShortsOverlayLabels();
    }
  };

  const attachOverlayObserver = (): void => {
    if (controller?.signal.aborted || currentShorts?.videoId !== videoId) return;
    sync();
    const overlayTarget = document.querySelector?.('ytlr-reel-player-overlay-renderer');
    if (overlayTarget) {
      observeDom(overlayTarget, sync, { childList: true, subtree: true }, controller?.signal);
      return;
    }
    const root = document.body ?? document.documentElement;
    if (!root) return;
    const waitAbort = typeof AbortController === 'function' ? new AbortController() : null;
    if (controller && waitAbort) {
      onAbort(controller.signal, () => waitAbort.abort());
    }
    observeDom(
      root,
      () => {
        if (controller?.signal.aborted || currentShorts?.videoId !== videoId) {
          waitAbort?.abort();
          return;
        }
        const mounted = document.querySelector?.('ytlr-reel-player-overlay-renderer');
        if (mounted) {
          waitAbort?.abort();
          sync();
          observeDom(mounted, sync, { childList: true, subtree: true }, controller?.signal);
        }
      },
      { childList: true, subtree: true },
      waitAbort?.signal ?? controller?.signal
    );
  };

  const scheduleFrame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb: () => void) => cb();
  scheduleFrame(attachOverlayObserver);

  void fetchDislikeCount(videoId, controller?.signal).then((dislikes) => {
    if (!dislikes || controller?.signal.aborted || currentShorts?.videoId !== videoId) return;
    currentShorts.dislikeCount = dislikes;
    sync();
  });
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
export function installReturnYouTubeDislike(): () => void {
  if (rydInstalled || typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  rydInstalled = true;
  installVoteLabelStyles();

  const targetWindow = window;
  const onHashChange = (): void => {
    if (!targetWindow.location.hash.includes('shorts')) {
      clearShortsOverlayState();
    }
  };
  targetWindow.addEventListener('hashchange', onHashChange);

  const unsub = onWatchSession((videoId, signal) => {
    clearShortsOverlayState();
    if (currentLike?.videoId !== videoId) currentLike = null;
    if (currentDislike?.videoId !== videoId) currentDislike = null;

    onAbort(signal, () => {
      if (currentLike?.videoId === videoId) currentLike = null;
      if (currentDislike?.videoId === videoId) currentDislike = null;
    });

    const applyForSession = (): { likeEls: HTMLElement[]; dislikeEls: HTMLElement[] } => {
      if (signal.aborted) return { likeEls: [], dislikeEls: [] };
      for (const container of queryElements(VOTE_CONTAINER_SELECTOR)) disableFocus(container);
      const likeEls = applyButtonLabels(
        LIKE_BUTTON_SELECTOR,
        currentLike?.videoId === videoId ? currentLike.count : null
      );
      const dislikeEls = applyButtonLabels(
        DISLIKE_BUTTON_SELECTOR,
        currentDislike?.videoId === videoId ? currentDislike.count : null
      );
      patchTransportFocusSkip();
      return { likeEls, dislikeEls };
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
        const { likeEls, dislikeEls } = applyForSession();
        if (signal.aborted) return;
        const watchHost = document.querySelector?.('ytlr-watch-default') ?? null;
        const desiredTarget = findObserverTarget(likeEls, dislikeEls, watchHost);
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
    }, signal);
  });

  return () => {
    targetWindow.removeEventListener?.('hashchange', onHashChange);
    unsub();
    clearShortsOverlayState();
    currentLike = null;
    currentDislike = null;
    rydInstalled = false;
  };
}
