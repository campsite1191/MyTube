import { t } from '../core/i18n.ts';
import {
  isPlayerBarVisible,
  observeDom,
  observePlayerBar,
  onAbort,
  onWatchSession,
  PLAYER_BAR_SELECTOR,
} from '../core/lifecycle.ts';
import { onVideo } from '../core/player-observer.ts';
import { injectCss } from '../core/styles.ts';

// Segment colors and opacities matching upstream ajayyy/SponsorBlock (`src/config.ts`).
const CATEGORY_SPECS = {
  sponsor: { color: '#00d400' },
  intro: { color: '#00ffff' },
  outro: { color: '#0202ed' },
  interaction: { color: '#cc00ff' },
  selfpromo: { color: '#ffff00' },
  preview: { color: '#008fd6' },
  filler: { color: '#7300FF', opacity: '0.9' },
  music_offtopic: { color: '#ff9900' },
  poi_highlight: { color: '#ff1684' },
} as const satisfies Record<string, { color: string; opacity?: string }>;

const ENABLED_CATEGORIES: readonly SponsorBlockCategory[] = [
  'sponsor',
  'intro',
  'outro',
  'interaction',
  'selfpromo',
  'poi_highlight',
];

export type SponsorBlockCategory = keyof typeof CATEGORY_SPECS;

type CategorySpec = { color: string; opacity?: string };
const CATEGORY_ENTRIES = Object.entries(CATEGORY_SPECS) as Array<[SponsorBlockCategory, CategorySpec]>;

export interface SponsorBlockBarType {
  color: string;
  opacity: string;
  name: string;
}

export interface SponsorBlockSegment {
  UUID: string;
  category: SponsorBlockCategory | string;
  actionType?: string;
  segment: [number, number];
}

const SPONSORBLOCK_API_URL = 'https://sponsor.ajay.app/api';
const SPONSORBLOCK_ACTION_TYPES = ['skip', 'poi'] as const;
const PROGRESS_TRACK_SELECTOR = 'div[idomkey="slider"], ytlr-progress-bar div[idomkey="progress-bar"]';
const PROGRESS_HOST_SELECTOR = 'ytlr-redux-connect-ytlr-progress-bar';

export const BAR_TYPES: Readonly<Record<string, SponsorBlockBarType>> = Object.fromEntries(
  CATEGORY_ENTRIES.map(([category, { color, opacity = '0.7' }]) => [
    category,
    { color, opacity, name: t(`sponsorblock.segments.${category}`) },
  ])
);

export function resolveSegmentActionType(segment: Pick<SponsorBlockSegment, 'actionType' | 'category'>): string {
  return segment.actionType ?? (segment.category === 'poi_highlight' ? 'poi' : 'skip');
}

export async function computeSha256HexPrefix(input: string, prefixLength = 4): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  const bytes = new Uint8Array(digest, 0, Math.ceil(prefixLength / 2));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, prefixLength);
}

export function computeSegmentBarGeometry(segment: SponsorBlockSegment, videoDuration: number) {
  const [start, end] = segment.segment;
  const { color, opacity } = BAR_TYPES[segment.category] ?? { color: 'blue', opacity: '0.7' };
  const isPoi = resolveSegmentActionType(segment) === 'poi' || segment.category === 'poi_highlight';
  if (videoDuration <= 0 || !Number.isFinite(videoDuration)) {
    return {
      leftPercent: 0,
      widthPercent: isPoi ? 1 : 0,
      color,
      opacity,
    };
  }
  const clampedStart = Math.max(0, Math.min(start, videoDuration));
  const clampedEnd = Math.max(clampedStart, Math.min(end, videoDuration));
  const leftPercent = (100 * clampedStart) / videoDuration;
  const widthPercent = isPoi
    ? Math.min(1, Math.max(0, 100 - leftPercent))
    : (100 * (clampedEnd - clampedStart)) / videoDuration;
  return {
    leftPercent,
    widthPercent,
    color,
    opacity,
  };
}

/** Fetches sorted SponsorBlock segments (`skip`, `poi`) for enabled categories. */
export async function fetchSponsorBlockSegments(
  videoId: string,
  signal?: AbortSignal,
  categories: readonly SponsorBlockCategory[] = ENABLED_CATEGORIES
): Promise<SponsorBlockSegment[]> {
  if (categories.length === 0) return [];

  const videoHash = await computeSha256HexPrefix(videoId, 4);
  if (signal?.aborted) return [];

  const query = new URLSearchParams({
    categories: JSON.stringify(categories),
    actionTypes: JSON.stringify(SPONSORBLOCK_ACTION_TYPES),
  });
  const resp = await fetch(`${SPONSORBLOCK_API_URL}/skipSegments/${videoHash}?${query}`, { signal });
  if (!resp.ok) return [];

  const results = (await resp.json()) as Array<{ videoID: string; segments?: SponsorBlockSegment[] }>;
  const entry = Array.isArray(results) ? results.find((v) => v.videoID === videoId) : undefined;
  return (entry?.segments ?? [])
    .map((seg) => ({ ...seg, actionType: resolveSegmentActionType(seg) }))
    .toSorted((a, b) => a.segment[0] - b.segment[0]);
}

