/**
 * AbortSignal-scoped lifecycle helpers so DOM observers, timers, and custom
 * cleanup hooks share one cancellation token without manual teardown bookkeeping.
 */

export function onAbort(signal: AbortSignal | undefined, cleanup: () => void): void {
  if (!signal) return;
  if (signal.aborted) {
    cleanup();
    return;
  }
  signal.addEventListener('abort', cleanup, { once: true });
}

export function observeDom(
  target: Node | null | undefined,
  callback: MutationCallback,
  options: MutationObserverInit,
  signal?: AbortSignal
): MutationObserver | null {
  if (!target || typeof MutationObserver === 'undefined' || signal?.aborted) return null;
  const observer = new MutationObserver(callback);
  observer.observe(target, options);
  onAbort(signal, () => observer.disconnect());
  return observer;
}

export function scheduleAbortableTimeout(
  callback: () => void,
  delayMs: number,
  signal?: AbortSignal
): ReturnType<typeof setTimeout> | null {
  if (signal?.aborted) return null;
  const id = setTimeout(() => {
    signal?.removeEventListener('abort', cancel);
    callback();
  }, delayMs);
  const cancel = () => clearTimeout(id);
  signal?.addEventListener('abort', cancel, { once: true });
  return id;
}

export function extractWatchVideoId(route: string | null | undefined): string | null {
  const query = typeof route === 'string' ? route.split('?')[1] : undefined;
  return query ? new URLSearchParams(query).get('v')?.trim() || null : null;
}

export function getActiveWatchVideoId(): string | null {
  if (typeof window === 'undefined') return null;
  return extractWatchVideoId(window.location?.hash) ?? extractWatchVideoId(window.location?.search);
}

function isShortsPageActive(): boolean {
  return Boolean(typeof document !== 'undefined' && document.body?.classList?.contains('WEB_PAGE_TYPE_SHORTS'));
}

export function isPlaybackPageActive(): boolean {
  if (typeof window !== 'undefined') {
    const hash = String(window.location?.hash || '');
    if (hash.includes('/watch') || Boolean(extractWatchVideoId(hash))) return true;
  }
  return isShortsPageActive();
}

export function observeShortsPage(callback: (isShortsActive: boolean) => void, signal?: AbortSignal): () => void {
  if (signal?.aborted || typeof document === 'undefined') return () => {};

  const doc = document;
  let lastActive = Boolean(doc.body?.classList?.contains('WEB_PAGE_TYPE_SHORTS'));
  let observer: MutationObserver | null = null;
  let cleanedUp = false;

  const sync = (): void => {
    const nextActive = Boolean(doc.body?.classList?.contains('WEB_PAGE_TYPE_SHORTS'));
    if (nextActive === lastActive) return;
    lastActive = nextActive;
    callback(nextActive);
  };

  const attach = (): void => {
    if (cleanedUp || !doc.body) return;
    sync();
    observer = observeDom(doc.body, sync, { attributes: true, attributeFilter: ['class'] });
  };

  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    observer?.disconnect();
    observer = null;
    doc.removeEventListener?.('DOMContentLoaded', attach);
  };

  if (signal) {
    onAbort(signal, cleanup);
  }

  if (doc.body) {
    attach();
  } else {
    doc.addEventListener?.('DOMContentLoaded', attach, { once: true });
  }

  return cleanup;
}

type WatchSessionHandler = (videoId: string, signal: AbortSignal) => void;
const watchSessionHandlers = new Set<WatchSessionHandler>();
let activeWatchVideoId: string | null = null;
let activeWatchAbort: AbortController | null = null;
let watchRouterInstalled = false;

