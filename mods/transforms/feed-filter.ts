import type { FeedItem } from '../types/innertube.ts';
import { compactInPlace, unwrapFeedItem } from '../utils/feed-helpers.ts';
import { readFormattedText, walkCommands } from '../utils/innertube-ast.ts';
import { isRecord, readRecordPath } from '../utils/type-guards.ts';

const BADGE_KEY_RE = /badge/i;
const SURVEY_KEY_RE = /survey|questionnaire/i;
const HIDDEN_SHELF_TITLE_RE = /^(?:(?:top\s+)?channels you watch|explore more topics)\b/i;
const SHELF_HEADER_KEYS = [
  'shelfRenderer',
  'richSectionRenderer',
  'richShelfRenderer',
  'itemSectionRenderer',
  'gridRenderer',
  'horizontalListRenderer',
  'horizontalCardListRenderer',
  'feedFilterChipBarRenderer',
  'topicPickerRenderer',
  'shelfHeaderRenderer',
  'richShelfHeaderRenderer',
  'tvShelfHeaderRenderer',
  'tvhtml5ShelfHeaderRenderer',
  'sectionHeaderViewModel',
  'shelfHeaderViewModel',
  'gridHeaderRenderer',
  'carouselHeaderRenderer',
  'richListHeaderRenderer',
  'headerRenderer',
  'header',
] as const;
const STANDALONE_HEADER_KEYS = [
  'shelfHeaderRenderer',
  'richShelfHeaderRenderer',
  'tvShelfHeaderRenderer',
  'tvhtml5ShelfHeaderRenderer',
  'sectionHeaderViewModel',
  'shelfHeaderViewModel',
  'gridHeaderRenderer',
  'carouselHeaderRenderer',
  'richListHeaderRenderer',
] as const;
const HEADER_CONTAINER_KEYS = new Set<string>([
  ...STANDALONE_HEADER_KEYS,
  'feedFilterChipBarRenderer',
  'headerRenderer',
  'header',
]);
const HEADER_SKIP_KEYS = new Set<string>(['items', 'contents', 'buttons', 'trackingParams', 'loggingDirectives']);
const TITLE_FIELD_KEYS = ['title', 'headline', 'headerText', 'superlabel', 'text'] as const;
const BADGE_SKIP_KEYS = new Set([
  'parameters',
  'trackingParams',
  'thumbnail',
  'thumbnails',
  'accessibility',
  'menu',
  'onLongPressCommand',
  'onSelectCommand',
  'onFocusCommand',
  'commandContext',
  'itemPlayback',
  'loggingDirectives',
]);
const PAID_BADGE_STYLES = ['BADGE_STYLE_TYPE_YPC', 'BADGE_STYLE_TYPE_PAID', 'PAID_CONTENT'] as const;
const PAID_BADGE_LABEL_RE = /\b(buy or rent|rent or buy|paid content)\b|^(paid|rent|buy)\b/i;

function isDirectMediaCard(node: Record<string, unknown>): boolean {
  return Boolean(
    (node.tileRenderer || node.lockupViewModel || node.shortsLockupViewModel) &&
      !node.shelfRenderer &&
      !node.richSectionRenderer &&
      !node.itemSectionRenderer &&
      !node.shelfHeaderRenderer &&
      !node.sectionHeaderViewModel &&
      !node.gridRenderer &&
      !node.horizontalListRenderer
  );
}

function getShelfTitleSources(item: Record<string, unknown>): unknown[] {
  const sources: unknown[] = [];
  const visit = (node: Record<string, unknown>, depth: number, insideHeader: boolean): void => {
    if (depth > 5) return;
    for (const key of TITLE_FIELD_KEYS) {
      if (node[key] !== undefined) sources.push(node[key]);
    }
    const richContent = readRecordPath(node, 'richSectionRenderer', 'content');
    if (richContent) {
      visit(richContent, depth + 1, insideHeader);
    }
    const itemSection = readRecordPath(node, 'itemSectionRenderer');
    if (Array.isArray(itemSection?.contents)) {
      for (const child of itemSection.contents) {
        if (isRecord(child) && !isDirectMediaCard(child)) {
          visit(child, depth + 1, false);
        }
      }
    }
    if (insideHeader) {
      for (const key of Object.keys(node)) {
        if (HEADER_SKIP_KEYS.has(key)) continue;
        const child = node[key];
        if (isRecord(child)) visit(child, depth + 1, true);
      }
      return;
    }
    for (const key of SHELF_HEADER_KEYS) {
      const child = node[key];
      if (isRecord(child)) visit(child, depth + 1, HEADER_CONTAINER_KEYS.has(key));
    }
  };
  visit(item, 0, false);
  return sources;
}

