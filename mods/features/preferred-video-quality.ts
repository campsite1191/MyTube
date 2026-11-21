import { configRead, onConfigChange, whenConfigReady } from '../core/config.ts';
import { onPlayer } from '../core/player-observer.ts';
import type { YtPlayerStateObject, YtQualityData, YtVideoData } from '../types/yttv.ts';

const PLAYER_STATE_CHANGE_EVENT = 'onStateChange';
const PREFERRED_VIDEO_QUALITY_KEY = 'preferredVideoQuality';
const HIGHRES_QUALITY_ID = 'highres';
const SHORTS_STAT_MARKER = 'shortspage';

export interface QualityControllablePlayer {
  addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
  removeEventListener?: (type: string, listener: EventListenerOrEventListenerObject) => void;
  getPlayerStateObject?: () => YtPlayerStateObject | null | undefined;
  getVideoData?: () => YtVideoData | null | undefined;
  getVideoStats?: () => Record<string, unknown> | null | undefined;
  getAvailableQualityData?: () => readonly YtQualityData[] | null | undefined;
  setPlaybackQualityRange?: (minQuality: string, maxQuality: string) => void;
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

export function selectPlaybackQuality(
  availableQualities: readonly YtQualityData[] | null | undefined,
  preferredQuality: string | null | undefined
): string | null {
  if (!preferredQuality || preferredQuality === 'auto') return null;

  const targetHeight = parseResolutionHeight(preferredQuality);
  if (targetHeight <= 0) return null;

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

  const exactMatch = candidates.find((candidate) => candidate.height === targetHeight);
  if (exactMatch) return exactMatch.quality;

  let highestBelowTarget: ResolutionCandidate | null = null;
  let lowestAboveTarget: ResolutionCandidate | null = null;

  for (const candidate of candidates) {
    if (candidate.height <= targetHeight) {
      if (!highestBelowTarget || candidate.height > highestBelowTarget.height) {
        highestBelowTarget = candidate;
      }
    } else if (!lowestAboveTarget || candidate.height < lowestAboveTarget.height) {
      lowestAboveTarget = candidate;
    }
  }

  return highestBelowTarget?.quality ?? lowestAboveTarget?.quality ?? HIGHRES_QUALITY_ID;
}

export function isShortsPlayback(player: QualityControllablePlayer | null | undefined): boolean {
  const videoStats = player?.getVideoStats?.();
  if (!videoStats || typeof videoStats !== 'object') return false;
  for (const key in videoStats) {
    if (Object.hasOwn(videoStats, key) && videoStats[key] === SHORTS_STAT_MARKER) return true;
  }
  return false;
}

export function applyPreferredQualityToPlayer(
  player: QualityControllablePlayer,
  preferredQuality: string = configRead(PREFERRED_VIDEO_QUALITY_KEY)
): boolean {
  if (!player.setPlaybackQualityRange) return false;

  try {
    const availableQualities = player.getAvailableQualityData?.();
    const targetQuality = selectPlaybackQuality(availableQualities, preferredQuality);
    if (!targetQuality) return false;

    player.setPlaybackQualityRange(targetQuality, targetQuality);
    return true;
  } catch (error) {
    console.warn('[PreferredQuality] Failed to apply quality:', error);
    return false;
  }
}

export function attachPreferredQualityController(
  player: QualityControllablePlayer,
  getPreferredQuality: () => string = () => configRead(PREFERRED_VIDEO_QUALITY_KEY)
): PreferredQualityController {
  let lastVideoId: string | undefined;
  let hasAppliedForCurrentVideo = false;

  const applyQuality = (): boolean => {
    if (isShortsPlayback(player)) return false;
    return applyPreferredQualityToPlayer(player, getPreferredQuality());
  };

  const handleStateChange = (): void => {
    const playerState = player.getPlayerStateObject?.();
    const videoId = player.getVideoData?.()?.video_id;

    if (videoId !== lastVideoId) {
      lastVideoId = videoId;
      hasAppliedForCurrentVideo = false;
    }

    if (playerState?.isPlaying && !hasAppliedForCurrentVideo && !isShortsPlayback(player)) {
      if (applyQuality()) {
        hasAppliedForCurrentVideo = true;
      }
    }
  };

  player.addEventListener(PLAYER_STATE_CHANGE_EVENT, handleStateChange);
  const stopConfigWatch = onConfigChange(PREFERRED_VIDEO_QUALITY_KEY, () => applyQuality());
  handleStateChange();

  return {
    handleStateChange,
    applyQuality,
    dispose: () => {
      player.removeEventListener?.(PLAYER_STATE_CHANGE_EVENT, handleStateChange);
      stopConfigWatch();
    },
  };
}

function initPreferredVideoQuality(): void {
  onPlayer((player) => {
    attachPreferredQualityController(player);
  });
}

if (typeof document !== 'undefined') {
  void whenConfigReady().then(initPreferredVideoQuality);
}
