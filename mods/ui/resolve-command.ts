import { t } from '../core/i18n.ts';
import { getFeedbackPanelTokens, requestNextAndNavigateChannel, sendFeedbackToken } from '../core/innertube-calls.ts';
import { isPlaybackPageActive } from '../core/lifecycle.ts';
import { findResolveCommandHost, registerCommandDispatcher, showToast } from '../core/yttv-bridge.ts';
import { patchAutoTranslateCommand } from '../features/more-subtitles.ts';
import type { FormattedText, InnertubeCommand } from '../types/innertube.ts';
import { compactInPlace } from '../utils/feed-helpers.ts';
import {
  extractCustomAction,
  hasReportOrFeedbackEndpointNode,
  isReportOrFeedbackIcon,
  isReportOrFeedbackText,
  readFormattedText,
  walkCommands,
} from '../utils/innertube-ast.ts';
import { isObjectLike, isRecord, readRecordPath } from '../utils/type-guards.ts';
import { formatPlaybackSpeedLabel, setPlaybackSpeed, speedSettings } from './speed-ui.ts';
import { buttonItem, overlayPanelItemListRenderer, showModal } from './yt-ui.ts';

type ResolveInstance = { resolveCommand: (cmd: InnertubeCommand, arg?: unknown) => unknown };

let activeResolveInstance: ResolveInstance | null = null;

function isLiveResolveInstance(instance: ResolveInstance | null): instance is ResolveInstance {
  if (!instance || typeof instance.resolveCommand !== 'function' || typeof window === 'undefined' || !window._yttv) {
    return false;
  }
  return Object.values(window._yttv).some((entry) => isObjectLike(entry) && entry.instance === instance);
}

export default function resolveCommand(cmd: unknown, arg?: unknown): unknown {
  patchResolveCommand();
  const target = isLiveResolveInstance(activeResolveInstance)
    ? activeResolveInstance
    : findResolveCommandHost()?.instance;
  return target ? target.resolveCommand(cmd as InnertubeCommand, arg) : undefined;
}

function buildUpdatedPrefCookieValue(existingCookie: string, lang: string): string {
  const prefEntry = existingCookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('PREF='));
  const rawPref = prefEntry ? prefEntry.slice('PREF='.length) : '';
  const parts = rawPref ? rawPref.split('&').filter((entry) => entry && !entry.startsWith('hl=')) : [];
  parts.unshift(`hl=${encodeURIComponent(lang)}`);
  return parts.join('&');
}

function handleSetClientSetting(endpoint: Record<string, unknown>): boolean {
  const settingDatas = Array.isArray(endpoint.settingDatas) ? endpoint.settingDatas : [];
  for (const rawSetting of settingDatas) {
    const enumObj = readRecordPath(rawSetting, 'clientSettingEnum');
    if (enumObj?.item === 'I18N_LANGUAGE') {
      const lang =
        typeof (rawSetting as Record<string, unknown>).stringValue === 'string'
          ? ((rawSetting as Record<string, unknown>).stringValue as string)
          : '';
      const date = new Date();
      date.setFullYear(date.getFullYear() + 10);
      const nextPref = buildUpdatedPrefCookieValue(document.cookie, lang);
      // biome-ignore lint/suspicious/noDocumentCookie: YouTube TV reads PREF cookie synchronously before RELOAD_PAGE.
      document.cookie = `PREF=${nextPref}; path=/; expires=${date.toUTCString()};`;
      resolveCommand({ signalAction: { signal: 'RELOAD_PAGE' } });
      return true;
    }
  }
  return false;
}

const POPUP_ITEM_RENDERER_KEYS = [
  'compactLinkRenderer',
  'compactToggleRenderer',
  'menuServiceItemRenderer',
  'menuNavigationItemRenderer',
] as const;

