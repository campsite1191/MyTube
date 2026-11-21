import { t } from '../core/i18n.ts';
import { getActiveWatchVideoId } from '../core/lifecycle.ts';
import { setWatchLikeCount } from '../features/return-youtube-dislike.ts';
import { getActiveSponsorBlockSegments, resolveSegmentActionType } from '../features/sponsorblock.ts';
import { addPreviews } from '../interceptors/previews.ts';
import { buildChaptersMarkerEntity } from '../transforms/chapters.ts';
import {
  extractItemChannelInfo,
  extractItemChannelName,
  filterFeedItemsSync,
  filterShelvesInPlaceSync,
  getExistingMenuItemLists,
  readFormattedText,
  walkCommands,
} from '../transforms/feed-filter.ts';
import type { AudioFormatEntry, SubscriptionTab } from '../transforms/innertube-player.ts';
import {
  dedupeAndSortSubscriptionTabs,
  disableAutoCaptionsInPayload,
  extractBrowseIdFromResponse,
  filterStreamingFormats,
  stripAdsFromPayload,
} from '../transforms/innertube-player.ts';
import {
  applyDeArrowBranding,
  installThumbnailErrorFallback,
  upgradeFeedThumbnails,
} from '../transforms/thumbnails.ts';
import type { FeedItem, InnertubeCommand, Thumbnail, WatchEndpoint } from '../types/innertube.ts';
import { transformGuideResponse } from '../ui/custom-guide-action.ts';
import { patchSettingsInPlace } from '../ui/custom-yt-settings.ts';
import { ButtonRenderer, longPressData, MenuServiceItemRenderer, timelyAction } from '../ui/yt-ui.ts';
import { buildLongPressPayload } from '../utils/feed-helpers.ts';
import { isObjectLike, isRecord } from '../utils/type-guards.ts';
import { configRead, onConfigChange, whenConfigReady } from './config.ts';
import { findFeedbackToken } from './innertube-calls.ts';
import resolveCommand, { patchResolveCommand } from './resolve-command.ts';
import { whenYttvReady } from './yttv-bridge.ts';

const ITEM_LIST_KEYS = [
  'horizontalListRenderer',
  'gridRenderer',
  'expandedShelfContentsRenderer',
  'verticalListRenderer',
] as const;

const MENU_TITLE_CASE_KEYS: Readonly<Record<string, string>> = {
  'save to watch later': 'videoMenu.saveToWatchLater',
  'remove from watch later': 'videoMenu.removeFromWatchLater',
  'not interested': 'videoMenu.notInterested',
  "don't recommend channel": 'videoMenu.dontRecommendChannel',
  'go to channel': 'videoMenu.goToChannel',
};

const EXTERNAL_JSON_HOSTS = ['sponsor.ajay.app', 'returnyoutubedislikeapi.com'] as const;

function processShelfContentSync(content: unknown, shouldAddPreviews = true): void {
  if (!isRecord(content)) return;
  if (Array.isArray(content.items)) {
    content.items = processItemsListSync(content.items as FeedItem[], shouldAddPreviews);
  }
  for (const key of ITEM_LIST_KEYS) {
    const listContainer = isRecord(content[key]) ? content[key] : undefined;
    if (listContainer && Array.isArray(listContainer.items)) {
      listContainer.items = processItemsListSync(listContainer.items as FeedItem[], shouldAddPreviews);
    }
  }
}

function getCustomActionName(serviceEndpoint: unknown): string {
  if (!isRecord(serviceEndpoint)) return '';
  const playlistEdit = isRecord(serviceEndpoint.playlistEditEndpoint)
    ? serviceEndpoint.playlistEditEndpoint
    : undefined;
  const playlistAction = isRecord(playlistEdit?.customAction) ? playlistEdit.customAction : undefined;
  if (typeof playlistAction?.action === 'string') return playlistAction.action;

  const directAction = isRecord(serviceEndpoint.customAction) ? serviceEndpoint.customAction : undefined;
  return typeof directAction?.action === 'string' ? directAction.action : '';
}

