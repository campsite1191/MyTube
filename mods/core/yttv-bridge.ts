import type {
  CurrentIdentityService,
  KabukiInnerTubeClient,
  YttvCommandExecutor,
  YttvResolveCommandHost,
} from '../types/yttv.ts';
import { isObjectLike, isRecord } from '../utils/type-guards.ts';
import { observeDom, onAbort, scheduleAbortableTimeout } from './lifecycle.ts';

function getYttvServicesMap(): Map<string, unknown> | null {
  const yttv = typeof window !== 'undefined' ? window._yttv : undefined;
  if (!yttv) return null;
  for (const entry of Object.values(yttv)) {
    if (isObjectLike(entry) && entry.mappings instanceof Map) {
      return entry.mappings as Map<string, unknown>;
    }
  }
  return null;
}

export function getKabukiInnerTubeClient(): KabukiInnerTubeClient | null {
  const client = getYttvServicesMap()?.get('KabukiInnerTubeClient');
  if (isObjectLike(client) && typeof client.fetch === 'function') {
    return client as unknown as KabukiInnerTubeClient;
  }
  return null;
}

export function getCurrentIdentityService(): CurrentIdentityService | null {
  const service = getYttvServicesMap()?.get('CurrentIdentityService');
  if (isObjectLike(service) && typeof service.get === 'function') {
    return service as unknown as CurrentIdentityService;
  }
  return null;
}

export function findResolveCommandHost(): YttvResolveCommandHost | null {
  const yttv = typeof window !== 'undefined' ? window._yttv : undefined;
  if (!yttv) return null;
  for (const entry of Object.values(yttv)) {
    if (isObjectLike(entry) && isObjectLike(entry.instance) && typeof entry.instance.resolveCommand === 'function') {
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
  const readyAbort = new AbortController();
  let pollAbort: AbortController | null = null;
  onAbort(readyAbort.signal, () => pollAbort?.abort());

  const cleanup = (): void => {
    readyAbort.abort();
  };

  const schedulePoll = (delayMs: number): void => {
    if (readyAbort.signal.aborted) return;
    pollAbort?.abort();
    pollAbort = new AbortController();
    scheduleAbortableTimeout(check, delayMs, pollAbort.signal);
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
    schedulePoll(200);
  };

  observeDom(
    document.documentElement ?? document,
    () => {
      if (isYttvPopulated()) flush();
    },
    { childList: true, subtree: true },
    readyAbort.signal
  );
  window.addEventListener('load', check, { once: true, signal: readyAbort.signal });
  document.addEventListener('DOMContentLoaded', check, { once: true, signal: readyAbort.signal });
  schedulePoll(50);
}

export function getCommandExecutor(): YttvCommandExecutor | null {
  const yttv = typeof window !== 'undefined' ? window._yttv : undefined;
  if (!yttv) return null;

  let instance: Record<string, unknown> | null = null;
  let executeFunction: ((command: unknown) => unknown) | null = null;

  for (const entry of Object.values(yttv)) {
    if (!isObjectLike(entry) || typeof entry.getInstance !== 'function') continue;
    const rawEntry = entry as { getInstance: () => unknown; toString?: () => string };
    let candidateInstance: unknown;
    try {
      candidateInstance = rawEntry.getInstance();
    } catch {
      continue;
    }
    if (String(rawEntry).includes('ytlrActionRouter')) {
      if (isObjectLike(candidateInstance)) instance = candidateInstance;
      continue;
    }

    if (!isObjectLike(candidateInstance)) continue;
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

let commandDispatcher: ((command: unknown) => unknown) | null = null;

/**
 * Registers the primary command dispatcher so bridge helpers respect active instances and patching
 * without introducing circular imports back into `resolve-command.ts`.
 */
export function registerCommandDispatcher(dispatcher: (command: unknown) => unknown): void {
  commandDispatcher = dispatcher;
}

export function dispatchYttvCommand(command: unknown): boolean {
  if (commandDispatcher) {
    void commandDispatcher(command);
    return true;
  }
  const host = findResolveCommandHost();
  if (!host) return false;
  host.instance.resolveCommand(command as Record<string, unknown>);
  return true;
}

export function showToast(title: string, subtitle: string): boolean {
  return dispatchYttvCommand({
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
}
