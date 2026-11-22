import { onAbort, onWatchSession, scheduleAbortableTimeout } from '../core/lifecycle.ts';
import { onVideo } from '../core/player-observer.ts';
import { injectCss } from '../core/styles.ts';

const CLOCK_ID = 'custom-clock';
const MAX_VOD_DURATION_SEC = 86400 * 7;

let tickAbort: AbortController | null = null;
let stylesInstalled = false;

/**
 * Formats a `Date` into 24-hour `HH:MM`.
 */
export function formatClockTime(date: Date): string {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * Computes the projected end-time label (`Ends HH:MM`) for the active video, or `''` if unavailable.
 */
export function computeEndTimeLabel(
  now: Date,
  durationSec: number,
  currentTimeSec: number,
  playbackRate: number
): string {
  if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec >= MAX_VOD_DURATION_SEC) return '';
  const rate = playbackRate > 0 ? playbackRate : 1;
  const secondsLeft = Math.max(0, durationSec - currentTimeSec);
  const at = new Date(now.getTime() + Math.round(secondsLeft / rate) * 1000);
  const end = new Date(at.getTime() + (at.getSeconds() >= 30 ? 60000 : 0));
  return `Ends ${formatClockTime(end)}`;
}

/**
 * Computes milliseconds until the next exact minute boundary.
 */
export function getNextClockDelayMs(now: Date): number {
  return Math.max(50, (60 - now.getSeconds()) * 1000 - now.getMilliseconds());
}

function installClockStyles(): void {
  if (stylesInstalled || typeof document === 'undefined') return;
  stylesInstalled = true;
  injectCss(`
      #${CLOCK_ID} {
        position: fixed;
        z-index: 2147483647;
        pointer-events: none;
        top: max(2%, env(safe-area-inset-top, 0px));
        right: max(4%, env(safe-area-inset-right, 0px));
        font-family: 'Roboto', 'Noto Sans', Arial, Helvetica, sans-serif;
        color: #f1f1f1;
      }
      #${CLOCK_ID} .tt-clock-inner {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        text-align: right;
        font-size: 1.125rem;
        line-height: 1.5rem;
        font-variant-numeric: tabular-nums;
        font-weight: 500;
        text-shadow: 0 0.0625rem 0.25rem rgba(0, 0, 0, 0.8);
      }
      #${CLOCK_ID} .tt-clock-end {
        font-size: 0.875rem;
        line-height: 1.25rem;
        font-weight: 400;
        display: none;
      }
    `);
}

const VIDEO_SYNC_EVENTS = [
  'loadedmetadata',
  'play',
  'pause',
  'seeked',
  'ratechange',
  'durationchange',
  'ended',
] as const;

function clearScheduledTick(): void {
  tickAbort?.abort();
  tickAbort = null;
}

let clockInitialized = false;

/** Initializes the always-on 24h overlay clock and Watch end-time projection via `onWatchSession`. */
export function initClock(): () => void {
  if (clockInitialized || typeof document === 'undefined' || document.getElementById(CLOCK_ID)) return () => {};
  const targetDoc = document;
  const host = targetDoc.body ?? targetDoc.documentElement;
  if (!host) return () => {};
  clockInitialized = true;

  installClockStyles();

  const clock = targetDoc.createElement('div');
  clock.id = CLOCK_ID;

  const inner = targetDoc.createElement('div');
  inner.className = 'tt-clock-inner';

  const clockTimeEl = targetDoc.createElement('div');
  const endTimeEl = targetDoc.createElement('div');
  endTimeEl.className = 'tt-clock-end';

  inner.appendChild(clockTimeEl);
  inner.appendChild(endTimeEl);
  clock.appendChild(inner);
  host.appendChild(clock);

  let activeVideo: HTMLVideoElement | null = null;
  let inWatchSession = false;

  const renderAndSchedule = (): void => {
    clearScheduledTick();
    if (!clock.isConnected) return;

    const now = new Date();
    const nextClock = formatClockTime(now);
    if (clockTimeEl.textContent !== nextClock) clockTimeEl.textContent = nextClock;

    const nextEnd =
      inWatchSession && activeVideo && !activeVideo.ended
        ? computeEndTimeLabel(now, activeVideo.duration, activeVideo.currentTime, activeVideo.playbackRate)
        : '';

    const nextEndDisplay = nextEnd ? 'block' : 'none';
    if (endTimeEl.style.display !== nextEndDisplay) endTimeEl.style.display = nextEndDisplay;
    if (endTimeEl.textContent !== nextEnd) endTimeEl.textContent = nextEnd;

    if (!targetDoc.hidden) {
      tickAbort = new AbortController();
      scheduleAbortableTimeout(renderAndSchedule, getNextClockDelayMs(now), tickAbort.signal);
    }
  };

  targetDoc.addEventListener('visibilitychange', renderAndSchedule);
  const unsub = onWatchSession((_videoId, signal) => {
    inWatchSession = true;
    onVideo((video) => {
      if (signal.aborted) return;
      activeVideo = video;
      for (const evt of VIDEO_SYNC_EVENTS) {
        video.addEventListener(evt, renderAndSchedule, { signal });
      }
      renderAndSchedule();
    }, signal);
    onAbort(signal, () => {
      inWatchSession = false;
      activeVideo = null;
      renderAndSchedule();
    });
  });

  renderAndSchedule();

  return () => {
    clearScheduledTick();
    targetDoc.removeEventListener?.('visibilitychange', renderAndSchedule);
    unsub();
    clock.remove?.();
    clockInitialized = false;
  };
}
