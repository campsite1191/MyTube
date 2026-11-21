import { isRecord } from '../utils/type-guards.ts';
import resolveCommand from './resolve-command.ts';
import { getCurrentIdentityService, getKabukiInnerTubeClient } from './yttv-bridge.ts';

let guideCache: unknown | null = null;

let currentAbortController: AbortController | null = null;

function getAbortSignal(): AbortSignal {
  if (currentAbortController) {
    currentAbortController.abort();
  }
  currentAbortController = new AbortController();
  return currentAbortController.signal;
}

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
  if (!identityService || !client) return;

  const videoId = params.tileRenderer ? params.tileRenderer.contentId : params.lockupViewModel?.contentId;
  const paramsValue = params.tileRenderer
    ? params.tileRenderer.onSelectCommand?.watchEndpoint?.params
    : params.lockupViewModel?.rendererContext?.commandContext?.onTap?.innertubeCommand?.watchEndpoint?.params;
  const randomDelay = Math.floor(Math.random() * 2000);

  void identityService.get().then((identity) => {
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

    client.fetch(request).subscribe((response: unknown) => {
      if (!isRecord(response)) return;
      const contents = isRecord(response.contents) ? response.contents : undefined;
      const watchNext = isRecord(contents?.singleColumnWatchNextResults)
        ? contents.singleColumnWatchNextResults
        : undefined;
      const results = isRecord(watchNext?.results) ? watchNext.results : undefined;
      const innerResults = isRecord(results?.results) ? results.results : undefined;
      const items = Array.isArray(innerResults?.contents) ? innerResults.contents : undefined;
      if (!items) return;

      const itemSection = items.find((item) => isRecord(item) && isRecord(item.itemSectionRenderer)) as
        | Record<string, unknown>
        | undefined;
      const sectionRenderer = isRecord(itemSection?.itemSectionRenderer) ? itemSection.itemSectionRenderer : undefined;
      const sectionContents = Array.isArray(sectionRenderer?.contents) ? sectionRenderer.contents : undefined;
      const metadataEntry = sectionContents?.find((item) => isRecord(item) && isRecord(item.videoMetadataRenderer)) as
        | Record<string, unknown>
        | undefined;
      const metadata = isRecord(metadataEntry?.videoMetadataRenderer) ? metadataEntry.videoMetadataRenderer : undefined;
      const owner = isRecord(metadata?.owner) ? metadata.owner : undefined;
      const ownerRenderer = isRecord(owner?.videoOwnerRenderer) ? owner.videoOwnerRenderer : undefined;
      if (ownerRenderer?.navigationEndpoint) {
        resolveCommand(ownerRenderer.navigationEndpoint);
      }
    });
  });
}

export async function getGuide(): Promise<unknown> {
  const client = getKabukiInnerTubeClient();
  if (!client) return null;

  if (guideCache) return guideCache;

  const { promise, resolve } = Promise.withResolvers<unknown>();
  client.fetch({ path: '/youtubei/v1/guide', signal: getAbortSignal() }).subscribe(resolve, () => resolve(null));

  const response = await promise;
  if (response !== null) guideCache = response;
  return response;
}

export function clearGuideCache(): void {
  guideCache = null;
}

/**
 * Recursively locates a `feedbackToken` string inside an InnerTube command or renderer object.
 */
export function findFeedbackToken(obj: unknown): string | null {
  if (!obj || typeof obj !== 'object') return null;
  const record = obj as Record<string, unknown>;
  if (typeof record.feedbackToken === 'string') return record.feedbackToken;
  for (const key in record) {
    if (!Object.hasOwn(record, key)) continue;
    const token = findFeedbackToken(record[key]);
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
    .subscribe((response: unknown) => {
      const res = isRecord(response) ? response : undefined;
      const content = isRecord(res?.content) ? res.content : undefined;
      const panel = isRecord(content?.engagementPanelSectionListRenderer)
        ? content.engagementPanelSectionListRenderer
        : undefined;
      const panelContent = isRecord(panel?.content) ? panel.content : undefined;
      const listVm = isRecord(panelContent?.listViewModel) ? panelContent.listViewModel : undefined;
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
    }, reject);
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
    .subscribe(resolve, reject);
  return promise;
}
