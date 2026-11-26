import { t } from '../core/i18n.ts';
import { buttonItem, overlayPanelItemListRenderer, showModal } from './yt-ui.ts';

const DEFAULT_PLAYBACK_SPEED = 1;
const SPEED_INCREMENT = 0.25;
const MAX_PLAYBACK_SPEED = 5;
const STUTTER_FIX_SPEED = 1.0001;

let activeSpeedSubtitleEl: WeakRef<Element> | null = null;

function normalizeSpeed(speed: number): number | undefined {
  if (!Number.isFinite(speed) || speed <= 0 || speed > MAX_PLAYBACK_SPEED) return undefined;
  return Math.round(speed * 10000) / 10000;
}

function queryLiveVideo(): HTMLVideoElement | null {
  return typeof document !== 'undefined' && typeof document.querySelector === 'function'
    ? document.querySelector('video')
    : null;
}

/**
 * Reads the active `<video>` playback rate without carrying speed state across videos.
 */
export function getActivePlaybackSpeed(): number {
  const rate = queryLiveVideo()?.playbackRate;
  return normalizeSpeed(rate ?? Number.NaN) ?? DEFAULT_PLAYBACK_SPEED;
}

export function formatPlaybackSpeedLabel(speed = getActivePlaybackSpeed()): string {
  const validSpeed = normalizeSpeed(speed) ?? DEFAULT_PLAYBACK_SPEED;
  return validSpeed === DEFAULT_PLAYBACK_SPEED ? t('player.playbackSpeed.normal') : `${validSpeed}x`;
}

export function setPlaybackSpeed(speed: number): void {
  const validSpeed = normalizeSpeed(speed);
  if (validSpeed === undefined) return;
  const video = queryLiveVideo();
  if (video && video.playbackRate !== validSpeed) {
    video.playbackRate = validSpeed;
  }
  const subtitleEl = activeSpeedSubtitleEl?.deref() ?? null;
  activeSpeedSubtitleEl = null;
  if (subtitleEl?.isConnected) {
    subtitleEl.textContent = formatPlaybackSpeedLabel(validSpeed);
  }
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
  const subtitleTarget =
    typeof document !== 'undefined'
      ? (document.activeElement?.querySelector?.('yt-formatted-string + div > yt-formatted-string') ?? null)
      : null;
  activeSpeedSubtitleEl = subtitleTarget ? new WeakRef(subtitleTarget) : null;

  const activeSpeed = getActivePlaybackSpeed();
  const buttons: unknown[] = [];
  let selectedIndex = 0;

  for (let speed = SPEED_INCREMENT; speed <= MAX_PLAYBACK_SPEED; speed += SPEED_INCREMENT) {
    const fixedSpeed = Math.round(speed * 100) / 100;
    buttons.push(createSpeedOption(formatPlaybackSpeedLabel(fixedSpeed), fixedSpeed));
    if (activeSpeed === fixedSpeed) {
      selectedIndex = buttons.length - 1;
    }
  }

  buttons.push(createSpeedOption(t('player.playbackSpeed.fixStuttering'), STUTTER_FIX_SPEED));
  if (activeSpeed === STUTTER_FIX_SPEED) {
    selectedIndex = buttons.length - 1;
  }

  showModal(t('player.playbackSpeed.title'), overlayPanelItemListRenderer(buttons, selectedIndex), 'tt-speed');
}
