import { t } from '../core/i18n.ts';
import type { FormattedText } from '../types/innertube.ts';
import { isRecord } from '../utils/type-guards.ts';
import { readFormattedText } from './feed-filter.ts';

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
    const match = rawLine.trim().match(TIMESTAMP_RE);
    if (!match || match[2] === undefined || match[3] === undefined) continue;
    const hasHours = match[1] !== undefined;
    const hours = hasHours ? Number.parseInt(match[1] ?? '0', 10) : 0;
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
          url: `https://i.ytimg.com/vi/${videoId}/hq720.jpg`,
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
  const fwUpdates = isRecord(video.frameworkUpdates) ? video.frameworkUpdates : undefined;
  const batchUpdate = isRecord(fwUpdates?.entityBatchUpdate) ? fwUpdates.entityBatchUpdate : undefined;
  const mutations = Array.isArray(batchUpdate?.mutations) ? batchUpdate.mutations : undefined;
  if (!mutations) return false;

  return mutations.some((mutation) => {
    if (!isRecord(mutation)) return false;
    const payload = isRecord(mutation.payload) ? mutation.payload : undefined;
    const listEntity = isRecord(payload?.macroMarkersListEntity) ? payload.macroMarkersListEntity : undefined;
    if (!listEntity) return false;
    const markersList = isRecord(listEntity.markersList) ? listEntity.markersList : undefined;
    return markersList?.markerType === 'MARKER_TYPE_CHAPTERS';
  });
}

function extractVideoMetadataRenderer(video: Record<string, unknown>): Record<string, unknown> | undefined {
  const contents = isRecord(video.contents) ? video.contents : undefined;
  const watchNext = isRecord(contents?.singleColumnWatchNextResults)
    ? contents.singleColumnWatchNextResults
    : undefined;
  const results = isRecord(watchNext?.results) ? watchNext.results : undefined;
  const innerResults = isRecord(results?.results) ? results.results : undefined;
  const sectionList = Array.isArray(innerResults?.contents) ? innerResults.contents : undefined;
  const firstSection = isRecord(sectionList?.[0]) ? sectionList[0] : undefined;
  const itemSection = isRecord(firstSection?.itemSectionRenderer) ? firstSection.itemSectionRenderer : undefined;
  const sectionItems = Array.isArray(itemSection?.contents) ? itemSection.contents : undefined;
  const firstItem = isRecord(sectionItems?.[0]) ? sectionItems[0] : undefined;
  return isRecord(firstItem?.videoMetadataRenderer) ? firstItem.videoMetadataRenderer : undefined;
}

function resolveVideoDurationMs(
  videoDetails: Record<string, unknown> | undefined,
  durationMsOverride?: number
): number {
  if (typeof durationMsOverride === 'number' && Number.isFinite(durationMsOverride) && durationMsOverride > 0) {
    return durationMsOverride;
  }

  const rawLength = videoDetails?.lengthSeconds;
  const lengthSeconds =
    typeof rawLength === 'number'
      ? rawLength
      : typeof rawLength === 'string'
        ? Number.parseFloat(rawLength)
        : Number.NaN;
  if (Number.isFinite(lengthSeconds) && lengthSeconds > 0) {
    return lengthSeconds * 1000;
  }

  if (typeof document !== 'undefined') {
    const videoEl = document.getElementsByTagName('video')[0];
    if (videoEl && Number.isFinite(videoEl.duration) && videoEl.duration > 0) {
      return videoEl.duration * 1000;
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

  const metadata = extractVideoMetadataRenderer(video);
  const videoDetails = isRecord(video.videoDetails) ? video.videoDetails : undefined;
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

  const videoDurationMs = resolveVideoDurationMs(videoDetails, durationMsOverride);
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
  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i];
    if (!chapter) continue;
    const nextChapter = chapters[i + 1];
    const duration = nextChapter ? nextChapter.time - chapter.time : videoDurationMs - chapter.time;
    markers.push(createMarker(chapter.name, String(chapter.time), String(duration), videoId, i));
  }

  return createMarkerEntity(videoId, markers);
}
