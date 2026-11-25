import {
  getActiveWatchVideoId,
  NOOP,
  observeDom,
  observeShortsPage,
  onAbort,
  onWatchSession,
} from '../core/lifecycle.ts';
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
const VOTE_COUNT_RE = /^(\d[\d,]*(?:\.\d+)?)\s*([KMBT])?$/i;

/**
 * Normalizes a formatted or raw vote count string (e.g. `"12.5 K"`, `"1,250"`) into a compact
 * display label (`"12.5K"`, `"1.3K"`), returning `null` for zero or non-numeric labels (e.g. `"Like"`).
 */
export function normalizeVoteCount(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const match = raw.trim().match(VOTE_COUNT_RE) as [string, string, string | undefined] | null;
  if (!match) return null;
  const digits = match[1].replace(/,/g, '');
  const suffix = match[2];
  if (suffix) {
    return `${digits}${suffix.toUpperCase()}`;
  }
  const numericValue = Number(digits);
  return numericValue > 0 ? formatCompactCount(numericValue) : null;
}

function installVoteLabelStyles(): void {
  if (stylesInstalled || typeof document === 'undefined') return;
  stylesInstalled = true;
  injectCss(`
      ytlr-watch-default ${VOTE_TARGET} {
        pointer-events: none !important;
      }
      ytlr-watch-default ${VOTE_TARGET}:has([data-tt-count]),
      ytlr-watch-default ${VOTE_TARGET}[data-tt-count],
      ${SHORTS_COUNT_TARGET} {
        width: auto !important;
        min-width: fit-content !important;
        max-width: none !important;
        vertical-align: top !important;
        overflow: visible !important;
      }
      ytlr-watch-default ${VOTE_TARGET}[data-tt-count],
      ${SHORTS_COUNT_TARGET} {
        display: inline-flex !important;
        flex-direction: row !important;
        align-items: center !important;
        gap: 0;
        vertical-align: top !important;
      }
      ${SHORTS_COUNT_TARGET} {
        gap: 0.375rem;
        margin-right: 0.75rem !important;
      }
      ${SHORTS_COUNT_TARGET} yt-formatted-string {
        display: none !important;
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
      ytlr-watch-default [idomkey="like-button"][data-tt-count]::after {
        padding-right: 0.75rem;
      }
      ytlr-watch-default [idomkey="dislike-button"][data-tt-count]::after {
        padding-right: 1rem;
      }
    `);
}

function queryElements(selector: string): HTMLElement[] {
  if (typeof document.querySelectorAll === 'function') {
    const matches = Array.from(document.querySelectorAll<HTMLElement>(selector));
    if (matches.length > 0) return matches;
  }
  const single = document.querySelector<HTMLElement>(selector);
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
  const tcEl = document.querySelector(TRANSPORT_CONTROLS_DOM_SELECTOR) as
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
    document.querySelector(TRANSPORT_CONTROLS_DOM_SELECTOR) ?? watchHost ?? document.body ?? document.documentElement
  );
}

/**
 * Records the live formatted like count from YouTube's InnerTube `/next` response.
 */
export function setWatchLikeCount(videoId: string | null, count: string | null): void {
  const compact = normalizeVoteCount(count);
  if (!videoId || !compact) return;
  currentLike = { videoId, count: compact };
  if (videoId === getActiveWatchVideoId() && typeof document !== 'undefined') {
    for (const container of queryElements(VOTE_CONTAINER_SELECTOR)) disableFocus(container);
    applyButtonLabels(LIKE_BUTTON_SELECTOR, compact);
    patchTransportFocusSkip();
  }
}

function patchShortsActionBarFocusSkip(): void {
  const barEl = document.querySelector('ytlr-reel-action-bar-view-model') as
    | (Element & { __instance?: Record<string, unknown> })
    | null;
  if (!barEl) return;
  const barInst = barEl.__instance;
  const fcEl = barEl.querySelector?.('yt-focus-container') as
    | (Element & { __instance?: { props?: Record<string, unknown> } })
    | null;
  const fcProps = fcEl?.__instance?.props;
  if (!barInst || !fcProps || patchedTransportInstances.has(barInst)) return;

  const fcEntries = Object.entries(fcProps);
  let matchedHandler: { barKey: string; fcKey: string } | null = null;
  for (const key of Object.getOwnPropertyNames(barInst)) {
    const fn = barInst[key];
    if (typeof fn !== 'function') continue;
    const fcMatch = fcEntries.find(([, value]) => value === fn);
    if (fcMatch) {
      matchedHandler = { barKey: key, fcKey: fcMatch[0] };
      break;
    }
  }
  if (!matchedHandler) return;

  patchedTransportInstances.add(barInst);
  const origSelect = barInst[matchedHandler.barKey] as (idx: number) => void;
  const wrappedSelect = (nextIdx: number): void => {
    const liveFc = barEl.querySelector('yt-focus-container') as
      | (Element & { __instance?: { props?: { selectedIndex?: unknown } } })
      | null;
    const liveIdx = liveFc?.__instance?.props?.selectedIndex;
    const prevIdx = typeof liveIdx === 'number' ? liveIdx : 0;
    const step = nextIdx >= prevIdx ? 1 : -1;
    const items = Array.from(barEl.querySelectorAll<HTMLElement>('ytlr-reel-action-bar-button-view-model'));
    let targetIdx = nextIdx;
    while (targetIdx >= 0 && targetIdx < items.length) {
      const item = items[targetIdx] as HTMLElement;
      if (!item.inert && item.getAttribute?.('hybridnavfocusable') !== 'false') {
        break;
      }
      targetIdx += step;
    }
    origSelect.call(barInst, targetIdx >= 0 && targetIdx < items.length ? targetIdx : prevIdx);
  };
  barInst[matchedHandler.barKey] = wrappedSelect;
  fcProps[matchedHandler.fcKey] = wrappedSelect;
}

