import { t } from '../core/i18n.ts';
import { dispatchYttvCommand } from '../core/yttv-bridge.ts';
import type { Thumbnail, WatchEndpoint } from '../types/innertube.ts';

interface LongPressDataInput {
  videoId: string;
  thumbnails: Thumbnail[];
  title: string;
  subtitle: string;
  watchEndpointData: WatchEndpoint;
  item: unknown;
}

export function showModal(title: string, content: unknown, id: string): void {
  dispatchYttvCommand({
    openPopupAction: {
      popupType: 'MODAL',
      popup: {
        overlaySectionRenderer: {
          overlay: {
            overlayTwoPanelRenderer: {
              actionPanel: {
                overlayPanelRenderer: {
                  header: {
                    overlayPanelHeaderRenderer: {
                      title: { simpleText: title },
                    },
                  },
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
    },
  });
}

export function overlayPanelItemListRenderer(items: unknown[], selectedIndex = 0) {
  return {
    overlayPanelItemListRenderer: {
      items,
      selectedIndex,
    },
  };
}

export function buttonItem(title: string, commands: unknown[]) {
  return {
    compactLinkRenderer: {
      title: { simpleText: title },
      serviceEndpoint: {
        commandExecutorCommand: { commands },
      },
    },
  };
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
            menuNavigationItemRenderer(t('videoMenu.play'), {
              clickTrackingParams: null,
              watchEndpoint: data.watchEndpointData,
            }),
            menuServiceItemRenderer(
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
            menuServiceItemRenderer(t('videoMenu.goToChannel'), {
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

export function menuServiceItemRenderer(text: string, serviceEndpoint: unknown) {
  return {
    menuServiceItemRenderer: {
      text: { runs: [{ text }] },
      serviceEndpoint,
      trackingParams: null,
    },
  };
}

function menuNavigationItemRenderer(text: string, navigateEndpoint: unknown) {
  return {
    menuNavigationItemRenderer: {
      text: { runs: [{ text }] },
      navigationEndpoint: navigateEndpoint,
      trackingParams: null,
    },
  };
}

export function buttonRenderer(text: string, iconType: string, command: unknown) {
  return {
    isDisabled: false,
    text: { runs: [{ text }] },
    icon: { iconType },
    command,
    trackingParams: null,
  };
}
