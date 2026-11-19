import type {
  CurrentIdentityService,
  KabukiInnerTubeClient,
  YttvCommandExecutor,
  YttvResolveCommandHost,
} from '../types/yttv.ts';
import { isRecord } from '../utils/type-guards.ts';

export function getYttvServicesMap(): Map<string, unknown> | null {
  const yttv = window._yttv;
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
  const yttv = window._yttv;
  if (!yttv) return null;
  for (const entry of Object.values(yttv)) {
    if (isRecord(entry) && isRecord(entry.instance) && typeof entry.instance.resolveCommand === 'function') {
      return entry as unknown as YttvResolveCommandHost;
    }
  }
  return null;
}

export function getCommandExecutor(): YttvCommandExecutor | null {
  const yttv = window._yttv;
  if (!yttv) return null;

  let instance: Record<string, unknown> | null = null;
  let executeFunction: ((command: unknown) => unknown) | null = null;

  for (const entry of Object.values(yttv)) {
    if (!isRecord(entry) || typeof entry.getInstance !== 'function') continue;
    const rawEntry = entry as { getInstance: () => unknown; toString?: () => string };
    if (String(rawEntry).includes('ytlrActionRouter')) {
      const candidate = rawEntry.getInstance();
      if (isRecord(candidate)) instance = candidate;
      continue;
    }

    const tempInstance = rawEntry.getInstance();
    if (!isRecord(tempInstance)) continue;
    const proto = Object.getPrototypeOf(tempInstance);
    if (!isRecord(proto)) continue;
    for (const propName of Object.getOwnPropertyNames(proto)) {
      const member = tempInstance[propName];
      if (typeof member === 'function' && member.toString().includes('ytlrActionRouter')) {
        executeFunction = member as (command: unknown) => unknown;
        instance = tempInstance;
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
