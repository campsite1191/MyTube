import type {
  CurrentIdentityService,
  KabukiInnerTubeClient,
  YttvCommandExecutor,
  YttvResolveCommandHost,
} from '../types/yttv.ts';
import { isRecord } from '../utils/type-guards.ts';

function getYttvServicesMap(): Map<string, unknown> | null {
  const yttv = typeof window !== 'undefined' ? window._yttv : undefined;
  if (!yttv) return null;
  for (const entry of Object.values(yttv)) {
    if (isRecord(entry) && entry.mappings instanceof Map) {
      return entry.mappings as Map<string, unknown>;
    }
  }
  return null;
}

export function getKabukiInnerTubeClient(): KabukiInnerTubeClient | null {
  const client = getYttvServicesMap()?.get('KabukiInnerTubeClient');
  if (isRecord(client) && typeof client.fetch === 'function') {
    return client as unknown as KabukiInnerTubeClient;
  }
  return null;
}

export function getCurrentIdentityService(): CurrentIdentityService | null {
  const service = getYttvServicesMap()?.get('CurrentIdentityService');
  if (isRecord(service) && typeof service.get === 'function') {
    return service as unknown as CurrentIdentityService;
  }
  return null;
}

export function findResolveCommandHost(): YttvResolveCommandHost | null {
  const yttv = typeof window !== 'undefined' ? window._yttv : undefined;
  if (!yttv) return null;
  for (const entry of Object.values(yttv)) {
    if (isRecord(entry) && isRecord(entry.instance) && typeof entry.instance.resolveCommand === 'function') {
      return entry as unknown as YttvResolveCommandHost;
    }
  }
  return null;
}

const yttvReadyCallbacks = new Set<() => void>();
let yttvWatcherActive = false;

function isYttvPopulated(): boolean {
  return Boolean(findResolveCommandHost());
}

/**
 * Invokes `callback` once `window._yttv` and its command host finish initializing.
 */
export function whenYttvReady(callback: () => void): void {
  if (isYttvPopulated()) {
    callback();
    return;
  }
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  yttvReadyCallbacks.add(callback);
  if (yttvWatcherActive) return;
  yttvWatcherActive = true;

  let attempts = 0;
  const maxAttempts = 150;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let observer: MutationObserver | null = null;

  const cleanup = (): void => {
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    observer?.disconnect();
    observer = null;
    window.removeEventListener('load', check);
    document.removeEventListener('DOMContentLoaded', check);
  };

  const flush = (): void => {
    cleanup();
    yttvWatcherActive = false;
    const callbacks = [...yttvReadyCallbacks];
    yttvReadyCallbacks.clear();
    for (const cb of callbacks) {
      try {
        cb();
      } catch (err) {
        console.error('[YttvBridge] Ready callback failed:', err);
      }
    }
  };

  const check = (): void => {
    if (isYttvPopulated()) {
      flush();
      return;
    }
    attempts++;
    if (attempts >= maxAttempts) {
      if (window._yttv && Object.keys(window._yttv).length > 0) {
        flush();
      } else {
        cleanup();
        yttvWatcherActive = false;
        yttvReadyCallbacks.clear();
      }
      return;
    }
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = setTimeout(check, 200);
  };

  if (typeof MutationObserver !== 'undefined') {
    const target = document.documentElement ?? document;
    observer = new MutationObserver(() => {
      if (isYttvPopulated()) flush();
    });
    observer.observe(target, { childList: true, subtree: true });
  }
  window.addEventListener('load', check, { once: true });
  document.addEventListener('DOMContentLoaded', check, { once: true });
  pollTimer = setTimeout(check, 50);
}

export function getCommandExecutor(): YttvCommandExecutor | null {
  const yttv = typeof window !== 'undefined' ? window._yttv : undefined;
  if (!yttv) return null;

  let instance: Record<string, unknown> | null = null;
  let executeFunction: ((command: unknown) => unknown) | null = null;

  for (const entry of Object.values(yttv)) {
    if (!isRecord(entry) || typeof entry.getInstance !== 'function') continue;
    const rawEntry = entry as { getInstance: () => unknown; toString?: () => string };
    let candidateInstance: unknown;
    try {
      candidateInstance = rawEntry.getInstance();
    } catch {
      continue;
    }
    if (String(rawEntry).includes('ytlrActionRouter')) {
      if (isRecord(candidateInstance)) instance = candidateInstance;
      continue;
    }

    if (!isRecord(candidateInstance)) continue;
    const proto = Object.getPrototypeOf(candidateInstance);
    if (!isRecord(proto)) continue;
    for (const propName of Object.getOwnPropertyNames(proto)) {
      const member = candidateInstance[propName];
      if (typeof member === 'function' && member.toString().includes('ytlrActionRouter')) {
        executeFunction = member as (command: unknown) => unknown;
        instance = candidateInstance;
      }
    }
  }

  if (!instance) return null;

  if (!executeFunction) {
    const proto = Object.getPrototypeOf(instance);
    if (isRecord(proto)) {
      for (const propName of Object.getOwnPropertyNames(proto)) {
        const member = instance[propName];
        if (typeof member === 'function' && member.toString().includes('ytlrActionRouter')) {
          executeFunction = member as (command: unknown) => unknown;
        }
      }
    }
  }

  if (!executeFunction) return null;

  let commandFunction: (new (actionName: string) => unknown) | undefined;
  for (const entry of Object.values(yttv)) {
    if (typeof entry === 'function' && entry.toString().includes('this.actionName')) {
      commandFunction = entry as new (actionName: string) => unknown;
    }
  }

  return {
    executeFunction: executeFunction.bind(instance),
    commandFunction,
  };
}

export function showToast(title: string, subtitle: string): boolean {
  const host = findResolveCommandHost();
  if (!host) return false;
  host.instance.resolveCommand({
    openPopupAction: {
      popupType: 'TOAST',
      popup: {
        overlayToastRenderer: {
          title: { simpleText: title },
          subtitle: { simpleText: subtitle },
        },
      },
    },
  });
  return true;
}
