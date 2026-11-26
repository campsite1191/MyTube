import type { AdaptiveFormat } from '../types/innertube.ts';
import { isRecord, readRecordPath } from '../utils/type-guards.ts';

export interface AudioFormatEntry extends AdaptiveFormat {
  audioChannels?: number;
  bitrate?: number;
  xtags?: string;
  isDrc?: boolean;
  isVb?: boolean;
  isVoiceBoost?: boolean;
}

/**
 * Decodes InnerTube `xtags` from either plain `key=value` tokens or YouTube's
 * base64url-encoded protobuf (`0x0a` entry -> `0x0a` key, `0x12` value).
 */
export function parseXtags(raw: string | undefined): Record<string, string> {
  const tags: Record<string, string> = {};
  if (!raw) return tags;

  if (/[a-z0-9_-]=[^=]/i.test(raw)) {
    for (const part of raw.split(/[:;&,]/)) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      const key = part.slice(0, eq).trim().toLowerCase();
      const val = part
        .slice(eq + 1)
        .trim()
        .toLowerCase();
      if (key && val) tags[key] = val;
    }
    return tags;
  }

  try {
    const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
    const pad = (4 - (normalized.length % 4)) % 4;
    const bin = atob(`${normalized}${'='.repeat(pad)}`);
    let i = 0;

    while (i + 1 < bin.length) {
      const tag = bin.charCodeAt(i++);
      const len = bin.charCodeAt(i++);
      if (i + len > bin.length) break;
      const end = i + len;
      if (tag !== 0x0a) {
        i = end;
        continue;
      }

      let key = '';
      let val = '';
      while (i + 1 < end) {
        const fieldTag = bin.charCodeAt(i++);
        const fieldLen = bin.charCodeAt(i++);
        if (i + fieldLen > end) break;
        const slice = bin.slice(i, i + fieldLen).toLowerCase();
        i += fieldLen;
        if (fieldTag === 0x0a) key = slice;
        else if (fieldTag === 0x12) val = slice;
      }
      i = end;
      if (key && val) tags[key] = val;
    }
  } catch {
    return tags;
  }

  return tags;
}

function getAudioTierFromTags(fmt: AudioFormatEntry, tags: Record<string, string>): number {
  const channels = typeof fmt.audioChannels === 'number' ? fmt.audioChannels : 0;
  if (channels > 6) return 1;
  if (channels > 2 || /ec-3|ac-3/i.test(fmt.mimeType || '')) return 2;

  if (fmt.isDrc || (tags.drc && tags.drc !== '0')) return 5;
  if (
    fmt.isVb ||
    fmt.isVoiceBoost ||
    (tags.vb && tags.vb !== '0') ||
    /\bvoice[\s_-]*boost\b/i.test(fmt.audioTrack?.displayName || '')
  ) {
    return 4;
  }
  return 3;
}

export function getAudioTier(fmt: AudioFormatEntry): number {
  return getAudioTierFromTags(fmt, parseXtags(fmt.xtags));
}

interface TrackSummary {
  id: string;
  displayName: string;
  isOriginal: boolean;
  isAutoDubbed: boolean;
  isDescriptive: boolean;
  rank: number;
  bestTier: number;
  bestChannels: number;
  sourceDefault: boolean;
  firstIndex: number;
}

function getTrackRank(track: TrackSummary): number {
  if (track.isDescriptive) return 3;
  if (track.isAutoDubbed) return 2;
  if (track.isOriginal) return 0;
  return 1;
}

function compareTrackSummaries(a: TrackSummary, b: TrackSummary): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.rank > 0 && a.sourceDefault !== b.sourceDefault) return a.sourceDefault ? -1 : 1;
  if (a.bestTier !== b.bestTier) return a.bestTier - b.bestTier;
  if (a.bestChannels !== b.bestChannels) return b.bestChannels - a.bestChannels;
  if (a.sourceDefault !== b.sourceDefault) return a.sourceDefault ? -1 : 1;
  const nameCmp = a.displayName.localeCompare(b.displayName);
  if (nameCmp !== 0) return nameCmp;
  return a.firstIndex - b.firstIndex;
}

