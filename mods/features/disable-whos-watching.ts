import { configRead, onConfigChange, whenConfigReady } from '../core/config.ts';
import { onAbort, scheduleAbortableTimeout } from '../core/lifecycle.ts';
import { isRecord } from '../utils/type-guards.ts';

const RECURRING_ACTIONS_KEY = 'yt.leanback.default::recurring_actions';
const SYNC_MODE_CACHE_KEY = 'tt.whosWatchingMode';
const ACTION_KEYS = [
  'startup-screen-account-selector-with-guest',
  'whos_watching_fullscreen_zero_accounts',
  'startup-screen-signed-out-welcome-back',
] as const;
const COOLDOWN_MS = 2 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const PERMANENT_REFRESH_MS = 60 * 1000;

let refreshAbort: AbortController | null = null;
let whosWatchingInstalled = false;

function stopPermanentRefresh(): void {
  refreshAbort?.abort();
  refreshAbort = null;
}

function getStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function readCachedMode(): { enabled: boolean; permanent: boolean } {
  const storage = getStorage();
  try {
    const raw = storage?.getItem(SYNC_MODE_CACHE_KEY);
    if (raw === 'permanent') return { enabled: true, permanent: true };
    if (raw === 'enabled') return { enabled: true, permanent: false };
  } catch {
    // Ignore storage read errors.
  }
  return { enabled: false, permanent: false };
}

function writeCachedMode(enabled: boolean, permanent: boolean): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(SYNC_MODE_CACHE_KEY, !enabled ? 'disabled' : permanent ? 'permanent' : 'enabled');
  } catch {
    // Ignore storage quota / security errors.
  }
}

function collectTargetActionKeys(innerData: Record<string, unknown>, createMissing: boolean): string[] {
  const keys = new Set<string>(createMissing ? ACTION_KEYS : []);
  for (const key of Object.keys(innerData)) {
    if (
      (ACTION_KEYS as readonly string[]).includes(key) ||
      key.startsWith('startup-screen-') ||
      key.startsWith('whos_watching')
    ) {
      if (createMissing || isRecord(innerData[key])) {
        keys.add(key);
      }
    }
  }
  return [...keys];
}

export function applyWhosWatchingPolicy(enabled: boolean, permanent: boolean): void {
  stopPermanentRefresh();
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
    if (enabled) return;
    recurringActions = { data: { data: {} }, creation: now };
  }

  let outerData = isRecord(recurringActions.data) ? recurringActions.data : undefined;
  if (!outerData) {
    if (enabled) return;
    outerData = { data: {} };
    recurringActions.data = outerData;
  }

  let innerData = isRecord(outerData.data) ? outerData.data : undefined;
  if (!innerData) {
    if (enabled) return;
    innerData = {};
    outerData.data = innerData;
  }

  const targetKeys = collectTargetActionKeys(innerData, !enabled);
  if (targetKeys.length === 0) return;

  const stamp = (ts: number): void => {
    for (const key of targetKeys) {
      const entry = innerData[key];
      if (isRecord(entry)) {
        entry.lastFired = ts;
      } else {
        innerData[key] = { lastFired: ts };
      }
    }
    try {
      storage.setItem(RECURRING_ACTIONS_KEY, JSON.stringify(recurringActions));
    } catch {
      // Ignore storage quota / security errors.
    }
  };

  if (!enabled) {
    // Push recurring timestamps 7 days ahead before YouTube scripts boot and read localStorage.
    stamp(now + SEVEN_DAYS_MS);
    return;
  }

  const firstEntry = innerData[targetKeys[0] ?? ''];
  const firstLastFired = isRecord(firstEntry) && typeof firstEntry.lastFired === 'number' ? firstEntry.lastFired : 0;
  if (!permanent && now - firstLastFired > 0 && now - firstLastFired < COOLDOWN_MS) {
    return;
  }

  if (permanent) {
    stamp(Date.now() - SEVEN_DAYS_MS);
    const abort = new AbortController();
    refreshAbort = abort;
    const scheduleTick = (): void => {
      scheduleAbortableTimeout(
        () => {
          if (abort.signal.aborted) return;
          stamp(Date.now() - SEVEN_DAYS_MS);
          scheduleTick();
        },
        PERMANENT_REFRESH_MS,
        abort.signal
      );
    };
    onAbort(abort.signal, () => {
      if (refreshAbort === abort) refreshAbort = null;
    });
    scheduleTick();
  } else {
    stamp(now);
  }
}

function syncFromConfig(): void {
  const enabled = Boolean(configRead('enableWhoIsWatchingMenu'));
  const permanent = Boolean(configRead('permanentlyEnableWhoIsWatchingMenu'));
  writeCachedMode(enabled, permanent);
  applyWhosWatchingPolicy(enabled, permanent);
}

/**
 * Installs "Who's watching?" startup suppression synchronously before YouTube reads `localStorage`,
 * then reconciles once IndexedDB config finishes loading and on live setting changes.
 */
export function installDisableWhosWatching(): void {
  if (whosWatchingInstalled || typeof window === 'undefined') return;
  whosWatchingInstalled = true;

  const cached = readCachedMode();
  applyWhosWatchingPolicy(cached.enabled, cached.permanent);

  onConfigChange(['enableWhoIsWatchingMenu', 'permanentlyEnableWhoIsWatchingMenu'], syncFromConfig);
  void whenConfigReady().then(syncFromConfig);
}
