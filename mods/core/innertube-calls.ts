import { isRecord, readRecordPath } from '../utils/type-guards.ts';
import { dispatchYttvCommand, getCurrentIdentityService, getKabukiInnerTubeClient } from './yttv-bridge.ts';

interface NextNavParams {
  tileRenderer?: {
    contentId?: string;
    onSelectCommand?: { watchEndpoint?: { params?: string } };
  };
  lockupViewModel?: {
    contentId?: string;
    rendererContext?: {
      commandContext?: {
        onTap?: {
          innertubeCommand?: { watchEndpoint?: { params?: string } };
        };
      };
    };
  };
}

export function requestNextAndNavigateChannel(params: NextNavParams): void {
  const identityService = getCurrentIdentityService();
  const client = getKabukiInnerTubeClient();
  const videoId = params.tileRenderer ? params.tileRenderer.contentId : params.lockupViewModel?.contentId;
  if (!identityService || !client || !videoId) return;

  const paramsValue = params.tileRenderer
    ? params.tileRenderer.onSelectCommand?.watchEndpoint?.params
    : params.lockupViewModel?.rendererContext?.commandContext?.onTap?.innertubeCommand?.watchEndpoint?.params;
  const randomDelay = Math.floor(Math.random() * 2000);

  void identityService
    .get()
    .then((identity) => {
      const request = {
        identity,
        isPrefetch: false,
        path: '/youtubei/v1/next',
        payload: {
          videoId,
          params: paramsValue,
          racyCheckOk: true,
          contentCheckOk: true,
          playbackContext: {
            lactMilliseconds: randomDelay,
            isLyricsMode: false,
          },
          autonavState: 'STATE_NONE',
          mdxContext: {
            mdxReceiverContext: {
              mdxConnectedDevices: [],
            },
          },
        },
        clickTracking: {
          clickTrackingParams: null,
        },
      };

      client.fetch(request).subscribe(
        (response: unknown) => {
          const innerResults = readRecordPath(
            response,
            'contents',
            'singleColumnWatchNextResults',
            'results',
            'results'
          );
          const items = Array.isArray(innerResults?.contents) ? innerResults.contents : undefined;
          if (!items) return;

          for (const section of items) {
            const sectionRenderer = readRecordPath(section, 'itemSectionRenderer');
            const sectionContents = Array.isArray(sectionRenderer?.contents) ? sectionRenderer.contents : undefined;
            const metadataEntry = sectionContents?.find(
              (item) => isRecord(item) && isRecord(item.videoMetadataRenderer)
            );
            const ownerRenderer = readRecordPath(metadataEntry, 'videoMetadataRenderer', 'owner', 'videoOwnerRenderer');
            if (ownerRenderer?.navigationEndpoint) {
              dispatchYttvCommand(ownerRenderer.navigationEndpoint);
              return;
            }
          }
        },
        (err) => console.error('[InnerTubeCalls] Failed to resolve channel navigation:', err)
      );
    })
    .catch((err) => console.error('[InnerTubeCalls] Failed to read active identity:', err));
}

const MAX_FEEDBACK_TOKEN_DEPTH = 12;

/**
 * Recursively locates a `feedbackToken` string inside an InnerTube command or renderer object.
 */
export function findFeedbackToken(obj: unknown, depth = 0): string | null {
  if (!obj || typeof obj !== 'object' || depth > MAX_FEEDBACK_TOKEN_DEPTH) return null;
  const record = obj as Record<string, unknown>;
  if (typeof record.feedbackToken === 'string') return record.feedbackToken;
  for (const value of Object.values(record)) {
    const token = findFeedbackToken(value, depth + 1);
    if (token) return token;
  }
  return null;
}

export function getFeedbackPanelTokens(panelId: string, params: string): Promise<string[]> {
  const client = getKabukiInnerTubeClient();
  if (!client) return Promise.resolve([]);

  const { promise, resolve, reject } = Promise.withResolvers<string[]>();
  client
    .fetch({
      path: '/youtubei/v1/get_panel',
      payload: { panelId, params },
    })
    .subscribe(
      (response: unknown) => {
        const listVm = readRecordPath(
          response,
          'content',
          'engagementPanelSectionListRenderer',
          'content',
          'listViewModel'
        );
        const listItems = listVm?.listItems;
        if (!Array.isArray(listItems)) {
          resolve([]);
          return;
        }
        const tokens: string[] = [];
        for (const item of listItems) {
          if (!isRecord(item)) continue;
          const token = findFeedbackToken(item.listItemViewModel);
          if (token) tokens.push(token);
        }
        resolve(tokens);
      },
      reject,
      () => resolve([])
    );
  return promise;
}

export function sendFeedbackToken(feedbackToken: string): Promise<unknown> {
  const client = getKabukiInnerTubeClient();
  if (!client) return Promise.resolve(null);

  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  client
    .fetch({
      path: '/youtubei/v1/feedback',
      payload: { feedbackTokens: [feedbackToken] },
    })
    .subscribe(resolve, reject, () => resolve(null));
  return promise;
}
