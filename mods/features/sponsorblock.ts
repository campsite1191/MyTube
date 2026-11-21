import type { ConfigKey } from '../core/config.ts';
import { configRead, whenConfigReady } from '../core/config.ts';
import { t } from '../core/i18n.ts';
import {
  isPlayerBarVisible,
  observeDom,
  observePlayerBar,
  onAbort,
  onWatchSession,
  PLAYER_BAR_SELECTOR,
  scheduleAbortableTimeout,
} from '../core/lifecycle.ts';
import { onVideo } from '../core/player-observer.ts';
import { showToast } from '../core/yttv-bridge.ts';

// Segment metadata, config keys, colors, and opacities matching upstream ajayyy/SponsorBlock (`src/config.ts`).
const CATEGORY_SPECS = {
  sponsor: { configKey: 'enableSponsorBlockSponsor', color: '#00d400' },
  intro: { configKey: 'enableSponsorBlockIntro', color: '#00ffff' },
  outro: { configKey: 'enableSponsorBlockOutro', color: '#0202ed' },
  interaction: { configKey: 'enableSponsorBlockInteraction', color: '#cc00ff' },
  selfpromo: { configKey: 'enableSponsorBlockSelfPromo', color: '#ffff00' },
  preview: { configKey: 'enableSponsorBlockPreview', color: '#008fd6' },
  filler: { configKey: 'enableSponsorBlockFiller', color: '#7300FF', opacity: '0.9' },
  music_offtopic: { configKey: 'enableSponsorBlockMusicOfftopic', color: '#ff9900' },
  poi_highlight: { configKey: 'enableSponsorBlockHighlight', color: '#ff1684' },
} as const satisfies Record<string, { configKey: ConfigKey; color: string; opacity?: string }>;

export type SponsorBlockCategory = keyof typeof CATEGORY_SPECS;

type CategorySpec = { configKey: ConfigKey; color: string; opacity?: string };
const CATEGORY_ENTRIES = Object.entries(CATEGORY_SPECS) as Array<[SponsorBlockCategory, CategorySpec]>;

type SponsorBlockActionType = 'skip' | 'poi' | 'mute';

export interface SponsorBlockBarType {
  color: string;
  opacity: string;
  name: string;
}

export interface SponsorBlockSegment {
  UUID: string;
  category: SponsorBlockCategory | string;
  actionType?: SponsorBlockActionType | string;
  segment: [number, number];
}

export interface MuteState {
  activeMuteUuid: string | null;
  priorVideoMuted: boolean;
}

const SPONSORBLOCK_API_URL = 'https://sponsor.ajay.app/api';
const SPONSORBLOCK_ACTION_TYPES = ['skip', 'poi', 'mute'] as const;
const REPEAT_SKIP_WINDOW_MS = 1000;
const SCHEDULE_LOOKBACK_SECONDS = 0.3;

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

/** Returns only SponsorBlock categories currently enabled in settings for fetching. */
export function getRequestedCategories(
  readConfig: <K extends ConfigKey>(key: K) => boolean = (key) => Boolean(configRead(key))
): SponsorBlockCategory[] {
  return CATEGORY_ENTRIES.filter(([, { configKey }]) => readConfig(configKey)).map(([category]) => category);
}

export function getEnabledSkipCategories(
  readConfig: <K extends ConfigKey>(key: K) => boolean = (key) => Boolean(configRead(key))
): SponsorBlockCategory[] {
  return getRequestedCategories(readConfig).filter((category) => category !== 'poi_highlight');
}

export function findNextSegment(
  segments: readonly SponsorBlockSegment[],
  currentTime: number
): SponsorBlockSegment | null {
  const threshold = currentTime - SCHEDULE_LOOKBACK_SECONDS;
  return segments.reduce<SponsorBlockSegment | null>((earliest, seg) => {
    if (resolveSegmentActionType(seg) !== 'skip' || seg.segment[0] <= threshold || seg.segment[1] <= threshold) {
      return earliest;
    }
    return !earliest || seg.segment[0] < earliest.segment[0] ? seg : earliest;
  }, null);
}

/** Returns the active auto-mute segment covering `currentTime`, excluding manual-skip categories. */
export function findActiveMuteSegment(
  segments: readonly SponsorBlockSegment[],
  currentTime: number,
  manualCategories: ReadonlySet<string>
): SponsorBlockSegment | null {
  return (
    segments.find(
      (seg) =>
        resolveSegmentActionType(seg) === 'mute' &&
        !manualCategories.has(seg.category) &&
        currentTime >= seg.segment[0] &&
        currentTime < seg.segment[1]
    ) ?? null
  );
}

