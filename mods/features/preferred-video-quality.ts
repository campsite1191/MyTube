import { NOOP, onAbort, onWatchSession } from '../core/lifecycle.ts';
import { onPlayer } from '../core/player-observer.ts';
import type { YtPlayerStateObject, YtQualityData } from '../types/yttv.ts';
import { isRecord } from '../utils/type-guards.ts';

const PLAYER_STATE_CHANGE_EVENT = 'onStateChange';
const PLAYER_QUALITY_STORAGE_KEY = 'yt-player-quality';
// YouTube TV's storage reader rejects entries older than 30 days and writes 360-day expiry.
const PLAYER_QUALITY_MAX_AGE_MS = 2_592_000_000;
const PLAYER_QUALITY_EXPIRY_MS = 31_104_000_000;
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
  getVideoData?: () => { video_id?: string } | null | undefined;
  getPlaybackQuality?: () => string | null | undefined;
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

function readStoredQualityHeight(raw: string | null, now: number): number | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    if (typeof parsed.expiration !== 'number' || parsed.expiration <= now) return null;
    if (typeof parsed.creation !== 'number' || parsed.creation <= now - PLAYER_QUALITY_MAX_AGE_MS) return null;

    const payload: unknown = typeof parsed.data === 'string' ? JSON.parse(parsed.data) : parsed.data;
    if (!isRecord(payload)) return null;
    return typeof payload.quality === 'number' ? payload.quality : null;
  } catch {
    return null;
  }
}

/**
 * Seeds YouTube's `yt-player-quality` storage preference to 2160p unless a valid entry at or
 * above 2160p is already stored, so Watch playback initializes at the target tier natively.
 */
export function seedPreferredQualityStorage(): boolean {
  let storage: Storage | null = null;
  try {
    storage = typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return false;
  }
  if (!storage) return false;

  const now = Date.now();
  try {
    const existingQuality = readStoredQualityHeight(storage.getItem(PLAYER_QUALITY_STORAGE_KEY), now);
    if (existingQuality !== null && existingQuality >= TARGET_VIDEO_HEIGHT) {
      return false;
    }

    storage.setItem(
      PLAYER_QUALITY_STORAGE_KEY,
      JSON.stringify({
        data: JSON.stringify({ quality: TARGET_VIDEO_HEIGHT, previousQuality: TARGET_VIDEO_HEIGHT }),
        expiration: now + PLAYER_QUALITY_EXPIRY_MS,
        creation: now,
      })
    );
    return true;
  } catch {
    return false;
  }
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

  return ((highestBelowTarget ?? lowestAboveTarget) as ResolutionCandidate).quality;
}

export function applyPreferredQualityToPlayer(player: QualityControllablePlayer): boolean {
  if (!player.setPlaybackQualityRange) return false;

  try {
    const targetQuality = selectPlaybackQuality(player.getAvailableQualityData?.());
    // Skipping setPlaybackQualityRange when already active avoids YouTube's unconditional MSE reload.
    if (player.getPlaybackQuality?.() === targetQuality) {
      return true;
    }
    player.setPlaybackQualityRange(targetQuality, targetQuality);
    return true;
  } catch (error) {
    console.warn('[PreferredQuality] Failed to apply quality:', error);
    return false;
  }
}

export function attachPreferredQualityController(
  player: QualityControllablePlayer,
  signal?: AbortSignal,
  expectedVideoId?: string
): PreferredQualityController {
  const controllerAbort = new AbortController();
  let locked = false;

  const dispose = (): void => {
    if (controllerAbort.signal.aborted) return;
    controllerAbort.abort();
    player.removeEventListener?.(PLAYER_STATE_CHANGE_EVENT, handleStateChange);
  };

  const applyQuality = (): boolean => {
    if (controllerAbort.signal.aborted) return false;
    return applyPreferredQualityToPlayer(player);
  };

  const handleStateChange = (): void => {
    if (controllerAbort.signal.aborted || locked) return;
    const state = player.getPlayerStateObject?.();
    if (!state?.isOrWillBePlaying && !state?.isPlaying) return;

    if (expectedVideoId) {
      const activeVideoId = player.getVideoData?.()?.video_id;
      if (activeVideoId && activeVideoId !== expectedVideoId) {
        return;
      }
    }

    if (player.getAvailableQualityData) {
      const availableQualities = player.getAvailableQualityData();
      const hasConcreteResolution = Boolean(
        availableQualities?.some((entry) => Boolean(entry?.quality) && parseResolutionHeight(entry.qualityLabel) > 0)
      );
      if (!hasConcreteResolution) {
        return;
      }
    }

    // Lock at most once per Watch session so mid-playback MSE loadstart events cannot re-trigger a seek to 0.
    if (applyQuality()) {
      locked = true;
      dispose();
    }
  };

  onAbort(signal, dispose);
  if (!signal?.aborted) {
    handleStateChange();
    if (!controllerAbort.signal.aborted) {
      player.addEventListener(PLAYER_STATE_CHANGE_EVENT, handleStateChange, { signal: controllerAbort.signal });
    }
  }

  return {
    handleStateChange,
    applyQuality,
    dispose,
  };
}

let preferredQualityInstalled = false;

/**
 * Seeds persistent quality preferences and locks Watch sessions to 2160p on initial startup
 * without interrupting Home inline previews or Shorts.
 */
export function installPreferredVideoQuality(): () => void {
  if (preferredQualityInstalled || typeof document === 'undefined' || typeof window === 'undefined') return NOOP;
  preferredQualityInstalled = true;
  seedPreferredQualityStorage();
  const unsub = onWatchSession((videoId, signal) => {
    onPlayer((player) => {
      attachPreferredQualityController(player, signal, videoId);
    }, signal);
  });

  return () => {
    unsub();
    preferredQualityInstalled = false;
  };
}
