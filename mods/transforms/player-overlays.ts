import { t } from '../core/i18n.ts';
import { getActiveWatchVideoId } from '../core/lifecycle.ts';
import { injectCss } from '../core/styles.ts';
import { dispatchYttvCommand } from '../core/yttv-bridge.ts';
import { normalizeVoteCount, setWatchLikeCount } from '../features/return-youtube-dislike.ts';
import type { SponsorBlockSegment } from '../features/sponsorblock.ts';
import { onSponsorBlockSegmentsReady, resolveSegmentActionType } from '../features/sponsorblock.ts';
import { buttonRenderer, timelyAction } from '../ui/yt-ui.ts';
import {
  hasReportOrFeedbackEndpointNode,
  isReportOrFeedbackIcon,
  isReportOrFeedbackText,
  readFormattedText,
} from '../utils/innertube-ast.ts';
import { isRecord, readRecordPath } from '../utils/type-guards.ts';
import { buildChaptersMarkerEntity } from './chapters.ts';

const TRANSPORT_BUTTON_LIST_KEYS = ['promotedActions', 'actions', 'buttons', 'engagementActions'] as const;
const DIRECT_PREV_NEXT_KEYS = ['skipPreviousButton', 'skipNextButton'] as const;

let transportStylesInstalled = false;

/**
 * Installs zero-loop static CSS rules hiding native Previous/Next player-bar controls
 * (`skipPrevious` / `skipNext`) and enabling multiline Shorts header metadata.
 */
export function installTransportControlsStyles(): void {
  if (transportStylesInstalled || typeof document === 'undefined') return;
  transportStylesInstalled = true;
  injectCss(`
      ytlr-watch-default [idomkey="transport-controls"] :is([idomkey="skipPrevious"], [idomkey="skipNext"]) {
        display: none !important;
      }
      ytlr-reel-player-header-renderer [idomkey="MV7Ztb"] yt-formatted-string {
        white-space: pre-line !important;
      }
    `);
}

