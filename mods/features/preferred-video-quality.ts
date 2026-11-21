import { onAbort } from '../core/lifecycle.ts';
import { onPlayer, onVideo } from '../core/player-observer.ts';
import type { YtPlayerStateObject, YtQualityData } from '../types/yttv.ts';

const PLAYER_STATE_CHANGE_EVENT = 'onStateChange';
const TARGET_VIDEO_HEIGHT = 2160;
const HIGHRES_QUALITY_ID = 'highres';

export interface QualityControllablePlayer {
  addEventListener: (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ) => void;
  removeEventListener?: (type: string, listener: EventListenerOrEventListenerObject) => void;
  getPlayerStateObject?: () => YtPlayerStateObject | null | undefined;
  getAvailableQualityData?: () => readonly YtQualityData[] | null | undefined;
  setPlaybackQualityRange?: (minQuality: string, maxQuality: string) => void;
}

export interface QualityVideoTarget {
  addEventListener: (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ) => void;
  removeEventListener?: (type: string, listener: EventListenerOrEventListenerObject) => void;
}

export interface PreferredQualityController {
  handleStateChange: () => void;
  applyQuality: () => boolean;
  dispose: () => void;
}

interface ResolutionCandidate {
  quality: string;
  height: number;
}

export function parseResolutionHeight(label: string | null | undefined): number {
  if (!label || typeof label !== 'string') return 0;
  const parsedHeight = Number.parseInt(label, 10);
  return Number.isFinite(parsedHeight) && parsedHeight > 0 ? parsedHeight : 0;
}

export function selectPlaybackQuality(availableQualities: readonly YtQualityData[] | null | undefined): string {
  if (!availableQualities || availableQualities.length === 0) return HIGHRES_QUALITY_ID;

  const candidates: ResolutionCandidate[] = [];
  for (const qualityEntry of availableQualities) {
    if (!qualityEntry?.quality) continue;
    const height = parseResolutionHeight(qualityEntry.qualityLabel);
    if (height > 0) {
      candidates.push({ quality: qualityEntry.quality, height });
    }
  }

  if (candidates.length === 0) return HIGHRES_QUALITY_ID;

  const exactMatch = candidates.find((candidate) => candidate.height === TARGET_VIDEO_HEIGHT);
  if (exactMatch) return exactMatch.quality;

  let highestBelowTarget: ResolutionCandidate | null = null;
  let lowestAboveTarget: ResolutionCandidate | null = null;

  for (const candidate of candidates) {
    if (candidate.height <= TARGET_VIDEO_HEIGHT) {
      if (!highestBelowTarget || candidate.height > highestBelowTarget.height) {
        highestBelowTarget = candidate;
      }
    } else if (!lowestAboveTarget || candidate.height < lowestAboveTarget.height) {
      lowestAboveTarget = candidate;
    }
  }

  return highestBelowTarget?.quality ?? lowestAboveTarget?.quality ?? HIGHRES_QUALITY_ID;
}

export function applyPreferredQualityToPlayer(player: QualityControllablePlayer): boolean {
  if (!player.setPlaybackQualityRange) return false;

  try {
    const targetQuality = selectPlaybackQuality(player.getAvailableQualityData?.());
    player.setPlaybackQualityRange(targetQuality, targetQuality);
    return true;
  } catch (error) {
    console.warn('[PreferredQuality] Failed to apply quality:', error);
    return false;
  }
}

export function attachPreferredQualityController(
  player: QualityControllablePlayer,
  video?: QualityVideoTarget | null,
  signal?: AbortSignal
): PreferredQualityController {
  const controllerAbort = new AbortController();
  let playAbort: AbortController | null = null;

  const disarmFirstPlay = (): void => {
    playAbort?.abort();
    playAbort = null;
    player.removeEventListener?.(PLAYER_STATE_CHANGE_EVENT, handleStateChange);
  };

  const applyQuality = (): boolean => {
    if (controllerAbort.signal.aborted) return false;
    return applyPreferredQualityToPlayer(player);
  };

  const handleStateChange = (): void => {
    if (controllerAbort.signal.aborted || !player.getPlayerStateObject?.()?.isPlaying) return;
    // Once quality locks on first play for the loaded media, detach onStateChange until next loadstart.
    if (applyQuality()) {
      disarmFirstPlay();
    }
  };

  const armFirstPlay = (): void => {
    if (controllerAbort.signal.aborted) return;
    disarmFirstPlay();
    playAbort = new AbortController();
    handleStateChange();
    if (playAbort && !playAbort.signal.aborted) {
      player.addEventListener(PLAYER_STATE_CHANGE_EVENT, handleStateChange, { signal: playAbort.signal });
    }
  };

  const dispose = (): void => {
    if (controllerAbort.signal.aborted) return;
    controllerAbort.abort();
    disarmFirstPlay();
    video?.removeEventListener?.('loadstart', armFirstPlay);
  };

  onAbort(signal, dispose);
  if (!signal?.aborted) {
    video?.addEventListener('loadstart', armFirstPlay, { signal: controllerAbort.signal });
    armFirstPlay();
  }

  return {
    handleStateChange,
    applyQuality,
    dispose,
  };
}

let preferredQualityInstalled = false;

/**
 * Applies preferred playback quality on first play for every media load across the app
 * (Watch videos, Shorts, and inline Previews), keeping zero state listeners active after lock.
 */
export function installPreferredVideoQuality(): void {
  if (preferredQualityInstalled || typeof document === 'undefined' || typeof window === 'undefined') return;
  preferredQualityInstalled = true;
  onPlayer((player) => {
    onVideo((video) => {
      attachPreferredQualityController(player, video);
    });
  });
}
