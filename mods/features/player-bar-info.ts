import {
  isPlayerBarVisible,
  NOOP,
  observePlayerBar,
  onAbort,
  onWatchSession,
  scheduleAbortableTimeout,
} from '../core/lifecycle.ts';
import { onVideo } from '../core/player-observer.ts';
import { injectCss } from '../core/styles.ts';
import type { YtPlayerElement } from '../types/yttv.ts';
import { formatPlaybackSpeedLabel } from '../ui/speed-ui.ts';
import { META_SEPARATOR, PLAYER_SELECTOR } from '../utils/innertube-ast.ts';

const TIME_LABEL_SELECTOR = '[idomkey="time-label"]';
const ELAPSED_SELECTOR = '[idomkey="elapsedTime"]';
const DURATION_SELECTOR = '[idomkey="duration"]';
const TEXT_NODE_TYPE = 3; // Node.TEXT_NODE (numeric fallback avoids ReferenceError when Node is unmocked in tests)
const OURS = /\s*(?:\(-\d+:\d{2}(?::\d{2})?\)|•\s*-\d+:\d{2}(?::\d{2})?)/g;
const CLOCK_RE = /\d+:\d{2}(?::\d{2})?/;
const CLOCK_SPLIT_RE = /^(.*?\d+:\d{2}(?::\d{2})?)([\s\S]*)$/;
const TRAILING_CLOCK_RE = /(\d+:\d{2}(?::\d{2})?)\s*$/;
const MAX_DISPLAY_SPEED = 5;
const VIDEO_EVENTS = [
  'timeupdate',
  'durationchange',
  'seeking',
  'seeked',
  'ratechange',
  'resize',
  'loadedmetadata',
] as const;

interface ClockTarget {
  node: Node;
  isText: boolean;
  el: HTMLElement;
  fallbackDur: boolean;
}

/**
 * Parses a clock string (`m:ss` or `h:mm:ss`) into total seconds.
 */
