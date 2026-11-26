import { t } from '../core/i18n.ts';
import { getActiveWatchVideoId } from '../core/lifecycle.ts';
import type { FormattedText } from '../types/innertube.ts';
import { readFormattedText } from '../utils/innertube-ast.ts';
import { isRecord, readRecordPath } from '../utils/type-guards.ts';
import { buildHq720Url } from './thumbnails.ts';

export interface ChapterTimestamp {
  time: number;
  name: string;
}

export interface ChapterMarkerEntity {
  entityKey: string;
  type: 'ENTITY_MUTATION_TYPE_REPLACE';
  payload: {
    macroMarkersListEntity: Record<string, unknown>;
  };
}

const TIMESTAMP_RE = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\s+(.*))?$/;
const LEADING_SEPARATOR_RE = /^[-–—:|•]+\s*/;

/**
 * Parses `m:ss` or `h:mm:ss` timestamp lines from a video description into millisecond chapters.
 */
export function parseTimestamps(input: string): ChapterTimestamp[] {
  const lines = input.trim().split(/\r?\n/);
  const result: ChapterTimestamp[] = [];

  for (const rawLine of lines) {
    const match = rawLine.trim().match(TIMESTAMP_RE) as
      | [string, string | undefined, string, string, string | undefined]
      | null;
    if (!match) continue;
    const hasHours = match[1] !== undefined;
    const hours = match[1] !== undefined ? Number.parseInt(match[1], 10) : 0;
    const minutes = Number.parseInt(match[2], 10);
    const seconds = Number.parseInt(match[3], 10);
    if (seconds >= 60 || (hasHours && minutes >= 60)) continue;

    const milliseconds = (hours * 3600 + minutes * 60 + seconds) * 1000;
    const name = (match[4] ?? '').replace(LEADING_SEPARATOR_RE, '').trim();
    result.push({ time: milliseconds, name });
  }

  return result;
}

function createMarker(title: string, start: string, duration: string, videoId: string, index: number) {
  const markerKey = `${videoId}${start}${duration}`;
  return {
    title: {
      simpleText: title,
    },
    startMillis: start,
    durationMillis: duration,
    thumbnailDetails: {
      thumbnails: [
        {
          url: buildHq720Url(videoId),
          width: 1280,
          height: 720,
        },
      ],
    },
    onActive: {
      innertubeCommand: {
        clickTrackingParams: null,
        entityUpdateCommand: {
          entityBatchUpdate: {
            mutations: [
              {
                entityKey: markerKey,
                type: 'ENTITY_MUTATION_TYPE_REPLACE',
                payload: {
                  markersEngagementPanelSyncEntity: {
                    key: markerKey,
                    panelId: 'engagement-panel-macro-markers-description-chapters',
                    activeItemIndex: index,
                    syncEnabled: true,
                  },
                },
              },
            ],
          },
        },
      },
    },
  };
}

function createMarkerEntity(videoId: string, markers: unknown[]): ChapterMarkerEntity {
  return {
    entityKey: `${videoId}-key`,
    type: 'ENTITY_MUTATION_TYPE_REPLACE',
    payload: {
      macroMarkersListEntity: {
        key: `${videoId}-key`,
        externalVideoId: videoId,
        markersList: {
          markerType: 'MARKER_TYPE_CHAPTERS',
          markers,
          headerTitle: {
            runs: [
              {
                text: t('player.chapters.title'),
              },
            ],
          },
          onTap: {
            innertubeCommand: {
              clickTrackingParams: null,
              changeEngagementPanelVisibilityAction: {
                targetId: 'engagement-panel-macro-markers-description-chapters',
                visibility: 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED',
              },
            },
          },
          markersEdu: {
            enterNudgeText: {
              runs: [
                {
                  text: t('player.chapters.enterNudge'),
                },
              ],
            },
            enterNudgeA11yText: t('player.chapters.enterNudge'),
            navNudgeText: {
              runs: [
                {
                  text: t('player.chapters.navNudge'),
                },
              ],
            },
            navNudgeA11yText: t('player.chapters.navNudgeA11y'),
          },
          loggingDirectives: {
            trackingParams: null,
            enableDisplayloggerExperiment: true,
          },
        },
      },
    },
  };
}

function hasNativeChapters(video: Record<string, unknown>): boolean {
  const batchUpdate = readRecordPath(video, 'frameworkUpdates', 'entityBatchUpdate');
  const mutations = Array.isArray(batchUpdate?.mutations) ? batchUpdate.mutations : undefined;
  if (!mutations) return false;

  return mutations.some((mutation) => {
    const markersList = readRecordPath(mutation, 'payload', 'macroMarkersListEntity', 'markersList');
    return markersList?.markerType === 'MARKER_TYPE_CHAPTERS';
  });
}

function extractVideoMetadataRenderer(video: Record<string, unknown>): Record<string, unknown> | undefined {
  const innerResults = readRecordPath(video, 'contents', 'singleColumnWatchNextResults', 'results', 'results');
  const sectionList = Array.isArray(innerResults?.contents) ? innerResults.contents : undefined;
  if (!sectionList) return undefined;

  for (const section of sectionList) {
    const itemSection = readRecordPath(section, 'itemSectionRenderer');
    const sectionItems = Array.isArray(itemSection?.contents) ? itemSection.contents : undefined;
    if (!sectionItems) continue;
    for (const item of sectionItems) {
      const metadata = readRecordPath(item, 'videoMetadataRenderer');
      if (metadata) return metadata;
    }
  }
  return undefined;
}