function isUnwantedTransportButton(btn: unknown): boolean {
  if (!isRecord(btn)) return false;
  const btnType = String(btn.type || '');
  if (/SUBSCRIBE/i.test(btnType)) return true;
  if (
    btnType !== 'TRANSPORT_CONTROLS_BUTTON_TYPE_SPONSORBLOCK_HIGHLIGHT' &&
    /(?:^|_)(?:PREVIOUS|NEXT)(?:_BUTTON)?$/i.test(btnType)
  ) {
    return true;
  }
  const nestedBtn = readRecordPath(btn, 'button');
  if (
    btn.subscribeButton ||
    btn.subscribeButtonRenderer ||
    nestedBtn?.subscribeButtonRenderer ||
    btn.previousButtonRenderer ||
    btn.nextButtonRenderer ||
    nestedBtn?.previousButtonRenderer ||
    nestedBtn?.nextButtonRenderer
  ) {
    return true;
  }
  const br = readRecordPath(nestedBtn, 'buttonRenderer') ?? readRecordPath(btn, 'buttonRenderer');
  const nav = readRecordPath(br, 'navigationEndpoint') ?? readRecordPath(br, 'command');
  const icon = readRecordPath(br, 'icon');
  const iconType = String(icon?.iconType || '');
  if (nav?.subscribeEndpoint || nav?.unsubscribeEndpoint || nav?.subscribeCommand || /SUBSCRIBE/i.test(iconType)) {
    return true;
  }
  const signal = isRecord(nav?.signalAction) ? nav.signalAction.signal : undefined;
  if (signal === 'PLAYER_PLAY_PREVIOUS' || signal === 'PLAYER_PLAY_NEXT') {
    return true;
  }
  if (iconType === 'SKIP_PREVIOUS' || (iconType === 'SKIP_NEXT' && !nav?.customAction)) {
    return true;
  }
  if (/(?:REPORT|FEEDBACK)/i.test(btnType) || isReportOrFeedbackIcon(icon?.iconType)) {
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
  queueMicrotask(() => {
    dispatchYttvCommand({
      clickTrackingParams: null,
      loadMarkersCommand: {
        visibleOnLoadKeys: [chapterData.entityKey],
        entityKeys: [chapterData.entityKey],
      },
    });
  });
}

function extractPayloadVideoId(r: Record<string, unknown>): string | null {
  const watchEp = readRecordPath(r, 'currentVideoEndpoint', 'watchEndpoint');
  const details = readRecordPath(r, 'videoDetails');
  const playerDetails = readRecordPath(r, 'playerResponse', 'videoDetails');
  return (
    (typeof watchEp?.videoId === 'string' && watchEp.videoId) ||
    (typeof details?.videoId === 'string' && details.videoId) ||
    (typeof playerDetails?.videoId === 'string' && playerDetails.videoId) ||
    getActiveWatchVideoId()
  );
}

function appendSponsorBlockTimelyActions(target: unknown[], segments: readonly SponsorBlockSegment[]): void {
  for (const segment of segments) {
    if (resolveSegmentActionType(segment) !== 'skip') continue;
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

function appendSponsorBlockHighlightButton(promotedActions: unknown[], segments: readonly SponsorBlockSegment[]): void {
  const alreadyPresent = promotedActions.some(
    (entry) => isRecord(entry) && entry.type === 'TRANSPORT_CONTROLS_BUTTON_TYPE_SPONSORBLOCK_HIGHLIGHT'
  );
  if (alreadyPresent) return;

  const highlight = segments.find((seg) => resolveSegmentActionType(seg) === 'poi');
  if (!highlight) return;

  promotedActions.push({
    type: 'TRANSPORT_CONTROLS_BUTTON_TYPE_SPONSORBLOCK_HIGHLIGHT',
    button: {
      buttonRenderer: buttonRenderer(t('sponsorblock.toasts.skipToHighlight'), 'SKIP_NEXT', {
        clickTrackingParams: null,
        customAction: {
          action: 'SKIP',
          parameters: { time: highlight.segment[0] },
        },
      }),
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
      const inner = readRecordPath(a, 'timelyActionRenderer');
      return inner?.type !== 'TIMELY_ACTION_TYPE_SHOPPING' && inner?.type !== 'TIMELY_ACTION_TYPE_NFL_WATERMARK';
    });
  } else {
    overlayRenderer.timelyActionRenderers = [];
  }

  const target = overlayRenderer.timelyActionRenderers as unknown[];
  onSponsorBlockSegmentsReady(extractPayloadVideoId(r), (segments, isLateAsync) => {
    const beforeCount = target.length;
    appendSponsorBlockTimelyActions(target, segments);
    if (isLateAsync && target.length > beforeCount) {
      dispatchYttvCommand({ updatePlayerOverlayCommand: { timelyActionRenderers: target } });
    }
  });
}

/**
 * Extracts and records the live Watch like count from `/next` transport controls.
 */
export function recordTransportLikeCount(r: Record<string, unknown>): void {
  const tc = getTransportControlsRenderer(r);
  if (!tc) return;

  const videoId = extractPayloadVideoId(r);
  if (!videoId) return;

  for (const key of TRANSPORT_BUTTON_LIST_KEYS) {
    const list = tc[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!isRecord(item)) continue;
      const lr = readRecordPath(item, 'button', 'likeButtonRenderer') ?? readRecordPath(item, 'likeButtonRenderer');
      if (!lr) continue;
      const text = readFormattedText(
        (lr.likeCountText ?? lr.likeCountWithLikeText ?? lr.likeCountWithUnlikeText) as Parameters<
          typeof readFormattedText
        >[0]
      );
      const normalized = normalizeVoteCount(text);
      if (normalized) {
        setWatchLikeCount(videoId, normalized);
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

  for (const directKey of DIRECT_PREV_NEXT_KEYS) {
    if (directKey in tcRenderer) {
      delete tcRenderer[directKey];
    }
  }

  for (const key of TRANSPORT_BUTTON_LIST_KEYS) {
    const list = tcRenderer[key];
    if (Array.isArray(list)) {
      tcRenderer[key] = list.filter((b) => !isUnwantedTransportButton(b));
    }
  }
  if (!Array.isArray(tcRenderer.promotedActions)) return;

  const promotedActions = tcRenderer.promotedActions as unknown[];
  onSponsorBlockSegmentsReady(extractPayloadVideoId(r), (segments, isLateAsync) => {
    const beforeCount = promotedActions.length;
    appendSponsorBlockHighlightButton(promotedActions, segments);
    if (isLateAsync && promotedActions.length > beforeCount) {
      dispatchYttvCommand({ updateTransportControlsCommand: { promotedActions } });
    }
  });
}
