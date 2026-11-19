import { configChangeEmitter, configRead } from '../core/config.ts';
import type { ConfigChangeListener, ConfigKey } from '../core/config.ts';
import { t } from '../core/i18n.ts';
import { onVideo } from '../core/player-observer.ts';
import { showToast } from '../core/yttv-bridge.ts';

export type SponsorBlockCategory =
  | 'sponsor'
  | 'intro'
  | 'outro'
  | 'interaction'
  | 'selfpromo'
  | 'preview'
  | 'filler'
  | 'music_offtopic'
  | 'poi_highlight';

export interface SponsorBlockBarType {
  color: string;
  opacity: string;
  name: string;
}

export interface SponsorBlockSegment {
  UUID: string;
  category: SponsorBlockCategory | string;
  segment: [number, number];
}

interface SkipSegmentsVideoEntry {
  videoID: string;
  segments?: SponsorBlockSegment[];
}

interface SkippedCategoryState {
  count: number;
  firstSkipped: number;
  lastSkipped: number;
  hasShownToast: boolean;
}

export interface SegmentBarGeometry {
  leftPercent: number;
  widthPercent: number;
  color: string;
  opacity: string;
}

const SPONSORBLOCK_API_URL = 'https://sponsor.ajay.app/api';
const REPEAT_SKIP_WINDOW_MS = 1000;
const SCHEDULE_LOOKBACK_SECONDS = 0.3;

export const SPONSORBLOCK_CATEGORIES: readonly SponsorBlockCategory[] = [
  'sponsor',
  'intro',
  'outro',
  'interaction',
  'selfpromo',
  'preview',
  'filler',
  'music_offtopic',
  'poi_highlight',
] as const;

const CATEGORY_CONFIG_KEYS: ReadonlyArray<readonly [SponsorBlockCategory, ConfigKey]> = [
  ['sponsor', 'enableSponsorBlockSponsor'],
  ['intro', 'enableSponsorBlockIntro'],
  ['outro', 'enableSponsorBlockOutro'],
  ['interaction', 'enableSponsorBlockInteraction'],
  ['selfpromo', 'enableSponsorBlockSelfPromo'],
  ['preview', 'enableSponsorBlockPreview'],
  ['filler', 'enableSponsorBlockFiller'],
  ['music_offtopic', 'enableSponsorBlockMusicOfftopic'],
];

const SPONSORBLOCK_CONFIG_KEYS = new Set<ConfigKey>([
  'enableSponsorBlock',
  'sponsorBlockManualSkips',
  ...CATEGORY_CONFIG_KEYS.map(([, configKey]) => configKey),
]);

// Segment colors & opacities matching SponsorBlock upstream conventions.
export const BAR_TYPES: Readonly<Record<string, SponsorBlockBarType>> = {
  sponsor: {
    color: '#00d400',
    opacity: '0.7',
    name: t('sponsorblock.segments.sponsor'),
  },
  intro: {
    color: '#00ffff',
    opacity: '0.7',
    name: t('sponsorblock.segments.intro'),
  },
  outro: {
    color: '#0202ed',
    opacity: '0.7',
    name: t('sponsorblock.segments.outro'),
  },
  interaction: {
    color: '#cc00ff',
    opacity: '0.7',
    name: t('sponsorblock.segments.interaction'),
  },
  selfpromo: {
    color: '#ffff00',
    opacity: '0.7',
    name: t('sponsorblock.segments.selfpromo'),
  },
  preview: {
    color: '#008fd6',
    opacity: '0.7',
    name: t('sponsorblock.segments.preview'),
  },
  filler: {
    color: '#7300FF',
    opacity: '0.9',
    name: t('sponsorblock.segments.filler'),
  },
  music_offtopic: {
    color: '#ff9900',
    opacity: '0.7',
    name: t('sponsorblock.segments.music_offtopic'),
  },
  poi_highlight: {
    color: '#9b044c',
    opacity: '0.7',
    name: t('sponsorblock.segments.poi_highlight'),
  },
};

export async function computeSha256HexPrefix(input: string, prefixLength = 4): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
    if (hex.length >= prefixLength) break;
  }
  return hex.slice(0, prefixLength);
}

export function extractWatchVideoId(locationHash: string, baseHref = 'https://www.youtube.com/'): string | null {
  if (!locationHash) return null;
  const relative = locationHash.startsWith('#') ? locationHash.slice(1) : locationHash;
  try {
    const parsed = new URL(relative, baseHref);
    const videoId = parsed.searchParams.get('v')?.trim();
    return videoId || null;
  } catch {
    return null;
  }
}

