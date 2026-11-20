import { configChangeEmitter, configRead } from '../core/config.ts';
import { onVideo } from '../core/player-observer.ts';

const CLOCK_ID = 'custom-clock';
const MAX_VOD_DURATION_SEC = 86400 * 7;

let clockTimeout: ReturnType<typeof setTimeout> | null = null;
let watchAttrObserver: MutationObserver | null = null;
let stylesInstalled = false;
let cachedWatchDefault: Element | null = null;
let cachedVideo: HTMLVideoElement | null = null;
let listenedVideo: HTMLVideoElement | null = null;
let updateHandler: (() => void) | null = null;

/**
 * Formats a `Date` into `HH:MM` or `HH:MM AM/PM`.
 */
export function formatClockTime(date: Date, is12HourFormat: boolean): string {
  let hours = date.getHours();
  const suffix = is12HourFormat ? (hours >= 12 ? ' PM' : ' AM') : '';
  if (is12HourFormat) {
    hours = hours % 12 || 12;
  }
  const hh = String(hours).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}${suffix}`;
}

/**
 * Computes the projected end-time label (`Ends HH:MM`) for the active video, or `''` if unavailable.
 */
export function computeEndTimeLabel(
  now: Date,
  durationSec: number,
  currentTimeSec: number,
  playbackRate: number,
  is12HourFormat: boolean
): string {
  if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec >= MAX_VOD_DURATION_SEC) return '';
  const rate = playbackRate > 0 ? playbackRate : 1;
  const secondsLeft = Math.max(0, durationSec - currentTimeSec);
  const at = new Date(now.getTime() + Math.round(secondsLeft / rate) * 1000);
  const end = new Date(at.getTime() + (at.getSeconds() >= 30 ? 60000 : 0));
  return `Ends ${formatClockTime(end, is12HourFormat)}`;
}

/**
 * Computes milliseconds until the next exact minute boundary.
 */
export function getNextClockDelayMs(now: Date): number {
  return Math.max(50, (60 - now.getSeconds()) * 1000 - now.getMilliseconds());
}

function resolveNativeTypography(): { fontFamily: string; color: string } {
  const fallback = { fontFamily: "'Roboto', 'YouTube Sans', sans-serif", color: '#f1f1f1' };
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return fallback;
  const host = document.querySelector('ytlr-app, ytlr-browse-page, ytlr-watch-default') ?? document.body;
  if (!host) return fallback;
  const computed = getComputedStyle(host);
  return {
    fontFamily: computed.fontFamily || fallback.fontFamily,
    color: computed.color || fallback.color,
  };
}

function installClockStyles(): void {
  if (stylesInstalled || typeof document === 'undefined') return;
  stylesInstalled = true;
  const { fontFamily, color } = resolveNativeTypography();
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
      #${CLOCK_ID} {
        position: fixed;
        z-index: 2147483647;
        pointer-events: none;
        top: max(2%, env(safe-area-inset-top, 0px));
        right: max(4%, env(safe-area-inset-right, 0px));
        font-family: ${fontFamily};
        color: ${color};
      }
      #${CLOCK_ID} .tt-clock-inner {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        text-align: right;
        font-size: 1.15rem;
        line-height: 1.15;
        font-variant-numeric: tabular-nums;
        font-weight: 500;
        text-shadow: 0 1px 3px rgba(0, 0, 0, 0.9);
      }
      #${CLOCK_ID} .tt-clock-end {
        font-size: 0.8125rem;
        font-weight: 500;
        margin-top: 0.125rem;
        display: none;
      }
    `);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  } catch {
    // Ignore environments without constructable stylesheets.
  }
}

function pickActiveVideo(): HTMLVideoElement | null {
  if (
    cachedVideo &&
    cachedVideo.isConnected &&
    !cachedVideo.ended &&
    !cachedVideo.paused &&
    cachedVideo.readyState > 0 &&
    Number.isFinite(cachedVideo.duration) &&
    cachedVideo.duration > 0 &&
    cachedVideo.duration < MAX_VOD_DURATION_SEC
  ) {
    return cachedVideo;
  }

  let fallback: HTMLVideoElement | null = null;
  const all = document.querySelectorAll('video');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (!el) continue;
    const usable = Number.isFinite(el.duration) && el.duration > 0 && el.duration < MAX_VOD_DURATION_SEC;
    if (usable && !el.paused && el.readyState > 0) {
      cachedVideo = el;
      return el;
    }
    if (usable && !fallback) fallback = el;
  }
  cachedVideo = fallback;
  return fallback;
}

const VIDEO_SYNC_EVENTS = ['loadedmetadata', 'play', 'pause', 'seeked', 'ratechange', 'durationchange', 'ended'] as const;

function syncVideoListeners(video: HTMLVideoElement | null, onUpdate: () => void): void {
  if (listenedVideo === video) return;
  if (listenedVideo) {
    for (const evt of VIDEO_SYNC_EVENTS) listenedVideo.removeEventListener(evt, onUpdate);
  }
  listenedVideo = video;
  if (listenedVideo) {
    for (const evt of VIDEO_SYNC_EVENTS) listenedVideo.addEventListener(evt, onUpdate);
  }
}

