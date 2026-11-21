import type { ConfigKey } from '../core/config.ts';
import { configRead, whenConfigReady } from '../core/config.ts';
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

const CATEGORY_CONFIG_KEYS = [
  ['sponsor', 'enableSponsorBlockSponsor'],
  ['intro', 'enableSponsorBlockIntro'],
  ['outro', 'enableSponsorBlockOutro'],
  ['interaction', 'enableSponsorBlockInteraction'],
  ['selfpromo', 'enableSponsorBlockSelfPromo'],
  ['preview', 'enableSponsorBlockPreview'],
  ['filler', 'enableSponsorBlockFiller'],
  ['music_offtopic', 'enableSponsorBlockMusicOfftopic'],
] as const satisfies ReadonlyArray<readonly [SponsorBlockCategory, ConfigKey]>;

const BAR_COLORS: Readonly<Record<SponsorBlockCategory, readonly [color: string, opacity?: string]>> = {
  sponsor: ['#00d400'],
  intro: ['#00ffff'],
  outro: ['#0202ed'],
  interaction: ['#cc00ff'],
  selfpromo: ['#ffff00'],
  preview: ['#008fd6'],
  filler: ['#7300FF', '0.9'],
  music_offtopic: ['#ff9900'],
  poi_highlight: ['#ff1684'],
};

