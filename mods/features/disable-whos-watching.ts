import { configChangeEmitter, configRead, whenConfigReady } from '../core/config.ts';
import { whenYttvReady } from '../core/yttv-bridge.ts';
import { isRecord } from '../utils/type-guards.ts';

const RECURRING_ACTIONS_KEY = 'yt.leanback.default::recurring_actions';
let interval: ReturnType<typeof setInterval> | null = null;

function handleWhosWatching(enabled: boolean): void {
  let raw: string | null = null;
  try {
    raw = typeof localStorage !== 'undefined' ? localStorage.getItem(RECURRING_ACTIONS_KEY) : null;
  } catch {
    return;
  }
  if (!raw) return;

  let recurringActions: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return;
    recurringActions = parsed;
  } catch {
    return;
  }

  const outerData = isRecord(recurringActions.data) ? recurringActions.data : undefined;
  const innerData = isRecord(outerData?.data) ? outerData.data : undefined;
  if (!innerData) return;

  const selectors = [
    innerData['startup-screen-account-selector-with-guest'],
    innerData.whos_watching_fullscreen_zero_accounts,
    innerData['startup-screen-signed-out-welcome-back'],
  ].filter(isRecord);
  if (selectors.length === 0) return;

  const applyTimestamp = (ts: number): void => {
    for (const selector of selectors) {
      selector.lastFired = ts;
    }
    try {
      localStorage.setItem(RECURRING_ACTIONS_KEY, JSON.stringify(recurringActions));
    } catch {
      // Ignore storage quota / security errors.
    }
  };

  if (interval !== null) {
    clearInterval(interval);
    interval = null;
  }

  if (!enabled) {
    // Push recurring timestamps 7 days ahead so YouTube skips the "Who's watching?" prompt.
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 7);
    applyTimestamp(futureDate.getTime());
    return;
  }

  const now = Date.now();
  const shouldPermanent = Boolean(configRead('permanentlyEnableWhoIsWatchingMenu'));
  const firstLastFired = typeof selectors[0]?.lastFired === 'number' ? selectors[0].lastFired : 0;
  if (!shouldPermanent && now - firstLastFired > 0 && now - firstLastFired < 2 * 60 * 60 * 1000) {
    return;
  }

  if (shouldPermanent) {
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 7);
    applyTimestamp(pastDate.getTime());
    interval = setInterval(() => {
      const tickPast = new Date();
      tickPast.setDate(tickPast.getDate() - 7);
      applyTimestamp(tickPast.getTime());
    }, 60 * 1000);
  } else {
    applyTimestamp(now);
  }
}

if (typeof window !== 'undefined') {
  configChangeEmitter.addEventListener('configChange', (event) => {
    const key = event.detail?.key;
    if (key === 'enableWhoIsWatchingMenu' || key === 'permanentlyEnableWhoIsWatchingMenu') {
      handleWhosWatching(Boolean(configRead('enableWhoIsWatchingMenu')));
    }
  });

  whenYttvReady(() => {
    void whenConfigReady().then(() => {
      handleWhosWatching(Boolean(configRead('enableWhoIsWatchingMenu')));
    });
  });
}