let lastKnownVideoDuration: { videoId: string; durationMs: number } | null = null;

function parseLengthSecondsMs(rawLength: unknown): number {
  const lengthSeconds =
    typeof rawLength === 'number'
      ? rawLength
      : typeof rawLength === 'string'
        ? Number.parseFloat(rawLength)
        : Number.NaN;
  return Number.isFinite(lengthSeconds) && lengthSeconds > 0 ? lengthSeconds * 1000 : 0;
}

function parseClockDurationMs(clockText: string): number {
  const match = clockText.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/) as
    | [string, string | undefined, string, string]
    | null;
  if (!match) return 0;
  const hasHours = match[1] !== undefined;
  const hours = match[1] !== undefined ? Number.parseInt(match[1], 10) : 0;
  const minutes = Number.parseInt(match[2], 10);
  const seconds = Number.parseInt(match[3], 10);
  if (seconds >= 60 || (hasHours && minutes >= 60)) return 0;
  const totalSeconds = hours * 3600 + minutes * 60 + seconds;
  return totalSeconds > 0 ? totalSeconds * 1000 : 0;
}

/**
 * Records `videoDetails.lengthSeconds` from `/youtubei/v1/player` responses so subsequent
 * `/youtubei/v1/next` responses can resolve the exact video duration without reading stale DOM state.
 */
export function recordVideoDurationFromPayload(payload: Record<string, unknown>): void {
  const details =
    (isRecord(payload.videoDetails) ? payload.videoDetails : null) ??
    readRecordPath(payload, 'playerResponse', 'videoDetails');
  const videoId = typeof details?.videoId === 'string' ? details.videoId : '';
  if (!videoId) return;
  const durationMs = parseLengthSecondsMs(details?.lengthSeconds);
  if (durationMs > 0) {
    lastKnownVideoDuration = { videoId, durationMs };
  }
}

function resolveVideoDurationMs(
  videoId: string,
  videoDetails: Record<string, unknown> | undefined,
  metadata: Record<string, unknown> | undefined,
  durationMsOverride?: number
): number {
  if (typeof durationMsOverride === 'number' && Number.isFinite(durationMsOverride) && durationMsOverride > 0) {
    return durationMsOverride;
  }

  const fromDetails = parseLengthSecondsMs(videoDetails?.lengthSeconds);
  if (fromDetails > 0) return fromDetails;

  if (videoId && lastKnownVideoDuration?.videoId === videoId && lastKnownVideoDuration.durationMs > 0) {
    return lastKnownVideoDuration.durationMs;
  }

  const fromLengthText = parseClockDurationMs(
    readFormattedText(metadata?.lengthText as FormattedText | string | undefined)
  );
  if (fromLengthText > 0) return fromLengthText;

  if (typeof document !== 'undefined') {
    const activeWatchId = getActiveWatchVideoId();
    if (!activeWatchId || activeWatchId === videoId) {
      const videoEl = document.getElementsByTagName('video')[0];
      if (videoEl && Number.isFinite(videoEl.duration) && videoEl.duration > 0) {
        return videoEl.duration * 1000;
      }
    }
  }

  return 0;
}

/**
 * Builds a chapters macro-marker entity from a watch-next InnerTube response when description timestamps exist
 * and YouTube has not already provided native chapters.
 */
export function buildChaptersMarkerEntity(
  video: Record<string, unknown>,
  durationMsOverride?: number
): ChapterMarkerEntity | null {
  if (hasNativeChapters(video)) return null;

  recordVideoDurationFromPayload(video);
  const metadata = extractVideoMetadataRenderer(video);
  const videoDetails =
    (isRecord(video.videoDetails) ? video.videoDetails : null) ??
    readRecordPath(video, 'playerResponse', 'videoDetails') ??
    undefined;
  const videoId =
    (typeof metadata?.videoId === 'string' && metadata.videoId) ||
    (typeof videoDetails?.videoId === 'string' && videoDetails.videoId) ||
    '';
  const description =
    readFormattedText(metadata?.description as FormattedText | string | undefined) ||
    (typeof videoDetails?.shortDescription === 'string' ? videoDetails.shortDescription : '');

  if (!videoId || !description) return null;

  const parsedChapters = parseTimestamps(description);
  if (parsedChapters.length < 2) return null;

  const videoDurationMs = resolveVideoDurationMs(videoId, videoDetails, metadata, durationMsOverride);
  if (!Number.isFinite(videoDurationMs) || videoDurationMs <= 0) return null;

  const chapters: ChapterTimestamp[] = [];
  for (const chapter of parsedChapters) {
    if (chapter.time >= videoDurationMs) continue;
    const previous = chapters.at(-1);
    if (previous && chapter.time <= previous.time) continue;
    chapters.push(chapter);
  }
  if (chapters.length < 2) return null;

  const markers: unknown[] = [];
  for (const [i, chapter] of chapters.entries()) {
    const nextChapter = chapters[i + 1];
    const duration = nextChapter ? nextChapter.time - chapter.time : videoDurationMs - chapter.time;
    markers.push(createMarker(chapter.name, String(chapter.time), String(duration), videoId, i));
  }

  return createMarkerEntity(videoId, markers);
}
