import { t } from '../core/i18n.ts';
import resolveCommand from '../core/resolve-command.ts';
import type { Thumbnail, WatchEndpoint } from '../types/innertube.ts';

export interface ModalTitle {
  title: string;
  subtitle?: string;
  overlayPanelHeaderRenderer?: Record<string, unknown>;
}

export interface ButtonItemTitle {
  title: string;
  subtitle?: string;
}

export interface ButtonItemIcon {
  icon: string;
  secondaryIcon?: string;
}

export interface LongPressDataInput {
  videoId: string;
  thumbnails: Thumbnail[];
  title: string;
  subtitle: string;
  watchEndpointData: WatchEndpoint;
  item: unknown;
}

export function showToast(title: string, subtitle: string, thumbnails?: Thumbnail[]): void {
  const overlayToastRenderer: Record<string, unknown> = {
    title: { simpleText: title },
    subtitle: { simpleText: subtitle },
  };
  if (thumbnails) {
    overlayToastRenderer.image = { thumbnails };
  }
  resolveCommand({
    openPopupAction: {
      popupType: 'TOAST',
      popup: { overlayToastRenderer },
    },
  });
}

function Modal(header: string | ModalTitle, content: unknown, id: string, update?: boolean): Record<string, unknown> {
  const titleSubtitleObj: ModalTitle = typeof header === 'string' ? { title: header, subtitle: '' } : header;
  const overlayPanelHeaderRenderer: Record<string, unknown> = titleSubtitleObj.overlayPanelHeaderRenderer ?? {
    title: { simpleText: titleSubtitleObj.title },
  };

  if (titleSubtitleObj.subtitle) {
    overlayPanelHeaderRenderer.subtitle = { simpleText: titleSubtitleObj.subtitle };
  }

  const openPopupAction: Record<string, unknown> = {
    popupType: 'MODAL',
    popup: {
      overlaySectionRenderer: {
        overlay: {
          overlayTwoPanelRenderer: {
            actionPanel: {
              overlayPanelRenderer: {
                header: { overlayPanelHeaderRenderer },
                content,
              },
            },
            backButton: {
              buttonRenderer: {
                accessibilityData: {
                  accessibilityData: { label: t('common.back') },
                },
                command: {
                  signalAction: { signal: 'POPUP_BACK' },
                },
              },
            },
          },
        },
        dismissalCommand: {
          signalAction: { signal: 'POPUP_BACK' },
        },
      },
    },
    uniqueId: id,
  };

  if (update) {
    openPopupAction.shouldMatchUniqueId = true;
    openPopupAction.updateAction = true;
  }

  return { openPopupAction };
}

export function showModal(header: string | ModalTitle, content: unknown, id: string, update?: boolean): void {
  resolveCommand(Modal(header, content, id, update));
}

export function overlayPanelItemListRenderer(items: unknown[], selectedIndex = 0) {
  return {
    overlayPanelItemListRenderer: {
      items,
      selectedIndex,
    },
  };
}

export function buttonItem(title: ButtonItemTitle | null, icon: ButtonItemIcon | null, commands: unknown[]) {
  const compactLinkRenderer: Record<string, unknown> = {
    serviceEndpoint: {
      commandExecutorCommand: { commands },
    },
  };

  if (title) {
    compactLinkRenderer.title = { simpleText: title.title };
    if (title.subtitle) {
      compactLinkRenderer.subtitle = { simpleText: title.subtitle };
    }
  }

  if (icon) {
    compactLinkRenderer.icon = { iconType: icon.icon };
    if (icon.secondaryIcon) {
      compactLinkRenderer.secondaryIcon = { iconType: icon.secondaryIcon };
    }
  }

  return { compactLinkRenderer };
}

export function timelyAction(text: string, icon: string, command: unknown, triggerTimeMs: number, timeoutMs: number) {
  return {
    timelyActionRenderer: {
      actionButtons: [
        {
          buttonRenderer: {
            isDisabled: false,
            text: { runs: [{ text }] },
            icon: { iconType: icon },
            trackingParams: null,
            command,
          },
        },
      ],
      triggerTimeMs,
      timeoutMs,
      type: '',
    },
  };
}

