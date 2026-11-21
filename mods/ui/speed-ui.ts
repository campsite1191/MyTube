import { t } from '../core/i18n.ts';
import { onVideo } from '../core/player-observer.ts';
import { buttonItem, overlayPanelItemListRenderer, showModal } from './yt-ui.ts';

const SPEED_INCREMENT = 0.25;
let currentPlaybackSpeed = 1;

export function setPlaybackSpeed(speed: number): void {
  if (!Number.isFinite(speed) || speed <= 0) return;
  currentPlaybackSpeed = speed;
  const video = document.querySelector('video');
  if (video) video.playbackRate = speed;
}

function initSpeedControls(video: HTMLVideoElement): void {
  video.addEventListener('canplay', () => {
    video.playbackRate = currentPlaybackSpeed;
  });
}

export function speedSettings(): void {
  let selectedIndex = 0;
  const maxSpeed = 5;
  const buttons: unknown[] = [];

  for (let speed = SPEED_INCREMENT; speed <= maxSpeed; speed += SPEED_INCREMENT) {
    const fixedSpeed = Math.round(speed * 100) / 100;
    buttons.push(
      buttonItem({ title: `${fixedSpeed}x` }, null, [
        { signalAction: { signal: 'POPUP_BACK' } },
        {
          customAction: {
            action: 'SET_PLAYER_SPEED',
            parameters: fixedSpeed.toString(),
          },
        },
      ])
    );
    if (currentPlaybackSpeed === fixedSpeed) {
      selectedIndex = buttons.length - 1;
    }
  }

  buttons.push(
    buttonItem({ title: t('player.playbackSpeed.fixStuttering') }, null, [
      { signalAction: { signal: 'POPUP_BACK' } },
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
