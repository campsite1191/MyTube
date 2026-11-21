import { t } from '../core/i18n.ts';
import { onWatchSession } from '../core/lifecycle.ts';
import { onVideo } from '../core/player-observer.ts';
import { buttonItem, overlayPanelItemListRenderer, showModal } from './yt-ui.ts';

const SPEED_INCREMENT = 0.25;
const MAX_PLAYBACK_SPEED = 5;
const STUTTER_FIX_SPEED = 1.0001;

let currentPlaybackSpeed = 1;
let speedControlsInstalled = false;

function syncVideoPlaybackRate(video: HTMLVideoElement): void {
  if (video.playbackRate !== currentPlaybackSpeed) {
    video.playbackRate = currentPlaybackSpeed;
  }
}

export function setPlaybackSpeed(speed: number): void {
  if (!Number.isFinite(speed) || speed <= 0 || speed > MAX_PLAYBACK_SPEED) return;
  currentPlaybackSpeed = speed;
  if (typeof document === 'undefined') return;
  const video = document.querySelector('video');
  if (video) syncVideoPlaybackRate(video);
}

function createSpeedOption(title: string, speed: number) {
  return buttonItem(title, [
    { signalAction: { signal: 'POPUP_BACK' } },
    {
      customAction: {
        action: 'SET_PLAYER_SPEED',
        parameters: speed.toString(),
      },
    },
  ]);
}

export function speedSettings(): void {
  const buttons: unknown[] = [];
  let selectedIndex = 0;

  for (let speed = SPEED_INCREMENT; speed <= MAX_PLAYBACK_SPEED; speed += SPEED_INCREMENT) {
    const fixedSpeed = Math.round(speed * 100) / 100;
    buttons.push(createSpeedOption(`${fixedSpeed}x`, fixedSpeed));
    if (currentPlaybackSpeed === fixedSpeed) {
      selectedIndex = buttons.length - 1;
    }
  }

  buttons.push(createSpeedOption(t('player.playbackSpeed.fixStuttering'), STUTTER_FIX_SPEED));
  if (currentPlaybackSpeed === STUTTER_FIX_SPEED) {
    selectedIndex = buttons.length - 1;
  }

  showModal(t('player.playbackSpeed.title'), overlayPanelItemListRenderer(buttons, selectedIndex), 'tt-speed');
}

/**
 * Reapplies selected playback speed across Watch video loads cleanly via `onWatchSession`.
 */
export function installSpeedControls(): void {
  if (speedControlsInstalled || typeof window === 'undefined' || typeof document === 'undefined') return;
  speedControlsInstalled = true;

  onWatchSession((_videoId, signal) => {
    onVideo((video) => {
      if (signal.aborted) return;
      const sync = (): void => {
        if (!signal.aborted) syncVideoPlaybackRate(video);
      };
      sync();
      video.addEventListener('loadedmetadata', sync, { signal });
      video.addEventListener('canplay', sync, { signal });
    });
  });
}
