import { configRead, configWrite } from '../core/config.ts';
import { t } from '../core/i18n.ts';
import { getGuide } from '../core/innertube-calls.ts';
import { isRecord } from '../utils/type-guards.ts';
import { getGuideItemId } from './custom-guide-action.ts';
import type { GuideEntryRendererData } from './custom-guide-action.ts';
import { buttonItem, overlayPanelItemListRenderer, showModal } from './yt-ui.ts';

interface GuideActionParams {
  direction?: 'up' | 'down';
  item?: {
    guideEntryRenderer?: GuideEntryRendererData;
  };
}

async function handleMoveGuideButton(params?: GuideActionParams): Promise<void> {
  const order = [...configRead('sidebarContentsOrder')];
  const browseId = getGuideItemId(params?.item?.guideEntryRenderer);
  const index = order.findIndex((item) => (typeof item === 'object' && item !== null ? item.browseId : item) === browseId);

  if (index === -1) {
    handleSidebarSettingsMenu('', true);
    return;
  }

  if (params?.direction === 'up' && index > 0) {
    const prev = order[index - 1];
    const curr = order[index];
    if (prev !== undefined && curr !== undefined) {
      order[index - 1] = curr;
      order[index] = prev;
    }
  } else if (params?.direction === 'down' && index < order.length - 1) {
    const next = order[index + 1];
    const curr = order[index];
    if (next !== undefined && curr !== undefined) {
      order[index + 1] = curr;
      order[index] = next;
    }
  }
  await configWrite('sidebarContentsOrder', order);
  handleSidebarSettingsMenu('', true);
}

function handleShowGuideButtons(params?: GuideActionParams): void {
  const title = params?.item?.guideEntryRenderer?.formattedTitle?.simpleText ?? '';
  const buttons = [
    buttonItem(
      {
        title: t('settings.options.uiSettings.options.sortSidebarContents.moveUp.title'),
        subtitle: t('settings.options.uiSettings.options.sortSidebarContents.moveUp.subtitle'),
      },
      { icon: 'UP_ARROW' },
      [
        {
          customAction: {
            action: 'MOVE_GUIDE_BUTTON',
            parameters: { direction: 'up', item: params?.item },
          },
        },
        { signalAction: { signal: 'POPUP_BACK' } },
      ]
    ),
    buttonItem(
      {
        title: t('settings.options.uiSettings.options.sortSidebarContents.moveDown.title'),
        subtitle: t('settings.options.uiSettings.options.sortSidebarContents.moveDown.subtitle'),
      },
      { icon: 'DOWN_ARROW' },
      [
        {
          customAction: {
            action: 'MOVE_GUIDE_BUTTON',
            parameters: { direction: 'down', item: params?.item },
          },
        },
        { signalAction: { signal: 'POPUP_BACK' } },
      ]
    ),
  ];

  showModal(title, overlayPanelItemListRenderer(buttons), 'tt-move-guide-button-modal');
}

function handleSidebarSettingsMenu(settingType: unknown, isReload: unknown): void {
  void getGuide().then((guide) => {
    if (!isRecord(guide) || !Array.isArray(guide.items)) return;
    const first = isRecord(guide.items[0]) ? guide.items[0] : undefined;
    const section = isRecord(first?.guideSectionRenderer) ? first.guideSectionRenderer : undefined;
    const guideItems = Array.isArray(section?.originalItems)
      ? section.originalItems
      : Array.isArray(section?.items)
        ? section.items
        : [];

    const buttons: unknown[] = [];
    let idx = 0;

    for (const item of guideItems) {
      if (!isRecord(item) || !isRecord(item.guideEntryRenderer)) continue;
      const renderer = item.guideEntryRenderer as GuideEntryRendererData;
      const title = renderer.formattedTitle?.simpleText ?? '';
      const icon = renderer.icon?.iconType ?? '';
      const browseId = getGuideItemId(renderer);
      const isDisabledMode = settingType === 'disabledSidebarContents';
      const isChecked = isDisabledMode && browseId ? configRead('disabledSidebarContents').includes(browseId) : false;

      buttons.push(
        buttonItem(
          { title },
          {
            icon,
            secondaryIcon: isDisabledMode ? (isChecked ? 'CHECK_BOX' : 'CHECK_BOX_OUTLINE_BLANK') : undefined,
          },
          [
            isDisabledMode
              ? {
                  setClientSettingEndpoint: {
                    settingDatas: [
                      {
                        clientSettingEnum: { item: 'disabledSidebarContents' },
                        arrayValue: browseId,
                      },
                    ],
                  },
                }
              : {
                  customAction: {
                    action: 'SHOW_GUIDE_BUTTONS',
                    parameters: { settingType, idx, item },
                  },
                },
            ...(isDisabledMode
              ? [
                  {
                    customAction: {
                      action: 'RELOAD_GUIDE_OPTIONS',
                      parameters: { settingType, idx, item },
                    },
                  },
                ]
              : []),
          ]
        )
      );
      idx++;
    }

    const isDisableMenu = settingType === 'disabledSidebarContents';
    showModal(
      {
        title: isDisableMenu
          ? t('settings.options.uiSettings.options.disableSidebarContents.title')
          : t('settings.options.uiSettings.options.sortSidebarContents.title'),
        subtitle: isDisableMenu
          ? t('settings.options.uiSettings.options.disableSidebarContents.subtitle')
          : t('settings.options.uiSettings.options.sortSidebarContents.subtitle'),
      },
      overlayPanelItemListRenderer(buttons),
      'tt-sidebar-settings',
      isReload === true
    );
  });
}

export default function showSetting(settingType: unknown, parameters?: unknown): void {
  const params = isRecord(parameters) ? (parameters as GuideActionParams) : undefined;
  if (settingType === 'MOVE_GUIDE_BUTTON') {
    void handleMoveGuideButton(params);
    return;
  }
  if (settingType === 'SHOW_GUIDE_BUTTONS') {
    handleShowGuideButtons(params);
    return;
  }
  handleSidebarSettingsMenu(settingType, parameters);
}