export function getEnabledSkipCategories(
  readConfig: <K extends ConfigKey>(key: K) => boolean = (key) => Boolean(configRead(key))
): SponsorBlockCategory[] {
  const enabled: SponsorBlockCategory[] = [];
  for (const [category, configKey] of CATEGORY_CONFIG_KEYS) {
    if (readConfig(configKey)) {
      enabled.push(category);
    }
  }
  return enabled;
}

export function findNextSegment(
  segments: readonly SponsorBlockSegment[],
  currentTime: number
): SponsorBlockSegment | null {
  let earliest: SponsorBlockSegment | null = null;
  const threshold = currentTime - SCHEDULE_LOOKBACK_SECONDS;

  for (const seg of segments) {
    const [start, end] = seg.segment;
    if (start > threshold && end > threshold) {
      if (!earliest || start < earliest.segment[0]) {
        earliest = seg;
      }
    }
  }

  return earliest;
}

export function computeSkipDelayMs(segmentStart: number, currentTime: number): number {
  return Math.max(0, (segmentStart - currentTime) * 1000);
}

export function computeTargetTimeAfterSkip(segmentEnd: number, videoDuration: number): number {
  if (Number.isFinite(videoDuration) && videoDuration > 0 && videoDuration - segmentEnd < 1) {
    return Math.max(0, segmentEnd - 1);
  }
  return Math.max(0, segmentEnd);
}

export function computeSegmentBarGeometry(
  segment: SponsorBlockSegment,
  videoDuration: number
): SegmentBarGeometry {
  const [start, end] = segment.segment;
  const barType = BAR_TYPES[segment.category] ?? { color: 'blue', opacity: '0.7', name: segment.category };
  const leftPercent = videoDuration > 0 ? (100 * start) / videoDuration : 0;
  const widthPercent =
    segment.category === 'poi_highlight' ? 1 : videoDuration > 0 ? (100 * (end - start)) / videoDuration : 0;

  return {
    leftPercent,
    widthPercent,
    color: barType.color,
    opacity: barType.opacity,
  };
}

export function getSuppressionDecision(
  state: SkippedCategoryState,
  now: number,
  windowMs = REPEAT_SKIP_WINDOW_MS
): { suppress: boolean; showToast: boolean; newState: SkippedCategoryState } {
  const newState = {
    ...state,
    count: state.count + 1,
    lastSkipped: now,
  };

  if (now - state.firstSkipped < windowMs) {
    if (!state.hasShownToast) {
      return { suppress: true, showToast: true, newState: { ...newState, hasShownToast: true } };
    }
    return { suppress: true, showToast: false, newState };
  }

  return { suppress: false, showToast: false, newState };
}

class SponsorBlockHandler {
  readonly videoId: string;
  private video: HTMLVideoElement | null = null;
  private active = true;
  private abortController = new AbortController();
  private nextSkipTimeout: ReturnType<typeof setTimeout> | null = null;
  private overlayObserver: MutationObserver | null = null;
  private sliderWaitObserver: MutationObserver | null = null;
  private segmentsOverlay: HTMLDivElement | null = null;
  private sliderHost: Element | null = null;
  private segments: SponsorBlockSegment[] = [];
  private skippableCategories: SponsorBlockCategory[] = [];
  private manualSkippableCategories: string[] = [];
  private skippedCategories = new Map<string, SkippedCategoryState>();

  private readonly scheduleSkipHandler = (): void => {
    const slider = document.querySelector('div[idomkey="slider"]');
    const sliderRect = slider?.getBoundingClientRect();
    const isOldUI = !document.querySelector('div[idomkey="Metadata-Section"]');
    if (isOldUI && sliderRect && this.segmentsOverlay) {
      this.segmentsOverlay.style.setProperty('top', `${sliderRect.top}px`, 'important');
    }
    this.scheduleSkip();
  };

  private readonly durationChangeHandler = (): void => {
    this.buildOverlay();
  };

  constructor(videoId: string) {
    this.videoId = videoId;
  }

