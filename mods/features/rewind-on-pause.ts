import { onAbort, onWatchSession } from '../core/lifecycle.ts';
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

export function installRewindOnPause(): void {
  if (rewindInstalled || typeof document === 'undefined' || typeof window === 'undefined') return;
  rewindInstalled = true;

  onWatchSession((_videoId, signal) => {
    onVideo((video) => {
      if (signal.aborted) return;

      let pausedAt = 0;
      let pausedTime = 0;
      let verifyAbort: AbortController | null = null;

      const resetPauseState = (): void => {
        pausedAt = 0;
        pausedTime = 0;
        verifyAbort?.abort();
        verifyAbort = null;
      };

      onAbort(signal, resetPauseState);

      video.addEventListener(
        'pause',
        () => {
          resetPauseState();
          if (video.ended || !Number.isFinite(video.duration) || video.duration <= 0 || video.currentTime <= 1) {
            return;
          }
          pausedAt = Date.now();
          pausedTime = video.currentTime;
        },
        { signal }
      );

      video.addEventListener(
        'seeking',
        () => {
          if (pausedAt && video.paused && Math.abs(video.currentTime - pausedTime) > MANUAL_SEEK_RESET_THRESHOLD_SEC) {
            resetPauseState();
          }
        },
        { signal }
      );

      video.addEventListener(
        'play',
        () => {
          if (!pausedAt) return;
          const snapshotPausedAt = pausedAt;
          resetPauseState();

          const resumeTime = video.currentTime;
          const nextTime = computeRewindTime(snapshotPausedAt, Date.now(), video.duration, resumeTime);
          if (nextTime === null) return;

          video.currentTime = nextTime;

          verifyAbort = new AbortController();
          onAbort(verifyAbort.signal, () => {
            verifyAbort = null;
          });
          video.addEventListener(
            'playing',
            () => {
              verifyAbort?.abort();
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
        { signal }
      );
    });
  });
}
