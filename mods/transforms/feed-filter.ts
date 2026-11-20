import { configRead } from '../core/config.ts';
import type { FeedItem, FormattedText, HiddenChannel } from '../types/innertube.ts';
import { compactInPlace } from '../utils/feed-helpers.ts';
import { isRecord } from '../utils/type-guards.ts';

interface ComputedItemMetadata {
  channelInfo?: HiddenChannel;
  hasPaidOffer?: boolean;
  hasBlockedBadge?: boolean;
}

const computedMetadataCache = new WeakMap<FeedItem, ComputedItemMetadata>();

function getComputedMetadata(item: FeedItem): ComputedItemMetadata {
  let meta = computedMetadataCache.get(item);
  if (!meta) {
    meta = {};
    computedMetadataCache.set(item, meta);
  }
  return meta;
}

export interface FeedFilterOptions {
  enableAdBlock?: boolean;
  enableSigninReminder?: boolean;
  enableShorts?: boolean;
  enableHideWatchedVideos?: boolean;
  hideWatchedVideosThreshold?: number;
  hideWatchedVideosPages?: readonly string[];
  hiddenChannels?: readonly HiddenChannel[];
  locationHash?: string;
}

const BADGE_KEY_RE = /badge/i;
const SURVEY_KEY_RE = /survey|questionnaire/i;
const BADGE_SKIP_KEYS = new Set([
  'parameters',
  'trackingParams',
  'thumbnail',
  'thumbnails',
  'accessibility',
  'menu',
  'onLongPressCommand',
  'loggingDirectives',
]);
const PAID_BADGE_STYLES = ['BADGE_STYLE_TYPE_YPC', 'BADGE_STYLE_TYPE_PAID', 'PAID_CONTENT'] as const;
const PAID_BADGE_LABEL_RE = /\b(buy or rent|rent or buy|paid content)\b|^(paid|rent|buy)\b/i;

function unwrapFeedItem(item: FeedItem | null | undefined): FeedItem | null {
  if (!isRecord(item)) return null;
  const content = item.richItemRenderer?.content;
  return isRecord(content) ? content : item;
}

/**
 * Traverses an InnerTube command object, following nested `innertubeCommand` and
 * `commandExecutorCommand.commands` entries up to `maxDepth`, stopping early if
 * `visitor` returns `true`.
 */
export function walkCommands(
  node: unknown,
  visitor: (command: Record<string, unknown>) => boolean,
  maxDepth = 4
): boolean {
  const visit = (current: unknown, depth: number): boolean => {
    if (!isRecord(current) || depth > maxDepth) return false;
    if (visitor(current)) return true;

    if (visit(current.innertubeCommand, depth + 1)) return true;

    const executor = current.commandExecutorCommand;
    if (isRecord(executor) && Array.isArray(executor.commands)) {
      for (const subCommand of executor.commands) {
        if (visit(subCommand, depth + 1)) return true;
      }
    }

    return false;
  };

  return visit(node, 0);
}

export function readFormattedText(node: unknown): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (!isRecord(node)) return '';

  if (typeof node.simpleText === 'string') return node.simpleText;
  if (typeof node.content === 'string') return node.content;
  if (Array.isArray(node.runs)) {
    return node.runs.map((run) => (isRecord(run) && typeof run.text === 'string' ? run.text : '')).join('');
  }
  return '';
}

function firstNonEmptyText(nodes: unknown, pick: (entry: Record<string, unknown>) => unknown): string {
  if (!Array.isArray(nodes)) return '';
  for (const entry of nodes) {
    if (!isRecord(entry)) continue;
    const text = readFormattedText(pick(entry)).trim();
    if (text) return text;
  }
  return '';
}

export function extractItemChannelName(item: FeedItem | null | undefined): string {
  const target = unwrapFeedItem(item);
  if (!target) return '';

  if (target.tileRenderer) {
    const lines = target.tileRenderer.metadata?.tileMetadataRenderer?.lines;
    const firstLine = Array.isArray(lines) ? lines[0] : undefined;
    const lineItems =
      isRecord(firstLine) && isRecord(firstLine.lineRenderer) ? firstLine.lineRenderer.items : undefined;
    return firstNonEmptyText(lineItems, (entry) =>
      isRecord(entry.lineItemRenderer) ? entry.lineItemRenderer.text : undefined
    );
  }

  const metaVm: unknown = target.lockupViewModel?.metadata?.lockupMetadataViewModel;
  if (!isRecord(metaVm)) return '';
  const contentMeta = isRecord(metaVm.metadata) ? metaVm.metadata.contentMetadataViewModel : undefined;
  const rows = isRecord(contentMeta) && Array.isArray(contentMeta.metadataRows) ? contentMeta.metadataRows : undefined;
  const firstRow = rows?.[0];
  const parts = isRecord(firstRow) ? firstRow.metadataParts : undefined;
  return firstNonEmptyText(parts, (entry) => entry.text);
}

