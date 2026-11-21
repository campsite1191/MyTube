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
    handler(nextVideoId, signal);
  }
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
    handler(activeWatchVideoId, activeWatchAbort.signal);
  } else {
    syncWatchSession();
  }
  return () => {
    watchSessionHandlers.delete(handler);
    if (watchSessionHandlers.size === 0) {
      activeWatchAbort?.abort();
      activeWatchAbort = null;
      activeWatchVideoId = null;
    }
  };
}
