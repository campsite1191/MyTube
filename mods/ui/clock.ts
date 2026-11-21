import { onAbort, onWatchSession, scheduleAbortableTimeout } from '../core/lifecycle.ts';
import { onVideo } from '../core/player-observer.ts';
import { injectCss } from '../core/styles.ts';

const CLOCK_ID = 'custom-clock';
const MAX_VOD_DURATION_SEC = 86400 * 7;

let tickAbort: AbortController | null = null;
let stylesInstalled = false;

/**
 * Formats a `Date` into `HH:MM` or `HH:MM AM/PM`.
 */
export function formatClockTime(date: Date, is12HourFormat = false): string {
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
  is12HourFormat = false
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
        font-family: 'YouTube Sans', 'Roboto', Arial, sans-serif;
        color: #f1f1f1;
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
export function initClock(): void {
  if (clockInitialized || typeof document === 'undefined' || document.getElementById(CLOCK_ID)) return;
  clockInitialized = true;

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

    if (!document.hidden) {
      tickAbort = new AbortController();
      scheduleAbortableTimeout(renderAndSchedule, getNextClockDelayMs(now), tickAbort.signal);
    }
  };

  document.addEventListener('visibilitychange', renderAndSchedule);
  onWatchSession((_videoId, signal) => {
    inWatchSession = true;
    onVideo((video) => {
      if (signal.aborted) return;
      activeVideo = video;
      for (const evt of VIDEO_SYNC_EVENTS) {
        video.addEventListener(evt, renderAndSchedule, { signal });
      }
      renderAndSchedule();
    });
    onAbort(signal, () => {
      inWatchSession = false;
      activeVideo = null;
      renderAndSchedule();
    });
  });

  renderAndSchedule();
}