/** Computes the next mute state and desired `video.muted` update (or `null` if unchanged). */
export function computeMuteTransition(
  state: MuteState,
  activeSegment: SponsorBlockSegment | null,
  currentMuted: boolean
): { state: MuteState; nextMuted: boolean | null; toastSegment: SponsorBlockSegment | null } {
  if (!activeSegment) {
    return state.activeMuteUuid === null
      ? { state, nextMuted: null, toastSegment: null }
      : {
          state: { activeMuteUuid: null, priorVideoMuted: false },
          nextMuted: state.priorVideoMuted,
          toastSegment: null,
        };
  }
  if (state.activeMuteUuid === activeSegment.UUID) {
    return { state, nextMuted: null, toastSegment: null };
  }
  return {
    state: {
      activeMuteUuid: activeSegment.UUID,
      priorVideoMuted: state.activeMuteUuid === null ? currentMuted : state.priorVideoMuted,
    },
    nextMuted: true,
    toastSegment: activeSegment,
  };
}

export function computeSkipDelayMs(segmentStart: number, currentTime: number): number {
  return Math.max(0, (segmentStart - currentTime) * 1000);
}

export function computeTargetTimeAfterSkip(segmentEnd: number, videoDuration: number): number {
  const target =
    Number.isFinite(videoDuration) && videoDuration > 0 && videoDuration - segmentEnd < 1 ? segmentEnd - 1 : segmentEnd;
  return Math.max(0, target);
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

export function getSuppressionDecision(
  state: { count: number; firstSkipped: number; lastSkipped: number; hasShownToast: boolean },
  now: number,
  windowMs = REPEAT_SKIP_WINDOW_MS
) {
  const newState = { ...state, count: state.count + 1, lastSkipped: now };
  if (now - state.firstSkipped >= windowMs) return { suppress: false, showToast: false, newState };
  return {
    suppress: true,
    showToast: !state.hasShownToast,
    newState: state.hasShownToast ? newState : { ...newState, hasShownToast: true },
  };
}

/** Fetches sorted SponsorBlock segments (`skip`, `poi`, `mute`) for enabled categories. */
export async function fetchSponsorBlockSegments(
  videoId: string,
  signal?: AbortSignal,
  categories: readonly SponsorBlockCategory[] = getRequestedCategories()
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
  private skipAbort: AbortController | null = null;
  private waitingForSlider = false;
  private segmentsOverlay: HTMLDivElement | null = null;
  private segments: SponsorBlockSegment[] = [];
  private skippableCategories = new Set<SponsorBlockCategory>();
  private manualSkippableCategories = new Set<string>();
  private skippedCategories = new Map<
    string,
    { count: number; firstSkipped: number; lastSkipped: number; hasShownToast: boolean }
  >();
  private muteState: MuteState = { activeMuteUuid: null, priorVideoMuted: false };
  private scheduledSegmentUuid: string | null = null;
  private scheduledSkipAtMs = 0;
  private isModernUi = false;

  private readonly playbackEventHandler = (event?: Event): void => {
    if (event?.type !== 'timeupdate' && event?.type !== 'ratechange') this.syncOldUiOverlayTop();
    this.syncMuteState();
    this.scheduleSkip();
  };

  private readonly durationChangeHandler = (): void => {
    this.buildOverlay();
    this.syncOldUiOverlayTop();
  };

  constructor(videoId: string, signal: AbortSignal) {
    this.videoId = videoId;
    this.signal = signal;
    onAbort(signal, () => {
      this.clearSkipTimer();
      this.segmentsOverlay?.remove();
      this.segmentsOverlay = null;
      this.skippedCategories.clear();
      if (this.video) {
        const transition = computeMuteTransition(this.muteState, null, this.video.muted);
        this.muteState = transition.state;
        if (transition.nextMuted !== null) this.video.muted = transition.nextMuted;
        this.video = null;
      }
    });
  }

  async init(): Promise<SponsorBlockSegment[]> {
    try {
      const segments = await fetchSponsorBlockSegments(this.videoId, this.signal);
      if (this.signal.aborted || segments.length === 0) return [];

      this.segments = segments;
      const manual = configRead('sponsorBlockManualSkips');
      this.manualSkippableCategories = new Set(Array.isArray(manual) ? manual : []);
      this.skippableCategories = new Set(getEnabledSkipCategories());

      onVideo((video) => {
        if (this.signal.aborted) return;
        this.bindVideo(video);
        this.buildOverlay();
        this.syncOldUiOverlayTop();
        this.syncMuteState();
        this.scheduleSkip(true);
      });
      return segments;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return [];
      console.warn('[SponsorBlock] Failed to load segments:', error);
      return [];
    }
  }

  private bindVideo(video: HTMLVideoElement): void {
    this.video = video;
    for (const evt of ['play', 'pause', 'timeupdate', 'seeked', 'ratechange'] as const) {
      video.addEventListener(evt, this.playbackEventHandler, { signal: this.signal });
    }
    video.addEventListener('durationchange', this.durationChangeHandler, { signal: this.signal });
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

  private syncMuteState(): void {
    if (this.signal.aborted || !this.video) return;
    const activeMute = findActiveMuteSegment(this.segments, this.video.currentTime, this.manualSkippableCategories);
    const transition = computeMuteTransition(this.muteState, activeMute, this.video.muted);
    this.muteState = transition.state;
    if (transition.nextMuted !== null) this.video.muted = transition.nextMuted;
    if (transition.toastSegment && configRead('enableSponsorBlockToasts')) {
      const name = BAR_TYPES[transition.toastSegment.category]?.name || transition.toastSegment.category;
      showToast('SponsorBlock', t('sponsorblock.toasts.muting', { segment: name }));
    }
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
      'z-index: 10 !important; background-color: rgba(0, 0, 0, 0) !important; width: 72rem !important; left: 4rem !important;';

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
      { childList: true, subtree: true },
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

  private clearSkipTimer(): void {
    this.skipAbort?.abort();
    this.skipAbort = null;
    this.scheduledSegmentUuid = null;
  }

  scheduleSkip(force = false): void {
    if (this.signal.aborted || !this.video || this.video.paused || this.segments.length === 0) {
      this.clearSkipTimer();
      return;
    }

    const segment = findNextSegment(this.segments, this.video.currentTime);
    if (!segment) {
      this.clearSkipTimer();
      return;
    }

    const [start, end] = segment.segment;
    const rate = this.video.playbackRate > 0 ? this.video.playbackRate : 1;
    const delayMs = computeSkipDelayMs(start, this.video.currentTime) / rate;
    const targetSkipAtMs = Date.now() + delayMs;

    if (
      !force &&
      this.skipAbort !== null &&
      this.scheduledSegmentUuid === segment.UUID &&
      Math.abs(targetSkipAtMs - this.scheduledSkipAtMs) < 150
    ) {
      return;
    }

    this.clearSkipTimer();
    this.scheduledSegmentUuid = segment.UUID;
    this.scheduledSkipAtMs = targetSkipAtMs;
    const skipAbort = new AbortController();
    this.skipAbort = skipAbort;
    scheduleAbortableTimeout(
      () => {
        this.skipAbort = null;
        this.scheduledSegmentUuid = null;
        if (this.signal.aborted || !this.video || this.video.paused) return;
        if (!this.skippableCategories.has(segment.category as SponsorBlockCategory)) return;
        if (this.manualSkippableCategories.has(segment.category)) return;

        const skipName = BAR_TYPES[segment.category]?.name || segment.category;
        const now = Date.now();
        const existingSkip = this.skippedCategories.get(segment.UUID);
        if (existingSkip) {
          const decision = getSuppressionDecision(existingSkip, now);
          this.skippedCategories.set(segment.UUID, decision.newState);
          if (decision.suppress) {
            if (decision.showToast && configRead('enableSponsorBlockToasts')) {
              showToast(
                'SponsorBlock',
                t('sponsorblock.toasts.notSkipping', { segment: skipName, count: decision.newState.count })
              );
            }
            return;
          }
        } else {
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
        this.scheduleSkip(true);
      },
      delayMs,
      skipAbort.signal
    );
  }
}

let activeSegments: readonly SponsorBlockSegment[] = [];
let sponsorBlockInstalled = false;

export function getActiveSponsorBlockSegments(): readonly SponsorBlockSegment[] {
  return activeSegments;
}

/**
 * Installs SponsorBlock segment fetching, skipping, muting, and progress-bar markers.
 */
export function installSponsorBlock(): void {
  if (sponsorBlockInstalled || typeof window === 'undefined' || typeof document === 'undefined') return;
  sponsorBlockInstalled = true;
  void whenConfigReady().then(() => {
    onWatchSession((videoId, signal) => {
      activeSegments = [];
      onAbort(signal, () => {
        activeSegments = [];
      });
      if (!configRead('enableSponsorBlock')) return;
      void new SponsorBlockHandler(videoId, signal).init().then((segments) => {
        if (!signal.aborted) activeSegments = segments;
      });
    });
  });
}