function syncWatchAttrObserver(watchEl: Element | null, onUpdate: () => void): void {
  if (!watchEl || typeof MutationObserver === 'undefined') return;
  if (watchAttrObserver && cachedWatchDefault === watchEl) return;
  watchAttrObserver?.disconnect();
  watchAttrObserver = new MutationObserver(onUpdate);
  watchAttrObserver.observe(watchEl, { attributes: true, attributeFilter: ['hybridnavfocusable'] });
}

function clearScheduledTick(): void {
  if (clockTimeout !== null) {
    clearTimeout(clockTimeout);
    clockTimeout = null;
  }
}

function cleanupClockListeners(): void {
  clearScheduledTick();
  watchAttrObserver?.disconnect();
  watchAttrObserver = null;
  if (listenedVideo && updateHandler) {
    for (const evt of VIDEO_SYNC_EVENTS) listenedVideo.removeEventListener(evt, updateHandler);
  }
  listenedVideo = null;
  if (updateHandler && typeof window !== 'undefined' && typeof document !== 'undefined') {
    window.removeEventListener('hashchange', updateHandler);
    document.removeEventListener('visibilitychange', updateHandler);
  }
  updateHandler = null;
}

function toggleClock(enabled: boolean): void {
  if (typeof document === 'undefined') return;
  const existingClock = document.getElementById(CLOCK_ID);
  if (enabled && existingClock) return;

  cleanupClockListeners();
  if (!enabled) {
    existingClock?.remove();
    return;
  }

  installClockStyles();

  const clock = document.createElement('div');
  clock.id = CLOCK_ID;

  const inner = document.createElement('div');
  inner.className = 'tt-clock-inner';

  const clockTimeEl = document.createElement('div');
  const endTimeEl = document.createElement('div');
  endTimeEl.className = 'tt-clock-end';

  inner.appendChild(clockTimeEl);
  inner.appendChild(endTimeEl);
  clock.appendChild(inner);
  const host = document.body ?? document.documentElement;
  if (!host) return;
  host.appendChild(clock);

  const renderAndSchedule = (): void => {
    clearScheduledTick();
    if (!clock.isConnected) return;

    const now = new Date();
    const is12HourFormat = configRead('isClock12HourFormat');
    const shouldHideWhenVideoPlaying = configRead('clockHideWhenVideoPlaying');

    if (!cachedWatchDefault || !cachedWatchDefault.isConnected) {
      cachedWatchDefault = document.querySelector('ytlr-watch-default');
      syncWatchAttrObserver(cachedWatchDefault, renderAndSchedule);
    }
    const isWatching = cachedWatchDefault?.getAttribute('hybridnavfocusable') === 'true';

    if (shouldHideWhenVideoPlaying) {
      const nextDisplay = isWatching ? 'none' : 'block';
      if (clock.style.display !== nextDisplay) clock.style.display = nextDisplay;
      if (isWatching) return;
    } else if (clock.style.display !== 'block') {
      clock.style.display = 'block';
    }

    const nextClock = formatClockTime(now, is12HourFormat);
    if (clockTimeEl.textContent !== nextClock) clockTimeEl.textContent = nextClock;

    const onWatchPage = location.hash.includes('watch') || location.hash.includes('v=');
    let nextEnd = '';
    if (onWatchPage) {
      const video = pickActiveVideo() ?? document.querySelector('video');
      if (video && video !== listenedVideo) {
        syncVideoListeners(video, renderAndSchedule);
      }
      if (video && !video.ended) {
        nextEnd = computeEndTimeLabel(now, video.duration, video.currentTime, video.playbackRate, is12HourFormat);
      }
    } else if (listenedVideo) {
      syncVideoListeners(null, renderAndSchedule);
    }

    const nextEndDisplay = nextEnd ? 'block' : 'none';
    if (endTimeEl.style.display !== nextEndDisplay) endTimeEl.style.display = nextEndDisplay;
    if (endTimeEl.textContent !== nextEnd) endTimeEl.textContent = nextEnd;

    if (!document.hidden) {
      clockTimeout = setTimeout(renderAndSchedule, getNextClockDelayMs(now));
    }
  };

  updateHandler = renderAndSchedule;
  window.addEventListener('hashchange', renderAndSchedule);
  document.addEventListener('visibilitychange', renderAndSchedule);
  onVideo((videoEl) => {
    syncVideoListeners(videoEl, renderAndSchedule);
    renderAndSchedule();
  });
  renderAndSchedule();
}

let clockInitialized = false;

/** Initializes the optional overlay clock and binds config change listeners once. */
export function initClock(): void {
  if (clockInitialized || typeof document === 'undefined') return;
  clockInitialized = true;

  configChangeEmitter.addEventListener('configChange', (e) => {
    const { key, value } = e.detail;
    if (key === 'enableClock') {
      toggleClock(Boolean(value));
    } else if (key === 'isClock12HourFormat' || key === 'clockHideWhenVideoPlaying') {
      updateHandler?.();
    }
  });

  toggleClock(configRead('enableClock'));
}
