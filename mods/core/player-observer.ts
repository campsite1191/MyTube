import type { YtPlayerElement } from '../types/yttv.ts';

const PLAYER_SELECTOR = '.html5-video-player';

type PlayerWaiter = (player: YtPlayerElement) => void;
type VideoWaiter = (video: HTMLVideoElement) => void;

const playerWaiters: PlayerWaiter[] = [];
const videoWaiters: VideoWaiter[] = [];
let domObserver: MutationObserver | null = null;
let domReadyListenerAttached = false;

let pendingFlush = false;
function flushWaiters(): void {
  if (pendingFlush) return;
  pendingFlush = true;
  requestAnimationFrame(() => {
    pendingFlush = false;
    if (playerWaiters.length > 0) {
      const player = document.querySelector<YtPlayerElement>(PLAYER_SELECTOR);
      if (player) {
        for (const waiter of playerWaiters.splice(0)) {
          waiter(player);
        }
      }
    }

    if (videoWaiters.length > 0) {
      const video = document.querySelector<HTMLVideoElement>('video');
      if (video) {
        for (const waiter of videoWaiters.splice(0)) {
          waiter(video);
        }
      }
    }

    if (playerWaiters.length === 0 && videoWaiters.length === 0 && domObserver) {
      domObserver.disconnect();
      domObserver = null;
    }
  });
}

function ensureObserving(): void {
  if (domObserver || typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;
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

export function onPlayer(callback: PlayerWaiter): void {
  const player = document.querySelector<YtPlayerElement>(PLAYER_SELECTOR);
  if (player) {
    callback(player);
    return;
  }
  playerWaiters.push(callback);
  ensureObserving();
}

export function onVideo(callback: VideoWaiter): void {
  const video = document.querySelector<HTMLVideoElement>('video');
  if (video) {
    callback(video);
    return;
  }
  videoWaiters.push(callback);
  ensureObserving();
}
