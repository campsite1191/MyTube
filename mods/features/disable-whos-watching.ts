import { isRecord } from '../utils/type-guards.ts';

const RECURRING_ACTIONS_KEY = 'yt.leanback.default::recurring_actions';
const ACTION_KEYS = [
  'startup-screen-account-selector-with-guest',
  'whos_watching_fullscreen_zero_accounts',
  'startup-screen-signed-out-welcome-back',
] as const;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

let whosWatchingInstalled = false;

function getStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function collectTargetActionKeys(innerData: Record<string, unknown>): string[] {
  const keys = new Set<string>(ACTION_KEYS);
  for (const key of Object.keys(innerData)) {
    if (key.startsWith('startup-screen-') || key.startsWith('whos_watching')) {
      keys.add(key);
    }
  }
  return [...keys];
}

export function suppressWhosWatching(): void {
  const storage = getStorage();
  if (!storage) return;

  let recurringActions: Record<string, unknown> | null = null;
  try {
    const raw = storage.getItem(RECURRING_ACTIONS_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed)) recurringActions = parsed;
    }
  } catch {
    return;
  }

  const now = Date.now();
  if (!recurringActions) {
    recurringActions = { data: { data: {} }, creation: now };
  }

  let outerData = isRecord(recurringActions.data) ? recurringActions.data : undefined;
  if (!outerData) {
    outerData = { data: {} };
    recurringActions.data = outerData;
  }

  let innerData = isRecord(outerData.data) ? outerData.data : undefined;
  if (!innerData) {
    innerData = {};
    outerData.data = innerData;
  }

  // Push recurring timestamps 7 days ahead before YouTube scripts boot and read localStorage.
  const targetTimestamp = now + SEVEN_DAYS_MS;
  for (const key of collectTargetActionKeys(innerData)) {
    const entry = innerData[key];
    if (isRecord(entry)) {
      entry.lastFired = targetTimestamp;
    } else {
      innerData[key] = { lastFired: targetTimestamp };
    }
  }

  try {
    storage.setItem(RECURRING_ACTIONS_KEY, JSON.stringify(recurringActions));
  } catch {
    // Ignore storage quota / security errors.
  }
}

/**
 * Installs "Who's watching?" startup suppression synchronously before YouTube reads `localStorage`.
 */
export function installDisableWhosWatching(): void {
  if (whosWatchingInstalled || typeof window === 'undefined') return;
  whosWatchingInstalled = true;
  suppressWhosWatching();
}
