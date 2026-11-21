import { isPlayerBarVisible, observePlayerBar, onWatchSession } from '../core/lifecycle.ts';
import { onVideo } from '../core/player-observer.ts';
import { injectCss } from '../core/styles.ts';

const TIME_LABEL_SELECTOR = '[idomkey="time-label"]';
const ELAPSED_SELECTOR = '[idomkey="elapsedTime"]';
const OURS = /\s*\(-\d+:\d{2}(?::\d{2})?\)/g;
const CLOCK_RE = /\d+:\d{2}(?::\d{2})?/;
const CLOCK_SPLIT_RE = /^(.*?\d+:\d{2}(?::\d{2})?)([\s\S]*)$/;
const VIDEO_EVENTS = ['timeupdate', 'durationchange', 'seeking', 'seeked', 'ratechange'] as const;

interface ElapsedTarget {
  node: Node;
  isText: boolean;
  el: Element;
  fallbackDur: boolean;
}

/**
 * Parses a clock string (`m:ss` or `h:mm:ss`) into total seconds.
 */
export function parseClockSeconds(str: string | null | undefined): number | null {
  const m = String(str || '').match(/(\d+):(\d{2})(?::(\d{2}))?/);
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (m[3] !== undefined) return a * 3600 + b * 60 + Number(m[3]);
  return a * 60 + b;
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
 * Formats an elapsed/duration label by appending `(-remaining)`.
 */
export function formatRemainingLabel(
  rawText: string,
  durationSec: number,
  currentTimeSec: number,
  durationOverrideSec: number | null,
  fallbackDur: boolean
): string | null {
  if (!durationSec || !Number.isFinite(durationSec)) return null;
  const clean = rawText.replace(OURS, '');
  const m = clean.match(CLOCK_SPLIT_RE);
  if (!m || m[1] === undefined) return null;
  const elapsedSec = fallbackDur ? null : parseClockSeconds(m[1]);
  const effectiveDuration = durationOverrideSec ?? Math.floor(durationSec);
  const secondsLeft =
    elapsedSec !== null
      ? Math.max(0, effectiveDuration - elapsedSec)
      : Math.max(0, effectiveDuration - Math.floor(currentTimeSec));
  const rem = `(-${formatClockTime(secondsLeft)})`;
  const suffix = m[2];
  if (suffix && /\S/.test(suffix)) {
    return `${m[1]} ${rem}${/^\s/.test(suffix) ? '' : ' '}${suffix}`;
  }
  return `${m[1].trim()} ${rem}`;
}

function findClockTextNode(node: Node | null | undefined): Text | null {
  if (!node) return null;
  if (node.nodeType === 3) {
    return CLOCK_RE.test(node.nodeValue || '') ? (node as Text) : null;
  }
  const children = node.childNodes;
  if (!children) return null;
  for (let i = 0; i < children.length; i++) {
    const hit = findClockTextNode(children[i]);
    if (hit) return hit;
  }
  return null;
}

function toElapsedTarget(el: Element, fallbackDur = false): ElapsedTarget {
  const textNode = findClockTextNode(el);
  if (textNode) return { node: textNode, isText: true, el, fallbackDur };
  return { node: el, isText: false, el, fallbackDur };
}

function findElapsedTarget(bar: Element): ElapsedTarget | null {
  const directs = bar.querySelectorAll(ELAPSED_SELECTOR);
  for (let i = 0; i < directs.length; i++) {
    const direct = directs[i];
    if (!direct || direct.closest?.('ytlr-storyboard')) continue;
    if (CLOCK_RE.test(direct.textContent || '')) return toElapsedTarget(direct);
  }
  const labels = bar.querySelectorAll(TIME_LABEL_SELECTOR);
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (!label || label.closest?.('ytlr-storyboard')) continue;
    const span = label.querySelector(
      '[idomkey="elapsedTime"], [idomkey="position"], [idomkey="time"], [idomkey="current-time"], [idomkey="elapsed"]'
    );
    if (span && CLOCK_RE.test(span.textContent || '')) return toElapsedTarget(span);
    const dur = label.querySelector('[idomkey="duration"]');
    if (dur && CLOCK_RE.test(dur.textContent || '')) return toElapsedTarget(dur, true);
    if (CLOCK_RE.test(label.textContent || '')) return toElapsedTarget(label);
  }
  return null;
}

