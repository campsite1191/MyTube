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
