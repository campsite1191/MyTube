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
