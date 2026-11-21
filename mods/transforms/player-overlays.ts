import { t } from '../core/i18n.ts';
import { getActiveWatchVideoId } from '../core/lifecycle.ts';
import resolveCommand, {
  hasReportOrFeedbackEndpointNode,
  isReportOrFeedbackIcon,
  isReportOrFeedbackText,
} from '../core/resolve-command.ts';
import { setWatchLikeCount } from '../features/return-youtube-dislike.ts';
import {
  getActiveSponsorBlockSegments,
  MANUAL_SKIP_CATEGORIES,
  resolveSegmentActionType,
} from '../features/sponsorblock.ts';
import { ButtonRenderer, timelyAction } from '../ui/yt-ui.ts';
import { isRecord, readRecordPath } from '../utils/type-guards.ts';
import { buildChaptersMarkerEntity } from './chapters.ts';
import { readFormattedText } from './feed-filter.ts';

const TRANSPORT_BUTTON_LIST_KEYS = ['promotedActions', 'actions', 'buttons', 'engagementActions'] as const;

function isUnwantedTransportButton(btn: unknown): boolean {
  if (!isRecord(btn)) return false;
  if (/SUBSCRIBE/i.test(String(btn.type || ''))) return true;
  const nestedBtn = isRecord(btn.button) ? btn.button : undefined;
  if (btn.subscribeButton || btn.subscribeButtonRenderer || nestedBtn?.subscribeButtonRenderer) return true;
  const br = isRecord(nestedBtn?.buttonRenderer)
    ? nestedBtn.buttonRenderer
    : isRecord(btn.buttonRenderer)
      ? btn.buttonRenderer
      : undefined;
  const nav = isRecord(br?.navigationEndpoint) ? br.navigationEndpoint : isRecord(br?.command) ? br.command : undefined;
  const icon = isRecord(br?.icon) ? br.icon : undefined;
  const iconType = String(icon?.iconType || '');
  if (nav?.subscribeEndpoint || nav?.unsubscribeEndpoint || nav?.subscribeCommand || /SUBSCRIBE/i.test(iconType)) {
    return true;
  }
  if (/(?:REPORT|FEEDBACK)/i.test(String(btn.type || '')) || isReportOrFeedbackIcon(icon?.iconType)) {
    return true;
  }
  if (isReportOrFeedbackText(readFormattedText(br?.text))) {
    return true;
  }
  return Boolean(nav && hasReportOrFeedbackEndpointNode(nav));
}

function getTransportControlsRenderer(r: Record<string, unknown>): Record<string, unknown> | undefined {
  return (
    readRecordPath(r, 'transportControls', 'transportControlsRenderer') ??
    readRecordPath(r, 'playerOverlays', 'playerOverlayRenderer', 'transportControls', 'transportControlsRenderer') ??
    undefined
  );
}

/**
 * Injects synthetic description chapters into `frameworkUpdates` and dispatches `loadMarkersCommand`
 * when no native chapter markers are present.
 */
export function injectChapters(r: Record<string, unknown>): void {
  const chapterData = buildChaptersMarkerEntity(r);
  if (!chapterData) return;

  const fwUpdates: Record<string, unknown> = isRecord(r.frameworkUpdates) ? r.frameworkUpdates : {};
  r.frameworkUpdates = fwUpdates;
  const batchUpdate: Record<string, unknown> = isRecord(fwUpdates.entityBatchUpdate) ? fwUpdates.entityBatchUpdate : {};
  fwUpdates.entityBatchUpdate = batchUpdate;
  const mutations: unknown[] = Array.isArray(batchUpdate.mutations) ? batchUpdate.mutations : [];
  batchUpdate.mutations = mutations;
  mutations.push(chapterData);
  resolveCommand({
    clickTrackingParams: null,
    loadMarkersCommand: {
      visibleOnLoadKeys: [chapterData.entityKey],
      entityKeys: [chapterData.entityKey],
    },
  });
}

/**
 * Removes shopping/watermark overlays and injects SponsorBlock manual-skip timely actions.
 */