function readTarget(target: ElapsedTarget): string {
  return target.isText ? target.node.nodeValue || '' : target.node.textContent || '';
}

function writeTarget(target: ElapsedTarget, value: string): void {
  if (target.isText) {
    if (target.node.nodeValue !== value) target.node.nodeValue = value;
  } else if (target.node.textContent !== value) {
    target.node.textContent = value;
  }
}

let remainingTimeInstalled = false;

/**
 * Installs remaining-time display on the Watch player bar, updating only while visible.
 */
export function installRemainingTime(): void {
  if (remainingTimeInstalled || typeof window === 'undefined' || typeof document === 'undefined') return;
  remainingTimeInstalled = true;

  injectCss(`
      ytlr-progress-bar [idomkey="elapsedTime"],
      ytlr-progress-bar [idomkey="duration"] {
        font-size: 1rem !important;
        line-height: 1.375 !important;
        font-weight: 500 !important;
        letter-spacing: normal !important;
      }
    `);

  onWatchSession((_videoId, signal) => {
    onVideo((video) => {
      if (signal.aborted) return;

      let cachedTarget: ElapsedTarget | null = null;
      let desiredText: string | null = null;
      let lastAppliedSec = -1;
      let pendingApply = false;

      const getTarget = (bar: Element): ElapsedTarget | null => {
        if (cachedTarget?.node.isConnected) return cachedTarget;
        cachedTarget = findElapsedTarget(bar);
        return cachedTarget;
      };

      const render = (bar: Element): void => {
        if (signal.aborted || !isPlayerBarVisible(bar) || !Number.isFinite(video.duration) || video.duration <= 0) {
          if (video.duration === Number.POSITIVE_INFINITY) desiredText = null;
          return;
        }
        const target = getTarget(bar);
        if (!target) return;
        const durEl =
          target.el.parentElement?.querySelector('[idomkey="duration"]') ||
          target.el.closest?.('[idomkey="time-label"]')?.querySelector('[idomkey="duration"]');
        const durOverride = parseClockSeconds(durEl?.textContent);
        const next = formatRemainingLabel(
          readTarget(target),
          video.duration,
          video.currentTime,
          durOverride,
          target.fallbackDur
        );
        if (next === null) return;
        desiredText = next;
        writeTarget(target, next);
      };

      const getBar = observePlayerBar(
        signal,
        (bar) => {
          if (!isPlayerBarVisible(bar)) return;
          const target = getTarget(bar);
          if (!target) return;
          if (desiredText !== null && readTarget(target) === desiredText) return;
          render(bar);
        },
        {
          characterData: true,
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['hybridnavfocusable'],
        }
      );

      const scheduleRender = (e?: Event): void => {
        if (pendingApply || signal.aborted) return;
        const bar = getBar();
        if (!bar || !isPlayerBarVisible(bar)) return;
        pendingApply = true;
        requestAnimationFrame(() => {
          pendingApply = false;
          if (signal.aborted) return;
          const liveBar = getBar();
          if (!liveBar || !isPlayerBarVisible(liveBar)) return;
          const sec = Math.floor(video.currentTime);
          if (e?.type === 'timeupdate' && sec === lastAppliedSec) return;
          lastAppliedSec = sec;
          render(liveBar);
        });
      };

      for (const name of VIDEO_EVENTS) video.addEventListener(name, scheduleRender, { signal });
      scheduleRender();
    });
  });
}