function isSurveyTitle(titleText: unknown): boolean {
  if (!titleText) return false;
  const normalized = String(titleText).toLowerCase();
  return normalized.includes('help us improve') || normalized.includes('help us make youtube');
}

export function isSurveyItem(item: FeedItem | null | undefined): boolean {
  if (!isRecord(item)) return false;

  if (Object.keys(item).some((key) => SURVEY_KEY_RE.test(key))) return true;

  for (const candidate of getShelfTitleSources(item)) {
    if (isSurveyTitle(readFormattedText(candidate))) {
      return true;
    }
  }

  return false;
}

export function isStandaloneHeaderNode(entry: Record<string, unknown>): boolean {
  return STANDALONE_HEADER_KEYS.some((key) => Boolean(entry[key]));
}

export function isHiddenShelf(item: FeedItem | null | undefined): boolean {
  if (!isRecord(item) || isDirectMediaCard(item)) return false;

  for (const candidate of getShelfTitleSources(item)) {
    const title = readFormattedText(candidate).replace(/\s+/g, ' ').trim();
    if (title && HIDDEN_SHELF_TITLE_RE.test(title)) {
      return true;
    }
  }

  return false;
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
    typeof record.style === 'string' ? record.style : typeof record.badgeStyle === 'string' ? record.badgeStyle : '';

  if (isBlockedBadge(rawStyle, readBadgeNodeText(record))) {
    return true;
  }

  for (const child of Object.values(record)) {
    if (child && typeof child === 'object' && matchBadgeNode(child, depth + 1)) {
      return true;
    }
  }

  return false;
}

export function hasBlockedBadge(item: FeedItem | null | undefined): boolean {
  const target = unwrapFeedItem(item);
  if (!target) return false;

  const checkBlocked = (node: unknown, depth = 0): boolean => {
    if (!node || typeof node !== 'object' || depth > 10) return false;

    if (Array.isArray(node)) {
      for (const element of node) {
        if (checkBlocked(element, depth + 1)) return true;
      }
      return false;
    }

    const record = node as Record<string, unknown>;
    for (const [key, child] of Object.entries(record)) {
      if (BADGE_SKIP_KEYS.has(key) || !child || typeof child !== 'object') continue;

      if (BADGE_KEY_RE.test(key)) {
        if (matchBadgeNode(child, 0)) return true;
      } else if (checkBlocked(child, depth + 1)) {
        return true;
      }
    }
    return false;
  };

  return checkBlocked(target);
}

export function hasPaidOfferEndpoint(item: FeedItem | null | undefined): boolean {
  const target = unwrapFeedItem(item);
  if (!target) return false;

  if (target.tileRenderer?.onSelectCommand?.ypcGetOffersEndpoint) {
    return true;
  }

  const onTap: unknown = target.lockupViewModel?.rendererContext?.commandContext?.onTap;
  return isRecord(onTap)
    ? Boolean(onTap.ypcGetOffersEndpoint) || walkCommands(onTap, (cmd) => Boolean(cmd.ypcGetOffersEndpoint))
    : false;
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
 * Determines whether a feed item or shelf entry should be filtered out (ads, sign-in nudges,
 * surveys, paid offers, or paid/members-only badges).
 */
export function shouldHideFeedItem(item: FeedItem | null | undefined): boolean {
  if (!isRecord(item)) return false;
  const target = unwrapFeedItem(item);

  if (item.adSlotRenderer || target.adSlotRenderer) return true;
  if (item.feedNudgeRenderer || target.feedNudgeRenderer) return true;
  if (isSurveyItem(item) || (target !== item && isSurveyItem(target))) return true;
  if (isHiddenShelf(item) || (target !== item && isHiddenShelf(target))) return true;

  if (isShelfContainer(target)) {
    return false;
  }

  return hasPaidOfferEndpoint(target) || hasBlockedBadge(target);
}

/**
 * Synchronously filters an InnerTube feed item list.
 */
export function filterFeedItemsSync(items: FeedItem[]): FeedItem[] {
  if (!Array.isArray(items)) return items;
  return items.filter((item) => !shouldHideFeedItem(item));
}

/**
 * Synchronously compacts a shelves array in place, dropping hidden shelves/entries.
 */
export function filterShelvesInPlaceSync(shelves: FeedItem[]): FeedItem[] {
  return compactInPlace(shelves, (item) => shouldHideFeedItem(item));
}
