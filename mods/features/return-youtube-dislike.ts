import { observeDom, onWatchSession } from '../core/lifecycle.ts';
import { onVideo } from '../core/player-observer.ts';
import { injectCss } from '../core/styles.ts';
import { formatCompactCount } from '../utils/feed-helpers.ts';

const DISLIKE_BUTTON_SELECTOR =
  'ytlr-watch-default yt-button-container[idomkey="dislike-button"], ytlr-watch-default [idomkey="dislike-button"]';

let stylesInstalled = false;
let rydInstalled = false;

function installDislikeStyles(): void {
  if (stylesInstalled || typeof document === 'undefined') return;
  stylesInstalled = true;
  injectCss(`
      ytlr-watch-default [idomkey="dislike-button"] {
        pointer-events: none !important;
      }
      ytlr-watch-default [idomkey="dislike-button"][data-tt-count] {
        position: relative !important;
        overflow: visible !important;
      }
      ytlr-watch-default [idomkey="dislike-button"][data-tt-count]::after {
        content: attr(data-tt-count);
        position: absolute;
        top: 100%;
        left: 50%;
        transform: translateX(-50%);
        margin-top: 0.5rem;
        font-family: inherit;
        font-size: 1rem;
        font-weight: 500;
        font-variant-numeric: tabular-nums;
        line-height: 1.375;
        letter-spacing: normal;
        color: #f1f1f1;
        white-space: nowrap;
        pointer-events: none;
      }
    `);
}

export async function fetchDislikeCount(videoId: string, signal?: AbortSignal): Promise<string | null> {
  if (!videoId || signal?.aborted || typeof fetch !== 'function') return null;
  try {
    const resp = await fetch(`https://returnyoutubedislikeapi.com/Votes?videoId=${encodeURIComponent(videoId)}`, {
      signal,
    });
    if (!resp.ok || signal?.aborted) return null;
    const data = (await resp.json()) as { dislikes?: unknown } | null;
    return typeof data?.dislikes === 'number' ? formatCompactCount(data.dislikes) : null;
  } catch {
    return null;
  }
}

function applyDislikeLabel(count: string): void {
  const el = document.querySelector<HTMLElement>(DISLIKE_BUTTON_SELECTOR);
  if (!el) return;

  // Keep dislike strictly a display-only label so D-pad focus skips it with no competing tooltip.
  el.inert = true;
  if (el.getAttribute?.('hybridnavfocusable') !== 'false') {
    el.setAttribute?.('hybridnavfocusable', 'false');
  }
  if (el.getAttribute?.('tabindex') !== '-1') {
    el.setAttribute?.('tabindex', '-1');
  }
  for (const child of el.querySelectorAll?.('[hybridnavfocusable]:not([hybridnavfocusable="false"])') ?? []) {
    child.setAttribute?.('hybridnavfocusable', 'false');
  }
  if (el.dataset.ttCount !== count) el.dataset.ttCount = count;
}

/**
 * Fetches and renders the dislike count on the Watch dislike button as a non-interactive label.
 */
export function installReturnYouTubeDislike(): void {
  if (rydInstalled || typeof window === 'undefined' || typeof document === 'undefined') return;
  rydInstalled = true;
  installDislikeStyles();

  onWatchSession((videoId, signal) => {
    void fetchDislikeCount(videoId, signal).then((count) => {
      if (!count || signal.aborted) return;
      onVideo(() => {
        if (signal.aborted) return;
        applyDislikeLabel(count);
        const watchHost = document.querySelector('ytlr-watch-default');
        if (watchHost) {
          observeDom(
            watchHost,
            () => applyDislikeLabel(count),
            { childList: true, subtree: true, attributes: true, attributeFilter: ['hybridnavfocusable'] },
            signal
          );
        }
      });
    });
  });
}
