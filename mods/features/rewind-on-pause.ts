const LONG_PAUSE_MS = 30 * 1000;
const REWIND_SECONDS = 5;

export interface RewindEvaluationInput {
  pausedAt: number;
  pausedSrc: string;
  currentSrc: string;
  now: number;
  isWatch: boolean;
  duration: number;
  currentTime: number;
}

/**
 * Computes the rewound playback time after a long pause, or null when no rewind should occur.
 */
export function computeRewindTime(input: RewindEvaluationInput): number | null {
  if (!input.pausedAt) return null;
  const elapsed = input.now - input.pausedAt;
  const sameSrc = input.currentSrc === input.pausedSrc;
  if (!sameSrc || elapsed < LONG_PAUSE_MS || !input.isWatch) return null;
  if (!Number.isFinite(input.duration) || input.duration <= 0 || input.currentTime <= 1) return null;
  return Math.max(0, input.currentTime - REWIND_SECONDS);
}

class PauseStateManager {
  private pausedAt = 0;
  private pausedVideo: HTMLVideoElement | null = null;
  private pausedSrc = '';
  private pausedTime = 0;

  get at() {
    return this.pausedAt;
  }
  get video() {
    return this.pausedVideo;
  }
  get src() {
    return this.pausedSrc;
  }
  get time() {
    return this.pausedTime;
  }

  set(at: number, video: HTMLVideoElement, src: string, time: number): void {
    this.pausedAt = at;
    this.pausedVideo = video;
    this.pausedSrc = src;
    this.pausedTime = time;
  }

  reset(): void {
    this.pausedAt = 0;
    this.pausedVideo = null;
    this.pausedSrc = '';
    this.pausedTime = 0;
  }

  isVideo(video: HTMLVideoElement): boolean {
    return video === this.pausedVideo;
  }
}

const pauseState = new PauseStateManager();

function isWatchPage(): boolean {
  return typeof window !== 'undefined' && window.location.hash.includes('watch');
}

function isVideoElement(target: EventTarget | null): target is HTMLVideoElement {
  return Boolean(
    target && typeof target === 'object' && 'tagName' in target && (target as Element).tagName === 'VIDEO'
  );
}

let rewindInstalled = false;

export function installRewindOnPause(): void {
  if (rewindInstalled || typeof document === 'undefined' || typeof window === 'undefined') return;
  rewindInstalled = true;

  document.addEventListener(
    'pause',
    (e: Event) => {
      if (!isVideoElement(e.target)) return;
      const video = e.target;
      if (
        !isWatchPage() ||
        video.ended ||
        !Number.isFinite(video.duration) ||
        video.duration <= 0 ||
        video.currentTime <= 1
      ) {
        pauseState.reset();
        return;
      }
      pauseState.set(Date.now(), video, video.currentSrc || video.src || '', video.currentTime);
    },
    true
  );

  document.addEventListener(
    'seeking',
    (e: Event) => {
      if (!isVideoElement(e.target)) return;
      const video = e.target;
      if (pauseState.isVideo(video) && video.paused && Math.abs(video.currentTime - pauseState.time) > 1) {
        pauseState.reset();
      }
    },
    true
  );

  document.addEventListener(
    'emptied',
    (e: Event) => {
      if (e.target === pauseState.video) {
        pauseState.reset();
      }
    },
    true
  );

  document.addEventListener(
    'play',
    (e: Event) => {
      if (!isVideoElement(e.target)) return;
      const video = e.target;
      if (!pauseState.at || !pauseState.isVideo(video)) return;

      const snapshotPausedAt = pauseState.at;
      const snapshotPausedSrc = pauseState.src;
      pauseState.reset();

      const nextTime = computeRewindTime({
        pausedAt: snapshotPausedAt,
        pausedSrc: snapshotPausedSrc,
        currentSrc: video.currentSrc || video.src || '',
        now: Date.now(),
        isWatch: isWatchPage(),
        duration: video.duration,
        currentTime: video.currentTime,
      });
      if (nextTime !== null) {
        video.currentTime = nextTime;
      }
    },
    true
  );

  window.addEventListener('hashchange', () => {
    if (!isWatchPage()) {
      pauseState.reset();
    }
  });
}
