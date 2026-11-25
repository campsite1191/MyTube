import { NOOP, onAbort, onWatchSession } from '../core/lifecycle.ts';
import { onVideo } from '../core/player-observer.ts';

const LONG_PAUSE_MS = 30 * 1000;
const REWIND_SECONDS = 5;
const MANUAL_SEEK_RESET_THRESHOLD_SEC = 5;
const PLAYING_VERIFY_TOLERANCE_SEC = 1.5;

/**
 * Computes the rewound playback time after a >= 30s pause, or null when no rewind should occur.
 */
export function computeRewindTime(pausedAt: number, now: number, duration: number, currentTime: number): number | null {
  if (!pausedAt || now - pausedAt < LONG_PAUSE_MS) return null;
  if (!Number.isFinite(duration) || duration <= 0 || currentTime <= 1) return null;
  return Math.max(0, currentTime - REWIND_SECONDS);
}

let rewindInstalled = false;

export function installRewindOnPause(): () => void {
  if (rewindInstalled || typeof document === 'undefined' || typeof window === 'undefined') return NOOP;
  rewindInstalled = true;

  const unsub = onWatchSession((_videoId, signal) => {
    onVideo((video) => {
      let activeAbort: AbortController | null = null;
      const cancelPending = (): void => {
        activeAbort?.abort();
        activeAbort = null;
      };
      onAbort(signal, cancelPending);

      video.addEventListener(
        'pause',
        () => {
          cancelPending();
          if (video.ended || !Number.isFinite(video.duration) || video.duration <= 0 || video.currentTime <= 1) {
            return;
          }

          const pausedAt = Date.now();
          const pausedTime = video.currentTime;
          const pauseAbort = new AbortController();
          activeAbort = pauseAbort;

          video.addEventListener(
            'seeking',
            () => {
              if (video.paused && Math.abs(video.currentTime - pausedTime) > MANUAL_SEEK_RESET_THRESHOLD_SEC) {
                cancelPending();
              }
            },
            { signal: pauseAbort.signal }
          );

          video.addEventListener(
            'play',
            () => {
              const resumeTime = video.currentTime;
              const nextTime = computeRewindTime(pausedAt, Date.now(), video.duration, resumeTime);
              cancelPending();
              if (nextTime === null) return;

              video.currentTime = nextTime;

              const verifyAbort = new AbortController();
              activeAbort = verifyAbort;
              video.addEventListener(
                'seeking',
                () => {
                  if (Math.abs(video.currentTime - nextTime) > MANUAL_SEEK_RESET_THRESHOLD_SEC) {
                    cancelPending();
                  }
                },
                { signal: verifyAbort.signal }
              );
              video.addEventListener(
                'playing',
                () => {
                  cancelPending();
                  // Re-apply once playback starts if YouTube/Cobalt snapped currentTime back on play.
                  if (
                    !video.paused &&
                    video.currentTime > nextTime + PLAYING_VERIFY_TOLERANCE_SEC &&
                    resumeTime > nextTime
                  ) {
                    video.currentTime = nextTime;
                  }
                },
                { once: true, signal: verifyAbort.signal }
              );
            },
            { once: true, signal: pauseAbort.signal }
          );
        },
        { signal }
      );
    }, signal);
  });

  return () => {
    unsub();
    rewindInstalled = false;
  };
}