class SponsorBlockHandler {
  readonly videoId: string;
  private readonly signal: AbortSignal;
  private video: HTMLVideoElement | null = null;
  private waitingForTrack = false;
  private segmentsOverlay: HTMLDivElement | null = null;
  private overlayDuration = 0;
  private segments: SponsorBlockSegment[] = [];

  private readonly durationChangeHandler = (): void => {
    if (this.segmentsOverlay && this.video?.duration && Math.abs(this.video.duration - this.overlayDuration) > 0.5) {
      this.renderSegmentBars(this.video.duration);
    } else {
      this.buildOverlay();
    }
    this.syncOverlayLayout();
  };

  constructor(videoId: string, signal: AbortSignal) {
    this.videoId = videoId;
    this.signal = signal;
    onAbort(signal, () => {
      this.segmentsOverlay?.remove();
      this.segmentsOverlay = null;
      this.overlayDuration = 0;
      this.video = null;
    });
  }

  async init(): Promise<SponsorBlockSegment[]> {
    try {
      const segments = await fetchSponsorBlockSegments(this.videoId, this.signal);
      if (this.signal.aborted || segments.length === 0) return [];

      this.segments = segments;

      onVideo((video) => {
        if (this.signal.aborted) return;
        this.video = video;
        video.addEventListener('durationchange', this.durationChangeHandler, { signal: this.signal });
        this.buildOverlay();
      }, this.signal);
      return segments;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return [];
      console.warn('[SponsorBlock] Failed to load segments:', error);
      return [];
    }
  }

  private findProgressTrack(): Element | null {
    return document.querySelector(PROGRESS_TRACK_SELECTOR);
  }

  private syncOverlayLayout(): void {
    if (!this.segmentsOverlay) return;
    const track = this.findProgressTrack();
    const host = document.querySelector(PROGRESS_HOST_SELECTOR);
    if (!track || !host) return;

    const trackRect = track.getBoundingClientRect?.();
    const hostRect = host.getBoundingClientRect?.();
    if (!trackRect || trackRect.width <= 0 || trackRect.height <= 0) return;

    const left = hostRect && hostRect.width > 0 ? trackRect.left - hostRect.left : trackRect.left;
    const top = hostRect && hostRect.height > 0 ? trackRect.top - hostRect.top : trackRect.top;
    this.segmentsOverlay.style.setProperty('left', `${left}px`, 'important');
    this.segmentsOverlay.style.setProperty('top', `${top}px`, 'important');
    this.segmentsOverlay.style.setProperty('width', `${trackRect.width}px`, 'important');
    this.segmentsOverlay.style.setProperty('height', `${trackRect.height}px`, 'important');
  }

  private syncOverlayVisibility(bar?: Element | null): void {
    if (!this.segmentsOverlay) return;
    const progressBar = bar ?? document.querySelector(PLAYER_BAR_SELECTOR);
    const nextDisplay = isPlayerBarVisible(progressBar) ? 'block' : 'none';
    if (this.segmentsOverlay.style.display !== nextDisplay) {
      this.segmentsOverlay.style.setProperty('display', nextDisplay, 'important');
    }
  }

  private renderSegmentBars(duration: number): void {
    if (!this.segmentsOverlay) return;
    const bars = this.segments.map((segment) => {
      const { color, opacity, widthPercent, leftPercent } = computeSegmentBarGeometry(segment, duration);
      const elm = document.createElement('div');
      elm.style.cssText = `background-color: ${color} !important; opacity: ${opacity} !important; height: 100% !important; width: ${widthPercent}% !important; left: ${leftPercent}% !important; position: absolute !important;`;
      return elm;
    });
    this.segmentsOverlay.replaceChildren(...bars);
    this.overlayDuration = duration;
  }