/**
 * Preserves video formats and all audio tracks, ordering tracks as
 * `Original -> Standard -> Auto-Dubbed -> Descriptive` (keeping `sourceDefault` ahead of codec tier
 * for non-original tracks) and sorting formats by `7.1 -> 5.1 -> Clean Stereo -> Voice Boost -> DRC`
 * and bitrate descending, while marking the best track as `audioIsDefault: true`.
 */
export function filterStreamingFormats(formats: AudioFormatEntry[]): AudioFormatEntry[] {
  const nonAudio: AudioFormatEntry[] = [];
  const tracks = new Map<string, TrackSummary>();
  const audioEntries: Array<{
    fmt: AudioFormatEntry;
    track: TrackSummary;
    tier: number;
    channels: number;
    bitrate: number;
  }> = [];

  for (let i = 0; i < formats.length; i++) {
    const fmt = formats[i];
    if (!fmt) continue;
    if (!fmt.mimeType?.startsWith('audio/')) {
      nonAudio.push(fmt);
      continue;
    }

    const tags = parseXtags(fmt.xtags);
    const id = fmt.audioTrack?.id ?? '';
    const displayName = fmt.audioTrack?.displayName ?? '';
    const tier = getAudioTierFromTags(fmt, tags);
    const channels = typeof fmt.audioChannels === 'number' ? fmt.audioChannels : 0;
    const isDescriptive = tags.acont === 'descriptive' || /\b(?:descriptive|audio\s*description)\b/i.test(displayName);
    const isAutoDubbed =
      Boolean(fmt.audioTrack?.isAutoDubbed) ||
      tags.acont === 'dubbed-auto' ||
      /\bauto[-\s]?dub(?:bed)?\b/i.test(displayName);
    const isOriginal = Boolean(
      id && (tags.acont === 'original' || /\boriginal\b/i.test(displayName) || id.endsWith('.4'))
    );

    let track = tracks.get(id);
    if (!track) {
      track = {
        id,
        displayName,
        isOriginal,
        isAutoDubbed,
        isDescriptive,
        rank: 1,
        bestTier: tier,
        bestChannels: channels,
        sourceDefault: Boolean(fmt.audioTrack?.audioIsDefault),
        firstIndex: i,
      };
      tracks.set(id, track);
    } else {
      if (!track.displayName && displayName) track.displayName = displayName;
      if (isDescriptive) track.isDescriptive = true;
      if (isAutoDubbed) track.isAutoDubbed = true;
      if (isOriginal) track.isOriginal = true;
      if (tier < track.bestTier || (tier === track.bestTier && channels > track.bestChannels)) {
        track.bestTier = tier;
        track.bestChannels = channels;
      }
      if (fmt.audioTrack?.audioIsDefault) track.sourceDefault = true;
    }

    audioEntries.push({
      fmt,
      track,
      tier,
      channels,
      bitrate: typeof fmt.bitrate === 'number' ? fmt.bitrate : 0,
    });
  }

  if (audioEntries.length === 0) return formats;

  for (const track of tracks.values()) {
    track.rank = getTrackRank(track);
  }

  const sortedAudio = audioEntries
    .toSorted((a, b) => {
      if (a.track !== b.track) return compareTrackSummaries(a.track, b.track);
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (a.channels !== b.channels) return b.channels - a.channels;
      return b.bitrate - a.bitrate;
    })
    .map((entry) => entry.fmt);

  const bestTrackId = (sortedAudio[0] as AudioFormatEntry).audioTrack?.id ?? '';
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
  const tracklist =
    readRecordPath(payload, 'captions', 'playerCaptionsTracklistRenderer') ??
    readRecordPath(payload, 'playerResponse', 'captions', 'playerCaptionsTracklistRenderer');

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
      return !readRecordPath(entry, 'command', 'reelWatchEndpoint', 'adClientParams')?.isAd;
    });
  }
}