function syncWatchSession(): void {
  const nextVideoId = getActiveWatchVideoId();
  if (!nextVideoId) {
    activeWatchAbort?.abort();
    activeWatchAbort = null;
    activeWatchVideoId = null;
    return;
  }
  if (nextVideoId === activeWatchVideoId && activeWatchAbort && !activeWatchAbort.signal.aborted) return;

  activeWatchAbort?.abort();
  activeWatchVideoId = nextVideoId;
  activeWatchAbort = new AbortController();
  const { signal } = activeWatchAbort;
  for (const handler of watchSessionHandlers) {
    if (signal.aborted) break;
    try {
      handler(nextVideoId, signal);
    } catch (error) {
      console.error('[Lifecycle] Watch session handler failed:', error);
    }
  }
}

export const PLAYER_BAR_SELECTOR = 'ytlr-progress-bar';

export function isPlayerBarVisible(bar: Element | null | undefined): boolean {
  return Boolean(
    bar && bar.getAttribute?.('hybridnavfocusable') !== 'false' && !bar.classList?.contains('zylon-hidden')
  );
}

/**
 * Observes the Watch player bar (`ytlr-progress-bar`) for the lifetime of `signal`,
 * re-binding automatically if YouTube TV swaps or remounts the player bar element.
 */
export function observePlayerBar(
  signal: AbortSignal,
  onBar: (bar: Element) => void,
  options: MutationObserverInit = {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['hybridnavfocusable', 'class'],
  }
): () => Element | null {
  let observedBar: Element | null = null;
  let barAbort: AbortController | null = null;
  let waitAbort: AbortController | null = null;

  onAbort(signal, () => {
    observedBar = null;
    barAbort?.abort();
    barAbort = null;
    waitAbort?.abort();
    waitAbort = null;
  });

  const bind = (): Element | null => {
    if (signal.aborted || typeof document === 'undefined') return null;
    if (observedBar?.isConnected) return observedBar;

    const bar = document.querySelector(PLAYER_BAR_SELECTOR);
    if (!bar) {
      barAbort?.abort();
      barAbort = null;
      observedBar = null;
      if (!waitAbort) {
        waitAbort = new AbortController();
        observeDom(
          document.body ?? document.documentElement,
          () => {
            if (document.querySelector(PLAYER_BAR_SELECTOR)) {
              bind();
            }
          },
          { childList: true, subtree: true },
          waitAbort.signal
        );
      }
      return null;
    }

    waitAbort?.abort();
    waitAbort = null;
    barAbort?.abort();
    observedBar = bar;
    barAbort = new AbortController();
    observeDom(
      bar,
      () => {
        if (!bar.isConnected) {
          bind();
          return;
        }
        onBar(bar);
      },
      options,
      barAbort.signal
    );
    if (bar.parentNode) {
      observeDom(
        bar.parentNode,
        () => {
          if (!bar.isConnected) {
            bind();
          }
        },
        { childList: true },
        barAbort.signal
      );
    }
    onBar(bar);
    return bar;
  };

  bind();
  return () => {
    if (observedBar?.isConnected) return observedBar;
    return bind();
  };
}

/**
 * Registers a callback invoked whenever a Watch video session becomes active.
 * Its `AbortSignal` aborts automatically on navigating away or switching videos.
 */
export function onWatchSession(handler: WatchSessionHandler): () => void {
  watchSessionHandlers.add(handler);
  if (typeof window !== 'undefined' && !watchRouterInstalled) {
    watchRouterInstalled = true;
    window.addEventListener('hashchange', syncWatchSession);
  }
  if (activeWatchAbort && activeWatchVideoId && !activeWatchAbort.signal.aborted) {
    try {
      handler(activeWatchVideoId, activeWatchAbort.signal);
    } catch (error) {
      console.error('[TizenTube] onWatchSession handler error:', error);
    }
  } else {
    syncWatchSession();
  }
  return () => {
    watchSessionHandlers.delete(handler);
    if (watchSessionHandlers.size === 0) {
      activeWatchAbort?.abort();
      activeWatchAbort = null;
      activeWatchVideoId = null;
      if (typeof window !== 'undefined') {
        window.removeEventListener?.('hashchange', syncWatchSession);
      }
      watchRouterInstalled = false;
    }
  };
}