  private mountOverlay(track: Element, host: Element, duration: number): void {
    const overlay = document.createElement('div');
    overlay.classList.add('ytLrProgressBarSlider', 'ytLrProgressBarSliderRectangularProgressBar');
    overlay.style.cssText =
      'position: absolute !important; z-index: 1 !important; pointer-events: none !important; background-color: rgba(0, 0, 0, 0) !important; width: 72rem !important; left: 4rem !important; height: 0.5rem !important;';

    if (track.classList && !track.classList.contains('ytLrProgressBarSlider')) {
      overlay.classList.add(...track.classList);
    }

    this.segmentsOverlay = overlay;
    this.renderSegmentBars(duration);
    this.syncOverlayLayout();
    observePlayerBar(
      this.signal,
      (bar) => {
        this.syncOverlayVisibility(bar);
        this.syncOverlayLayout();
      },
      {
        attributes: true,
        attributeFilter: ['hybridnavfocusable', 'class'],
      }
    );
    observeDom(
      host,
      (mutations) => {
        if (this.signal.aborted || !this.segmentsOverlay) return;
        for (const mutation of mutations) {
          for (const removed of mutation.removedNodes) {
            if (removed === this.segmentsOverlay) {
              host.appendChild(this.segmentsOverlay);
              break;
            }
          }
        }
        this.syncOverlayVisibility();
        this.syncOverlayLayout();
      },
      { childList: true },
      this.signal
    );
    host.appendChild(overlay);
  }

  private buildOverlay(): void {
    if (this.signal.aborted || this.segmentsOverlay || !this.video?.duration) return;

    const tryMount = (): boolean => {
      const track = this.findProgressTrack();
      const host = document.querySelector(PROGRESS_HOST_SELECTOR);
      if (!track || !host || !this.video?.duration) return false;
      this.mountOverlay(track, host, this.video.duration);
      return true;
    };

    if (tryMount() || this.waitingForTrack) return;
    this.waitingForTrack = true;
    const observer = observeDom(
      document.body ?? document.documentElement,
      () => {
        if (this.signal.aborted || !this.video?.duration || this.segmentsOverlay || tryMount()) {
          this.waitingForTrack = false;
          observer?.disconnect();
        }
      },
      { childList: true, subtree: true },
      this.signal
    );
  }
}

let activeVideoId: string | null = null;
let activeSegments: readonly SponsorBlockSegment[] = [];
let pendingSegmentListeners: Array<{
  videoId: string;
  callback: (segments: readonly SponsorBlockSegment[]) => void;
}> = [];
let sponsorBlockInstalled = false;
let sponsorBlockStylesInstalled = false;

function installSponsorBlockStyles(): void {
  if (sponsorBlockStylesInstalled || typeof document === 'undefined') return;
  sponsorBlockStylesInstalled = true;
  injectCss(`
      ytlr-progress-bar :is(.ytLrProgressBarPlayhead, [idomkey="playhead"]) {
        z-index: 2 !important;
      }
    `);
}

export function getActiveSponsorBlockSegments(videoId?: string | null): readonly SponsorBlockSegment[] {
  if (videoId && activeVideoId && activeVideoId !== videoId) return [];
  return activeSegments;
}

/**
 * Invokes `callback` immediately if SponsorBlock segments are already loaded for `videoId`,
 * or queues it for the active Watch session if `/next` parsed before `sponsor.ajay.app` responded.
 */
export function onSponsorBlockSegmentsReady(
  videoId: string | null | undefined,
  callback: (segments: readonly SponsorBlockSegment[]) => void
): void {
  const current = getActiveSponsorBlockSegments(videoId);
  if (current.length > 0) {
    callback(current);
    return;
  }
  if (!videoId) return;
  if (pendingSegmentListeners.length > 0 && pendingSegmentListeners[0]?.videoId !== videoId) {
    pendingSegmentListeners = [];
  }
  pendingSegmentListeners.push({ videoId, callback });
}

/**
 * Installs SponsorBlock segment fetching, progress-bar markers, highlight jump, and manual-skip overlay data.
 */
export function installSponsorBlock(): () => void {
  if (sponsorBlockInstalled || typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  sponsorBlockInstalled = true;
  installSponsorBlockStyles();
  const unsub = onWatchSession((videoId, signal) => {
    activeVideoId = videoId;
    activeSegments = [];
    pendingSegmentListeners = pendingSegmentListeners.filter((entry) => entry.videoId === videoId);
    onAbort(signal, () => {
      if (activeVideoId === videoId) {
        activeVideoId = null;
        activeSegments = [];
      }
      pendingSegmentListeners = pendingSegmentListeners.filter((entry) => entry.videoId !== videoId);
    });
    void new SponsorBlockHandler(videoId, signal).init().then((segments) => {
      if (signal.aborted) return;
      activeVideoId = videoId;
      activeSegments = segments;
      const listeners = pendingSegmentListeners.splice(0);
      if (segments.length > 0) {
        for (const entry of listeners) {
          if (entry.videoId === videoId) {
            entry.callback(segments);
          }
        }
      }
    });
  });

  return () => {
    unsub();
    activeVideoId = null;
    activeSegments = [];
    pendingSegmentListeners = [];
    sponsorBlockInstalled = false;
  };
}