export function getExistingMenuItemLists(
  item: FeedItem | null | undefined
): Array<Array<Record<string, unknown>>> {
  const target = unwrapFeedItem(item);
  if (!target) return [];

  const lists: Array<Array<Record<string, unknown>>> = [];
  const collectMenuItems = (command: unknown): void => {
    walkCommands(command, (cmd) => {
      const showMenu = isRecord(cmd.showMenuCommand) ? cmd.showMenuCommand : undefined;
      const menu = isRecord(showMenu?.menu) ? showMenu.menu : undefined;
      const menuRenderer = isRecord(menu?.menuRenderer) ? menu.menuRenderer : undefined;
      if (Array.isArray(menuRenderer?.items)) {
        lists.push(menuRenderer.items as Array<Record<string, unknown>>);
      }
      return false;
    });
  };

  if (target.tileRenderer) {
    const tileMenu = isRecord(target.tileRenderer.menu) ? target.tileRenderer.menu : undefined;
    const tileMenuRenderer = isRecord(tileMenu?.menuRenderer) ? tileMenu.menuRenderer : undefined;
    if (Array.isArray(tileMenuRenderer?.items)) {
      lists.push(tileMenuRenderer.items as Array<Record<string, unknown>>);
    }
    collectMenuItems(target.tileRenderer.onLongPressCommand);
  } else if (target.lockupViewModel) {
    collectMenuItems(target.lockupViewModel.rendererContext?.commandContext?.onLongPress);
  }

  return Array.from(new Set(lists));
}

export function extractItemChannelInfo(item: FeedItem | null | undefined): HiddenChannel {
  const target = unwrapFeedItem(item);
  if (!target) return { id: '', name: '' };

  const name = extractItemChannelName(target);
  let id = '';

  const pickBrowseId = (command: unknown): void => {
    if (!command || id) return;
    walkCommands(command, (cmd) => {
      const browseEndpoint = isRecord(cmd.browseEndpoint) ? cmd.browseEndpoint : undefined;
      const browseId = browseEndpoint?.browseId;
      if (typeof browseId === 'string' && browseId.startsWith('UC')) {
        id = browseId;
        return true;
      }
      return false;
    });
  };

  const metaVm: unknown = target.lockupViewModel?.metadata?.lockupMetadataViewModel;
  if (isRecord(metaVm)) {
    const avatarContainer = isRecord(metaVm.image)
      ? metaVm.image
      : isRecord(metaVm.avatar)
        ? metaVm.avatar
        : undefined;
    const decoratedAvatar = isRecord(avatarContainer?.decoratedAvatarViewModel)
      ? avatarContainer.decoratedAvatarViewModel
      : undefined;
    const avatarRendererContext = isRecord(decoratedAvatar?.rendererContext)
      ? decoratedAvatar.rendererContext
      : undefined;
    const avatarCommandContext = isRecord(avatarRendererContext?.commandContext)
      ? avatarRendererContext.commandContext
      : undefined;
    pickBrowseId(avatarCommandContext?.onTap);
  }

  if (!id) {
    const menuLists = getExistingMenuItemLists(target);
    for (const rawItems of menuLists) {
      if (id) break;
      for (const menuItem of rawItems) {
        if (id) break;
        const navRenderer = isRecord(menuItem.menuNavigationItemRenderer)
          ? menuItem.menuNavigationItemRenderer
          : undefined;
        const serviceRenderer = isRecord(menuItem.menuServiceItemRenderer)
          ? menuItem.menuServiceItemRenderer
          : undefined;
        pickBrowseId(navRenderer?.navigationEndpoint ?? serviceRenderer?.serviceEndpoint);
      }
    }
  }

  return { id, name };
}

function isSurveyTitle(titleText: unknown): boolean {
  if (!titleText) return false;
  const normalized = String(titleText).toLowerCase();
  return normalized.includes('help us improve') || normalized.includes('help us make youtube');
}

