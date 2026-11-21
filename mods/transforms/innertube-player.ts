import type { AdaptiveFormat } from '../types/innertube.ts';
import { isRecord } from '../utils/type-guards.ts';

export interface AudioFormatEntry extends AdaptiveFormat {
  audioChannels?: number;
  xtags?: string;
  isDrc?: boolean;
  isVoiceBoost?: boolean;
}

export function getAudioTier(fmt: AudioFormatEntry, preferDrcAudio = false): number {
  const channels = typeof fmt.audioChannels === 'number' ? fmt.audioChannels : 0;
  if (channels > 6) return 1;
  if (channels > 2 || /ec-3|ac-3/i.test(fmt.mimeType || '')) return 2;

  const xtags = String(fmt.xtags || '');
  const isDrc = Boolean(fmt.isDrc || /drc=1/i.test(xtags));
  if (preferDrcAudio && isDrc) {
    return 3;
  }
  if (
    !isDrc &&
    (fmt.isVoiceBoost || /vb=|voice[_-]?boost/i.test(xtags) || /voice\s*boost/i.test(fmt.audioTrack?.displayName || ''))
  ) {
    return preferDrcAudio ? 4 : 3;
  }
  if (preferDrcAudio) {
    return 5;
  }
  return isDrc ? 5 : 4;
}

/**
 * Filters `adaptiveFormats` by preferred video codec (when set) and enforces
 * Cobalt's preferred original-track audio priority:
 * 7.1 -> 5.1 Surround -> Voice Boost -> Original Stereo -> DRC
 * (or DRC ahead of Voice Boost / Stereo when `preferDrcAudio` is true).
 */
export function filterStreamingFormats(
  formats: AudioFormatEntry[],
  preferredCodec = 'any',
  preferDrcAudio = false
): AudioFormatEntry[] {
  let result = formats;

  if (preferredCodec && preferredCodec !== 'any') {
    const hasPreferred = result.some((fmt) => fmt.mimeType?.includes(preferredCodec));
    if (hasPreferred) {
      result = result.filter((fmt) => fmt.mimeType?.startsWith('audio/') || fmt.mimeType?.includes(preferredCodec));
    }
  }

  let firstId: string | null = null;
  let hasMultiple = false;
  let originalId: string | null = null;
  let fallbackId: string | null = null;

  for (const fmt of result) {
    if (!fmt?.mimeType?.startsWith('audio/')) continue;
    const at = fmt.audioTrack;
    const id = at?.id;
    if (!id) continue;
    if (firstId === null) firstId = id;
    else if (id !== firstId) hasMultiple = true;
    if (!originalId && /\boriginal\b/i.test(at.displayName || '')) originalId = id;
    if (!fallbackId && id.endsWith('.4')) fallbackId = id;
  }

  const targetId = hasMultiple ? originalId || fallbackId : null;
  let bestTier = Number.POSITIVE_INFINITY;
  let needsFilter = false;

  for (const fmt of result) {
    if (!fmt?.mimeType?.startsWith('audio/')) continue;
    if (targetId && fmt.audioTrack?.id !== targetId) {
      needsFilter = true;
      continue;
    }
    const tier = getAudioTier(fmt, preferDrcAudio);
    if (tier < bestTier) {
      if (bestTier !== Number.POSITIVE_INFINITY) needsFilter = true;
      bestTier = tier;
    } else if (tier > bestTier) {
      needsFilter = true;
    }
  }

  if (bestTier !== Number.POSITIVE_INFINITY && (needsFilter || targetId)) {
    return result.filter((fmt) => {
      if (!fmt?.mimeType?.startsWith('audio/')) return true;
      if (targetId && fmt.audioTrack?.id !== targetId) return false;
      if (getAudioTier(fmt, preferDrcAudio) !== bestTier) return false;
      if (targetId && fmt.audioTrack) fmt.audioTrack.audioIsDefault = true;
      return true;
    });
  }

  return result;
}

/**
 * Forces YouTube TV's initial caption state to OFF so auto-captions do not turn
 * on unexpectedly at playback start (manual CC toggling remains unaffected).
 */
export function disableAutoCaptionsInPayload(payload: Record<string, unknown>): void {
  const captions = isRecord(payload.captions) ? payload.captions : undefined;
  const playerResponse = isRecord(payload.playerResponse) ? payload.playerResponse : undefined;
  const prCaptions = isRecord(playerResponse?.captions) ? playerResponse.captions : undefined;
  const tracklist = isRecord(captions?.playerCaptionsTracklistRenderer)
    ? captions.playerCaptionsTracklistRenderer
    : isRecord(prCaptions?.playerCaptionsTracklistRenderer)
      ? prCaptions.playerCaptionsTracklistRenderer
      : undefined;

  if (!tracklist) return;

  tracklist.captionsInitialState = 'CAPTIONS_INITIAL_STATE_OFF_REQUIRED';
  if (!Array.isArray(tracklist.audioTracks)) return;

  for (const track of tracklist.audioTracks) {
    if (!isRecord(track)) continue;
    track.captionsInitialState = 'CAPTIONS_INITIAL_STATE_OFF_REQUIRED';
    track.visibility = 'OFF';
    track.hasDefaultTrack = false;
    delete track.defaultCaptionTrackIndex;
  }
}

export interface SubscriptionTab {
  tabRenderer?: {
    selected?: boolean;
    title?: string;
    tabIdentifier?: string;
    endpoint?: {
      browseEndpoint?: {
        browseId?: string;
        params?: string;
      };
    };
    content?: {
      tvSurfaceContentRenderer?: {
        content?: unknown;
      };
    };
  };
}

export function dedupeAndSortSubscriptionTabs(
  tabs: SubscriptionTab[],
  seenTabs: Set<string>,
  sortAlphabetically: boolean
): SubscriptionTab[] {
  const deduped = tabs.filter((tab) => {
    const tr = tab.tabRenderer;
    if (!tr) return true;
    const ep = tr.endpoint?.browseEndpoint;
    const key = ep?.browseId ? `${ep.browseId}:${ep.params || tr.title || ''}` : tr.tabIdentifier || tr.title;
    if (!key) return true;
    if (seenTabs.has(key)) return false;
    seenTabs.add(key);
    return true;
  });

  if (!sortAlphabetically) return deduped;

  return deduped.toSorted((a, b) => {
    if (a.tabRenderer?.selected && !b.tabRenderer?.selected) return -1;
    if (!a.tabRenderer?.selected && b.tabRenderer?.selected) return 1;
    return (a.tabRenderer?.title || '').localeCompare(b.tabRenderer?.title || '');
  });
}

/**
 * Strips InnerTube ad placements, player ads, ad slots, and Shorts ad entries in place.
 */
export function stripAdsFromPayload(payload: Record<string, unknown>): void {
  if (payload.adPlacements) {
    payload.adPlacements = [];
  }
  if (payload.playerAds) {
    payload.playerAds = false;
  }
  if (payload.adSlots) {
    payload.adSlots = [];
  }
  if (Array.isArray(payload.entries)) {
    payload.entries = payload.entries.filter((entry) => {
      if (!isRecord(entry)) return true;
      const cmd = isRecord(entry.command) ? entry.command : undefined;
      const reelEp = isRecord(cmd?.reelWatchEndpoint) ? cmd.reelWatchEndpoint : undefined;
      const adParams = isRecord(reelEp?.adClientParams) ? reelEp.adClientParams : undefined;
      return !adParams?.isAd;
    });
  }
}
