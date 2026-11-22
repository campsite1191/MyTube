import type { YtPlayerElement } from '../types/yttv.ts';
import { onAbort } from './lifecycle.ts';

const PLAYER_SELECTOR = '.html5-video-player';

type PlayerWaiter = (player: YtPlayerElement) => void;
type VideoWaiter = (video: HTMLVideoElement) => void;

interface WaiterEntry<T> {
  callback: (target: T) => void;
  cleanup?: () => void;
}

const playerWaiters: Array<WaiterEntry<YtPlayerElement>> = [];
const videoWaiters: Array<WaiterEntry<HTMLVideoElement>> = [];
let domObserver: MutationObserver | null = null;
let domReadyListenerAttached = false;
let pendingFlush = false;

function disconnectIfEmpty(): void {
  if (playerWaiters.length === 0 && videoWaiters.length === 0 && domObserver) {
    domObserver.disconnect();
    domObserver = null;
  }
}

function drainWaiters<T>(waiters: Array<WaiterEntry<T>>, target: T): void {
  for (const entry of waiters.splice(0)) {
    entry.cleanup?.();
    try {
      entry.callback(target);
    } catch (error) {
      console.error('[PlayerObserver] Waiter failed:', error);
    }
  }
}

function flushWaiters(): void {
  if (pendingFlush) return;
  pendingFlush = true;
  const schedule =
    typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb: () => void) => setTimeout(cb, 0);
  schedule(() => {
    pendingFlush = false;
    if (playerWaiters.length > 0) {
      const player = document.querySelector<YtPlayerElement>(PLAYER_SELECTOR);
      if (player) drainWaiters(playerWaiters, player);
    }

    if (videoWaiters.length > 0) {
      const video = document.querySelector<HTMLVideoElement>('video');
      if (video) drainWaiters(videoWaiters, video);
    }

    disconnectIfEmpty();
  });
}

function ensureObserving(): void {
  if (
    (playerWaiters.length === 0 && videoWaiters.length === 0) ||
    domObserver ||
    typeof MutationObserver === 'undefined' ||
    typeof document === 'undefined'
  ) {
    return;
  }
  const target = document.body ?? document.documentElement;
  if (!target) {
    if (domReadyListenerAttached) return;
    domReadyListenerAttached = true;
    document.addEventListener(
      'DOMContentLoaded',
      () => {
        domReadyListenerAttached = false;
        flushWaiters();
        ensureObserving();
      },
      { once: true }
    );
    return;
  }
  domObserver = new MutationObserver(flushWaiters);
  domObserver.observe(target, { childList: true, subtree: true });
}

function enqueueWaiter<T>(waiters: Array<WaiterEntry<T>>, callback: (target: T) => void, signal?: AbortSignal): void {
  const entry: WaiterEntry<T> = { callback };
  if (signal) {
    const removeWaiter = () => {
      const idx = waiters.indexOf(entry);
      if (idx >= 0) waiters.splice(idx, 1);
      disconnectIfEmpty();
    };
    entry.cleanup = () => signal.removeEventListener('abort', removeWaiter);
    onAbort(signal, removeWaiter);
  }
  waiters.push(entry);
  ensureObserving();
}

export function onPlayer(callback: PlayerWaiter, signal?: AbortSignal): void {
  if (signal?.aborted) return;
  const player = document.querySelector<YtPlayerElement>(PLAYER_SELECTOR);
  if (player) {
    callback(player);
    return;
  }
  enqueueWaiter(playerWaiters, callback, signal);
}

export function onVideo(callback: VideoWaiter, signal?: AbortSignal): void {
  if (signal?.aborted) return;
  const video = document.querySelector<HTMLVideoElement>('video');
  if (video) {
    callback(video);
    return;
  }
  enqueueWaiter(videoWaiters, callback, signal);
}