export function isSurveyItem(item: FeedItem | null | undefined): boolean {
  if (!isRecord(item)) return false;

  for (const key of Object.keys(item)) {
    if (SURVEY_KEY_RE.test(key)) return true;
  }

  const textSources: Array<FormattedText | string | undefined> = [
    item.shelfRenderer?.title,
    item.shelfRenderer?.headerRenderer?.shelfHeaderRenderer?.title,
    item.title,
  ];

  for (const candidate of textSources) {
    if (isSurveyTitle(readFormattedText(candidate))) {
      return true;
    }
  }

  return false;
}

export function isShortsItem(item: FeedItem | null | undefined): boolean {
  if (!isRecord(item)) return false;
  const target = unwrapFeedItem(item);
  if (!target) return false;

  if (
    item.shelfRenderer?.tvhtml5ShelfRendererType === 'TVHTML5_SHELF_RENDERER_TYPE_SHORTS' ||
    Boolean(item.reelShelfRenderer) ||
    Boolean(item.shortsLockupViewModel) ||
    Boolean(target.shortsLockupViewModel)
  ) {
    return true;
  }

  if (target.lockupViewModel?.contentType === 'LOCKUP_CONTENT_TYPE_SHORT') {
    return true;
  }

  const tile = target.tileRenderer;
  if (!tile) return false;

  return (
    tile.tvhtml5ShelfRendererType === 'TVHTML5_TILE_RENDERER_TYPE_SHORTS' ||
    tile.style === 'TILE_STYLE_YTLR_SHORTS' ||
    tile.contentType === 'TILE_CONTENT_TYPE_SHORTS' ||
    Boolean(tile.onSelectCommand?.reelWatchEndpoint)
  );
}

function readBadgeNodeText(node: Record<string, unknown>): string {
  if (typeof node.label === 'string') return node.label;
  if (typeof node.badgeText === 'string') return node.badgeText;
  if (typeof node.badgeLabel === 'string') return node.badgeLabel;
  if (typeof node.text === 'string') return node.text;
  if (isRecord(node.text)) {
    return readFormattedText(node.text);
  }
  return '';
}

export function isBlockedBadge(style: string, label: string): boolean {
  const normalizedStyle = style.toUpperCase();
  const trimmedLabel = label.trim();

  if (
    normalizedStyle.includes('MEMBERS_ONLY') ||
    normalizedStyle.includes('SPONSORS_ONLY') ||
    /^members[-\s]?only$/i.test(trimmedLabel)
  ) {
    return true;
  }

  if (normalizedStyle && PAID_BADGE_STYLES.some((paidStyle) => normalizedStyle.includes(paidStyle))) {
    return true;
  }

  return Boolean(trimmedLabel && !/promotion/i.test(trimmedLabel) && PAID_BADGE_LABEL_RE.test(trimmedLabel));
}

function matchBadgeNode(node: unknown, depth = 0): boolean {
  if (!node || typeof node !== 'object' || depth > 6) return false;

  if (Array.isArray(node)) {
    for (const element of node) {
      if (matchBadgeNode(element, depth + 1)) return true;
    }
    return false;
  }

  const record = node as Record<string, unknown>;
  const rawStyle =
    typeof record.style === 'string'
      ? record.style
      : typeof record.badgeStyle === 'string'
        ? record.badgeStyle
        : '';

  if (isBlockedBadge(rawStyle, readBadgeNodeText(record))) {
    return true;
  }

  for (const key of Object.keys(record)) {
    const child = record[key];
    if (child && typeof child === 'object' && matchBadgeNode(child, depth + 1)) {
      return true;
    }
  }

  return false;
}

export function hasBlockedBadge(item: FeedItem | null | undefined): boolean {
  const target = unwrapFeedItem(item);
  if (!target) return false;

  const meta = getComputedMetadata(target);
  if (meta.hasBlockedBadge !== undefined) return meta.hasBlockedBadge;

  const checkBlocked = (node: unknown, depth = 0): boolean => {
    if (!node || typeof node !== 'object' || depth > 10) return false;

    if (Array.isArray(node)) {
      for (const element of node) {
        if (checkBlocked(element, depth + 1)) return true;
      }
      return false;
    }

    const record = node as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (BADGE_SKIP_KEYS.has(key)) continue;
      const child = record[key];
      if (!child || typeof child !== 'object') continue;

      if (BADGE_KEY_RE.test(key)) {
        if (matchBadgeNode(child, 0)) return true;
      } else if (checkBlocked(child, depth + 1)) {
        return true;
      }
    }
    return false;
  };

  return (meta.hasBlockedBadge = checkBlocked(target));
}

