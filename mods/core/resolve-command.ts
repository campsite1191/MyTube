import { patchAutoTranslateCommand } from '../features/more-subtitles.ts';
import { readFormattedText, walkCommands } from '../transforms/feed-filter.ts';
import type { FormattedText, InnertubeCommand } from '../types/innertube.ts';
import { setPlaybackSpeed, speedSettings } from '../ui/speed-ui.ts';
import { buttonItem, overlayPanelItemListRenderer, showModal, showToast } from '../ui/yt-ui.ts';
import { compactInPlace } from '../utils/feed-helpers.ts';
import { isObjectLike, isRecord } from '../utils/type-guards.ts';
import { t } from './i18n.ts';
import { getFeedbackPanelTokens, requestNextAndNavigateChannel, sendFeedbackToken } from './innertube-calls.ts';
import { findResolveCommandHost } from './yttv-bridge.ts';

type ResolveInstance = { resolveCommand: (cmd: InnertubeCommand, arg?: unknown) => unknown };

let activeResolveInstance: ResolveInstance | null = null;

function isLiveResolveInstance(instance: ResolveInstance | null): instance is ResolveInstance {
  if (!instance || typeof instance.resolveCommand !== 'function' || typeof window === 'undefined' || !window._yttv) {
    return false;
  }
  return Object.values(window._yttv).some((entry) => isObjectLike(entry) && entry.instance === instance);
}

export default async function resolveCommand(cmd: unknown, arg?: unknown): Promise<unknown> {
  patchResolveCommand();
  const target = isLiveResolveInstance(activeResolveInstance)
    ? activeResolveInstance
    : findResolveCommandHost()?.instance;
  return target ? target.resolveCommand(cmd as InnertubeCommand, arg) : undefined;
}

function handleSetClientSetting(endpoint: Record<string, unknown>): boolean {
  const settingDatas = Array.isArray(endpoint.settingDatas) ? endpoint.settingDatas : [];
  for (const rawSetting of settingDatas) {
    if (!isRecord(rawSetting)) continue;
    const enumObj = isRecord(rawSetting.clientSettingEnum) ? rawSetting.clientSettingEnum : undefined;
    if (enumObj?.item === 'I18N_LANGUAGE') {
      const lang = typeof rawSetting.stringValue === 'string' ? rawSetting.stringValue : '';
      const date = new Date();
      date.setFullYear(date.getFullYear() + 10);
      // biome-ignore lint/suspicious/noDocumentCookie: YouTube TV reads PREF cookie synchronously before RELOAD_PAGE.
      document.cookie = `PREF=hl=${lang}; expires=${date.toUTCString()};`;
      resolveCommand({ signalAction: { signal: 'RELOAD_PAGE' } });
      return true;
    }
  }
  return false;
}

const REPORT_OR_FEEDBACK_ICON_RE = /(?:REPORT|FLAG|FEEDBACK)/i;
const REPORT_OR_FEEDBACK_TEXT_RE = /\b(?:report|feedback)\b/i;
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
    if (
      node.getReportVideoFormEndpoint ||
      node.getReportFormEndpoint ||
      node.flagVideoEndpoint ||
      node.sendFeedbackEndpoint ||
      node.feedbackEndpoint
    ) {
      return true;
    }
    const clientOverlay = isRecord(node.openClientOverlayAction) ? node.openClientOverlayAction : undefined;
    if (typeof clientOverlay?.type === 'string' && REPORT_OR_FEEDBACK_TEXT_RE.test(clientOverlay.type)) {
      return true;
    }
    const openPopup = isRecord(node.openPopupAction) ? node.openPopupAction : undefined;
    if (typeof openPopup?.uniqueId === 'string' && REPORT_OR_FEEDBACK_TEXT_RE.test(openPopup.uniqueId)) {
      return true;
    }
    const signal = isRecord(node.signalAction) ? node.signalAction : undefined;
    return typeof signal?.signal === 'string' && REPORT_OR_FEEDBACK_TEXT_RE.test(signal.signal);
  });
}

function isReportOrFeedbackPopupItem(item: unknown): boolean {
  const renderer = unwrapPopupItemRenderer(item);
  if (!renderer) return false;

  const icon = isRecord(renderer.icon) ? renderer.icon : undefined;
  if (typeof icon?.iconType === 'string' && REPORT_OR_FEEDBACK_ICON_RE.test(icon.iconType)) {
    return true;
  }

  const label = readFormattedText(renderer.title ?? renderer.text);
  if (label && REPORT_OR_FEEDBACK_TEXT_RE.test(label)) {
    return true;
  }

  return (
    hasReportOrFeedbackEndpoint(renderer.serviceEndpoint) ||
    hasReportOrFeedbackEndpoint(renderer.navigationEndpoint) ||
    hasReportOrFeedbackEndpoint(renderer.command)
  );
}

