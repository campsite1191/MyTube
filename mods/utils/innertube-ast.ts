import type { FeedItem } from '../types/innertube.ts';
import { unwrapFeedItem } from './feed-helpers.ts';
import { isRecord, readRecordPath } from './type-guards.ts';

export const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
export const META_SEPARATOR = ' • ';
export const PLAYER_SELECTOR = '.html5-video-player';

const NON_REPORT_ICONS = new Set(['BUG_REPORT']);
const REPORT_OR_FEEDBACK_ICON_RE = /(?:REPORT|FLAG|FEEDBACK)/i;
const REPORT_OR_FEEDBACK_TEXT_RE = /\b(?:report|feedback)\b/i;

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

/**
 * Extracts plain text from an InnerTube formatted text node (`simpleText`, `content`, or `runs`).
 */
export function readFormattedText(node: unknown): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (!isRecord(node)) return '';

  if (typeof node.simpleText === 'string') return node.simpleText;
  if (typeof node.content === 'string') return node.content;
  if (Array.isArray(node.runs)) {
    return node.runs.map((run) => (isRecord(run) && typeof run.text === 'string' ? run.text : '')).join('');
  }
  if (isRecord(node.text)) {
    const nested = readFormattedText(node.text);
    if (nested) return nested;
  }
  if (isRecord(node.attributedString)) {
    const attributed = readFormattedText(node.attributedString);
    if (attributed) return attributed;
  }
  const accessLabel = readRecordPath(node, 'accessibility', 'accessibilityData')?.label;
  return typeof accessLabel === 'string' ? accessLabel : '';
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

/**
 * Extracts the channel display name from a `tileRenderer` or `lockupViewModel` feed item.
 */
export function extractItemChannelName(item: FeedItem | null | undefined): string {
  const target = unwrapFeedItem(item);
  if (!target) return '';

  if (target.tileRenderer) {
    const lines = target.tileRenderer.metadata?.tileMetadataRenderer?.lines;
    const lineItems = readRecordPath(Array.isArray(lines) ? lines[0] : undefined, 'lineRenderer')?.items;
    return firstNonEmptyText(lineItems, (entry) => readRecordPath(entry, 'lineItemRenderer')?.text);
  }

  const contentMeta = readRecordPath(
    target.lockupViewModel?.metadata?.lockupMetadataViewModel,
    'metadata',
    'contentMetadataViewModel'
  );
  const rows = Array.isArray(contentMeta?.metadataRows) ? contentMeta.metadataRows : undefined;
  const parts = isRecord(rows?.[0]) ? rows[0].metadataParts : undefined;
  return firstNonEmptyText(parts, (entry) => entry.text);
}

/**
 * Collects unique existing menu item arrays attached to a feed item's menu or long-press commands.
 */
export function getExistingMenuItemLists(item: FeedItem | null | undefined): Array<Array<Record<string, unknown>>> {
  const target = unwrapFeedItem(item);
  if (!target) return [];

  const lists: Array<Array<Record<string, unknown>>> = [];
  const collectMenuItems = (command: unknown): void => {
    walkCommands(command, (cmd) => {
      const menuRenderer = readRecordPath(cmd, 'showMenuCommand', 'menu', 'menuRenderer');
      if (Array.isArray(menuRenderer?.items)) {
        lists.push(menuRenderer.items as Array<Record<string, unknown>>);
      }
      return false;
    });
  };

  if (target.tileRenderer) {
    const tileMenuRenderer = readRecordPath(target.tileRenderer.menu, 'menuRenderer');
    if (Array.isArray(tileMenuRenderer?.items)) {
      lists.push(tileMenuRenderer.items as Array<Record<string, unknown>>);
    }
    collectMenuItems(target.tileRenderer.onLongPressCommand);
  } else if (target.lockupViewModel) {
    collectMenuItems(target.lockupViewModel.rendererContext?.commandContext?.onLongPress);
  }

  return Array.from(new Set(lists));
}

export function extractCustomAction(cmd: unknown): { action: string; parameters?: unknown } | null {
  if (!isRecord(cmd)) return null;
  const direct = isRecord(cmd.customAction) ? cmd.customAction : undefined;
  if (typeof direct?.action === 'string') return { action: direct.action, parameters: direct.parameters };

  for (const wrapperKey of ['signalAction', 'showEngagementPanelEndpoint', 'playlistEditEndpoint'] as const) {
    const nested = readRecordPath(cmd, wrapperKey, 'customAction');
    if (typeof nested?.action === 'string') return { action: nested.action, parameters: nested.parameters };
  }
  return null;
}

export function isReportOrFeedbackIcon(iconType: unknown): boolean {
  return typeof iconType === 'string' && !NON_REPORT_ICONS.has(iconType) && REPORT_OR_FEEDBACK_ICON_RE.test(iconType);
}

export function isReportOrFeedbackText(text: unknown): boolean {
  return typeof text === 'string' && text.length > 0 && REPORT_OR_FEEDBACK_TEXT_RE.test(text);
}

export function hasReportOrFeedbackEndpointNode(node: Record<string, unknown>): boolean {
  return Boolean(
    node.getReportVideoFormEndpoint || node.getReportFormEndpoint || node.flagVideoEndpoint || node.sendFeedbackEndpoint
  );
}
