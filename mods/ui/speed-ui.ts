import { configRead } from '../core/config.ts';
import { t } from '../core/i18n.ts';
import { onVideo } from '../core/player-observer.ts';
import { buttonItem, overlayPanelItemListRenderer, showModal } from './yt-ui.ts';

function initSpeedControls(video: HTMLVideoElement): void {
  video.addEventListener('canplay', () => {
    video.playbackRate = configRead('videoSpeed');
  });
}

export function speedSettings(): void {
  const currentSpeed = configRead('videoSpeed');
  let selectedIndex = 0;
  const maxSpeed = 5;
  const increment = configRead('speedSettingsIncrement') || 0.25;
  const buttons: unknown[] = [];

  for (let speed = increment; speed <= maxSpeed; speed += increment) {
    const fixedSpeed = Math.round(speed * 100) / 100;
    buttons.push(
      buttonItem({ title: `${fixedSpeed}x` }, null, [
        { signalAction: { signal: 'POPUP_BACK' } },
        {
          setClientSettingEndpoint: {
            settingDatas: [
              {
                clientSettingEnum: { item: 'videoSpeed' },
                intValue: fixedSpeed.toString(),
              },
            ],
          },
        },
        {
          customAction: {
            action: 'SET_PLAYER_SPEED',
            parameters: fixedSpeed.toString(),
          },
        },
      ])
    );
    if (currentSpeed === fixedSpeed) {
      selectedIndex = buttons.length - 1;
    }
  }

  buttons.push(
    buttonItem({ title: t('player.playbackSpeed.fixStuttering') }, null, [
      { signalAction: { signal: 'POPUP_BACK' } },
      {
        setClientSettingEndpoint: {
          settingDatas: [
            {
              clientSettingEnum: { item: 'videoSpeed' },
              intValue: '1.0001',
            },
          ],
        },
      },
      {
        customAction: {
          action: 'SET_PLAYER_SPEED',
          parameters: '1.0001',
        },
      },
    ])
  );

  showModal(t('player.playbackSpeed.title'), overlayPanelItemListRenderer(buttons, selectedIndex), 'tt-speed');
}

if (typeof document !== 'undefined') {
  onVideo(initSpeedControls);
}
