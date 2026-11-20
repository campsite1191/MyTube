import { patchAutoTranslateCommand } from '../features/more-subtitles.ts';
import { readFormattedText } from '../transforms/feed-filter.ts';
import type { FormattedText, HiddenChannel, InnertubeCommand } from '../types/innertube.ts';
import modernUI, { optionShow } from '../ui/settings.ts';
import showGuideSettings from '../ui/sidebar-modification.ts';
import { speedSettings } from '../ui/speed-ui.ts';
import { buttonItem, overlayMessageRenderer, overlayPanelItemListRenderer, showModal, showToast } from '../ui/yt-ui.ts';
import { isRecord } from '../utils/type-guards.ts';
import type { ConfigKey, ConfigSchema, SidebarContentItem } from './config.ts';
import { configRead, configWrite } from './config.ts';
import { t } from './i18n.ts';
import { getFeedbackPanelTokens, requestNextAndNavigateChannel, sendFeedbackToken } from './innertube-calls.ts';
import { findResolveCommandHost } from './yttv-bridge.ts';

type ResolveInstance = { resolveCommand: (cmd: InnertubeCommand, arg?: unknown) => unknown };

let activeResolveInstance: ResolveInstance | null = null;

function isLiveResolveInstance(instance: ResolveInstance | null): instance is ResolveInstance {
  if (!instance || typeof instance.resolveCommand !== 'function' || typeof window === 'undefined' || !window._yttv) {
    return false;
  }
  return Object.values(window._yttv).some((entry) => isRecord(entry) && entry.instance === instance);
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
  let handledCustomSetting = false;
  for (const rawSetting of settingDatas) {
    if (!isRecord(rawSetting)) continue;
    const enumObj = isRecord(rawSetting.clientSettingEnum) ? rawSetting.clientSettingEnum : undefined;
    const itemKey = typeof enumObj?.item === 'string' ? enumObj.item : '';
    if (!itemKey) continue;

    if (!itemKey.includes('_')) {
      const sKey = itemKey as ConfigKey;
      const valName = Object.keys(rawSetting).find((k) => k.includes('Value'));
      if (!valName) continue;
      const rawVal = valName === 'intValue' ? Number(rawSetting[valName]) : rawSetting[valName];
      if (valName === 'arrayValue') {
        const current = configRead(sKey);
        const arr: unknown[] = Array.isArray(current) ? [...current] : [];
        const idx = arr.indexOf(rawVal);
        if (idx !== -1) arr.splice(idx, 1);
        else arr.push(rawVal);
        void configWrite(sKey, arr as ConfigSchema[typeof sKey]);
      } else {
        void configWrite(sKey, rawVal as ConfigSchema[typeof sKey]);
      }
      handledCustomSetting = true;
    } else if (itemKey === 'I18N_LANGUAGE') {
      const lang = typeof rawSetting.stringValue === 'string' ? rawSetting.stringValue : '';
      const date = new Date();
      date.setFullYear(date.getFullYear() + 10);
      // biome-ignore lint/suspicious/noDocumentCookie: YouTube TV reads PREF cookie synchronously before RELOAD_PAGE.
      document.cookie = `PREF=hl=${lang}; expires=${date.toUTCString()};`;
      resolveCommand({ signalAction: { signal: 'RELOAD_PAGE' } });
      return true;
    }
  }
  return handledCustomSetting;
}

