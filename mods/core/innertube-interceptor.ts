import { configRead } from './config.ts';
import { t } from '../core/i18n.ts';
import { getActiveSponsorBlockSegments } from '../features/sponsorblock.ts';
import { processRydResponse } from '../features/return-youtube-dislike.ts';
import {
  extractItemChannelInfo,
  extractItemChannelName,
  filterFeedItems,
  filterShelvesInPlace,
  getExistingMenuItemLists,
  readFormattedText,
  walkCommands,
} from '../transforms/feed-filter.ts';
import resolveCommand from './resolve-command.ts';
import {
  dedupeAndSortSubscriptionTabs,
  disableAutoCaptionsInPayload,
  extractBrowseIdFromResponse,
  filterStreamingFormats,
  stripAdsFromPayload,
} from '../transforms/innertube-player.ts';
import { addPreviews } from '../interceptors/previews.ts';
import type { AudioFormatEntry, SubscriptionTab } from '../transforms/innertube-player.ts';
import { applyDeArrowBranding, installThumbnailErrorFallback, upgradeFeedThumbnails } from '../transforms/thumbnails.ts';
import type { FeedItem, InnertubeCommand, PlayerResponse, Thumbnail, WatchEndpoint } from '../types/innertube.ts';
import { buildChaptersMarkerEntity } from '../transforms/chapters.ts';
import { transformGuideResponse } from '../ui/custom-guide-action.ts';
import { ButtonRenderer, MenuServiceItemRenderer, longPressData, timelyAction } from '../ui/yt-ui.ts';
import { buildLongPressPayload } from '../utils/feed-helpers.ts';
import { findFeedbackToken } from './innertube-calls.ts';
import { isRecord } from '../utils/type-guards.ts';

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