function unwrapPopupItemRenderer(item: unknown): Record<string, unknown> | undefined {
  if (!isRecord(item)) return undefined;
  for (const key of POPUP_ITEM_RENDERER_KEYS) {
    if (isRecord(item[key])) return item[key];
  }
  return undefined;
}

function hasReportOrFeedbackEndpoint(endpoint: unknown): boolean {
  if (!isRecord(endpoint)) return false;
  return walkCommands(endpoint, (node) => {
    if (hasReportOrFeedbackEndpointNode(node)) {
      return true;
    }
    const clientOverlay = readRecordPath(node, 'openClientOverlayAction');
    if (isReportOrFeedbackText(clientOverlay?.type)) {
      return true;
    }
    const openPopup = readRecordPath(node, 'openPopupAction');
    if (isReportOrFeedbackText(openPopup?.uniqueId)) {
      return true;
    }
    const signal = readRecordPath(node, 'signalAction');
    return isReportOrFeedbackText(signal?.signal);
  });
}

function isReportOrFeedbackPopupItem(item: unknown): boolean {
  const renderer = unwrapPopupItemRenderer(item);
  if (!renderer) return false;

  const icon = readRecordPath(renderer, 'icon');
  if (isReportOrFeedbackIcon(icon?.iconType)) {
    return true;
  }

  if (isReportOrFeedbackText(readFormattedText(renderer.title ?? renderer.text))) {
    return true;
  }

  return (
    hasReportOrFeedbackEndpoint(renderer.serviceEndpoint) ||
    hasReportOrFeedbackEndpoint(renderer.navigationEndpoint) ||
    hasReportOrFeedbackEndpoint(renderer.command)
  );
}

function patchPlaybackSettingsPopup(cmd: Record<string, unknown>, isPrimaryPlaybackSettings: boolean): void {
  const popup = readRecordPath(cmd, 'openPopupAction', 'popup');
  const itemList = readRecordPath(
    popup,
    'overlaySectionRenderer',
    'overlay',
    'overlayTwoPanelRenderer',
    'actionPanel',
    'overlayPanelRenderer',
    'content',
    'overlayPanelItemListRenderer'
  );
  const menuPopup = readRecordPath(popup, 'menuPopupRenderer');
  const listContainer = itemList ?? menuPopup;
  if (!listContainer || !Array.isArray(listContainer.items)) return;
  const items = listContainer.items;

  compactInPlace(items, isReportOrFeedbackPopupItem);

  if (typeof listContainer.selectedIndex === 'number' && listContainer.selectedIndex >= items.length) {
    listContainer.selectedIndex = Math.max(0, items.length - 1);
  }

  if (!isPrimaryPlaybackSettings) return;

  for (const item of items) {
    const clr = readRecordPath(item, 'compactLinkRenderer');
    if (!clr) continue;
    const iconType = readRecordPath(clr, 'icon')?.iconType;
    if (iconType === 'SLOW_MOTION_VIDEO' || iconType === 'SPEEDOMETER') {
      clr.subtitle = { simpleText: formatPlaybackSpeedLabel() };
      clr.serviceEndpoint = {
        clickTrackingParams: 'null',
        signalAction: {
          customAction: {
            action: 'TT_SPEED_SETTINGS_SHOW',
            parameters: [],
          },
        },
      };
    }
  }
}

const patchedResolveFns = new WeakSet<object>();

function runCustomAction(action: string, parameters?: unknown): void {
  void customAction(action, parameters).catch((error) => {
    console.error('[ResolveCommand] customAction failed:', action, error);
  });
}

function isInterceptedPopupUniqueId(uniqueId: string): boolean {
  return (
    uniqueId === 'playback-settings' ||
    uniqueId === 'CLIENT_OVERLAY_TYPE_CAPTIONS_AUTO_TRANSLATE' ||
    (Boolean(uniqueId) && !uniqueId.startsWith('tt-') && /(?:playback|player|more|settings)/i.test(uniqueId))
  );
}

