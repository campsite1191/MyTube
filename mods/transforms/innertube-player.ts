import type { AdaptiveFormat } from '../types/innertube.ts';
import { isRecord } from '../utils/type-guards.ts';

export interface AudioFormatEntry extends AdaptiveFormat {
  audioChannels?: number;
  bitrate?: number;
  xtags?: string;
  isDrc?: boolean;
  isVoiceBoost?: boolean;
}

export function getAudioTier(fmt: AudioFormatEntry): number {
  const channels = typeof fmt.audioChannels === 'number' ? fmt.audioChannels : 0;
  if (channels > 6) return 1;
  if (channels > 2 || /ec-3|ac-3/i.test(fmt.mimeType || '')) return 2;

  const xtags = String(fmt.xtags || '');
  const isDrc = Boolean(fmt.isDrc || /drc=1/i.test(xtags));
  if (
    !isDrc &&
    (fmt.isVoiceBoost || /vb=|voice[_-]?boost/i.test(xtags) || /voice\s*boost/i.test(fmt.audioTrack?.displayName || ''))
  ) {
    return 3;
  }
  return isDrc ? 5 : 4;
}

interface TrackSummary {
  id: string;
  displayName: string;
  isOriginal: boolean;
  bestTier: number;
  bestChannels: number;
  sourceDefault: boolean;
  firstIndex: number;
}

function compareTrackSummaries(a: TrackSummary, b: TrackSummary): number {
  if (a.isOriginal !== b.isOriginal) return a.isOriginal ? -1 : 1;
  if (a.bestTier !== b.bestTier) return a.bestTier - b.bestTier;
  if (a.bestChannels !== b.bestChannels) return b.bestChannels - a.bestChannels;
  if (a.sourceDefault !== b.sourceDefault) return a.sourceDefault ? -1 : 1;
  return a.firstIndex - b.firstIndex;
}

/**
 * Preserves video formats and all audio tracks, ordering audio formats in recommended order
 * (best/original track first, then highest tier `7.1 -> 5.1 Surround -> Voice Boost -> Original Stereo -> DRC`
 * and bitrate descending) and marking the best track as initially selected (`audioIsDefault: true`).
 */
export function filterStreamingFormats(formats: AudioFormatEntry[]): AudioFormatEntry[] {
  const nonAudio: AudioFormatEntry[] = [];
  const audio: AudioFormatEntry[] = [];
  const tracks = new Map<string, TrackSummary>();

  for (let i = 0; i < formats.length; i++) {
    const fmt = formats[i];
    if (!fmt) continue;
    if (!fmt.mimeType?.startsWith('audio/')) {
      nonAudio.push(fmt);
      continue;
    }

    audio.push(fmt);
    const id = fmt.audioTrack?.id ?? '';
    const displayName = fmt.audioTrack?.displayName ?? '';
    const tier = getAudioTier(fmt);
    const channels = typeof fmt.audioChannels === 'number' ? fmt.audioChannels : 0;
    const isOriginal = Boolean(id && (/\boriginal\b/i.test(displayName) || id.endsWith('.4')));
    const existing = tracks.get(id);

    if (!existing) {
      tracks.set(id, {
        id,
        displayName,
        isOriginal,
        bestTier: tier,
        bestChannels: channels,
        sourceDefault: Boolean(fmt.audioTrack?.audioIsDefault),
        firstIndex: i,
      });
    } else {
      if (!existing.displayName && displayName) existing.displayName = displayName;
      if (isOriginal) existing.isOriginal = true;
      if (tier < existing.bestTier || (tier === existing.bestTier && channels > existing.bestChannels)) {
        existing.bestTier = tier;
        existing.bestChannels = channels;
      }
      if (fmt.audioTrack?.audioIsDefault) existing.sourceDefault = true;
    }
  }

  if (audio.length === 0) return formats;

  const rankedTracks = Array.from(tracks.values()).toSorted(compareTrackSummaries);
  const bestTrackId = rankedTracks[0]?.id ?? '';

  const sortedAudio = audio.toSorted((a, b) => {
    const aId = a.audioTrack?.id ?? '';
    const bId = b.audioTrack?.id ?? '';
    const aIsBestTrack = aId === bestTrackId;
    const bIsBestTrack = bId === bestTrackId;
    if (aIsBestTrack !== bIsBestTrack) return aIsBestTrack ? -1 : 1;

    if (aId !== bId) {
      const aTrack = tracks.get(aId);
      const bTrack = tracks.get(bId);
      if (aTrack && bTrack) {
        if (aTrack.isOriginal !== bTrack.isOriginal) return aTrack.isOriginal ? -1 : 1;
        if (aTrack.bestTier !== bTrack.bestTier) return aTrack.bestTier - bTrack.bestTier;
        const nameCmp = aTrack.displayName.localeCompare(bTrack.displayName);
        if (nameCmp !== 0) return nameCmp;
        if (aTrack.firstIndex !== bTrack.firstIndex) return aTrack.firstIndex - bTrack.firstIndex;
      }
    }

    const tierDiff = getAudioTier(a) - getAudioTier(b);
    if (tierDiff !== 0) return tierDiff;

    const aChannels = typeof a.audioChannels === 'number' ? a.audioChannels : 0;
    const bChannels = typeof b.audioChannels === 'number' ? b.audioChannels : 0;
    if (aChannels !== bChannels) return bChannels - aChannels;

    const aBitrate = typeof a.bitrate === 'number' ? a.bitrate : 0;
    const bBitrate = typeof b.bitrate === 'number' ? b.bitrate : 0;
    return bBitrate - aBitrate;
  });

  if (bestTrackId) {
    for (const fmt of sortedAudio) {
      if (fmt.audioTrack) {
        fmt.audioTrack.audioIsDefault = fmt.audioTrack.id === bestTrackId;
      }
    }
  }

  return [...nonAudio, ...sortedAudio];
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

export function dedupeAndSortSubscriptionTabs(tabs: SubscriptionTab[], seenTabs: Set<string>): SubscriptionTab[] {
  return tabs
    .filter((tab) => {
      const tr = tab.tabRenderer;
      if (!tr) return true;
      const ep = tr.endpoint?.browseEndpoint;
      const key = ep?.browseId ? `${ep.browseId}:${ep.params || tr.title || ''}` : tr.tabIdentifier || tr.title;
      if (!key) return true;
      if (seenTabs.has(key)) return false;
      seenTabs.add(key);
      return true;
    })
    .toSorted((a, b) => {
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
