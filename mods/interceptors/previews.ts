import { walkCommands } from '../transforms/feed-filter.ts';
import type { FeedItem } from '../types/innertube.ts';
import { unwrapFeedItem } from '../utils/feed-helpers.ts';
import { isRecord } from '../utils/type-guards.ts';

const INLINE_PREVIEW_OPTIONS = {
  blockAdoption: true,
  autotransitionDelayMs: -1,
  forceSeamlessAutotransition: false,
  caption: false,
  delayMs: 2500,
  durationMs: 3600000,
  muted: true,
  restartPlaybackBeforeSeconds: 10,
  resumeVideo: false,
} as const;

function stripEndTimeSeconds(watchEndpoint: Record<string, unknown>): Record<string, unknown> {
  if (!('endTimeSeconds' in watchEndpoint)) return { ...watchEndpoint };
  const cleaned = { ...watchEndpoint };
  delete cleaned.endTimeSeconds;
  return cleaned;
}

function tunePreview(cmd: Record<string, unknown>): void {
  Object.assign(cmd, INLINE_PREVIEW_OPTIONS);
  const ep = isRecord(cmd.playbackEndpoint) ? cmd.playbackEndpoint : undefined;
  const watchEndpoint = isRecord(ep?.watchEndpoint) ? ep.watchEndpoint : undefined;
  if (ep && watchEndpoint && 'endTimeSeconds' in watchEndpoint) {
    cmd.playbackEndpoint = { ...ep, watchEndpoint: stripEndTimeSeconds(watchEndpoint) };
  }
}

function inspectFocusCmd(cmd: unknown): boolean {
  let found = false;
  walkCommands(cmd, (node) => {
    if (isRecord(node.startInlinePlaybackCommand)) {
      tunePreview(node.startInlinePlaybackCommand);
      found = true;
    } else if (node.playbackEndpoint) {
      found = true;
    }
    return false;
  });
  return found;
}

function extractWatchOrReelEndpoint(cmd: unknown): Record<string, unknown> | null {
  const result: { endpoint: Record<string, unknown> | null } = { endpoint: null };
  walkCommands(cmd, (node) => {
    const reelEp = isRecord(node.reelWatchEndpoint) ? node.reelWatchEndpoint : undefined;
    const watchEp = isRecord(node.watchEndpoint) ? node.watchEndpoint : undefined;
    if (typeof reelEp?.videoId === 'string') {
      result.endpoint = { watchEndpoint: { videoId: reelEp.videoId } };
    } else if (typeof watchEp?.videoId === 'string') {
      result.endpoint = { watchEndpoint: stripEndTimeSeconds(watchEp) };
    }
    return Boolean(result.endpoint);
  });
  return result.endpoint;
}

function findCommandExecutor(cmd: unknown): Record<string, unknown> | undefined {
  const result: { executor: Record<string, unknown> | undefined } = { executor: undefined };
  walkCommands(cmd, (node) => {
    const candidate = isRecord(node.commandExecutorCommand) ? node.commandExecutorCommand : undefined;
    if (candidate && Array.isArray(candidate.commands)) {
      result.executor = candidate;
      return true;
    }
    return false;
  });
  return result.executor;
}

function attachPreviewCmd(
  existing: unknown,
  previewCmd: Record<string, unknown>,
  setCmd: (cmd: Record<string, unknown>) => void
): void {
  const executor = findCommandExecutor(existing);
  if (executor && Array.isArray(executor.commands)) {
    executor.commands.push(previewCmd);
  } else if (isRecord(existing)) {
    setCmd({ commandExecutorCommand: { commands: [existing, previewCmd] } });
  } else {
    setCmd(previewCmd);
  }
}

function makePreviewCmd(playbackEndpoint: Record<string, unknown>): Record<string, unknown> {
  return {
    startInlinePlaybackCommand: {
      ...INLINE_PREVIEW_OPTIONS,
      playbackEndpoint,
    },
  };
}

function injectPreviewIfMissing(
  allowInject: boolean,
  hasPreview: boolean,
  sourceCommand: unknown,
  targetCommand: unknown,
  setCmd: (cmd: Record<string, unknown>) => void
): void {
  if (hasPreview || !allowInject) return;
  const endpoint = extractWatchOrReelEndpoint(sourceCommand);
  if (endpoint) {
    attachPreviewCmd(targetCommand, makePreviewCmd(endpoint), setCmd);
  }
}

/**
 * Ensures feed tiles, lockups, shorts, and masthead companion videos trigger muted inline playback
 * previews on focus without auto-advancing into Watch or preserving clip end boundaries.
 */
export function addPreviews(items: FeedItem[], shouldInject = true): void {
  if (!Array.isArray(items)) return;
  const allowInject = Boolean(shouldInject);

  for (const entry of items) {
    const item = unwrapFeedItem(entry) as Record<string, unknown> | null;
    if (!item) continue;

    const masthead = isRecord(item.tvMastheadRenderer) ? item.tvMastheadRenderer : undefined;
    if (Array.isArray(masthead?.companionVideos)) {
      addPreviews(masthead.companionVideos as FeedItem[], allowInject);
    }

    if (isRecord(item.shortsLockupViewModel)) {
      const slv = item.shortsLockupViewModel;
      injectPreviewIfMissing(allowInject, inspectFocusCmd(slv.onFocusCommand), slv.onTap, slv.onFocusCommand, (cmd) => {
        slv.onFocusCommand = cmd;
      });
      continue;
    }

    if (isRecord(item.lockupViewModel)) {
      const lv = item.lockupViewModel;
      const rendererContext = isRecord(lv.rendererContext) ? lv.rendererContext : undefined;
      const lvCmdCtx = isRecord(rendererContext?.commandContext) ? rendererContext.commandContext : undefined;
      const itemPlayback = isRecord(lv.itemPlayback) ? lv.itemPlayback : undefined;
      const hasPlayback = inspectFocusCmd(itemPlayback?.playbackCommand);
      const hasOnFocus = inspectFocusCmd(lvCmdCtx?.onFocus);
      injectPreviewIfMissing(
        allowInject,
        hasPlayback || hasOnFocus,
        lvCmdCtx?.onTap,
        itemPlayback?.playbackCommand,
        (cmd) => {
          if (!isRecord(lv.itemPlayback)) {
            lv.itemPlayback = {};
          }
          (lv.itemPlayback as Record<string, unknown>).playbackCommand = cmd;
        }
      );
      continue;
    }

    if (isRecord(item.tileRenderer)) {
      const tr = item.tileRenderer;
      injectPreviewIfMissing(
        allowInject,
        inspectFocusCmd(tr.onFocusCommand),
        tr.onSelectCommand,
        tr.onFocusCommand,
        (cmd) => {
          tr.onFocusCommand = cmd;
        }
      );
    }
  }
}