export function transformPlayerOverlays(r: Record<string, unknown>): void {
  const overlayRenderer = readRecordPath(r, 'playerOverlays', 'playerOverlayRenderer');
  if (!overlayRenderer) return;

  if (Array.isArray(overlayRenderer.timelyActionRenderers)) {
    overlayRenderer.timelyActionRenderers = overlayRenderer.timelyActionRenderers.filter((a) => {
      const inner = isRecord(a) && isRecord(a.timelyActionRenderer) ? a.timelyActionRenderer : undefined;
      return inner?.type !== 'TIMELY_ACTION_TYPE_SHOPPING' && inner?.type !== 'TIMELY_ACTION_TYPE_NFL_WATERMARK';
    });
  } else {
    overlayRenderer.timelyActionRenderers = [];
  }

  const activeSegments = getActiveSponsorBlockSegments();
  if (activeSegments.length === 0) return;

  const target = overlayRenderer.timelyActionRenderers as unknown[];
  for (const segment of activeSegments) {
    if (resolveSegmentActionType(segment) !== 'skip' || !MANUAL_SKIP_CATEGORIES.includes(segment.category)) continue;
    target.push(
      timelyAction(
        t('sponsorblock.toasts.skip', { segment: t(`sponsorblock.segments.${segment.category}`) }),
        'SKIP_NEXT',
        {
          clickTrackingParams: null,
          showEngagementPanelEndpoint: {
            customAction: {
              action: 'SKIP',
              parameters: { time: segment.segment[1] },
            },
          },
        },
        segment.segment[0] * 1000,
        segment.segment[1] * 1000 - segment.segment[0] * 1000
      )
    );
  }
}

/**
 * Extracts and records the live Watch like count from `/next` transport controls.
 */
export function recordTransportLikeCount(r: Record<string, unknown>): void {
  const tc = getTransportControlsRenderer(r);
  if (!tc) return;

  const currentEp = isRecord(r.currentVideoEndpoint) ? r.currentVideoEndpoint : undefined;
  const watchEp = isRecord(currentEp?.watchEndpoint) ? currentEp.watchEndpoint : undefined;
  const details = isRecord(r.videoDetails) ? r.videoDetails : undefined;
  const playerResp = isRecord(r.playerResponse) ? r.playerResponse : undefined;
  const playerDetails = isRecord(playerResp?.videoDetails) ? playerResp.videoDetails : undefined;
  const videoId =
    (typeof watchEp?.videoId === 'string' && watchEp.videoId) ||
    (typeof details?.videoId === 'string' && details.videoId) ||
    (typeof playerDetails?.videoId === 'string' && playerDetails.videoId) ||
    getActiveWatchVideoId();
  if (!videoId) return;

  for (const key of TRANSPORT_BUTTON_LIST_KEYS) {
    const list = tc[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!isRecord(item)) continue;
      const btn = isRecord(item.button) ? item.button : undefined;
      const lr = isRecord(btn?.likeButtonRenderer)
        ? btn.likeButtonRenderer
        : isRecord(item.likeButtonRenderer)
          ? item.likeButtonRenderer
          : undefined;
      if (!lr) continue;
      const text = readFormattedText(
        (lr.likeCountText ?? lr.likeCountWithLikeText ?? lr.likeCountWithUnlikeText) as Parameters<
          typeof readFormattedText
        >[0]
      );
      if (text) {
        setWatchLikeCount(videoId, text);
        return;
      }
    }
  }
}

/**
 * Strips Subscribe/Report/Feedback transport buttons and appends SponsorBlock highlight jump actions.
 */
export function transformTransportControls(r: Record<string, unknown>): void {
  const tcRenderer = getTransportControlsRenderer(r);
  if (!tcRenderer) return;

  for (const key of TRANSPORT_BUTTON_LIST_KEYS) {
    const list = tcRenderer[key];
    if (Array.isArray(list)) {
      tcRenderer[key] = list.filter((b) => !isUnwantedTransportButton(b));
    }
  }
  if (!Array.isArray(tcRenderer.promotedActions)) return;

  const highlight = getActiveSponsorBlockSegments().find((seg) => resolveSegmentActionType(seg) === 'poi');
  if (!highlight) return;

  tcRenderer.promotedActions.push({
    type: 'TRANSPORT_CONTROLS_BUTTON_TYPE_SPONSORBLOCK_HIGHLIGHT',
    button: {
      buttonRenderer: ButtonRenderer(t('sponsorblock.toasts.skipToHighlight'), 'SKIP_NEXT', {
        clickTrackingParams: null,
        customAction: {
          action: 'SKIP',
          parameters: { time: highlight.segment[0] },
        },
      }),
    },
  });
}