export function longPressData(data: LongPressDataInput) {
  const isWatchLaterItem = data.watchEndpointData.playlistId === 'WL';
  const watchLaterAction = isWatchLaterItem
    ? {
        removedVideoId: data.videoId,
        action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID',
      }
    : {
        addedVideoId: data.videoId,
        action: 'ACTION_ADD_VIDEO',
      };

  return {
    clickTrackingParams: null,
    showMenuCommand: {
      contentId: data.videoId,
      thumbnail: { thumbnails: data.thumbnails },
      title: { simpleText: data.title },
      subtitle: { simpleText: data.subtitle },
      menu: {
        menuRenderer: {
          items: [
            MenuNavigationItemRenderer(t('videoMenu.play'), {
              clickTrackingParams: null,
              watchEndpoint: data.watchEndpointData,
            }),
            MenuServiceItemRenderer(
              isWatchLaterItem ? t('videoMenu.removeFromWatchLater') : t('videoMenu.saveToWatchLater'),
              {
                clickTrackingParams: null,
                commandMetadata: {
                  webCommandMetadata: {
                    sendPost: true,
                    apiUrl: '/youtubei/v1/browse/edit_playlist',
                  },
                },
                playlistEditEndpoint: {
                  playlistId: 'WL',
                  actions: [watchLaterAction],
                },
              }
            ),
            MenuServiceItemRenderer(t('videoMenu.goToChannel'), {
              clickTrackingParams: null,
              playlistEditEndpoint: {
                customAction: {
                  action: 'GO_TO_CHANNEL',
                  parameters: data.item,
                },
              },
            }),
          ],
          trackingParams: null,
          accessibility: {
            accessibilityData: { label: t('videoMenu.videoOptions') },
          },
        },
      },
    },
  };
}

export function MenuServiceItemRenderer(text: string, serviceEndpoint: unknown) {
  return {
    menuServiceItemRenderer: {
      text: { runs: [{ text }] },
      serviceEndpoint,
      trackingParams: null,
    },
  };
}

function MenuNavigationItemRenderer(text: string, navigateEndpoint: unknown) {
  return {
    menuNavigationItemRenderer: {
      text: { runs: [{ text }] },
      navigationEndpoint: navigateEndpoint,
      trackingParams: null,
    },
  };
}

export function SettingsCategory(categoryId: string, items: unknown[], title?: string) {
  const settingCategoryCollectionRenderer: Record<string, unknown> = {
    items,
    categoryId,
    focused: false,
    trackingParams: 'null',
  };

  if (title) {
    settingCategoryCollectionRenderer.title = { runs: [{ text: title }] };
  }

  return { settingCategoryCollectionRenderer };
}

export function SettingActionRenderer(
  title: string,
  itemId: string,
  serviceEndpoint: unknown,
  summary: string,
  thumbnail: string
) {
  return {
    settingActionRenderer: {
      title: { runs: [{ text: title }] },
      serviceEndpoint,
      summary: { runs: [{ text: summary }] },
      trackingParams: 'null',
      actionLabel: { runs: [{ text: title }] },
      itemId,
      thumbnail: {
        thumbnails: [{ url: thumbnail }],
      },
    },
  };
}

export function overlayMessageRenderer(simpleText: string) {
  return {
    overlayMessageRenderer: {
      title: { simpleText },
    },
  };
}

export function ButtonRenderer(disabled: boolean, text: string, iconType: string, command: unknown) {
  return {
    isDisabled: disabled,
    text: { runs: [{ text }] },
    icon: { iconType },
    command,
    trackingParams: null,
  };
}

export function GuideEntryRenderer(simpleText: string, navigationEndpoint: unknown, icon?: string, thumbnail?: string) {
  const guideEntryRenderer: Record<string, unknown> = {
    navigationEndpoint,
    trackingParams: null,
    formattedTitle: { simpleText },
  };

  if (icon) {
    guideEntryRenderer.icon = { iconType: icon };
  }
  if (thumbnail) {
    guideEntryRenderer.thumbnail = { thumbnails: [{ url: thumbnail }] };
  }

  return { guideEntryRenderer };
}
