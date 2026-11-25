import { t } from '../core/i18n.ts';
import { findFeedbackToken } from '../core/innertube-calls.ts';
import type { FeedItem, InnertubeCommand, Thumbnail, WatchEndpoint } from '../types/innertube.ts';
import { longPressData, MenuServiceItemRenderer } from '../ui/yt-ui.ts';
import { buildLongPressPayload, unwrapFeedItem } from '../utils/feed-helpers.ts';
import {
  extractCustomAction,
  extractItemChannelName,
  getExistingMenuItemLists,
  readFormattedText,
  walkCommands,
} from '../utils/innertube-ast.ts';
import { isRecord, readRecordPath } from '../utils/type-guards.ts';

const MENU_TITLE_CASE_KEYS: Readonly<Record<string, string>> = {
  'save to watch later': 'videoMenu.saveToWatchLater',
  'remove from watch later': 'videoMenu.removeFromWatchLater',
  'not interested': 'videoMenu.notInterested',
  "don't recommend channel": 'videoMenu.dontRecommendChannel',
  'go to channel': 'videoMenu.goToChannel',
};

function getCustomActionName(serviceEndpoint: unknown): string {
  return extractCustomAction(serviceEndpoint)?.action ?? '';
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
  const renderer =
    readRecordPath(menuItem, 'menuServiceItemRenderer') ?? readRecordPath(menuItem, 'menuNavigationItemRenderer');
  return readFormattedText(renderer?.text).trim();
}

function setMenuItemText(menuItem: Record<string, unknown>, newText: string): void {
  const renderer =
    readRecordPath(menuItem, 'menuServiceItemRenderer') ?? readRecordPath(menuItem, 'menuNavigationItemRenderer');
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
  const navEp = readRecordPath(menuItem, 'menuNavigationItemRenderer', 'navigationEndpoint');
  if (navEp?.addToPlaylistEndpoint) return true;

  const service = readRecordPath(menuItem, 'menuServiceItemRenderer');
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
    const serviceEp = readRecordPath(menuItem, 'menuServiceItemRenderer')?.serviceEndpoint;
    const navEp = readRecordPath(menuItem, 'menuNavigationItemRenderer')?.navigationEndpoint;
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

/**
 * Ensures video items have a clean long-press menu without queue/playlist clutter,
 * restoring feedback actions and generating fallback `showMenuCommand` menus when absent.
 */
export function addLongPress(items: FeedItem[]): void {
  if (!Array.isArray(items)) return;
  for (const entry of items) {
    const item = unwrapFeedItem(entry);
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
      if (item.tileRenderer && !hasShowMenuCmd && item.tileRenderer.contentId) {
        item.tileRenderer.onLongPressCommand = {
          showMenuCommand: { contentId: item.tileRenderer.contentId } as unknown as InnertubeCommand['showMenuCommand'],
        };
      }
      continue;
    }

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

    restoreFeedbackMenuItems(item, data.showMenuCommand.menu.menuRenderer.items);

    if (tr) {
      tr.onLongPressCommand = data;
    } else if (lv) {
      (lv.rendererContext as { commandContext: { onLongPress?: unknown } }).commandContext.onLongPress = {
        innertubeCommand: data,
      };
    }
  }
}
