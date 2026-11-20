import { configChangeEmitter, configRead, whenConfigReady } from '../core/config.ts';
import { get, set } from '../core/indexed-db.ts';
import { isRecord } from '../utils/type-guards.ts';

const RECURRING_ACTIONS_KEY = 'yt.leanback.default::recurring_actions';
let interval: ReturnType<typeof setInterval> | null = null;

async function handleWhosWatching(enabled: boolean): Promise<void> {
  const raw = await get<string>(RECURRING_ACTIONS_KEY);
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
    innerData['startup-screen-signed-out-welcome-back']
  ].filter(isRecord);

  const applyTimestamp = async (ts: number): Promise<void> => {
    for (const selector of selectors) {
      selector.lastFired = ts;
    }
    await set(RECURRING_ACTIONS_KEY, JSON.stringify(recurringActions));
  };

  if (interval !== null) {
    clearInterval(interval);
    interval = null;
  }

  if (!enabled) {
    // If disabled, set to future
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 7);
    await applyTimestamp(futureDate.getTime());
  } else {
    // If enabled, apply now
    const now = Date.now();
    await applyTimestamp(now);
    if (configRead('permanentlyEnableWhoIsWatchingMenu')) {
      interval = setInterval(() => applyTimestamp(Date.now()), 60 * 1000);
    }
  }
}

if (typeof window !== 'undefined') {
  configChangeEmitter.addEventListener('configChange', (event) => {
    const { key, value } = event.detail;
    if (key === 'enableWhoIsWatchingMenu') {
      handleWhosWatching(Boolean(value));
    }
  });

  void whenConfigReady().then(() => {
    void handleWhosWatching(configRead('enableWhoIsWatchingMenu'));
  });
}