function clearShortsOverlayState(): void {
  activeShortsAbort?.abort();
  activeShortsAbort = null;
  currentShorts = null;
}

function applyShortsOverlayLabels(shorts: NonNullable<typeof currentShorts>): void {
  if (typeof document === 'undefined') return;
  applyButtonLabels(SHORTS_LIKE_SELECTOR, shorts.likeCount, false);
  applyButtonLabels(SHORTS_DISLIKE_SELECTOR, shorts.dislikeCount, true);
  patchShortsActionBarFocusSkip();
}

/**
 * Displays like counts from `reel_item_watch` and RYD dislike counts on the Shorts action bar.
 */
export function setShortsOverlayStats(videoId: string | null, likeCount: string | null): void {
  if (!videoId) return;
  const compactLikes = normalizeVoteCount(likeCount);

  if (currentShorts?.videoId === videoId) {
    if (compactLikes) currentShorts.likeCount = compactLikes;
    applyShortsOverlayLabels(currentShorts);
    return;
  }

  activeShortsAbort?.abort();
  const controller = new AbortController();
  activeShortsAbort = controller;
  const shorts = { videoId, likeCount: compactLikes, dislikeCount: null };
  currentShorts = shorts;

  if (typeof document === 'undefined') return;
  installVoteLabelStyles();

  const sync = (): void => {
    if (!controller.signal.aborted && currentShorts?.videoId === videoId) {
      applyShortsOverlayLabels(shorts);
    }
  };

  const attachOverlayObserver = (): void => {
    if (controller.signal.aborted || currentShorts?.videoId !== videoId) return;
    sync();
    const overlayTarget = document.querySelector('ytlr-reel-player-overlay-renderer');
    if (overlayTarget) {
      observeDom(overlayTarget, sync, { childList: true, subtree: true }, controller.signal);
      return;
    }
    const root = document.body ?? document.documentElement;
    if (!root) return;
    const waitAbort = new AbortController();
    onAbort(controller.signal, () => waitAbort.abort());
    observeDom(
      root,
      () => {
        if (controller.signal.aborted || currentShorts?.videoId !== videoId) {
          waitAbort.abort();
          return;
        }
        const mounted = document.querySelector('ytlr-reel-player-overlay-renderer');
        if (mounted) {
          waitAbort.abort();
          sync();
          observeDom(mounted, sync, { childList: true, subtree: true }, controller.signal);
        }
      },
      { childList: true, subtree: true },
      waitAbort.signal
    );
  };

  const scheduleFrame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb: () => void) => cb();
  scheduleFrame(attachOverlayObserver);

  void fetchDislikeCount(videoId, controller.signal).then((dislikes) => {
    if (!dislikes || controller.signal.aborted || currentShorts?.videoId !== videoId) return;
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
    return typeof data?.dislikes === 'number' && data.dislikes > 0 ? formatCompactCount(data.dislikes) : null;
  } catch {
    return null;
  }
}

/**
 * Displays live YouTube like counts from `/next` alongside uncached RYD dislike counts as non-interactive labels.
 */
export function installReturnYouTubeDislike(): () => void {
  if (rydInstalled || typeof window === 'undefined' || typeof document === 'undefined') return NOOP;
  rydInstalled = true;
  installVoteLabelStyles();

  const targetWindow = window;
  const onHashChange = (): void => {
    if (!targetWindow.location.hash.includes('shorts')) {
      clearShortsOverlayState();
    }
  };
  targetWindow.addEventListener('hashchange', onHashChange);
  const unobserveShorts = observeShortsPage((active) => {
    if (!active) clearShortsOverlayState();
  });

  const unsub = onWatchSession((videoId, signal) => {
    clearShortsOverlayState();
    if (currentLike?.videoId !== videoId) currentLike = null;
    currentDislike = null;

    onAbort(signal, () => {
      if (currentLike?.videoId === videoId) currentLike = null;
      if (currentDislike?.videoId === videoId) currentDislike = null;
    });

    const applyForSession = (): { likeEls: HTMLElement[]; dislikeEls: HTMLElement[] } => {
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
      let observedTarget: Element | null = null;
      let hostAbort: AbortController | null = null;
      onAbort(signal, () => {
        hostAbort?.abort();
        hostAbort = null;
      });

      const syncTargetObserverAndLabels = (): void => {
        if (signal.aborted) return;
        const { likeEls, dislikeEls } = applyForSession();
        const watchHost = document.querySelector('ytlr-watch-default');
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
    unobserveShorts();
    unsub();
    clearShortsOverlayState();
    currentLike = null;
    currentDislike = null;
    rydInstalled = false;
  };
}
