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
  return {
    leftPercent: videoDuration > 0 ? (100 * start) / videoDuration : 0,
    widthPercent: isPoi ? 1 : videoDuration > 0 ? (100 * (end - start)) / videoDuration : 0,
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
  private waitingForSlider = false;
  private segmentsOverlay: HTMLDivElement | null = null;
  private segments: SponsorBlockSegment[] = [];
  private isModernUi = false;

  private readonly durationChangeHandler = (): void => {
    this.buildOverlay();
    this.syncOldUiOverlayTop();
  };

  constructor(videoId: string, signal: AbortSignal) {
    this.videoId = videoId;
    this.signal = signal;
    onAbort(signal, () => {
      this.segmentsOverlay?.remove();
      this.segmentsOverlay = null;
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
        this.syncOldUiOverlayTop();
      });
      return segments;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return [];
      console.warn('[SponsorBlock] Failed to load segments:', error);
      return [];
    }
  }

  private syncOldUiOverlayTop(): void {
    if (!this.segmentsOverlay || this.isModernUi) return;
    if (document.querySelector('div[idomkey="Metadata-Section"]')) {
      this.isModernUi = true;
      return;
    }
    const sliderRect = document.querySelector('div[idomkey="slider"]')?.getBoundingClientRect();
    if (sliderRect) this.segmentsOverlay.style.setProperty('top', `${sliderRect.top}px`, 'important');
  }

  private syncOverlayVisibility(bar?: Element | null): void {
    if (!this.segmentsOverlay) return;
    const progressBar = bar ?? document.querySelector(PLAYER_BAR_SELECTOR);
    const nextDisplay = isPlayerBarVisible(progressBar) ? 'block' : 'none';
    if (this.segmentsOverlay.style.display !== nextDisplay) {
      this.segmentsOverlay.style.setProperty('display', nextDisplay, 'important');
    }
  }

  private mountOverlay(slider: Element, host: Element, duration: number): void {
    const overlay = document.createElement('div');
    overlay.classList.add('ytLrProgressBarSlider', 'ytLrProgressBarSliderRectangularProgressBar');
    overlay.style.cssText =
      'z-index: 1 !important; pointer-events: none !important; background-color: rgba(0, 0, 0, 0) !important; width: 72rem !important; left: 4rem !important;';

    if (!slider.classList.contains('ytLrProgressBarSlider')) {
      const rect = slider.getBoundingClientRect();
      overlay.classList.add(...slider.classList);
      overlay.style.setProperty('height', `${rect.height}px`, 'important');
      overlay.style.setProperty('bottom', `${rect.bottom - rect.top}px`, 'important');
    }

    const bars = this.segments.map((segment) => {
      const { color, opacity, widthPercent, leftPercent } = computeSegmentBarGeometry(segment, duration);
      const elm = document.createElement('div');
      elm.style.cssText = `background-color: ${color} !important; opacity: ${opacity} !important; height: 100% !important; width: ${widthPercent}% !important; left: ${leftPercent}% !important; position: absolute !important;`;
      return elm;
    });
    overlay.append(...bars);

    this.segmentsOverlay = overlay;
    observePlayerBar(this.signal, (bar) => this.syncOverlayVisibility(bar), {
      attributes: true,
      attributeFilter: ['hybridnavfocusable'],
    });
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
      },
      { childList: true },
      this.signal
    );
    host.appendChild(overlay);
  }

  private buildOverlay(): void {
    if (this.signal.aborted || this.segmentsOverlay || !this.video?.duration) return;

    const tryMount = (): boolean => {
      const slider = document.querySelector('div[idomkey="slider"]');
      const host = document.querySelector('ytlr-redux-connect-ytlr-progress-bar');
      if (!slider || !host || !this.video?.duration) return false;
      this.mountOverlay(slider, host, this.video.duration);
      this.syncOldUiOverlayTop();
      return true;
    };

    if (tryMount() || this.waitingForSlider) return;
    this.waitingForSlider = true;
    const observer = observeDom(
      document.body ?? document.documentElement,
      () => {
        if (this.signal.aborted || !this.video?.duration || this.segmentsOverlay || tryMount()) {
          this.waitingForSlider = false;
          observer?.disconnect();
        }
      },
      { childList: true, subtree: true },
      this.signal
    );
  }
}

let activeSegments: readonly SponsorBlockSegment[] = [];
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

export function getActiveSponsorBlockSegments(): readonly SponsorBlockSegment[] {
  return activeSegments;
}

/**
 * Installs SponsorBlock segment fetching, progress-bar markers, highlight jump, and manual-skip overlay data.
 */
export function installSponsorBlock(): void {
  if (sponsorBlockInstalled || typeof window === 'undefined' || typeof document === 'undefined') return;
  sponsorBlockInstalled = true;
  installSponsorBlockStyles();
  onWatchSession((videoId, signal) => {
    activeSegments = [];
    onAbort(signal, () => {
      activeSegments = [];
    });
    void new SponsorBlockHandler(videoId, signal).init().then((segments) => {
      if (!signal.aborted) activeSegments = segments;
    });
  });
}