function patchPlaybackSettingsPopup(cmd: Record<string, unknown>): void {
  const openPopup = isRecord(cmd.openPopupAction) ? cmd.openPopupAction : undefined;
  const popup = isRecord(openPopup?.popup) ? openPopup.popup : undefined;
  const overlaySection = isRecord(popup?.overlaySectionRenderer) ? popup.overlaySectionRenderer : undefined;
  const overlay = isRecord(overlaySection?.overlay) ? overlaySection.overlay : undefined;
  const twoPanel = isRecord(overlay?.overlayTwoPanelRenderer) ? overlay.overlayTwoPanelRenderer : undefined;
  const actionPanel = isRecord(twoPanel?.actionPanel) ? twoPanel.actionPanel : undefined;
  const panelRenderer = isRecord(actionPanel?.overlayPanelRenderer) ? actionPanel.overlayPanelRenderer : undefined;
  const content = isRecord(panelRenderer?.content) ? panelRenderer.content : undefined;
  const itemList = isRecord(content?.overlayPanelItemListRenderer) ? content.overlayPanelItemListRenderer : undefined;
  const items = Array.isArray(itemList?.items) ? itemList.items : undefined;
  if (!items) return;

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
    if (!isRecord(entry) || !isRecord(entry.instance) || typeof entry.instance.resolveCommand !== 'function') {
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
        if (openPopup?.uniqueId === 'playback-settings') {
          patchPlaybackSettingsPopup(rawCmd);
        } else if (openPopup?.uniqueId === 'CLIENT_OVERLAY_TYPE_CAPTIONS_AUTO_TRANSLATE') {
          patchAutoTranslateCommand(rawCmd);
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
      if (acctCtx?.eventTrigger === 'ACCOUNT_EVENT_TRIGGER_ON_EXIT' && !configRead('enableWhosWatchingMenuOnAppExit')) {
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
    case 'SETTINGS_UPDATE':
      modernUI(true, Array.isArray(parameters) ? (parameters as number[]) : undefined);
      break;
    case 'OPTIONS_SHOW':
      optionShow(
        parameters,
        typeof params?.update === 'boolean' || typeof params?.update === 'string' ? params.update : undefined
      );
      break;
    case 'SKIP': {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, which: 27, bubbles: true }));
      const video = document.querySelector('video');
      if (video && typeof params?.time === 'number') {
        video.currentTime = params.time;
      }
      break;
    }
    case 'TT_SETTINGS_SHOW':
      modernUI();
      break;
    case 'TT_SPEED_SETTINGS_SHOW':
      speedSettings();
      break;
    case 'SET_PLAYER_SPEED': {
      const video = document.querySelector('video');
      if (video) video.playbackRate = Number(parameters);
      break;
    }
    case 'SHOW_TOAST':
      showToast('YouTube', String(parameters ?? ''));
      break;
    case 'GO_TO_CHANNEL':
      requestNextAndNavigateChannel(parameters as Parameters<typeof requestNextAndNavigateChannel>[0]);
      break;
    case 'HIDE_CHANNEL': {
      const id = typeof params?.id === 'string' ? params.id : '';
      const name = typeof params?.name === 'string' ? params.name : '';
      if (id || name) {
        const list: HiddenChannel[] = [...configRead('hiddenChannels')];
        const exists = list.some(
          (e) => (id && e.id === id) || (name && e.name && e.name.toLowerCase() === name.toLowerCase())
        );
        if (!exists) {
          list.push({ id, name });
          await configWrite('hiddenChannels', list);
        }
        showToast('Feed', `Hidden channel: ${name || id}`);
      }
      break;
    }
    case 'UNHIDE_CHANNEL': {
      const targetId = typeof params?.id === 'string' ? params.id : '';
      const targetName = typeof params?.name === 'string' ? params.name : '';
      const list = configRead('hiddenChannels').filter((e) => {
        if (targetId && e.id === targetId) return false;
        if (targetName && e.name && e.name.toLowerCase() === targetName.toLowerCase()) return false;
        return true;
      });
      await configWrite('hiddenChannels', list);
      showToast('Feed', `Unhidden channel: ${targetName || targetId}`);
      await customAction('OPEN_HIDDEN_CHANNELS', { update: true });
      break;
    }
    case 'CLEAR_HIDDEN_CHANNELS':
      await configWrite('hiddenChannels', []);
      showToast('Feed', 'Cleared all hidden channels');
      await customAction('OPEN_HIDDEN_CHANNELS', { update: true });
      break;
    case 'OPEN_HIDDEN_CHANNELS': {
      const list = configRead('hiddenChannels');
      const btns: unknown[] = list.map((ch) =>
        buttonItem({ title: ch.name || ch.id || '', subtitle: 'Select to unhide' }, { icon: 'DELETE' }, [
          { customAction: { action: 'UNHIDE_CHANNEL', parameters: ch } },
        ])
      );
      if (btns.length > 0) {
        btns.push(
          buttonItem(
            { title: 'Clear All Hidden Channels', subtitle: `${btns.length} channel(s) hidden` },
            { icon: 'DELETE_SWEEP' },
            [{ customAction: { action: 'CLEAR_HIDDEN_CHANNELS' } }]
          )
        );
      } else {
        btns.push(
          overlayMessageRenderer('No channels are currently hidden. Use long-press -> Hide Channel on any video.')
        );
      }
      showModal(
        { title: 'Hidden Channels', subtitle: `${list.length} hidden` },
        overlayPanelItemListRenderer(btns, 0),
        'tt-hidden-channels',
        Boolean(params?.update)
      );
      break;
    }
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
    case 'SHOW_GUIDE_BUTTONS':
      showGuideSettings('SHOW_GUIDE_BUTTONS', parameters);
      break;
    case 'RELOAD_GUIDE_OPTIONS':
      showGuideSettings(params?.settingType, true);
      break;
    case 'MOVE_GUIDE_BUTTON':
      showGuideSettings('MOVE_GUIDE_BUTTON', parameters);
      break;
    case 'SHOW_GUIDE_SETTINGS':
      showGuideSettings(parameters);
      break;
    case 'ADD_OR_REMOVE_CHANNEL_TO_SIDEBAR': {
      const browseId = typeof params?.browseId === 'string' ? params.browseId : '';
      const title = typeof params?.title === 'string' ? params.title : '';
      if (!browseId) break;
      const currentOrder: SidebarContentItem[] = [...configRead('sidebarContentsOrder')];
      const existingIdx = currentOrder.findIndex((item) => typeof item === 'object' && item.browseId === browseId);
      if (existingIdx !== -1) {
        currentOrder.splice(existingIdx, 1);
      } else {
        currentOrder.push({ browseId, title });
      }
      await configWrite('sidebarContentsOrder', currentOrder);
      showToast(t('toasts.sidebarContentsUpdated.title'), t('toasts.sidebarContentsUpdated.subtitle'));
      break;
    }
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