export function hasPaidOfferEndpoint(item: FeedItem | null | undefined): boolean {
  const target = unwrapFeedItem(item);
  if (!target) return false;

  const meta = getComputedMetadata(target);
  if (meta.hasPaidOffer !== undefined) return meta.hasPaidOffer;

  if (target.tileRenderer?.onSelectCommand?.ypcGetOffersEndpoint) {
    return (meta.hasPaidOffer = true);
  }

  const onTap: unknown = target.lockupViewModel?.rendererContext?.commandContext?.onTap;
  if (!isRecord(onTap)) return (meta.hasPaidOffer = false);
  if (onTap.ypcGetOffersEndpoint) return (meta.hasPaidOffer = true);

  return (meta.hasPaidOffer = walkCommands(onTap, (cmd) => Boolean(cmd.ypcGetOffersEndpoint)));
}

export function isChannelHidden(
  item: FeedItem | null | undefined,
  hiddenChannels?: readonly HiddenChannel[]
): boolean {
  const configuredHidden = hiddenChannels ?? configRead('hiddenChannels');
  if (!Array.isArray(configuredHidden) || configuredHidden.length === 0) return false;

  const target = unwrapFeedItem(item);
  if (!target) return false;

  const meta = getComputedMetadata(target);
  if (!meta.channelInfo) meta.channelInfo = extractItemChannelInfo(target);
  const { id, name } = meta.channelInfo;
  if (!id && !name) return false;

  const normalizedName = name.toLowerCase();
  for (const entry of configuredHidden) {
    if (!entry) continue;
    if (id && entry.id && entry.id === id) return true;
    if (normalizedName && entry.name && entry.name.toLowerCase() === normalizedName) return true;
  }

  return false;
}

function readNumericProgress(progressBar: unknown): number | null {
  if (!isRecord(progressBar)) return null;
  if (typeof progressBar.percentDurationWatched === 'number' && Number.isFinite(progressBar.percentDurationWatched)) {
    return progressBar.percentDurationWatched;
  }
  if (typeof progressBar.startPercent === 'number' && Number.isFinite(progressBar.startPercent)) {
    return progressBar.startPercent;
  }
  return null;
}

export function extractWatchedPercent(item: FeedItem | null | undefined): number | null {
  const target = unwrapFeedItem(item);
  if (!target) return null;

  if (target.tileRenderer) {
    const overlays = target.tileRenderer.header?.tileHeaderRenderer?.thumbnailOverlays;
    if (!Array.isArray(overlays)) return null;
    for (const overlay of overlays) {
      if (isRecord(overlay) && isRecord(overlay.thumbnailOverlayResumePlaybackRenderer)) {
        return readNumericProgress(overlay.thumbnailOverlayResumePlaybackRenderer);
      }
    }
    return null;
  }

  if (target.lockupViewModel) {
    const overlays = target.lockupViewModel.contentImage?.thumbnailViewModel?.overlays;
    if (!Array.isArray(overlays)) return null;
    for (const overlay of overlays) {
      if (!isRecord(overlay) || !isRecord(overlay.thumbnailBottomOverlayViewModel)) continue;
      const progressBar = overlay.thumbnailBottomOverlayViewModel.progressBar;
      if (!isRecord(progressBar)) continue;
      const model = isRecord(progressBar.thumbnailOverlayProgressBarViewModel)
        ? progressBar.thumbnailOverlayProgressBarViewModel
        : progressBar;
      const percent = readNumericProgress(model);
      if (percent !== null) return percent;
    }
  }

  return null;
}

export function resolveFeedPageName(locationHash?: string): string {
  const raw =
    locationHash !== undefined
      ? locationHash
      : typeof globalThis.location !== 'undefined'
        ? String(globalThis.location.hash || '')
        : '';

  const path = raw.startsWith('#') ? raw.slice(1) : raw;
  if (path === '/') return 'home';
  if (path.startsWith('/search')) return 'search';

  const queryIndex = path.indexOf('?');
  if (queryIndex === -1) return '';

  const query = path.slice(queryIndex + 1);
  const params = new URLSearchParams(query);
  const category = params.get('c') ?? query.split('&')[0]?.split('=')[1] ?? '';
  return category.replace(/^FE/, '').replace(/^topics_/, '');
}