export function parseClockSeconds(str: string | null | undefined): number | null {
  const m = String(str || '').match(/(\d+):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (m[3] !== undefined) return a * 3600 + b * 60 + Number(m[3]);
  return a * 60 + b;
}

function matchClockSplit(rawText: string): [string, string] | null {
  const clean = rawText.replace(OURS, '');
  const m = clean.match(CLOCK_SPLIT_RE) as [string, string, string] | null;
  return m ? [m[1], m[2]] : null;
}

/**
 * Formats a duration in seconds as `m:ss` or `h:mm:ss`.
 */
export function formatClockTime(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  const ss = String(rest).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Computes the formatted remaining-time label (`-m:ss` or `-h:mm:ss`) for the player bar.
 */
export function computeRemainingText(
  rawText: string,
  durationSec: number,
  currentTimeSec: number,
  durationOverrideSec: number | null,
  fallbackDur: boolean,
  splitMatch: [string, string] | null = matchClockSplit(rawText)
): string | null {
  if (!durationSec || !Number.isFinite(durationSec) || !splitMatch) return null;
  const elapsedSec = fallbackDur ? null : parseClockSeconds(splitMatch[0]);
  const effectiveDuration = durationOverrideSec ?? Math.floor(durationSec);
  const secondsLeft =
    elapsedSec !== null
      ? Math.max(0, effectiveDuration - elapsedSec)
      : Math.max(0, effectiveDuration - Math.floor(currentTimeSec));
  return `-${formatClockTime(secondsLeft)}`;
}

/**
 * Formats a combined elapsed/duration fallback label by inserting `• -remaining`.
 */
export function formatRemainingLabel(
  rawText: string,
  durationSec: number,
  currentTimeSec: number,
  durationOverrideSec: number | null,
  fallbackDur: boolean
): string | null {
  const split = matchClockSplit(rawText);
  if (!split) return null;
  const rem = computeRemainingText(rawText, durationSec, currentTimeSec, durationOverrideSec, fallbackDur, split);
  if (rem === null) return null;
  const [prefix, suffix] = split;
  if (suffix && /\S/.test(suffix)) {
    return `${prefix}${META_SEPARATOR}${rem}${/^\s/.test(suffix) ? '' : ' '}${suffix}`;
  }
  return `${prefix.trim()}${META_SEPARATOR}${rem}`;
}

/**
 * Resolves the active picture quality label from the YouTube player API with a video-dimension fallback.
 */
export function readActiveQualityLabel(
  player?: Pick<YtPlayerElement, 'getPlaybackQualityLabel'> | null,
  video?: Pick<HTMLVideoElement, 'videoWidth' | 'videoHeight'> | null
): string | null {
  const rawLabel = typeof player?.getPlaybackQualityLabel === 'function' ? player.getPlaybackQualityLabel() : '';
  const apiLabel = typeof rawLabel === 'string' ? rawLabel.trim().replace(/^Auto\s*\(([^)]+)\)$/i, '$1') : '';
  if (apiLabel && !/^auto$/i.test(apiLabel)) {
    return apiLabel;
  }
  const width = video?.videoWidth ?? 0;
  const height = video?.videoHeight ?? 0;
  const shortEdge = width > 0 && height > 0 ? Math.min(width, height) : Math.max(height, 0);
  return shortEdge > 0 ? `${shortEdge}p` : null;
}

/**
 * Formats the right-side player bar duration label with non-default playback speed and picture quality.
 */
export function formatDurationLabel(
  rawText: string,
  playbackRate: number,
  qualityLabel: string | null | undefined
): string | null {
  const match = String(rawText || '').match(TRAILING_CLOCK_RE);
  if (!match?.[1]) return null;

  const parts: string[] = [];
  if (
    Number.isFinite(playbackRate) &&
    playbackRate > 0 &&
    playbackRate <= MAX_DISPLAY_SPEED &&
    Math.abs(playbackRate - 1) > 1e-6
  ) {
    parts.push(formatPlaybackSpeedLabel(playbackRate));
  }
  const cleanQuality = typeof qualityLabel === 'string' ? qualityLabel.trim() : '';
  if (cleanQuality) {
    parts.push(cleanQuality);
  }
  parts.push(match[1]);
  return parts.join(META_SEPARATOR);
}

function findClockTextNode(node: Node): Text | null {
  if (node.nodeType === TEXT_NODE_TYPE) {
    return CLOCK_RE.test(node.nodeValue || '') ? (node as Text) : null;
  }
  const children = node.childNodes;
  if (!children) return null;
  for (const child of children) {
    const hit = findClockTextNode(child);
    if (hit) return hit;
  }
  return null;
}

function toClockTarget(el: Element, fallbackDur = false): ClockTarget {
  const htmlEl = el as HTMLElement;
  const textNode = findClockTextNode(htmlEl);
  if (textNode) return { node: textNode, isText: true, el: htmlEl, fallbackDur };
  return { node: htmlEl, isText: false, el: htmlEl, fallbackDur };
}

function findElapsedTarget(bar: Element): ClockTarget | null {
  for (const direct of bar.querySelectorAll(ELAPSED_SELECTOR)) {
    if (!direct || direct.closest?.('ytlr-storyboard')) continue;
    if (CLOCK_RE.test(direct.textContent || '')) return toClockTarget(direct);
  }
  for (const label of bar.querySelectorAll(TIME_LABEL_SELECTOR)) {
    if (!label || label.closest?.('ytlr-storyboard')) continue;
    const span = label.querySelector(
      '[idomkey="elapsedTime"], [idomkey="position"], [idomkey="time"], [idomkey="current-time"], [idomkey="elapsed"]'
    );
    if (span && CLOCK_RE.test(span.textContent || '')) return toClockTarget(span);
    const dur = label.querySelector(DURATION_SELECTOR);
    if (dur && CLOCK_RE.test(dur.textContent || '')) return toClockTarget(dur, true);
    if (CLOCK_RE.test(label.textContent || '')) return toClockTarget(label);
  }
  return null;
}

function findDurationTarget(bar: Element): ClockTarget | null {
  for (const dur of bar.querySelectorAll(DURATION_SELECTOR)) {
    if (!dur || dur.closest?.('ytlr-storyboard')) continue;
    if (TRAILING_CLOCK_RE.test(dur.textContent || '')) return toClockTarget(dur);
  }
  return null;
}

function readTarget(target: ClockTarget): string {
  return target.isText ? target.node.nodeValue || '' : target.node.textContent || '';
}

function writeTarget(target: ClockTarget, value: string): void {
  if (target.isText) {
    if (target.node.nodeValue !== value) target.node.nodeValue = value;
  } else if (target.node.textContent !== value) {
    target.node.textContent = value;
  }
}

function writeRemainingAttribute(el: HTMLElement, value: string | null): void {
  if (!el.dataset) return;
  if (value) {
    if (el.dataset.ttRemaining !== value) el.dataset.ttRemaining = value;
  } else if ('ttRemaining' in el.dataset) {
    delete el.dataset.ttRemaining;
  }
}

function resolveRemainingAttrTarget(elapsedEl: HTMLElement): {
  target: HTMLElement;
  marker: HTMLElement | null;
  isMarker: boolean;
} {
  const marker = elapsedEl.querySelector?.<HTMLElement>('[idomkey="marker-title"]') ?? null;
  const hasMarkerText = Boolean(marker?.textContent?.trim());
  return hasMarkerText && marker
    ? { target: marker, marker, isMarker: true }
    : { target: elapsedEl, marker, isMarker: false };
}

let playerBarInfoInstalled = false;

/**
 * Installs remaining-time (`• -m:ss`) and metadata display on the Watch player bar, updating only while visible.
 */
export function installPlayerBarInfo(): () => void {
  if (playerBarInfoInstalled || typeof window === 'undefined' || typeof document === 'undefined') return NOOP;
  playerBarInfoInstalled = true;

  injectCss(`
      ytlr-progress-bar :is([idomkey="elapsedTime"], [idomkey="duration"]) {
        font-size: 1rem !important;
        line-height: 1.375 !important;
        font-weight: 500 !important;
        font-variant-numeric: tabular-nums !important;
        letter-spacing: normal !important;
        white-space: nowrap !important;
      }
      ytlr-progress-bar
        :is(
          [idomkey="elapsedTime"],
          [idomkey="position"],
          [idomkey="time"],
          [idomkey="current-time"],
          [idomkey="elapsed"]
        )[data-tt-remaining]::after {
        content: ' • ' attr(data-tt-remaining);
        color: rgb(170, 170, 170);
      }
      ytlr-progress-bar [idomkey="marker-title"][data-tt-remaining]::before {
        content: attr(data-tt-remaining) ' • ';
        color: rgb(170, 170, 170);
      }
    `);

  const unsub = onWatchSession((_videoId, signal) => {
    let cachedElapsed: ClockTarget | null = null;
    let cachedDuration: ClockTarget | null = null;
    let desiredElapsed: string | null = null;
    let desiredRemaining: string | null = null;
    let desiredDuration: string | null = null;
    let lastRenderedElapsedRaw: string | null = null;
    let lastRenderedDurKey: string | null = null;
    let boundVideo: HTMLVideoElement | null = null;
    let videoAbort: AbortController | null = null;
    let boundPlayer: YtPlayerElement | null = null;
    let lastAppliedSec = -1;
    let pendingApply = false;
    let pendingForceRender = false;

    onAbort(signal, () => {
      videoAbort?.abort();
      videoAbort = null;
      boundVideo = null;
      boundPlayer = null;
    });

    const getElapsedTarget = (bar: Element): ClockTarget | null => {
      if (cachedElapsed?.node.isConnected) return cachedElapsed;
      cachedElapsed = findElapsedTarget(bar);
      return cachedElapsed;
    };

    const getDurationTarget = (bar: Element): ClockTarget | null => {
      if (cachedDuration?.node.isConnected) return cachedDuration;
      cachedDuration = findDurationTarget(bar);
      return cachedDuration;
    };

    const bindVideo = (video: HTMLVideoElement): HTMLVideoElement => {
      if (video === boundVideo) return boundVideo;
      videoAbort?.abort();
      boundVideo = video;
      videoAbort = new AbortController();
      const vSignal = videoAbort.signal;
      for (const name of VIDEO_EVENTS) {
        video.addEventListener(name, scheduleRender, { signal: vSignal });
      }
      return boundVideo;
    };

    const resolveLiveVideo = (): HTMLVideoElement | null => {
      const current = document.querySelector<HTMLVideoElement>('video');
      if (current) return bindVideo(current);
      return boundVideo?.isConnected !== false ? boundVideo : null;
    };

    const resolvePlayer = (): YtPlayerElement | null => {
      const player = document.querySelector<YtPlayerElement>(PLAYER_SELECTOR);
      if (player && player !== boundPlayer) {
        boundPlayer = player;
        player.addEventListener?.('onPlaybackQualityChange', scheduleRender, { signal });
      }
      return player ?? boundPlayer;
    };

    const render = (bar: Element, video: HTMLVideoElement): boolean => {
      const elapsedTarget = getElapsedTarget(bar);
      if (video.duration === Number.POSITIVE_INFINITY) {
        desiredElapsed = null;
        desiredRemaining = null;
        desiredDuration = null;
        lastRenderedElapsedRaw = null;
        lastRenderedDurKey = null;
        if (elapsedTarget && !elapsedTarget.fallbackDur) {
          const { target, marker } = resolveRemainingAttrTarget(elapsedTarget.el);
          writeRemainingAttribute(elapsedTarget.el, null);
          writeRemainingAttribute(target, null);
          if (marker) writeRemainingAttribute(marker, null);
        }
        return false;
      }

      let updated = false;
      const durTarget = elapsedTarget?.fallbackDur ? null : getDurationTarget(bar);
      const durMatch = durTarget ? readTarget(durTarget).match(TRAILING_CLOCK_RE) : null;
      const durOverride = durMatch ? parseClockSeconds(durMatch[1]) : null;
      const effectiveDuration =
        Number.isFinite(video.duration) && video.duration > 0 ? video.duration : (durOverride ?? 0);

      if (elapsedTarget && effectiveDuration > 0) {
        const rawElapsedBefore = readTarget(elapsedTarget);
        if (elapsedTarget.fallbackDur) {
          const nextElapsed = formatRemainingLabel(
            rawElapsedBefore,
            effectiveDuration,
            video.currentTime,
            durOverride,
            true
          );
          if (nextElapsed !== null) {
            desiredElapsed = nextElapsed;
            lastRenderedElapsedRaw = nextElapsed;
            writeTarget(elapsedTarget, nextElapsed);
            updated = true;
          }
        } else {
          const nextRemaining = computeRemainingText(
            rawElapsedBefore,
            effectiveDuration,
            video.currentTime,
            durOverride,
            false
          );
          if (nextRemaining !== null) {
            desiredRemaining = nextRemaining;
            lastRenderedElapsedRaw = rawElapsedBefore;
            const { target, marker, isMarker } = resolveRemainingAttrTarget(elapsedTarget.el);
            if (isMarker) {
              writeRemainingAttribute(elapsedTarget.el, null);
            } else if (marker) {
              writeRemainingAttribute(marker, null);
            }
            writeRemainingAttribute(target, nextRemaining);
            updated = true;
          }
        }
      }

      if (durTarget) {
        const player = resolvePlayer();
        const qualityLabel = readActiveQualityLabel(player, video);
        const nextDuration = formatDurationLabel(readTarget(durTarget), video.playbackRate, qualityLabel);
        if (nextDuration !== null) {
          desiredDuration = nextDuration;
          lastRenderedDurKey = `${video.playbackRate}|${qualityLabel ?? ''}`;
          writeTarget(durTarget, nextDuration);
          updated = true;
        }
      }

      return updated;
    };

    function scheduleRender(e?: Event): void {
      if (signal.aborted) return;
      if (e?.type !== 'timeupdate') {
        pendingForceRender = true;
      }
      if (pendingApply) return;
      const bar = getBar();
      if (!bar || !isPlayerBarVisible(bar)) return;
      pendingApply = true;
      const flush = (): void => {
        const force = pendingForceRender;
        pendingApply = false;
        pendingForceRender = false;
        if (signal.aborted) return;
        const video = resolveLiveVideo();
        const liveBar = getBar();
        if (!video || !liveBar || !isPlayerBarVisible(liveBar)) return;
        const sec = Math.floor(video.currentTime);
        if (!force && sec === lastAppliedSec) return;
        if (render(liveBar, video)) {
          lastAppliedSec = sec;
        }
      };
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(flush);
      } else {
        scheduleAbortableTimeout(flush, 16, signal);
      }
    }

    const getBar = observePlayerBar(
      signal,
      (bar) => {
        if (!isPlayerBarVisible(bar)) return;
        const video = resolveLiveVideo();
        if (!video) return;
        const elapsedTarget = getElapsedTarget(bar);
        const durTarget = elapsedTarget?.fallbackDur ? null : getDurationTarget(bar);
        const rawElapsed = elapsedTarget ? readTarget(elapsedTarget) : null;
        const player = durTarget ? resolvePlayer() : null;
        const durKey = durTarget ? `${video.playbackRate}|${readActiveQualityLabel(player, video) ?? ''}` : null;
        const elapsedReady =
          !elapsedTarget ||
          (rawElapsed === lastRenderedElapsedRaw &&
            (elapsedTarget.fallbackDur
              ? desiredElapsed !== null && rawElapsed === desiredElapsed
              : desiredRemaining !== null &&
                resolveRemainingAttrTarget(elapsedTarget.el).target.dataset?.ttRemaining === desiredRemaining));
        const durReady =
          !durTarget ||
          (!pendingForceRender &&
            durKey === lastRenderedDurKey &&
            desiredDuration !== null &&
            readTarget(durTarget) === desiredDuration);
        if (elapsedReady && durReady) return;
        if (render(bar, video)) {
          pendingForceRender = false;
          lastAppliedSec = Math.floor(video.currentTime);
        }
      },
      {
        characterData: true,
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['hybridnavfocusable', 'class'],
      }
    );

    onVideo((video) => {
      bindVideo(video);
      scheduleRender();
    }, signal);
  });

  return () => {
    unsub();
    playerBarInfoInstalled = false;
  };
}