function isLongPressVideoItem(item: FeedItem): boolean {
  if (item?.lockupViewModel?.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') return true;
  const tr = item?.tileRenderer;
  if (!tr) return false;
  if (tr.style === 'TILE_STYLE_YTLR_SHORTS') return false;
  if (
    tr.contentType === 'TILE_CONTENT_TYPE_SHORTS' ||
    tr.contentType === 'TILE_CONTENT_TYPE_CHANNEL' ||
    tr.contentType === 'TILE_CONTENT_TYPE_PLAYLIST' ||
    tr.contentType === 'TILE_CONTENT_TYPE_VIDEO_AD'
  ) {
    return false;
  }
  return tr.style === 'TILE_STYLE_YTLR_DEFAULT' || tr.contentType === 'TILE_CONTENT_TYPE_VIDEO';
}

function findWatchEndpoint(node: unknown): WatchEndpoint | null {
  const result: { endpoint: WatchEndpoint | null } = { endpoint: null };
  walkCommands(node, (n) => {
    if (isRecord(n.watchEndpoint)) {
      result.endpoint = n.watchEndpoint as WatchEndpoint;
      return true;
    }
    return false;
  });
  return result.endpoint;
}

function readMenuItemText(menuItem: Record<string, unknown>): string {
  const service = isRecord(menuItem.menuServiceItemRenderer) ? menuItem.menuServiceItemRenderer : undefined;
  const nav = isRecord(menuItem.menuNavigationItemRenderer) ? menuItem.menuNavigationItemRenderer : undefined;
  const renderer = service ?? nav;
  return readFormattedText(renderer?.text).trim();
}

function setMenuItemText(menuItem: Record<string, unknown>, newText: string): void {
  const service = isRecord(menuItem.menuServiceItemRenderer) ? menuItem.menuServiceItemRenderer : undefined;
  const nav = isRecord(menuItem.menuNavigationItemRenderer) ? menuItem.menuNavigationItemRenderer : undefined;
  const renderer = service ?? nav;
  if (!renderer || !isRecord(renderer.text)) return;

  if (Array.isArray(renderer.text.runs)) {
    renderer.text.runs = [{ text: newText }];
  } else if ('simpleText' in renderer.text) {
    renderer.text.simpleText = newText;
  } else {
    renderer.text = { runs: [{ text: newText }] };
  }
}

function normalizeMenuItemText(menuItem: Record<string, unknown>): void {
  const raw = readMenuItemText(menuItem);
  if (!raw) return;
  const i18nKey = MENU_TITLE_CASE_KEYS[raw.toLowerCase().replace(/\u2019/g, "'")];
  if (!i18nKey) return;
  const replacement = t(i18nKey);
  if (replacement && replacement !== raw) setMenuItemText(menuItem, replacement);
}

function isRemovedLongPressMenuItem(menuItem: Record<string, unknown>): boolean {
  const nav = isRecord(menuItem.menuNavigationItemRenderer) ? menuItem.menuNavigationItemRenderer : undefined;
  const navEp = isRecord(nav?.navigationEndpoint) ? nav.navigationEndpoint : undefined;
  if (navEp?.addToPlaylistEndpoint) return true;

  const service = isRecord(menuItem.menuServiceItemRenderer) ? menuItem.menuServiceItemRenderer : undefined;
  if (getCustomActionName(service?.serviceEndpoint) === 'ADD_TO_QUEUE') return true;

  const label = readMenuItemText(menuItem).toLowerCase();
  return label === 'save to playlist' || label === 'add to queue';
}

function getFeedbackPanel(item: FeedItem): { panelId: string; params: string } | null {
  const onLongPress = item?.tileRenderer
    ? item.tileRenderer.onLongPressCommand
    : item?.lockupViewModel?.rendererContext?.commandContext?.onLongPress;
  const result: { endpoint: InnertubeCommand['showEngagementPanelEndpoint'] | null } = { endpoint: null };
  walkCommands(onLongPress, (n) => {
    if (isRecord(n.showEngagementPanelEndpoint)) {
      result.endpoint = n.showEngagementPanelEndpoint as InnertubeCommand['showEngagementPanelEndpoint'];
      return true;
    }
    return false;
  });
  if (result.endpoint?.identifier?.tag && result.endpoint?.globalConfiguration?.params) {
    return {
      panelId: result.endpoint.identifier.tag,
      params: result.endpoint.globalConfiguration.params,
    };
  }
  return null;
}

function menuHasFeedbackItems(menuItems: readonly Record<string, unknown>[]): boolean {
  return menuItems.some((menuItem) => {
    const service = isRecord(menuItem.menuServiceItemRenderer) ? menuItem.menuServiceItemRenderer : undefined;
    const nav = isRecord(menuItem.menuNavigationItemRenderer) ? menuItem.menuNavigationItemRenderer : undefined;
    const serviceEp = service?.serviceEndpoint;
    const navEp = nav?.navigationEndpoint;
    const act = getCustomActionName(serviceEp);
    return (
      act === 'NOT_INTERESTED' ||
      act === 'DONT_RECOMMEND_CHANNEL' ||
      Boolean(findFeedbackToken(serviceEp)) ||
      Boolean(findFeedbackToken(navEp))
    );
  });
}

function restoreFeedbackMenuItems(item: FeedItem, menuItems: Record<string, unknown>[]): void {
  const panel = getFeedbackPanel(item);
  if (!panel || menuHasFeedbackItems(menuItems)) return;
  menuItems.push(
    MenuServiceItemRenderer(t('videoMenu.notInterested'), {
      clickTrackingParams: null,
      playlistEditEndpoint: {
        customAction: { action: 'NOT_INTERESTED', parameters: panel },
      },
    }) as Record<string, unknown>,
    MenuServiceItemRenderer(t('videoMenu.dontRecommendChannel'), {
      clickTrackingParams: null,
      playlistEditEndpoint: {
        customAction: { action: 'DONT_RECOMMEND_CHANNEL', parameters: panel },
      },
    }) as Record<string, unknown>
  );
}

function isFeedbackMenuItem(menuItem: Record<string, unknown>): boolean {
  const service = isRecord(menuItem.menuServiceItemRenderer) ? menuItem.menuServiceItemRenderer : undefined;
  const act = getCustomActionName(service?.serviceEndpoint);
  if (act === 'NOT_INTERESTED' || act === 'DONT_RECOMMEND_CHANNEL') return true;
  const label = readMenuItemText(menuItem)
    .toLowerCase()
    .replace(/\u2019/g, "'");
  return label === 'not interested' || label === "don't recommend channel";
}

function addHideChannelMenuItem(item: FeedItem, menuItems: Record<string, unknown>[]): void {
  const ch = extractItemChannelInfo(item);
  if (!ch.name && !ch.id) return;
  if (
    menuItems.some((m) => {
      const service = isRecord(m.menuServiceItemRenderer) ? m.menuServiceItemRenderer : undefined;
      return getCustomActionName(service?.serviceEndpoint) === 'HIDE_CHANNEL';
    })
  ) {
    return;
  }
  const hideItem = MenuServiceItemRenderer('Hide Channel', {
    clickTrackingParams: null,
    playlistEditEndpoint: {
      customAction: { action: 'HIDE_CHANNEL', parameters: ch },
    },
  }) as Record<string, unknown>;
  const feedbackIdx = menuItems.findIndex(isFeedbackMenuItem);
  if (feedbackIdx !== -1) {
    menuItems.splice(feedbackIdx, 0, hideItem);
  } else {
    menuItems.push(hideItem);
  }
}

function addLongPress(items: FeedItem[]): void {
  if (!Array.isArray(items)) return;
  for (const entry of items) {
    const item = entry?.richItemRenderer?.content ?? entry;
    if (!item || !isLongPressVideoItem(item)) continue;

    const menuLists = getExistingMenuItemLists(item);
    if (menuLists.length > 0) {
      for (const menuItems of menuLists) {
        for (let i = menuItems.length - 1; i >= 0; i--) {
          const menuItem = menuItems[i];
          if (!menuItem) continue;
          if (isRemovedLongPressMenuItem(menuItem)) {
            menuItems.splice(i, 1);
          } else {
            normalizeMenuItemText(menuItem);
          }
        }
        addHideChannelMenuItem(item, menuItems);
        restoreFeedbackMenuItems(item, menuItems);
      }

      let hasShowMenuCmd = false;
      walkCommands(item.tileRenderer?.onLongPressCommand, (n) => {
        if (n.showMenuCommand) {
          hasShowMenuCmd = true;
          return true;
        }
        return false;
      });
      if (item.tileRenderer && !hasShowMenuCmd && configRead('enableLongPress') && item.tileRenderer.contentId) {
        item.tileRenderer.onLongPressCommand = {
          showMenuCommand: { contentId: item.tileRenderer.contentId } as unknown as InnertubeCommand['showMenuCommand'],
        };
      }
      continue;
    }

    if (!configRead('enableLongPress')) continue;
    const tr = item.tileRenderer;
    const lv = item.lockupViewModel;
    const thumbnails: Thumbnail[] | undefined = tr
      ? tr.header?.tileHeaderRenderer?.thumbnail?.thumbnails
      : (lv?.contentImage?.thumbnailViewModel?.image?.sources ??
        lv?.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel?.image?.sources);
    const videoId = tr?.contentId || lv?.contentId;
    const title = readFormattedText(
      tr ? tr.metadata?.tileMetadataRenderer?.title : lv?.metadata?.lockupMetadataViewModel?.title
    ).trim();
    const watchEndpointData = findWatchEndpoint(tr ? tr.onSelectCommand : lv?.rendererContext?.commandContext?.onTap);
    if (!videoId || !thumbnails || !title || !watchEndpointData) continue;

    const subtitle = extractItemChannelName(item);
    const data = longPressData({
      videoId,
      thumbnails,
      title,
      subtitle,
      watchEndpointData,
      item: buildLongPressPayload(item, videoId, watchEndpointData),
    }) as unknown as { showMenuCommand: { menu: { menuRenderer: { items: Record<string, unknown>[] } } } };

    addHideChannelMenuItem(item, data.showMenuCommand.menu.menuRenderer.items);
    restoreFeedbackMenuItems(item, data.showMenuCommand.menu.menuRenderer.items);

    if (tr) {
      tr.onLongPressCommand = data;
    } else if (lv) {
      lv.rendererContext = lv.rendererContext || {};
      lv.rendererContext.commandContext = lv.rendererContext.commandContext || {};
      lv.rendererContext.commandContext.onLongPress = { innertubeCommand: data };
    }
  }
}

function processItemsListSync(items: FeedItem[], shouldAddPreviews = true): FeedItem[] {
  if (!Array.isArray(items)) return items;
  const filtered = filterFeedItemsSync(items);
  // Fire DeArrow branding asynchronously so feed rendering never blocks on external API latency.
  void applyDeArrowBranding(filtered);
  upgradeFeedThumbnails(filtered);
  addLongPress(filtered);
  addPreviews(filtered, shouldAddPreviews);
  return filtered;
}

/**
 * Unifies processing of feed content, ensuring each node is processed exactly once
 * to avoid duplicacy and conflicting in-place mutations.
 */
function processContentNodeSync(node: unknown, shouldAddPreviews = true): void {
  if (!isRecord(node)) return;

  // Handle shelf-like renderers
  if (isRecord(node.shelfRenderer)) {
    processShelfContentSync(node.shelfRenderer.content, shouldAddPreviews);
  } else {
    const isr = isRecord(node.itemSectionRenderer) ? node.itemSectionRenderer : undefined;
    if (isr && Array.isArray(isr.contents)) {
      processShelvesSync(isr.contents as FeedItem[], shouldAddPreviews);
    } else if (node.richSectionRenderer) {
      const richSectionRecord = isRecord(node.richSectionRenderer) ? node.richSectionRenderer : undefined;
      const richContent = isRecord(richSectionRecord?.content) ? richSectionRecord.content : undefined;
      const richContentRecord = isRecord(richContent) ? richContent : undefined;
      if (
        richContentRecord?.richShelfRenderer &&
        Array.isArray((richContentRecord.richShelfRenderer as Record<string, unknown>).contents)
      ) {
        processShelvesSync(
          (richContentRecord.richShelfRenderer as Record<string, unknown>).contents as FeedItem[],
          shouldAddPreviews
        );
      } else if (richContentRecord) {
        processShelfContentSync(richContentRecord, shouldAddPreviews);
      }
    }
  }

  // Handle list-like containers
  for (const key of ITEM_LIST_KEYS) {
    const listContainer = isRecord(node[key]) ? node[key] : undefined;
    if (listContainer && Array.isArray(listContainer.items)) {
      listContainer.items = processItemsListSync(listContainer.items as FeedItem[], shouldAddPreviews);
    }
  }
}

// Unified Shelf Processor
function processShelvesSync(shelves: FeedItem[], shouldAddPreviews = true): void {
  if (!Array.isArray(shelves)) return;
  filterShelvesInPlaceSync(shelves);

  const directItems: FeedItem[] = [];

  for (const entry of shelves) {
    if (!isRecord(entry)) continue;

    // Delegate to unified processor
    if (entry.shelfRenderer || entry.itemSectionRenderer || entry.richSectionRenderer) {
      processContentNodeSync(entry, shouldAddPreviews);
    } else if (entry.sectionListRenderer || entry.richGridRenderer || ITEM_LIST_KEYS.some((k) => entry[k])) {
      processContentNodeSync(entry, shouldAddPreviews);
    } else if (
      entry.tileRenderer ||
      entry.lockupViewModel ||
      entry.shortsLockupViewModel ||
      entry.richItemRenderer?.content
    ) {
      directItems.push((entry.richItemRenderer?.content ?? entry) as FeedItem);
    }
  }

  if (directItems.length > 0) {
    processItemsListSync(directItems, shouldAddPreviews);
  }
}

function processBrowseActionsSync(actions: unknown, shouldAddPreviews = true): void {
  if (!Array.isArray(actions)) return;
  for (const action of actions) {
    if (!isRecord(action)) continue;
    const reload = isRecord(action.reloadContinuationItemsCommand) ? action.reloadContinuationItemsCommand : undefined;
    if (Array.isArray(reload?.continuationItems)) {
      processShelvesSync(reload.continuationItems as FeedItem[], shouldAddPreviews);
    }
    const append = isRecord(action.appendContinuationItemsAction) ? action.appendContinuationItemsAction : undefined;
    if (Array.isArray(append?.continuationItems)) {
      processShelvesSync(append.continuationItems as FeedItem[], shouldAddPreviews);
    }
    const replaceContainer = isRecord(action.replaceEnclosingAction) ? action.replaceEnclosingAction : undefined;
    const replace = isRecord(replaceContainer?.item) ? replaceContainer.item : undefined;
    if (replace) {
      if (
        replace.tileRenderer ||
        replace.lockupViewModel ||
        replace.shortsLockupViewModel ||
        (isRecord(replace.richItemRenderer) && replace.richItemRenderer.content)
      ) {
        processItemsListSync([replace as FeedItem], shouldAddPreviews);
      } else {
        processShelvesSync([replace as FeedItem], shouldAddPreviews);
      }
    }
  }
}

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
  if (/(?:REPORT|FEEDBACK)/i.test(String(btn.type || '')) || /(?:REPORT|FLAG|FEEDBACK)/i.test(iconType)) {
    return true;
  }
  return Boolean(nav?.getReportVideoFormEndpoint || nav?.sendFeedbackEndpoint || nav?.feedbackEndpoint);
}