export function shouldHideWatchedItem(item: FeedItem | null | undefined, options: FeedFilterOptions = {}): boolean {
  const enabled = options.enableHideWatchedVideos ?? configRead('enableHideWatchedVideos');
  if (!enabled) return false;

  const pages = options.hideWatchedVideosPages ?? configRead('hideWatchedVideosPages');
  if (!Array.isArray(pages) || pages.length === 0) return false;

  const pageName = resolveFeedPageName(options.locationHash);
  if (!pageName || !pages.includes(pageName)) return false;

  const percentWatched = extractWatchedPercent(item);
  if (percentWatched === null) return false;

  const threshold = options.hideWatchedVideosThreshold ?? configRead('hideWatchedVideosThreshold');
  if (threshold >= 100) {
    return percentWatched >= 100;
  }
  return percentWatched > threshold;
}

function isShelfContainer(item: FeedItem): boolean {
  return Boolean(
    item.shelfRenderer ||
      item.itemSectionRenderer ||
      item.richSectionRenderer ||
      item.sectionListRenderer ||
      item.richGridRenderer
  );
}

/**
 * Determines whether a feed item or shelf entry should be filtered out based
 * on ad-block, sign-in reminder, Shorts, survey, paid/member badge, hidden
 * channel, and watched-progress rules.
 */
export function shouldHideFeedItem(item: FeedItem | null | undefined, options: FeedFilterOptions = {}): boolean {
  if (!isRecord(item)) return false;
  const target = unwrapFeedItem(item);
  if (!target) return false;

  const enableAdBlock = options.enableAdBlock ?? configRead('enableAdBlock');
  const enableSigninReminder = options.enableSigninReminder ?? configRead('enableSigninReminder');
  const enableShorts = options.enableShorts ?? configRead('enableShorts');

  if (enableAdBlock && (item.adSlotRenderer || target.adSlotRenderer)) return true;
  if (!enableSigninReminder && (item.feedNudgeRenderer || target.feedNudgeRenderer)) return true;
  if (!enableShorts && isShortsItem(item)) return true;
  if (isSurveyItem(item) || isSurveyItem(target)) return true;

  if (isShelfContainer(target)) {
    return false;
  }

  if (hasPaidOfferEndpoint(target)) return true;
  if (isChannelHidden(target, options.hiddenChannels)) return true;
  if (hasBlockedBadge(target)) return true;
  return shouldHideWatchedItem(target, options);
}

/**
 * Synchronously filters an InnerTube feed item list using the configured feed rules.
 */
export function filterFeedItemsSync(items: FeedItem[], options: FeedFilterOptions = {}): FeedItem[] {
  if (!Array.isArray(items)) return items;
  return items.filter((item) => !shouldHideFeedItem(item, options));
}

/**
 * Synchronously compacts a shelves array in place, dropping hidden shelves/entries.
 */
export function filterShelvesInPlaceSync(shelves: FeedItem[], options: FeedFilterOptions = {}): FeedItem[] {
  if (!Array.isArray(shelves)) return shelves;

  let writeIndex = 0;
  for (let readIndex = 0; readIndex < shelves.length; readIndex++) {
    const item = shelves[readIndex] as FeedItem;
    if (!shouldHideFeedItem(item, options)) {
      shelves[writeIndex] = item;
      writeIndex++;
    }
  }
  shelves.length = writeIndex;
  return shelves;
}

export async function filterFeedItems(items: FeedItem[], options: FeedFilterOptions = {}): Promise<FeedItem[]> {
  if (!Array.isArray(items)) return items;
  
  const filtered: FeedItem[] = [];
  const BATCH_SIZE = 20;

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    filtered.push(...batch.filter((item) => !shouldHideFeedItem(item, options)));
    
    // Yield to the main thread
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return filtered;
}

export async function filterShelvesInPlace(shelves: FeedItem[], options: FeedFilterOptions = {}): Promise<FeedItem[]> {
  if (!Array.isArray(shelves)) return shelves;
  
  let writeIndex = 0;
  const BATCH_SIZE = 20;

  for (let readIndex = 0; readIndex < shelves.length; readIndex++) {
    const item = shelves[readIndex] as FeedItem;
    if (!shouldHideFeedItem(item, options)) {
      shelves[writeIndex] = item;
      writeIndex++;
    }

    // Yield to the main thread every BATCH_SIZE items
    if (readIndex % BATCH_SIZE === 0 && readIndex > 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  
  shelves.length = writeIndex;
  return shelves;
}

