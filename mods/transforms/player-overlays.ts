import { t } from '../core/i18n.ts';
import { getActiveWatchVideoId } from '../core/lifecycle.ts';
import resolveCommand, {
  hasReportOrFeedbackEndpointNode,
  isReportOrFeedbackIcon,
  isReportOrFeedbackText,
} from '../core/resolve-command.ts';
import { injectCss } from '../core/styles.ts';
import { setWatchLikeCount } from '../features/return-youtube-dislike.ts';
import type { SponsorBlockSegment } from '../features/sponsorblock.ts';
import { onSponsorBlockSegmentsReady, resolveSegmentActionType } from '../features/sponsorblock.ts';
import { ButtonRenderer, timelyAction } from '../ui/yt-ui.ts';
import { isRecord, readRecordPath } from '../utils/type-guards.ts';
import { buildChaptersMarkerEntity } from './chapters.ts';
import { readFormattedText } from './feed-filter.ts';

const TRANSPORT_BUTTON_LIST_KEYS = ['promotedActions', 'actions', 'buttons', 'engagementActions'] as const;
const DIRECT_PREV_NEXT_KEYS = ['skipPreviousButton', 'skipNextButton'] as const;

let transportStylesInstalled = false;

/**
 * Installs zero-loop static CSS rules hiding native Previous/Next player-bar controls
 * (`skipPrevious` / `skipNext`) and making the Shorts page backdrop pure `#000`.
 */
export function installTransportControlsStyles(): void {
  if (transportStylesInstalled || typeof document === 'undefined') return;
  transportStylesInstalled = true;
  injectCss(`
      ytlr-watch-default [idomkey="transport-controls"] :is([idomkey="skipPrevious"], [idomkey="skipNext"]) {
        display: none !important;
      }
      body.WEB_PAGE_TYPE_SHORTS,
      body.WEB_PAGE_TYPE_SHORTS #container,
      body.WEB_PAGE_TYPE_SHORTS #app-background {
        background-color: #000 !important;
        background-image: none !important;
      }
      body.WEB_PAGE_TYPE_SHORTS :is(ytlr-app, ytlr-app-background-container, ytlr-player-container [idomkey="background"]) {
        background-color: transparent !important;
        background-image: none !important;
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
  const nestedBtn = isRecord(btn.button) ? btn.button : undefined;
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
  resolveCommand({
    clickTrackingParams: null,
    loadMarkersCommand: {
      visibleOnLoadKeys: [chapterData.entityKey],
      entityKeys: [chapterData.entityKey],
    },
  });
}

function extractPayloadVideoId(r: Record<string, unknown>): string | null {
  const currentEp = isRecord(r.currentVideoEndpoint) ? r.currentVideoEndpoint : undefined;
  const watchEp = isRecord(currentEp?.watchEndpoint) ? currentEp.watchEndpoint : undefined;
  const details = isRecord(r.videoDetails) ? r.videoDetails : undefined;
  const playerResp = isRecord(r.playerResponse) ? r.playerResponse : undefined;
  const playerDetails = isRecord(playerResp?.videoDetails) ? playerResp.videoDetails : undefined;
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

  const target = overlayRenderer.timelyActionRenderers as unknown[];
  onSponsorBlockSegmentsReady(extractPayloadVideoId(r), (segments) => {
    appendSponsorBlockTimelyActions(target, segments);
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
  onSponsorBlockSegmentsReady(extractPayloadVideoId(r), (segments) => {
    appendSponsorBlockHighlightButton(promotedActions, segments);
  });
}
