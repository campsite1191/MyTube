const TIME_LABEL_SELECTOR = 'ytlr-progress-bar [idomkey="time-label"]';
const ELAPSED_SELECTOR = 'ytlr-progress-bar [idomkey="elapsedTime"]';
const GUARD_SELECTOR = 'ytlr-progress-bar';
const ATTACH_RETRY_MS = 100;
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
    elapsedSec !== null ? Math.max(0, effectiveDuration - elapsedSec) : Math.max(0, effectiveDuration - Math.floor(currentTimeSec));
  const rem = `(-${formatClockTime(secondsLeft)})`;
  const suffix = m[2];
  if (suffix && /\S/.test(suffix)) {
    return `${m[1]} ${rem}${/^\s/.test(suffix) ? '' : ' '}${suffix}`;
  }
  return `${m[1].trim()} ${rem}`;
}

let video: HTMLVideoElement | null = null;
let desiredText: string | null = null;
let lastAppliedSec = -1;
let attachRetryTimeout: ReturnType<typeof setTimeout> | null = null;
let guardObserver: MutationObserver | null = null;
let observedContainer: Element | null = null;

function pickVideo(): HTMLVideoElement | null {
  let fallback: HTMLVideoElement | null = null;
  try {
    const all = document.querySelectorAll('video');
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (!el) continue;
      const usable = Number.isFinite(el.duration) && el.duration > 0;
      if (usable && !el.paused && el.readyState > 0) return el;
      if (usable && !fallback) fallback = el;
      if (!fallback) fallback = el;
    }
  } catch {
    // Ignore DOM query errors while player mounts.
  }
  if (fallback) return fallback;
  try {
    return document.querySelector('video');
  } catch {
    return null;
  }
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

let cachedTarget: ElapsedTarget | null = null;

function getElapsedTarget(): ElapsedTarget | null {
  if (cachedTarget && cachedTarget.node.isConnected) return cachedTarget;
  cachedTarget = findElapsedTarget();
  return cachedTarget;
}

function findElapsedTarget(): ElapsedTarget | null {
  const directs = document.querySelectorAll(ELAPSED_SELECTOR);
  for (let i = 0; i < directs.length; i++) {
    const direct = directs[i];
    if (!direct || direct.closest('ytlr-storyboard')) continue;
    if (CLOCK_RE.test(direct.textContent || '')) return toElapsedTarget(direct);
  }
  const labels = document.querySelectorAll(TIME_LABEL_SELECTOR);
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (!label || label.closest('ytlr-storyboard')) continue;
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

function computeDesiredText(target: ElapsedTarget): string | null {
  if (!video || !video.duration || !Number.isFinite(video.duration)) return null;
  const durEl =
    target.el.parentElement?.querySelector('[idomkey="duration"]') ||
    target.el.closest('[idomkey="time-label"]')?.querySelector('[idomkey="duration"]');
  const durOverride = parseClockSeconds(durEl?.textContent);
  return formatRemainingLabel(readTarget(target), video.duration, video.currentTime, durOverride, target.fallbackDur);
}

function listen(el: HTMLVideoElement | null): void {
  if (!el) return;
  for (const name of VIDEO_EVENTS) el.addEventListener(name, apply);
}

function unlisten(el: HTMLVideoElement | null): void {
  if (!el) return;
  for (const name of VIDEO_EVENTS) el.removeEventListener(name, apply);
}

function liveVideo(): HTMLVideoElement | null {
  if (video && video.isConnected && Number.isFinite(video.duration) && video.duration > 0 && !video.paused && video.readyState > 0) {
    return video;
  }
  const found = pickVideo();
  if (found && found !== video) {
    unlisten(video);
    video = found;
    listen(video);
    desiredText = null;
    lastAppliedSec = -1;
  }
  return video;
}

let pendingApply = false;
function apply(e?: Event): void {
  if (pendingApply) return;
  pendingApply = true;
  requestAnimationFrame(() => {
    pendingApply = false;
    if (!liveVideo() || !video) return;
    if (!observedContainer || !observedContainer.isConnected) {
      attach();
      return;
    }
    const sec = Math.floor(video.currentTime);
    if (e?.type === 'timeupdate' && sec === lastAppliedSec) return;
    lastAppliedSec = sec;
    const target = getElapsedTarget();
    if (!target) return;
    const next = computeDesiredText(target);
    if (next === null) return;
    desiredText = next;
    writeTarget(target, desiredText);
  });
}

function detach(): void {
  if (attachRetryTimeout !== null) {
    clearTimeout(attachRetryTimeout);
    attachRetryTimeout = null;
  }
  if (guardObserver) {
    guardObserver.disconnect();
    guardObserver = null;
  }
  observedContainer = null;
  desiredText = null;
  lastAppliedSec = -1;
  unlisten(video);
  video = null;
}

function attach(): void {
  detach();
  if (!location.hash.includes('watch') && !location.hash.includes('v=')) return;
  video = pickVideo();
  const container = document.querySelector(GUARD_SELECTOR);

  if (!video || !container || !getElapsedTarget()) {
    video = null;
    attachRetryTimeout = setTimeout(attach, ATTACH_RETRY_MS);
    return;
  }

  observedContainer = container;
  desiredText = null;
  listen(video);

  guardObserver = new MutationObserver(() => {
    const target = getElapsedTarget();
    if (!target) return;
    if (desiredText !== null && readTarget(target) === desiredText) return;
    liveVideo();
    const next = computeDesiredText(target);
    if (next !== null) {
      desiredText = next;
      writeTarget(target, desiredText);
      return;
    }
    if (video && video.duration === Infinity) {
      desiredText = null;
      return;
    }
    if (desiredText !== null) writeTarget(target, desiredText);
  });
  guardObserver.observe(container, { characterData: true, childList: true, subtree: true });

  apply();
}

let remainingTimeInstalled = false;

export function installRemainingTime(): void {
  if (remainingTimeInstalled || typeof window === 'undefined' || typeof document === 'undefined') return;
  remainingTimeInstalled = true;

  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
      ytlr-progress-bar [idomkey="elapsedTime"],
      ytlr-progress-bar [idomkey="duration"] {
        font-size: 1rem !important;
        line-height: 1.375 !important;
        font-weight: 500 !important;
        letter-spacing: normal !important;
      }
    `);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  } catch {
    // Ignore environments without constructable stylesheets.
  }

  window.addEventListener('hashchange', attach, false);
  attach();
}