async function processShelfContent(content: unknown, shouldAddPreviews = true): Promise<void> {
  if (!isRecord(content)) return;
  if (Array.isArray(content.items)) {
    content.items = await processItemsList(content.items as FeedItem[], shouldAddPreviews);
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
  const label = readMenuItemText(menuItem).toLowerCase().replace(/\u2019/g, "'");
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
    const title = readFormattedText(tr ? tr.metadata?.tileMetadataRenderer?.title : lv?.metadata?.lockupMetadataViewModel?.title).trim();
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

async function processItemsList(items: FeedItem[], shouldAddPreviews = true): Promise<FeedItem[]> {
  if (!Array.isArray(items)) return items;
  const filtered = await filterFeedItems(items);
  await applyDeArrowBranding(filtered);
  upgradeFeedThumbnails(filtered);
  addLongPress(filtered);
  addPreviews(filtered, shouldAddPreviews);
  return filtered;
}

/**
 * Unifies processing of feed content, ensuring each node is processed exactly once
 * to avoid duplicacy and conflicting in-place mutations.
 */
async function processContentNode(node: unknown, shouldAddPreviews = true): Promise<void> {
  if (!isRecord(node)) return;

  // Handle shelf-like renderers
  if (isRecord(node.shelfRenderer)) {
    await processShelfContent(node.shelfRenderer.content, shouldAddPreviews);
  } else {
    const isr = isRecord(node.itemSectionRenderer) ? node.itemSectionRenderer : undefined;
    if (isr && Array.isArray(isr.contents)) {
      await processShelves(isr.contents as FeedItem[], shouldAddPreviews);
    } else if (node.richSectionRenderer) {
      const richSectionRecord = isRecord(node.richSectionRenderer) ? node.richSectionRenderer : undefined;
      const richContent = isRecord(richSectionRecord?.content) ? richSectionRecord.content : undefined;
      const richContentRecord = isRecord(richContent) ? richContent : undefined;
      if (richContentRecord?.richShelfRenderer && Array.isArray((richContentRecord.richShelfRenderer as Record<string, unknown>).contents)) {
        await processShelves((richContentRecord.richShelfRenderer as Record<string, unknown>).contents as FeedItem[], shouldAddPreviews);
      } else if (richContentRecord) {
        await processShelfContent(richContentRecord, shouldAddPreviews);
      }
    }
  }

  // Handle list-like containers
  for (const key of ITEM_LIST_KEYS) {
    const listContainer = isRecord(node[key]) ? node[key] : undefined;
    if (listContainer && Array.isArray(listContainer.items)) {
      listContainer.items = await processItemsList(listContainer.items as FeedItem[], shouldAddPreviews);
    }
  }
}

// Unified Shelf Processor
async function processShelves(shelves: FeedItem[], shouldAddPreviews = true): Promise<void> {
  if (!Array.isArray(shelves)) return;
  await filterShelvesInPlace(shelves);
  
  const directItems: FeedItem[] = [];

  for (const entry of shelves) {
    if (!isRecord(entry)) continue;

    // Delegate to unified processor
    if (entry.shelfRenderer || entry.itemSectionRenderer || entry.richSectionRenderer) {
      await processContentNode(entry, shouldAddPreviews);
    } else if (entry.sectionListRenderer || entry.richGridRenderer || ITEM_LIST_KEYS.some((k) => entry[k])) {
      await processContentNode(entry, shouldAddPreviews);
    } else if (entry.tileRenderer || entry.lockupViewModel || entry.shortsLockupViewModel || entry.richItemRenderer?.content) {
      directItems.push((entry.richItemRenderer?.content ?? entry) as FeedItem);
    }
  }

  if (directItems.length > 0) {
    await processItemsList(directItems, shouldAddPreviews);
  }
}

async function processBrowseActions(actions: unknown, shouldAddPreviews = true): Promise<void> {
  if (!Array.isArray(actions)) return;
  for (const action of actions) {
    if (!isRecord(action)) continue;
    const reload = isRecord(action.reloadContinuationItemsCommand) ? action.reloadContinuationItemsCommand : undefined;
    if (Array.isArray(reload?.continuationItems)) {
      await processShelves(reload.continuationItems as FeedItem[], shouldAddPreviews);
    }
    const append = isRecord(action.appendContinuationItemsAction) ? action.appendContinuationItemsAction : undefined;
    if (Array.isArray(append?.continuationItems)) {
      await processShelves(append.continuationItems as FeedItem[], shouldAddPreviews);
    }
    const replaceContainer = isRecord(action.replaceEnclosingAction) ? action.replaceEnclosingAction : undefined;
    const replace = isRecord(replaceContainer?.item) ? replaceContainer.item : undefined;
    if (replace) {
      if (replace.tileRenderer || replace.lockupViewModel || replace.shortsLockupViewModel || isRecord(replace.richItemRenderer) && replace.richItemRenderer.content) {
        await processItemsList([replace as FeedItem], shouldAddPreviews);
      } else {
        await processShelves([replace as FeedItem], shouldAddPreviews);
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
  const nav = isRecord(br?.navigationEndpoint)
    ? br.navigationEndpoint
    : isRecord(br?.command)
      ? br.command
      : undefined;
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

  const fwUpdates = isRecord(r.frameworkUpdates) ? r.frameworkUpdates : (r.frameworkUpdates = {});
  const batchUpdate = isRecord(fwUpdates.entityBatchUpdate)
    ? fwUpdates.entityBatchUpdate
    : (fwUpdates.entityBatchUpdate = {});
  const mutations: unknown[] = Array.isArray(batchUpdate.mutations)
    ? batchUpdate.mutations
    : (batchUpdate.mutations = []);
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
    if (!manualSkipped.includes(segment.category)) continue;
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

  const highlight = getActiveSponsorBlockSegments().find((seg) => seg.category === 'poi_highlight');
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

function transformChannelHeaderButtons(r: Record<string, unknown>, tvSurface: Record<string, unknown> | undefined): void {
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
      r.continuationContents ||
      r.onResponseReceivedActions ||
      r.endscreen ||
      r.messages ||
      r.title ||
      r.playerOverlays ||
      r.transportControls ||
      r.videoDetails
  );
}

export async function transformInnertubeResponse(r: unknown): Promise<unknown> {
  if (!isRecord(r) || !hasRelevantInnertubeKey(r)) return r;

  try {
    if (Array.isArray(r.items)) {
      await transformGuideResponse(r);
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
        configRead('preferredVideoCodec')
      );
    }

    disableAutoCaptionsInPayload(r);

    const contents = isRecord(r.contents) ? r.contents : undefined;
    if (contents) {
      await processContentNode(contents, true);
      // Fallback for older layouts
      const slr = isRecord(contents.sectionListRenderer) ? contents.sectionListRenderer : undefined;
      if (slr && Array.isArray(slr.contents)) {
        await processShelves(slr.contents as FeedItem[], true);
      }
      const rgr = isRecord(contents.richGridRenderer) ? contents.richGridRenderer : undefined;
      if (rgr && Array.isArray(rgr.contents)) {
        await processShelves(rgr.contents as FeedItem[], true);
      }
    }

    const tvBrowseContent = isRecord(r.tvBrowseContent) ? r.tvBrowseContent : undefined;
    const tvSurface = isRecord(tvBrowseContent?.tvSurfaceRenderer)
      ? tvBrowseContent.tvSurfaceRenderer
      : undefined;
    const secondaryNav = isRecord(tvBrowseContent?.tvSecondaryNavRenderer)
      ? tvBrowseContent.tvSecondaryNavRenderer
      : undefined;
    if (Array.isArray(secondaryNav?.sections)) {
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
          if (content) await processShelfContent(content);
        }
      }
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
      await processShelves(pivotContents as FeedItem[], false);
    }

    injectChapters(r);
    transformPlayerOverlays(r);
    transformTransportControls(r);
    processRydResponse(r as PlayerResponse);
    transformChannelHeaderButtons(r, tvSurface);
  } catch (error) {
    console.error('[InnertubeInterceptor] Failed to process JSON payload:', error);
  }

  return r;
}

export function installInnertubeInterceptor(): void {
  // 1. Intercept Response.json() (Main JSON response processing)
  if (typeof Response !== 'undefined' && typeof Response.prototype?.json === 'function') {
    const origResponseJson = Response.prototype.json;
    Response.prototype.json = (async function (this: Response) {
      const data: unknown = await origResponseJson.call(this);
      const url = typeof this.url === 'string' ? this.url : '';
      if (url && EXTERNAL_JSON_HOSTS.some((host) => url.includes(host))) {
        return data;
      }
      return transformInnertubeResponse(data);
    }) as typeof Response.prototype.json;
  }

  // 2. Intercept fetch() for outgoing request modifications (replacing JSON.stringify patch)
  if (typeof window !== 'undefined' && typeof window.fetch === 'function') {
    const origFetch = window.fetch;
    window.fetch = (resource, init) => {
      if (init && typeof init.body === 'string') {
        try {
          const body = JSON.parse(init.body);
          if (isRecord(body) && body.playbackContext) {
            const playbackCtx = isRecord(body.playbackContext) ? body.playbackContext : undefined;
            const contentCtx = isRecord(playbackCtx?.contentPlaybackContext) ? playbackCtx.contentPlaybackContext : undefined;
            if (contentCtx && !contentCtx.isInlinePlaybackNoAd) {
              const patched = {
                ...body,
                playbackContext: {
                  ...playbackCtx,
                  contentPlaybackContext: {
                    ...contentCtx,
                    isInlinePlaybackNoAd: true,
                  },
                },
              };
              init.body = JSON.stringify(patched);
            }
          }
        } catch (e) {
          console.error('[InnertubeInterceptor] Failed to patch request body:', e);
        }
      }
      return origFetch(resource, init);
    };
  }

  // 3. Keep environment specific patches (window._yttv) if required
  if (typeof window !== 'undefined' && window._yttv) {
    for (const entry of Object.values(window._yttv)) {
      if (entry instanceof Map && entry.has('ENABLE_PREVIEWS_WITH_SOUND')) {
        entry.set('ENABLE_PREVIEWS_WITH_SOUND', false);
      }
    }
  }

  installThumbnailErrorFallback();
}

if (typeof window !== 'undefined') {
  installInnertubeInterceptor();
}