// Segment colors & opacities matching upstream ajayyy/SponsorBlock (`src/config.ts`).
export const BAR_TYPES: Readonly<Record<string, SponsorBlockBarType>> = Object.fromEntries(
  (Object.entries(BAR_COLORS) as Array<[SponsorBlockCategory, readonly [string, string?]]>).map(
    ([category, [color, opacity = '0.7']]) => [
      category,
      { color, opacity, name: t(`sponsorblock.segments.${category}`) },
    ]
  )
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

export function extractWatchVideoId(locationHash: string): string | null {
  const query = locationHash.split('?')[1];
  return query ? new URLSearchParams(query).get('v')?.trim() || null : null;
}

export function getEnabledSkipCategories(
  readConfig: <K extends ConfigKey>(key: K) => boolean = (key) => Boolean(configRead(key))
): SponsorBlockCategory[] {
  return CATEGORY_CONFIG_KEYS.filter(([, key]) => readConfig(key)).map(([category]) => category);
}

/** Returns only SponsorBlock categories currently enabled in settings for fetching. */
export function getRequestedCategories(
  readConfig: <K extends ConfigKey>(key: K) => boolean = (key) => Boolean(configRead(key))
): SponsorBlockCategory[] {
  const categories = getEnabledSkipCategories(readConfig);
  if (readConfig('enableSponsorBlockHighlight')) categories.push('poi_highlight');
  return categories;
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
  private video: HTMLVideoElement | null = null;
  private active = true;
  private abortController = new AbortController();
  private nextSkipTimeout: ReturnType<typeof setTimeout> | null = null;
  private overlayObserver: MutationObserver | null = null;
  private sliderWaitObserver: MutationObserver | null = null;
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

  private readonly playbackEventHandler = (event?: Event): void => {
    if (event?.type !== 'timeupdate') this.syncOldUiOverlayTop();
    this.syncMuteState();
    this.scheduleSkip();
  };

  private readonly durationChangeHandler = (): void => {
    this.buildOverlay();
    this.syncOldUiOverlayTop();
  };

  constructor(videoId: string) {
    this.videoId = videoId;
  }

  async init(): Promise<void> {
    try {
      const segments = await fetchSponsorBlockSegments(this.videoId, this.abortController.signal);
      if (!this.active || segments.length === 0) return;

      this.segments = segments;
      const manual = configRead('sponsorBlockManualSkips');
      this.manualSkippableCategories = new Set(Array.isArray(manual) ? manual : []);
      this.skippableCategories = new Set(getEnabledSkipCategories());

      onVideo((video) => {
        if (!this.active) return;
        this.bindVideo(video);
        this.buildOverlay();
        this.syncOldUiOverlayTop();
        this.syncMuteState();
        this.scheduleSkip(true);
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      console.warn('[SponsorBlock] Failed to load segments:', error);
    }
  }

  getSegments(): readonly SponsorBlockSegment[] {
    return this.segments;
  }

  private bindVideo(video: HTMLVideoElement): void {
    this.video = video;
    const { signal } = this.abortController;
    for (const evt of ['play', 'pause', 'timeupdate', 'seeked'] as const) {
      video.addEventListener(evt, this.playbackEventHandler, { signal });
    }
    video.addEventListener('durationchange', this.durationChangeHandler, { signal });
  }

  private syncOldUiOverlayTop(): void {
    if (!this.segmentsOverlay || document.querySelector('div[idomkey="Metadata-Section"]')) return;
    const sliderRect = document.querySelector('div[idomkey="slider"]')?.getBoundingClientRect();
    if (sliderRect) this.segmentsOverlay.style.setProperty('top', `${sliderRect.top}px`, 'important');
  }

  private syncMuteState(): void {
    if (!this.active || !this.video) return;
    const activeMute = findActiveMuteSegment(this.segments, this.video.currentTime, this.manualSkippableCategories);
    const transition = computeMuteTransition(this.muteState, activeMute, this.video.muted);
    this.muteState = transition.state;
    if (transition.nextMuted !== null) this.video.muted = transition.nextMuted;
    if (transition.toastSegment && configRead('enableSponsorBlockToasts')) {
      const name = BAR_TYPES[transition.toastSegment.category]?.name || transition.toastSegment.category;
      showToast('SponsorBlock', t('sponsorblock.toasts.muting', { segment: name }));
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
    this.overlayObserver = new MutationObserver((mutations) => {
      if (!this.active || !this.segmentsOverlay) return;
      if (mutations.some((m) => Array.from(m.removedNodes).includes(this.segmentsOverlay as Node))) {
        host.appendChild(this.segmentsOverlay);
      }
      const focusable = document.querySelector('ytlr-progress-bar')?.getAttribute('hybridnavfocusable');
      const nextDisplay = focusable === 'false' ? 'none' : 'block';
      if (this.segmentsOverlay.style.display !== nextDisplay) {
        this.segmentsOverlay.style.setProperty('display', nextDisplay, 'important');
      }
    });
    this.overlayObserver.observe(host, { childList: true, subtree: true });
    host.appendChild(overlay);
  }

  private buildOverlay(): void {
    if (!this.active || this.segmentsOverlay || !this.video?.duration) return;

    const tryMount = (): boolean => {
      const slider = document.querySelector('div[idomkey="slider"]');
      const host = document.querySelector('ytlr-redux-connect-ytlr-progress-bar');
      if (!slider || !host || !this.video?.duration) return false;
      this.mountOverlay(slider, host, this.video.duration);
      this.syncOldUiOverlayTop();
      return true;
    };

    if (tryMount() || this.sliderWaitObserver) return;
    this.sliderWaitObserver = new MutationObserver(() => {
      if (!this.active || !this.video?.duration || this.segmentsOverlay || tryMount()) {
        this.sliderWaitObserver?.disconnect();
        this.sliderWaitObserver = null;
      }
    });
    this.sliderWaitObserver.observe(document.documentElement ?? document, { childList: true, subtree: true });
  }

  private clearSkipTimer(): void {
    if (this.nextSkipTimeout !== null) clearTimeout(this.nextSkipTimeout);
    this.nextSkipTimeout = null;
    this.scheduledSegmentUuid = null;
  }

  scheduleSkip(force = false): void {
    if (!this.active || !this.video || this.video.paused || this.segments.length === 0) {
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
      this.nextSkipTimeout !== null &&
      this.scheduledSegmentUuid === segment.UUID &&
      Math.abs(targetSkipAtMs - this.scheduledSkipAtMs) < 150
    ) {
      return;
    }

    this.clearSkipTimer();
    this.scheduledSegmentUuid = segment.UUID;
    this.scheduledSkipAtMs = targetSkipAtMs;
    this.nextSkipTimeout = setTimeout(() => {
      this.nextSkipTimeout = null;
      this.scheduledSegmentUuid = null;
      if (!this.active || !this.video || this.video.paused) return;
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
    }, delayMs);
  }

  destroy(): void {
    this.active = false;
    this.abortController.abort();
    this.clearSkipTimer();
    this.sliderWaitObserver?.disconnect();
    this.sliderWaitObserver = null;
    this.overlayObserver?.disconnect();
    this.overlayObserver = null;
    this.segmentsOverlay?.remove();
    this.segmentsOverlay = null;

    if (this.video) {
      const transition = computeMuteTransition(this.muteState, null, this.video.muted);
      this.muteState = transition.state;
      if (transition.nextMuted !== null) this.video.muted = transition.nextMuted;
      this.video = null;
    }

    this.skippedCategories.clear();
  }
}

let activeHandler: SponsorBlockHandler | null = null;

export function getActiveSponsorBlockSegments(): readonly SponsorBlockSegment[] {
  return activeHandler?.getSegments() ?? [];
}

function destroyActiveHandler(): void {
  if (!activeHandler) return;
  try {
    activeHandler.destroy();
  } catch (error) {
    console.warn('[SponsorBlock] Failed to destroy previous handler:', error);
  }
  activeHandler = null;
}

function handleHashChange(): void {
  const videoId = extractWatchVideoId(location.hash);
  if (!videoId) {
    destroyActiveHandler();
    return;
  }

  if (activeHandler?.videoId === videoId) return;
  destroyActiveHandler();

  if (configRead('enableSponsorBlock')) {
    activeHandler = new SponsorBlockHandler(videoId);
    void activeHandler.init();
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('hashchange', handleHashChange, false);
  void whenConfigReady().then(handleHashChange);
}
