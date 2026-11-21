import type { SidebarContentItem } from '../core/config.ts';
import { configRead, configWrite, onConfigChange } from '../core/config.ts';
import { clearGuideCache } from '../core/innertube-calls.ts';
import { getCommandExecutor } from '../core/yttv-bridge.ts';
import { isRecord } from '../utils/type-guards.ts';
import { GuideEntryRenderer } from './yt-ui.ts';

export interface GuideEntryRendererData {
  navigationEndpoint?: {
    browseEndpoint?: { browseId?: string };
    searchEndpoint?: unknown;
    reelWatchEndpoint?: unknown;
  };
  icon?: { iconType?: string };
  thumbnail?: unknown;
  formattedTitle?: { simpleText?: string };
}

export function getGuideItemId(entry: GuideEntryRendererData | null | undefined): string | null {
  const ep = entry?.navigationEndpoint;
  if (ep?.browseEndpoint?.browseId) return ep.browseEndpoint.browseId;
  if (ep?.searchEndpoint) return 'search';
  if (ep?.reelWatchEndpoint || entry?.icon?.iconType === 'TAB_SHORTS' || entry?.icon?.iconType === 'SHORTS') {
    return 'FEshorts';
  }
  return entry?.icon?.iconType || null;
}

export function transformGuideResponse(r: unknown): unknown {
  if (!isRecord(r) || !Array.isArray(r.items)) return r;
  const firstEntry = isRecord(r.items[0]) ? r.items[0] : undefined;
  const firstSection = isRecord(firstEntry?.guideSectionRenderer) ? firstEntry.guideSectionRenderer : undefined;
  if (!firstSection || !Array.isArray(firstSection.items)) return r;

  const order: SidebarContentItem[] = [...configRead('sidebarContentsOrder')];
  const orderIds = new Set(order.map((o) => (typeof o === 'object' ? o.browseId : o)));
  let orderChanged = false;
  for (const item of firstSection.items) {
    const renderer = isRecord(item) ? (item.guideEntryRenderer as GuideEntryRendererData | undefined) : undefined;
    const itemOrder = getGuideItemId(renderer);
    if (itemOrder && !orderIds.has(itemOrder)) {
      order.push(itemOrder);
      orderIds.add(itemOrder);
      orderChanged = true;
    }
  }
  if (orderChanged) void configWrite('sidebarContentsOrder', order);

  const currentOrder = configRead('sidebarContentsOrder');
  if (currentOrder.length === 0) {
    const initialOrder: SidebarContentItem[] = [];
    for (const item of firstSection.items) {
      const renderer = isRecord(item) ? (item.guideEntryRenderer as GuideEntryRendererData | undefined) : undefined;
      const browseId = getGuideItemId(renderer);
      if (browseId) initialOrder.push(browseId);
    }
    void configWrite('sidebarContentsOrder', initialOrder);
  } else {
    const copiedItems: unknown[] = [...firstSection.items];
    for (const orderItem of currentOrder) {
      if (typeof orderItem === 'object' && orderItem !== null) {
        copiedItems.push(
          GuideEntryRenderer(orderItem.title, { browseEndpoint: { browseId: orderItem.browseId } }, 'PERSON')
        );
      }
    }

    const indexById = new Map<string, number>();
    for (let idx = 0; idx < copiedItems.length; idx++) {
      const raw = copiedItems[idx];
      const renderer = isRecord(raw) ? (raw.guideEntryRenderer as GuideEntryRendererData | undefined) : undefined;
      const id = getGuideItemId(renderer);
      if (id && !indexById.has(id)) {
        indexById.set(id, idx);
      }
    }

    const orderedItems: unknown[] = [];
    const placed = new Set<number>();
    for (const orderItem of currentOrder) {
      const browseId = typeof orderItem === 'object' ? orderItem.browseId : orderItem;
      const index = indexById.get(browseId);
      if (index !== undefined) {
        orderedItems.push(copiedItems[index]);
        placed.add(index);
      }
    }
    copiedItems.forEach((item, index) => {
      if (!placed.has(index)) orderedItems.push(item);
    });
    firstSection.items = orderedItems;
  }

  const disabledSet = new Set(configRead('disabledSidebarContents'));
  const disableChannelsOnSidebar = configRead('disableChannelsOnSidebar');
  for (const rawSection of r.items) {
    if (!isRecord(rawSection)) continue;
    const section = isRecord(rawSection.guideSectionRenderer) ? rawSection.guideSectionRenderer : undefined;
    if (!section || !Array.isArray(section.items)) continue;
    section.originalItems = section.items.slice();
    for (let j = section.items.length - 1; j >= 0; j--) {
      const entry = section.items[j];
      const item = isRecord(entry) ? (entry.guideEntryRenderer as GuideEntryRendererData | undefined) : undefined;
      if (!item) continue;
      const itemId = getGuideItemId(item);
      if ((disabledSet.size > 0 && itemId && disabledSet.has(itemId)) || (disableChannelsOnSidebar && item.thumbnail)) {
        section.items.splice(j, 1);
      }
    }
  }

  return r;
}

if (typeof window !== 'undefined') {
  onConfigChange(['disabledSidebarContents', 'disableChannelsOnSidebar', 'sidebarContentsOrder'], () => {
    clearGuideCache();
    const commandExecutor = getCommandExecutor();
    if (commandExecutor?.commandFunction) {
      commandExecutor.executeFunction(new commandExecutor.commandFunction('reloadGuideAction'));
    }
  });
}