function injectChapters(r: Record<string, unknown>): void {
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

function transformPlayerOverlays(r: Record<string, unknown>): void {
  const playerOverlays = isRecord(r.playerOverlays) ? r.playerOverlays : undefined;
  const overlayRenderer = isRecord(playerOverlays?.playerOverlayRenderer)
    ? playerOverlays.playerOverlayRenderer
    : undefined;
  if (!overlayRenderer) return;

  if (Array.isArray(overlayRenderer.timelyActionRenderers)) {
    overlayRenderer.timelyActionRenderers = overlayRenderer.timelyActionRenderers.filter((a) => {
      const inner = isRecord(a) && isRecord(a.timelyActionRenderer) ? a.timelyActionRenderer : undefined;
      return inner?.type !== 'TIMELY_ACTION_TYPE_SHOPPING' && inner?.type !== 'TIMELY_ACTION_TYPE_NFL_WATERMARK';
    });
  } else {
    overlayRenderer.timelyActionRenderers = [];
  }

  const manualSkipped = configRead('sponsorBlockManualSkips');
  const activeSegments = getActiveSponsorBlockSegments();
  if (!Array.isArray(manualSkipped) || manualSkipped.length === 0 || activeSegments.length === 0) return;

  const target = overlayRenderer.timelyActionRenderers as unknown[];
  for (const segment of activeSegments) {
    if (resolveSegmentActionType(segment) !== 'skip' || !manualSkipped.includes(segment.category)) continue;
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

function recordTransportLikeCount(r: Record<string, unknown>): void {
  const overlay = isRecord(r.playerOverlays) ? r.playerOverlays : undefined;
  const overlayRenderer = isRecord(overlay?.playerOverlayRenderer) ? overlay.playerOverlayRenderer : undefined;
  const tcWrapper = isRecord(r.transportControls)
    ? r.transportControls
    : isRecord(overlayRenderer?.transportControls)
      ? overlayRenderer.transportControls
      : undefined;
  const tc = isRecord(tcWrapper?.transportControlsRenderer) ? tcWrapper.transportControlsRenderer : undefined;
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

  for (const key of ['promotedActions', 'actions', 'buttons', 'engagementActions'] as const) {
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

function transformTransportControls(r: Record<string, unknown>): void {
  const transportControls = isRecord(r.transportControls) ? r.transportControls : undefined;
  const tcRenderer = isRecord(transportControls?.transportControlsRenderer)
    ? transportControls.transportControlsRenderer
    : undefined;
  if (!tcRenderer) return;

  if (Array.isArray(tcRenderer.promotedActions)) {
    tcRenderer.promotedActions = tcRenderer.promotedActions.filter((b) => !isUnwantedTransportButton(b));
  }
  if (Array.isArray(tcRenderer.actions)) {
    tcRenderer.actions = tcRenderer.actions.filter((b) => !isUnwantedTransportButton(b));
  }
  if (!Array.isArray(tcRenderer.promotedActions) || !configRead('enableSponsorBlockHighlight')) return;

  const highlight = getActiveSponsorBlockSegments().find((seg) => resolveSegmentActionType(seg) === 'poi');
  if (!highlight) return;

  tcRenderer.promotedActions.push({
    type: 'TRANSPORT_CONTROLS_BUTTON_TYPE_SPONSORBLOCK_HIGHLIGHT',
    button: {
      buttonRenderer: ButtonRenderer(false, t('sponsorblock.toasts.skipToHighlight'), 'SKIP_NEXT', {
        clickTrackingParams: null,
        customAction: {
          action: 'SKIP',
          parameters: { time: highlight.segment[0] },
        },
      }),
    },
  });
}

function transformChannelHeaderButtons(
  r: Record<string, unknown>,
  tvSurface: Record<string, unknown> | undefined
): void {
  const surfaceHeader = isRecord(tvSurface?.header) ? tvSurface.header : undefined;
  const channelHeader = isRecord(surfaceHeader?.channelHeaderRenderer)
    ? surfaceHeader.channelHeaderRenderer
    : undefined;
  if (!channelHeader || !Array.isArray(channelHeader.buttons)) return;

  const browseId = extractBrowseIdFromResponse(r);
  const titleNode = isRecord(channelHeader.title) ? channelHeader.title : undefined;
  const title = typeof titleNode?.simpleText === 'string' ? titleNode.simpleText : '';
  const inSidebar = configRead('sidebarContentsOrder')?.some(
    (orderItem) => (typeof orderItem === 'object' ? orderItem.browseId : orderItem) === browseId
  );

  channelHeader.buttons.push({
    buttonRenderer: ButtonRenderer(
      false,
      inSidebar
        ? t('settings.options.uiSettings.options.sortSidebarContents.removeFromSidebar')
        : t('settings.options.uiSettings.options.sortSidebarContents.addToSidebar'),
      inSidebar ? 'REMOVE' : 'ADD',
      {
        customAction: {
          action: 'ADD_OR_REMOVE_CHANNEL_TO_SIDEBAR',
          parameters: { browseId, title },
        },
      }
    ),
  });
}

const processedPayloads = new WeakSet<object>();

function isSettingsPayload(r: Record<string, unknown>, items: readonly unknown[]): boolean {
  if (items.some((entry) => isRecord(entry) && isRecord(entry.settingCategoryCollectionRenderer))) {
    return true;
  }
  const title = isRecord(r.title) ? r.title : undefined;
  return Boolean(
    Array.isArray(title?.runs) && !items.some((entry) => isRecord(entry) && isRecord(entry.guideSectionRenderer))
  );
}

function processSecondaryNavSync(secondaryNav: Record<string, unknown> | undefined): void {
  if (!Array.isArray(secondaryNav?.sections)) return;
  const seenTabs = new Set<string>();
  const sortAlpha = Boolean(configRead('sortSubscriptionsByAlphabet'));
  for (const rawSection of secondaryNav.sections) {
    if (!isRecord(rawSection)) continue;
    const section = isRecord(rawSection.tvSecondaryNavSectionRenderer)
      ? rawSection.tvSecondaryNavSectionRenderer
      : undefined;
    if (!section || !Array.isArray(section.tabs)) continue;

    section.tabs = dedupeAndSortSubscriptionTabs(section.tabs as SubscriptionTab[], seenTabs, sortAlpha);
    for (const tab of section.tabs as SubscriptionTab[]) {
      const content = tab.tabRenderer?.content?.tvSurfaceContentRenderer?.content;
      if (content) processBrowseContentSync(content, true);
    }
  }
}

function processBrowseContentSync(node: unknown, shouldAddPreviews = true): void {
  if (!isRecord(node)) return;
  processContentNodeSync(node, shouldAddPreviews);

  const slr = isRecord(node.sectionListRenderer) ? node.sectionListRenderer : undefined;
  if (slr && Array.isArray(slr.contents)) {
    processShelvesSync(slr.contents as FeedItem[], shouldAddPreviews);
  }
  const rgr = isRecord(node.richGridRenderer) ? node.richGridRenderer : undefined;
  if (rgr && Array.isArray(rgr.contents)) {
    processShelvesSync(rgr.contents as FeedItem[], shouldAddPreviews);
  }
}

function hasRelevantInnertubeKey(r: Record<string, unknown>): boolean {
  return Boolean(
    r.items ||
      r.adPlacements ||
      r.playerAds ||
      r.adSlots ||
      r.entries ||
      r.paidContentOverlay ||
      r.streamingData ||
      r.captions ||
      r.contents ||
      r.tvBrowseContent ||
      r.continuationContents ||
      r.onResponseReceivedActions ||
      r.endscreen ||
      r.messages ||
      r.title ||
      r.playerOverlays ||
      r.transportControls ||
      r.videoDetails ||
      r.playerResponse
  );
}

/**
 * Synchronously mutates parsed InnerTube payloads across `fetch` (`Response.json`),
 * `JSON.parse`, and `_yttv` internal JSON parsers without double-processing objects.
 */
export function transformInnertubeResponseSync(r: unknown): unknown {
  if (!isRecord(r) || processedPayloads.has(r) || !hasRelevantInnertubeKey(r)) return r;
  processedPayloads.add(r);

  try {
    if (Array.isArray(r.items)) {
      if (isSettingsPayload(r, r.items)) {
        patchSettingsInPlace(r);
        patchResolveCommand();
        syncYttvPreviewAndJson();
      } else {
        transformGuideResponse(r);
      }
    }

    if ((r.adPlacements || r.playerAds || r.adSlots || r.entries) && configRead('enableAdBlock')) {
      stripAdsFromPayload(r);
    }

    const signinReminderEnabled = configRead('enableSigninReminder');

    if (r.paidContentOverlay && !configRead('enablePaidPromotionOverlay')) {
      r.paidContentOverlay = null;
    }

    const streamingData = isRecord(r.streamingData) ? r.streamingData : undefined;
    if (Array.isArray(streamingData?.adaptiveFormats)) {
      streamingData.adaptiveFormats = filterStreamingFormats(
        streamingData.adaptiveFormats as AudioFormatEntry[],
        configRead('preferredVideoCodec'),
        Boolean(configRead('enableStableVolume'))
      );
    }

    disableAutoCaptionsInPayload(r);

    if (r.endscreen && configRead('enableHideEndScreenCards')) {
      r.endscreen = null;
    }

    if (Array.isArray(r.messages) && !configRead('enableYouThereRenderer')) {
      r.messages = r.messages.filter((msg) => !isRecord(msg) || !msg.youThereRenderer);
    }

    const contents = isRecord(r.contents) ? r.contents : undefined;
    if (contents) {
      processBrowseContentSync(contents, true);

      const tvBrowse = isRecord(contents.tvBrowseRenderer) ? contents.tvBrowseRenderer : undefined;
      const tvBrowseInner = isRecord(tvBrowse?.content) ? tvBrowse.content : undefined;
      const tvSurfaceContent = isRecord(tvBrowseInner?.tvSurfaceContentRenderer)
        ? tvBrowseInner.tvSurfaceContentRenderer
        : undefined;
      if (tvSurfaceContent?.content) {
        processBrowseContentSync(tvSurfaceContent.content, true);
      }
      processSecondaryNavSync(
        isRecord(tvBrowseInner?.tvSecondaryNavRenderer) ? tvBrowseInner.tvSecondaryNavRenderer : undefined
      );

      const singleColTabs = isRecord(contents.singleColumnBrowseResultsRenderer)
        ? contents.singleColumnBrowseResultsRenderer.tabs
        : undefined;
      if (Array.isArray(singleColTabs)) {
        for (const tab of singleColTabs) {
          const tabRenderer = isRecord(tab) && isRecord(tab.tabRenderer) ? tab.tabRenderer : undefined;
          if (tabRenderer?.content) {
            processBrowseContentSync(tabRenderer.content, true);
          }
        }
      }
    }

    const tvBrowseContent = isRecord(r.tvBrowseContent) ? r.tvBrowseContent : undefined;
    const tvSurface = isRecord(tvBrowseContent?.tvSurfaceRenderer)
      ? tvBrowseContent.tvSurfaceRenderer
      : isRecord(tvBrowseContent?.tvSurfaceContentRenderer)
        ? tvBrowseContent.tvSurfaceContentRenderer
        : undefined;
    if (tvSurface?.content) {
      processBrowseContentSync(tvSurface.content, true);
    }
    processSecondaryNavSync(
      isRecord(tvBrowseContent?.tvSecondaryNavRenderer) ? tvBrowseContent.tvSecondaryNavRenderer : undefined
    );

    const cont = isRecord(r.continuationContents) ? r.continuationContents : undefined;
    if (cont) {
      const sectionListCont = isRecord(cont.sectionListContinuation) ? cont.sectionListContinuation : undefined;
      if (Array.isArray(sectionListCont?.contents)) {
        processShelvesSync(sectionListCont.contents as FeedItem[], true);
      }
      const horizCont = isRecord(cont.horizontalListContinuation) ? cont.horizontalListContinuation : undefined;
      if (Array.isArray(horizCont?.items)) {
        horizCont.items = processItemsListSync(horizCont.items as FeedItem[], true);
      }
      const gridCont = isRecord(cont.gridContinuation) ? cont.gridContinuation : undefined;
      if (Array.isArray(gridCont?.items)) {
        gridCont.items = processItemsListSync(gridCont.items as FeedItem[], true);
      }
      const surfaceCont = isRecord(cont.tvSurfaceContentContinuation) ? cont.tvSurfaceContentContinuation : undefined;
      if (surfaceCont?.content) {
        processBrowseContentSync(surfaceCont.content, true);
      }
    }

    if (Array.isArray(r.onResponseReceivedActions)) {
      processBrowseActionsSync(r.onResponseReceivedActions, true);
    }

    const watchNext = isRecord(contents?.singleColumnWatchNextResults)
      ? contents.singleColumnWatchNextResults
      : undefined;
    const pivot = isRecord(watchNext?.pivot) ? watchNext.pivot : undefined;
    const pivotSectionList = isRecord(pivot?.sectionListRenderer) ? pivot.sectionListRenderer : undefined;
    if (pivotSectionList && Array.isArray(pivotSectionList.contents)) {
      let pivotContents: unknown[] = pivotSectionList.contents;
      if (!signinReminderEnabled) {
        pivotContents = pivotContents.filter((elm) => !isRecord(elm) || !elm.alertWithActionsRenderer);
        pivotSectionList.contents = pivotContents;
      }
      processShelvesSync(pivotContents as FeedItem[], false);
    }

    injectChapters(r);
    transformPlayerOverlays(r);
    recordTransportLikeCount(r);
    transformTransportControls(r);
    transformChannelHeaderButtons(r, tvSurface);
  } catch (error) {
    console.error('[InnertubeInterceptor] Failed to process JSON payload:', error);
  }

  return r;
}

function patchPlaybackContextBody(rawBody: string): string | null {
  if (!rawBody.includes('contentPlaybackContext')) return null;
  try {
    const body = JSON.parse(rawBody);
    if (!isRecord(body) || !body.playbackContext) return null;
    const playbackCtx = isRecord(body.playbackContext) ? body.playbackContext : undefined;
    const contentCtx = isRecord(playbackCtx?.contentPlaybackContext) ? playbackCtx.contentPlaybackContext : undefined;
    if (!contentCtx || contentCtx.isInlinePlaybackNoAd) return null;
    return JSON.stringify({
      ...body,
      playbackContext: {
        ...playbackCtx,
        contentPlaybackContext: {
          ...contentCtx,
          isInlinePlaybackNoAd: true,
        },
      },
    });
  } catch (e) {
    console.error('[InnertubeInterceptor] Failed to patch request body:', e);
    return null;
  }
}

const wrappedJsonParsers = new WeakSet<typeof JSON.parse>();

function wrapJsonParseFn(origParse: typeof JSON.parse): typeof JSON.parse {
  if (wrappedJsonParsers.has(origParse)) return origParse;
  const wrappedParse = function (
    this: unknown,
    text: string,
    reviver?: (this: unknown, key: string, value: unknown) => unknown
  ): unknown {
    const parsed = origParse.call(this, text, reviver);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return transformInnertubeResponseSync(parsed);
    }
    return parsed;
  } as typeof JSON.parse;
  wrappedJsonParsers.add(origParse);
  wrappedJsonParsers.add(wrappedParse);
  return wrappedParse;
}

function syncYttvPreviewAndJson(): void {
  if (typeof window === 'undefined' || !window._yttv) return;
  const enablePreviews = Boolean(configRead('enablePreviews'));
  for (const entry of Object.values(window._yttv)) {
    if (entry instanceof Map && entry.has('ENABLE_PREVIEWS_WITH_SOUND')) {
      entry.set('ENABLE_PREVIEWS_WITH_SOUND', enablePreviews);
    }
    if (isObjectLike(entry) && isObjectLike(entry.JSON) && typeof entry.JSON.parse === 'function') {
      entry.JSON.parse = wrapJsonParseFn(entry.JSON.parse as typeof JSON.parse);
    }
  }
}

let interceptorInstalled = false;

export function installInnertubeInterceptor(): void {
  if (interceptorInstalled) return;
  interceptorInstalled = true;

  // 1. Wrap JSON.parse so XHR, Response.text(), and inline XSSI-stripped payloads transform synchronously.
  if (typeof JSON !== 'undefined' && typeof JSON.parse === 'function') {
    JSON.parse = wrapJsonParseFn(JSON.parse);
  }

  // 2. Intercept Response.json() (native V8 JSON path that bypasses JSON.parse).
  if (typeof Response !== 'undefined' && typeof Response.prototype?.json === 'function') {
    const origResponseJson = Response.prototype.json;
    Response.prototype.json = async function (this: Response) {
      const data: unknown = await origResponseJson.call(this);
      const url = typeof this.url === 'string' ? this.url : '';
      if (url && EXTERNAL_JSON_HOSTS.some((host) => url.includes(host))) {
        return data;
      }
      return transformInnertubeResponseSync(data);
    } as typeof Response.prototype.json;
  }

  // 3. Intercept fetch() & XMLHttpRequest.send() for outgoing playbackContext modifications.
  if (typeof window !== 'undefined' && typeof window.fetch === 'function') {
    const origFetch = window.fetch;
    window.fetch = (resource, init) => {
      if (init && typeof init.body === 'string') {
        const patchedBody = patchPlaybackContextBody(init.body);
        if (patchedBody !== null) init.body = patchedBody;
      }
      return origFetch(resource, init);
    };
  }

  if (typeof XMLHttpRequest !== 'undefined' && typeof XMLHttpRequest.prototype?.send === 'function') {
    const origXhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (
      this: XMLHttpRequest,
      body?: Document | XMLHttpRequestBodyInit | null
    ): void {
      if (typeof body === 'string') {
        const patchedBody = patchPlaybackContextBody(body);
        if (patchedBody !== null) {
          origXhrSend.call(this, patchedBody);
          return;
        }
      }
      origXhrSend.call(this, body);
    };
  }

  // 4. Sync feature flags & _yttv-scoped JSON.parse once YouTube TV runtime initializes, plus on toggle.
  onConfigChange('enablePreviews', () => {
    syncYttvPreviewAndJson();
  });
  whenYttvReady(() => {
    syncYttvPreviewAndJson();
    void whenConfigReady().then(syncYttvPreviewAndJson);
  });

  installThumbnailErrorFallback();
}

if (typeof window !== 'undefined') {
  installInnertubeInterceptor();
}
