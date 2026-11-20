import { configRead } from '../core/config.ts';
import { walkCommands } from '../transforms/feed-filter.ts';
import type { FeedItem } from '../types/innertube.ts';
import { isRecord } from '../utils/type-guards.ts';

export function addPreviews(items: FeedItem[], shouldInject = true): void {
  if (!Array.isArray(items)) return;
  const allowInject = Boolean(shouldInject && configRead('enablePreviews'));

  const tunePreview = (cmd: Record<string, unknown>): void => {
    cmd.blockAdoption = true;
    cmd.autotransitionDelayMs = -1;
    cmd.forceSeamlessAutotransition = false;
    cmd.delayMs = 2500;
    cmd.durationMs = 3600000;
    cmd.muted = true;
    cmd.resumeVideo = false;
    if (!configRead('enablePreviews')) cmd.overrideSettingsSwitch = false;
    const ep = isRecord(cmd.playbackEndpoint) ? cmd.playbackEndpoint : undefined;
    const watchEndpoint = isRecord(ep?.watchEndpoint) ? ep.watchEndpoint : undefined;
    if (ep && watchEndpoint && 'endTimeSeconds' in watchEndpoint) {
      const cleaned = { ...watchEndpoint };
      delete cleaned.endTimeSeconds;
      cmd.playbackEndpoint = { ...ep, watchEndpoint: cleaned };
    }
  };

  const inspectFocusCmd = (cmd: unknown): boolean => {
    let found = false;
    walkCommands(cmd, (n) => {
      if (isRecord(n.startInlinePlaybackCommand)) {
        tunePreview(n.startInlinePlaybackCommand);
        found = true;
      } else if (n.playbackEndpoint) {
        found = true;
      }
      return false;
    });
    return found;
  };

  const extractWatchOrReelEndpoint = (cmd: unknown): Record<string, unknown> | null => {
    const result: { endpoint: Record<string, unknown> | null } = { endpoint: null };
    walkCommands(cmd, (n) => {
      const reelEp = isRecord(n.reelWatchEndpoint) ? n.reelWatchEndpoint : undefined;
      const watchEp = isRecord(n.watchEndpoint) ? n.watchEndpoint : undefined;
      if (typeof reelEp?.videoId === 'string') {
        result.endpoint = { watchEndpoint: { videoId: reelEp.videoId } };
      } else if (typeof watchEp?.videoId === 'string') {
        const copy = { ...watchEp };
        delete copy.endTimeSeconds;
        result.endpoint = { watchEndpoint: copy };
      }
      return Boolean(result.endpoint);
    });
    return result.endpoint;
  };

  const attachPreviewCmd = (
    existing: unknown,
    previewCmd: Record<string, unknown>,
    setCmd: (cmd: Record<string, unknown>) => void
  ): void => {
    const existingRec = isRecord(existing) ? existing : undefined;
    const innerCmd = isRecord(existingRec?.innertubeCommand) ? existingRec.innertubeCommand : undefined;
    const executor = isRecord(existingRec?.commandExecutorCommand)
      ? existingRec.commandExecutorCommand
      : isRecord(innerCmd?.commandExecutorCommand)
        ? innerCmd.commandExecutorCommand
        : undefined;
    if (Array.isArray(executor?.commands)) {
      executor.commands.push(previewCmd);
    } else {
      setCmd(previewCmd);
    }
  };

  const makePreviewCmd = (playbackEndpoint: Record<string, unknown>): Record<string, unknown> => ({
    startInlinePlaybackCommand: {
      blockAdoption: true,
      autotransitionDelayMs: -1,
      forceSeamlessAutotransition: false,
      caption: false,
      delayMs: 2500,
      durationMs: 3600000,
      muted: true,
      restartPlaybackBeforeSeconds: 10,
      resumeVideo: false,
      playbackEndpoint,
    },
  });

  for (const entry of items) {
    const item = (entry?.richItemRenderer?.content ?? entry) as Record<string, unknown> | null;
    if (!isRecord(item)) continue;

    const masthead = isRecord(item.tvMastheadRenderer) ? item.tvMastheadRenderer : undefined;
    if (Array.isArray(masthead?.companionVideos)) {
      addPreviews(masthead.companionVideos as FeedItem[], shouldInject);
    }

    if (isRecord(item.shortsLockupViewModel)) {
      const slv = item.shortsLockupViewModel;
      const hasPreview = inspectFocusCmd(slv.onFocusCommand);
      if (!hasPreview && allowInject) {
        const ep = extractWatchOrReelEndpoint(slv.onTap);
        const watchEp = isRecord(ep?.watchEndpoint) ? ep.watchEndpoint : undefined;
        const vid = typeof watchEp?.videoId === 'string' ? watchEp.videoId : undefined;
        if (vid) {
          attachPreviewCmd(slv.onFocusCommand, makePreviewCmd({ watchEndpoint: { videoId: vid } }), (cmd) => {
            slv.onFocusCommand = cmd;
          });
        }
      }
      continue;
    }

    if (isRecord(item.lockupViewModel)) {
      const lv = item.lockupViewModel;
      const rendererContext = isRecord(lv.rendererContext) ? lv.rendererContext : undefined;
      const lvCmdCtx = isRecord(rendererContext?.commandContext) ? rendererContext.commandContext : undefined;
      const itemPlayback = isRecord(lv.itemPlayback) ? lv.itemPlayback : undefined;
      const hasPlayback = inspectFocusCmd(itemPlayback?.playbackCommand);
      const hasOnFocus = inspectFocusCmd(lvCmdCtx?.onFocus);
      if (!hasPlayback && !hasOnFocus && allowInject && lvCmdCtx) {
        const ep = extractWatchOrReelEndpoint(lvCmdCtx.onTap);
        if (ep) {
          if (!isRecord(lv.itemPlayback)) {
            lv.itemPlayback = {};
          }
          const playbackTarget = lv.itemPlayback as Record<string, unknown>;
          attachPreviewCmd(playbackTarget.playbackCommand, makePreviewCmd(ep), (cmd) => {
            playbackTarget.playbackCommand = cmd;
          });
        }
      }
      continue;
    }

    if (isRecord(item.tileRenderer)) {
      const tr = item.tileRenderer;
      const hasPreview = inspectFocusCmd(tr.onFocusCommand);
      if (!hasPreview && allowInject) {
        const ep = extractWatchOrReelEndpoint(tr.onSelectCommand);
        if (ep) {
          attachPreviewCmd(tr.onFocusCommand, makePreviewCmd(ep), (cmd) => {
            tr.onFocusCommand = cmd;
          });
        }
      }
    }
  }
}