function unwrapInnertubeCommand(cmd: Record<string, unknown>): Record<string, unknown> {
  let current = cmd;
  let depth = 0;
  while (isRecord(current.innertubeCommand) && depth < 4) {
    current = current.innertubeCommand;
    depth++;
  }
  return current;
}

function needsCommandInterception(cmd: unknown, depth = 0): boolean {
  if (!isRecord(cmd) || depth > 4) return false;
  if (isRecord(cmd.setClientSettingEndpoint) || extractCustomAction(cmd)) return true;
  if (isRecord(cmd.startInlinePlaybackCommand) && isPlaybackPageActive()) return true;
  if (isRecord(cmd.innertubeCommand) && needsCommandInterception(cmd.innertubeCommand, depth + 1)) {
    return true;
  }

  const openPopup = readRecordPath(cmd, 'openPopupAction');
  const uniqueId = typeof openPopup?.uniqueId === 'string' ? openPopup.uniqueId : '';
  if (isInterceptedPopupUniqueId(uniqueId)) return true;

  const acctCtx = readRecordPath(cmd, 'requestAccountSelectorCommand', 'identityActionContext');
  if (acctCtx?.eventTrigger === 'ACCOUNT_EVENT_TRIGGER_ON_EXIT') return true;

  const cmdExec = readRecordPath(cmd, 'commandExecutorCommand');
  if (Array.isArray(cmdExec?.commands)) {
    return cmdExec.commands.some((subCmd) => needsCommandInterception(subCmd, depth + 1));
  }
  return false;
}

export function patchResolveCommand(): void {
  registerCommandDispatcher(resolveCommand);
  if (typeof window === 'undefined' || !window._yttv) return;
  for (const entry of Object.values(window._yttv)) {
    if (!isObjectLike(entry) || !isObjectLike(entry.instance) || typeof entry.instance.resolveCommand !== 'function') {
      continue;
    }
    const instance = entry.instance as { resolveCommand: (cmd: unknown, arg?: unknown) => unknown };
    const ogResolve = instance.resolveCommand;
    if (patchedResolveFns.has(ogResolve)) continue;

    const wrappedResolve = function (this: unknown, rawCmd: unknown, arg?: unknown): unknown {
      activeResolveInstance = instance as ResolveInstance;
      if (!isRecord(rawCmd)) return ogResolve.call(this, rawCmd, arg);
      const effectiveCmd = unwrapInnertubeCommand(rawCmd);
      if (isRecord(effectiveCmd.startInlinePlaybackCommand) && isPlaybackPageActive()) {
        return false;
      }

      if (isRecord(effectiveCmd.setClientSettingEndpoint)) {
        if (handleSetClientSetting(effectiveCmd.setClientSettingEndpoint)) return true;
      } else {
        const extracted = extractCustomAction(effectiveCmd);
        if (extracted) {
          runCustomAction(extracted.action, extracted.parameters);
          return true;
        }
        const openPopup = readRecordPath(effectiveCmd, 'openPopupAction');
        const uniqueId = typeof openPopup?.uniqueId === 'string' ? openPopup.uniqueId : '';
        if (uniqueId === 'playback-settings') {
          patchPlaybackSettingsPopup(effectiveCmd, true);
        } else if (uniqueId === 'CLIENT_OVERLAY_TYPE_CAPTIONS_AUTO_TRANSLATE') {
          patchAutoTranslateCommand(effectiveCmd);
        } else if (isInterceptedPopupUniqueId(uniqueId)) {
          patchPlaybackSettingsPopup(effectiveCmd, false);
        }
      }

      const cmdExec = readRecordPath(effectiveCmd, 'commandExecutorCommand');
      if (Array.isArray(cmdExec?.commands) && cmdExec.commands.some((subCmd) => needsCommandInterception(subCmd))) {
        for (const subCmd of cmdExec.commands) {
          const unwrappedSub = isRecord(subCmd) ? unwrapInnertubeCommand(subCmd) : null;
          const extracted = unwrappedSub ? extractCustomAction(unwrappedSub) : null;
          if (extracted) {
            runCustomAction(extracted.action, extracted.parameters);
          } else {
            instance.resolveCommand(unwrappedSub ?? subCmd, arg);
          }
        }
        return true;
      }

      const acctCtx = readRecordPath(effectiveCmd, 'requestAccountSelectorCommand', 'identityActionContext');
      if (acctCtx?.eventTrigger === 'ACCOUNT_EVENT_TRIGGER_ON_EXIT') {
        ogResolve.call(this, { signalAction: { signal: 'EXIT_APP' } });
        return false;
      }

      return ogResolve.call(this, rawCmd, arg);
    };

    patchedResolveFns.add(wrappedResolve);
    instance.resolveCommand = wrappedResolve;
  }
}