  async init(): Promise<void> {
    try {
      const videoHash = await computeSha256HexPrefix(this.videoId, 4);
      if (!this.active) return;

      const categoriesParam = encodeURIComponent(JSON.stringify(SPONSORBLOCK_CATEGORIES));
      const resp = await fetch(`${SPONSORBLOCK_API_URL}/skipSegments/${videoHash}?categories=${categoriesParam}`, {
        signal: this.abortController.signal,
      });
      if (!resp.ok) return;

      const results = (await resp.json()) as SkipSegmentsVideoEntry[];
      if (!this.active || !Array.isArray(results)) return;

      const entry = results.find((v) => v.videoID === this.videoId);
      if (!entry?.segments?.length) {
        return;
      }

      this.segments = entry.segments;
      this.refreshCategoryPreferences();

      onVideo((video) => {
        if (!this.active) return;
        this.bindVideo(video);
        this.buildOverlay();
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      console.warn('[SponsorBlock] Failed to load segments:', error);
    }
  }

  refreshCategoryPreferences(): void {
    const manual = configRead('sponsorBlockManualSkips');
    this.manualSkippableCategories = Array.isArray(manual) ? manual : [];
    this.skippableCategories = getEnabledSkipCategories();
    this.scheduleSkip();
  }

  getSegments(): readonly SponsorBlockSegment[] {
    return this.segments;
  }

  private bindVideo(video: HTMLVideoElement): void {
    this.video = video;
    video.addEventListener('play', this.scheduleSkipHandler);
    video.addEventListener('pause', this.scheduleSkipHandler);
    video.addEventListener('timeupdate', this.scheduleSkipHandler);
    video.addEventListener('durationchange', this.durationChangeHandler);
  }

  private createOverlayElement(slider: Element, videoDuration: number): HTMLDivElement {
    const overlay = document.createElement('div');
    overlay.classList.add('ytLrProgressBarSlider', 'ytLrProgressBarSliderRectangularProgressBar');
    overlay.style.cssText = 'z-index: 10 !important; background-color: rgba(0, 0, 0, 0) !important; width: 72rem !important; left: 4rem !important;';

    const sliderRect = slider.getBoundingClientRect();
    if (!slider.classList.contains('ytLrProgressBarSlider')) {
      for (const cls of slider.classList) {
        overlay.classList.add(cls);
      }
      overlay.style.setProperty('height', `${sliderRect.height}px`, 'important');
      overlay.style.setProperty('bottom', `${sliderRect.bottom - sliderRect.top}px`, 'important');
    }

    const fragment = document.createDocumentFragment();
    for (const segment of this.segments) {
      const geometry = computeSegmentBarGeometry(segment, videoDuration);
      const elm = document.createElement('div');
      elm.style.cssText = `background-color: ${geometry.color} !important; opacity: ${geometry.opacity} !important; height: 100% !important; width: ${geometry.widthPercent}% !important; left: ${geometry.leftPercent}% !important; position: absolute !important;`;
      fragment.appendChild(elm);
    }
    overlay.appendChild(fragment);

    return overlay;
  }

  private attachOverlayToHost(sliderHost: Element, overlay: HTMLDivElement): void {
    this.sliderHost = sliderHost;
    this.overlayObserver = new MutationObserver((mutations) => {
      if (!this.active || !this.segmentsOverlay || !this.sliderHost) return;

      for (const mutation of mutations) {
        for (const node of mutation.removedNodes) {
          if (node === this.segmentsOverlay) {
            this.sliderHost.appendChild(this.segmentsOverlay);
            break;
          }
        }
      }

      const progressBar = document.querySelector('ytlr-progress-bar');
      if (!progressBar) return;
      const nextDisplay = progressBar.getAttribute('hybridnavfocusable') === 'false' ? 'none' : 'block';
      if (this.segmentsOverlay.style.display !== nextDisplay) {
        this.segmentsOverlay.style.setProperty('display', nextDisplay, 'important');
      }
    });

    this.overlayObserver.observe(sliderHost, { childList: true, subtree: true });
    sliderHost.appendChild(overlay);
  }

  private buildOverlay(): void {
    if (!this.active || this.segmentsOverlay || !this.video || !this.video.duration) {
      return;
    }

    const slider = document.querySelector('div[idomkey="slider"]');
    const sliderHost = document.querySelector('ytlr-redux-connect-ytlr-progress-bar');

    if (slider && sliderHost) {
      this.segmentsOverlay = this.createOverlayElement(slider, this.video.duration);
      this.attachOverlayToHost(sliderHost, this.segmentsOverlay);
      return;
    }

    if (this.sliderWaitObserver) return;
    const root = document.documentElement ?? document;
    this.sliderWaitObserver = new MutationObserver(() => {
      if (!this.active || !this.video?.duration || this.segmentsOverlay) {
        this.sliderWaitObserver?.disconnect();
        this.sliderWaitObserver = null;
        return;
      }

      const readySlider = document.querySelector('div[idomkey="slider"]');
      const readyHost = document.querySelector('ytlr-redux-connect-ytlr-progress-bar');
      if (readySlider && readyHost) {
        this.sliderWaitObserver?.disconnect();
        this.sliderWaitObserver = null;
        this.segmentsOverlay = this.createOverlayElement(readySlider, this.video.duration);
        this.attachOverlayToHost(readyHost, this.segmentsOverlay);
      }
    });
    this.sliderWaitObserver.observe(root, { childList: true, subtree: true });
  }

  scheduleSkip(): void {
    if (this.nextSkipTimeout !== null) {
      clearTimeout(this.nextSkipTimeout);
      this.nextSkipTimeout = null;
    }

    if (!this.active || !this.video || this.video.paused || this.segments.length === 0) {
      return;
    }

    const segment = findNextSegment(this.segments, this.video.currentTime);
    if (!segment) return;

    const [start, end] = segment.segment;
    const delayMs = computeSkipDelayMs(start, this.video.currentTime);

    this.nextSkipTimeout = setTimeout(() => {
      this.nextSkipTimeout = null;
      if (!this.active || !this.video || this.video.paused) return;
      if (!this.skippableCategories.includes(segment.category as SponsorBlockCategory)) return;
      if (this.manualSkippableCategories.includes(segment.category)) return;

      const skipName = BAR_TYPES[segment.category]?.name || segment.category;
      const existingSkip = this.skippedCategories.get(segment.UUID);
      if (existingSkip) {
        const decision = getSuppressionDecision(existingSkip, Date.now());
        this.skippedCategories.set(segment.UUID, decision.newState);
        if (decision.suppress) {
          if (decision.showToast && configRead('enableSponsorBlockToasts')) {
            showToast('SponsorBlock', t('sponsorblock.toasts.notSkipping', { segment: skipName, count: decision.newState.count }));
          }
          return;
        }
      } else {
        const now = Date.now();
        this.skippedCategories.set(segment.UUID, {
          count: 1,
          firstSkipped: now,
          lastSkipped: now,
          hasShownToast: false,
        });
      }

      if (configRead('enableSponsorBlockToasts')) {
        showToast('SponsorBlock', t('sponsorblock.toasts.skipping', { segment: skipName }));
      }
      this.video.currentTime = computeTargetTimeAfterSkip(end, this.video.duration);
      this.scheduleSkip();
    }, delayMs);
  }

  destroy(): void {
    this.active = false;
    this.abortController.abort();

    if (this.nextSkipTimeout !== null) {
      clearTimeout(this.nextSkipTimeout);
      this.nextSkipTimeout = null;
    }

    this.sliderWaitObserver?.disconnect();
    this.sliderWaitObserver = null;

    this.overlayObserver?.disconnect();
    this.overlayObserver = null;

    this.segmentsOverlay?.remove();
    this.segmentsOverlay = null;
    this.sliderHost = null;

    if (this.video) {
      this.video.removeEventListener('play', this.scheduleSkipHandler);
      this.video.removeEventListener('pause', this.scheduleSkipHandler);
      this.video.removeEventListener('timeupdate', this.scheduleSkipHandler);
      this.video.removeEventListener('durationchange', this.durationChangeHandler);
      this.video = null;
    }

    this.skippedCategories.clear();
  }
}

let activeHandler: SponsorBlockHandler | null = null;

export function getActiveSponsorBlockSegments(): readonly SponsorBlockSegment[] {
  return activeHandler?.getSegments() ?? [];
}

function handleHashChange(): void {
  const videoId = extractWatchVideoId(location.hash, location.href);
  const needsReload = Boolean(videoId && (!activeHandler || activeHandler.videoId !== videoId));

  if (!needsReload || !videoId) return;

  if (activeHandler) {
    try {
      activeHandler.destroy();
    } catch (error) {
      console.warn('[SponsorBlock] Failed to destroy previous handler:', error);
    }
    activeHandler = null;
  }

  if (configRead('enableSponsorBlock')) {
    activeHandler = new SponsorBlockHandler(videoId);
    void activeHandler.init();
  }
}

const handleConfigChange: ConfigChangeListener = (event) => {
  if (!SPONSORBLOCK_CONFIG_KEYS.has(event.detail?.key)) return;

  if (event.detail.key === 'enableSponsorBlock') {
    if (!event.detail.value && activeHandler) {
      activeHandler.destroy();
      activeHandler = null;
    } else if (event.detail.value) {
      handleHashChange();
    }
    return;
  }

  activeHandler?.refreshCategoryPreferences();
};

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('hashchange', handleHashChange, false);
  configChangeEmitter.addEventListener('configChange', handleConfigChange);
}
