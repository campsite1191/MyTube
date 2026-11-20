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

/**
 * Parses `m:ss` or `h:mm:ss` timestamp lines from a video description into millisecond chapters.
 */
export function parseTimestamps(input: string): ChapterTimestamp[] {
  const lines = input.trim().split('\n');
  const result: ChapterTimestamp[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const match = line.match(TIMESTAMP_RE);
    if (!match || match[2] === undefined || match[3] === undefined) continue;
    const hours = match[1] !== undefined ? Number.parseInt(match[1], 10) : 0;
    const minutes = Number.parseInt(match[2], 10);
    const seconds = Number.parseInt(match[3], 10);
    const milliseconds = (hours * 3600 + minutes * 60 + seconds) * 1000;
    const name = (match[4] ?? '').trim();
    result.push({ time: milliseconds, name });
  }

  return result;
}

function createMarker(title: string, start: string, duration: string, videoId: string, index: number) {
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
                entityKey: `${videoId}${start}${duration}`,
                type: 'ENTITY_MUTATION_TYPE_REPLACE',
                payload: {
                  markersEngagementPanelSyncEntity: {
                    key: `${videoId}${start}${duration}`,
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

/**
 * Builds a chapters macro-marker entity from a watch-next InnerTube response when description timestamps exist.
 */
export function buildChaptersMarkerEntity(
  video: Record<string, unknown>,
  durationMsOverride?: number
): ChapterMarkerEntity | null {
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
  const metadata = isRecord(firstItem?.videoMetadataRenderer) ? firstItem.videoMetadataRenderer : undefined;

  const videoDetails = isRecord(video.videoDetails) ? video.videoDetails : undefined;
  const videoId =
    (typeof metadata?.videoId === 'string' && metadata.videoId) ||
    (typeof videoDetails?.videoId === 'string' && videoDetails.videoId) ||
    '';
  const description =
    readFormattedText(metadata?.description as FormattedText | string | undefined) ||
    (typeof videoDetails?.shortDescription === 'string' ? videoDetails.shortDescription : '');

  if (!videoId || !description) return null;

  const chapters = parseTimestamps(description);
  if (chapters.length === 0) return null;

  let videoDurationMs = durationMsOverride ?? 0;
  if (!videoDurationMs && typeof document !== 'undefined') {
    const videoEl = document.getElementsByTagName('video')[0];
    if (videoEl && Number.isFinite(videoEl.duration) && videoEl.duration > 0) {
      videoDurationMs = videoEl.duration * 1000;
    }
  }
  if (!Number.isFinite(videoDurationMs) || videoDurationMs <= 0) return null;

  const markers: unknown[] = [];
  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i];
    if (!chapter) continue;
    const nextChapter = chapters[i + 1];
    const duration = Math.max(0, nextChapter ? nextChapter.time - chapter.time : videoDurationMs - chapter.time);
    markers.push(createMarker(chapter.name, String(chapter.time), String(duration), videoId, i));
  }

  return createMarkerEntity(videoId, markers);
}