async function customAction(action: string, parameters?: unknown): Promise<void> {
  const params = isRecord(parameters) ? parameters : undefined;
  switch (action) {
    case 'SKIP': {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, which: 27, bubbles: true }));
      const video = document.querySelector('video');
      if (video && typeof params?.time === 'number') {
        video.currentTime = params.time;
      }
      break;
    }
    case 'TT_SPEED_SETTINGS_SHOW':
      speedSettings();
      break;
    case 'SET_PLAYER_SPEED':
      setPlaybackSpeed(Number(parameters));
      break;
    case 'SHOW_TOAST':
      showToast('YouTube', String(parameters ?? ''));
      break;
    case 'GO_TO_CHANNEL':
      requestNextAndNavigateChannel(parameters as Parameters<typeof requestNextAndNavigateChannel>[0]);
      break;
    case 'NOT_INTERESTED':
      void markFeedback(params, 0, true);
      break;
    case 'DONT_RECOMMEND_CHANNEL':
      void markFeedback(params, 1, false);
      break;
    case 'FEEDBACK_REASON':
      if (typeof params?.token === 'string') {
        void sendFeedbackToken(params.token)
          .then(() => {
            resolveCommand({ signalAction: { signal: 'POPUP_BACK' } });
            showToast('Feedback', t('toasts.feedbackSent'));
          })
          .catch((err) => console.error('Failed to send feedback:', err));
      }
      break;
  }
}

async function markFeedback(
  params: Record<string, unknown> | undefined,
  tokenIndex: number,
  showReasons: boolean
): Promise<void> {
  try {
    const panelId = typeof params?.panelId === 'string' ? params.panelId : '';
    const panelParams = typeof params?.params === 'string' ? params.params : '';
    if (!panelId || !panelParams) return;

    const tokens = await getFeedbackPanelTokens(panelId, panelParams);
    const token = tokens[tokenIndex];
    if (!token) return;

    const response = await sendFeedbackToken(token);
    if (!showReasons || !isRecord(response)) return;

    const feedbackResponses = Array.isArray(response.feedbackResponses) ? response.feedbackResponses : [];
    const dismissal = readRecordPath(feedbackResponses[0], 'followUpDialog', 'dismissalFollowUpRenderer');
    const reasons = dismissal?.reasons;
    if (!Array.isArray(reasons) || reasons.length === 0) return;

    const buttons = reasons
      .filter((reason): reason is Record<string, unknown> => isRecord(reason))
      .map((reason) =>
        buttonItem(readFormattedText(reason.title as FormattedText | string | undefined), [
          { signalAction: { signal: 'POPUP_BACK' } },
          { customAction: { action: 'FEEDBACK_REASON', parameters: { token: reason.token } } },
        ])
      );

    showModal(
      readFormattedText(dismissal?.dismissalReasonsPrompt as FormattedText | string | undefined),
      overlayPanelItemListRenderer(buttons),
      'tt-feedback-reasons'
    );
  } catch (err) {
    console.error('Failed to mark feedback:', err);
  }
}