function patchPlaybackSettingsPopup(cmd: Record<string, unknown>, isPrimaryPlaybackSettings: boolean): void {
  const openPopup = isRecord(cmd.openPopupAction) ? cmd.openPopupAction : undefined;
  const popup = isRecord(openPopup?.popup) ? openPopup.popup : undefined;
  const overlaySection = isRecord(popup?.overlaySectionRenderer) ? popup.overlaySectionRenderer : undefined;
  const overlay = isRecord(overlaySection?.overlay) ? overlaySection.overlay : undefined;
  const twoPanel = isRecord(overlay?.overlayTwoPanelRenderer) ? overlay.overlayTwoPanelRenderer : undefined;
  const actionPanel = isRecord(twoPanel?.actionPanel) ? twoPanel.actionPanel : undefined;
  const panelRenderer = isRecord(actionPanel?.overlayPanelRenderer) ? actionPanel.overlayPanelRenderer : undefined;
  const content = isRecord(panelRenderer?.content) ? panelRenderer.content : undefined;
  const itemList = isRecord(content?.overlayPanelItemListRenderer) ? content.overlayPanelItemListRenderer : undefined;
  const menuPopup = isRecord(popup?.menuPopupRenderer) ? popup.menuPopupRenderer : undefined;
  const listContainer = itemList ?? menuPopup;
  const items = Array.isArray(listContainer?.items) ? listContainer.items : undefined;
  if (!items || !listContainer) return;

  compactInPlace(items, isReportOrFeedbackPopupItem);

  if (typeof listContainer.selectedIndex === 'number' && listContainer.selectedIndex >= items.length) {
    listContainer.selectedIndex = Math.max(0, items.length - 1);
  }

  if (!isPrimaryPlaybackSettings) return;

  for (const item of items) {
    if (!isRecord(item) || !isRecord(item.compactLinkRenderer)) continue;
    const clr = item.compactLinkRenderer;
    const icon = isRecord(clr.icon) ? clr.icon : undefined;
    const iconType = icon?.iconType;
    if (iconType === 'SLOW_MOTION_VIDEO' || iconType === 'SPEEDOMETER') {
      if (isRecord(clr.subtitle)) {
        clr.subtitle.simpleText = t('player.withCustomSpeed');
      }
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

function extractCustomAction(cmd: Record<string, unknown>): { action: string; parameters?: unknown } | null {
  const direct = isRecord(cmd.customAction) ? cmd.customAction : undefined;
  if (typeof direct?.action === 'string') return { action: direct.action, parameters: direct.parameters };

  for (const wrapperKey of ['signalAction', 'showEngagementPanelEndpoint', 'playlistEditEndpoint'] as const) {
    const wrapper = isRecord(cmd[wrapperKey]) ? cmd[wrapperKey] : undefined;
    const nested = isRecord(wrapper?.customAction) ? wrapper.customAction : undefined;
    if (typeof nested?.action === 'string') return { action: nested.action, parameters: nested.parameters };
  }
  return null;
}

const patchedResolveFns = new WeakSet<object>();

function runCustomAction(action: string, parameters?: unknown): void {
  void customAction(action, parameters).catch((error) => {
    console.error('[ResolveCommand] customAction failed:', action, error);
  });
}

export function patchResolveCommand(): void {
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

      if (isRecord(rawCmd.setClientSettingEndpoint)) {
        if (handleSetClientSetting(rawCmd.setClientSettingEndpoint)) return true;
      } else {
        const extracted = extractCustomAction(rawCmd);
        if (extracted) {
          runCustomAction(extracted.action, extracted.parameters);
          return true;
        }
        const openPopup = isRecord(rawCmd.openPopupAction) ? rawCmd.openPopupAction : undefined;
        const uniqueId = typeof openPopup?.uniqueId === 'string' ? openPopup.uniqueId : '';
        if (uniqueId === 'playback-settings') {
          patchPlaybackSettingsPopup(rawCmd, true);
        } else if (uniqueId === 'CLIENT_OVERLAY_TYPE_CAPTIONS_AUTO_TRANSLATE') {
          patchAutoTranslateCommand(rawCmd);
        } else if (uniqueId && !uniqueId.startsWith('tt-') && /(?:playback|player|more|settings)/i.test(uniqueId)) {
          patchPlaybackSettingsPopup(rawCmd, false);
        }
      }

      const cmdExec = isRecord(rawCmd.commandExecutorCommand) ? rawCmd.commandExecutorCommand : undefined;
      if (Array.isArray(cmdExec?.commands)) {
        for (const subCmd of cmdExec.commands) {
          const extracted = isRecord(subCmd) ? extractCustomAction(subCmd) : null;
          if (extracted) {
            runCustomAction(extracted.action, extracted.parameters);
          } else {
            instance.resolveCommand(subCmd, arg);
          }
        }
        return true;
      }

      const reqAcct = isRecord(rawCmd.requestAccountSelectorCommand) ? rawCmd.requestAccountSelectorCommand : undefined;
      const acctCtx = isRecord(reqAcct?.identityActionContext) ? reqAcct.identityActionContext : undefined;
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
    const first = isRecord(feedbackResponses[0]) ? feedbackResponses[0] : undefined;
    const dialog = isRecord(first?.followUpDialog) ? first.followUpDialog : undefined;
    const dismissal = isRecord(dialog?.dismissalFollowUpRenderer) ? dialog.dismissalFollowUpRenderer : undefined;
    const reasons = dismissal?.reasons;
    if (!Array.isArray(reasons) || reasons.length === 0) return;

    const buttons = reasons
      .filter((reason): reason is Record<string, unknown> => isRecord(reason))
      .map((reason) =>
        buttonItem({ title: readFormattedText(reason.title as FormattedText | string | undefined) }, null, [
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
