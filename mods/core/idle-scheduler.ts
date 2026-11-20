type IdleWindow = {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
};

/**
 * Schedules non-critical initialization work after the initial frame/tick so
 * startup rendering and critical Innertube hooks run without contention.
 */
export function schedulePostFirstPaint(task: () => void): void {
  if (typeof window === 'undefined') {
    task();
    return;
  }

  const idleWindow = window as unknown as IdleWindow;
  if (typeof idleWindow.requestIdleCallback === 'function') {
    idleWindow.requestIdleCallback(task, { timeout: 1000 });
    return;
  }

  setTimeout(task, 0);
}

/**
 * Installs idempotent `<link rel="preconnect">` hints for external addon origins
 * after first paint so DNS/TLS setup overlaps idle time before video playback.
 */
export function preconnectOrigins(
  origins: readonly string[],
  targetDocument: Document | undefined = typeof document !== 'undefined' ? document : undefined
): void {
  const head = targetDocument?.head;
  if (!targetDocument || !head) return;

  for (const origin of origins) {
    if (!origin) continue;
    const existing =
      typeof targetDocument.querySelector === 'function'
        ? targetDocument.querySelector(`link[rel="preconnect"][href="${origin}"]`)
        : null;
    if (existing) continue;

    const link = targetDocument.createElement('link');
    link.rel = 'preconnect';
    link.href = origin;
    link.crossOrigin = 'anonymous';
    head.appendChild(link);
  }
}
