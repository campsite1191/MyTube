import { NOOP } from '../core/lifecycle.ts';
import { getCommandExecutor, registerCommandDispatcher, whenYttvReady } from '../core/yttv-bridge.ts';
import resolveCommand, { patchResolveCommand } from './resolve-command.ts';

const STARTUP_COMMAND = { browseEndpoint: { browseId: 'FEtopics' } } as const;

let uiInitialized = false;
let uiHooksInstalled = false;

function isHomeStartupRoute(): boolean {
  if (typeof location === 'undefined') return true;
  const hash = location.hash;
  return !hash || hash === '#' || hash === '#/';
}

export function initUi(force = false): void {
  if (uiInitialized && !force) return;
  uiInitialized = true;

  if (isHomeStartupRoute()) {
    resolveCommand(STARTUP_COMMAND);
  }

  const commandExecutor = getCommandExecutor();
  if (commandExecutor?.commandFunction) {
    commandExecutor.executeFunction(new commandExecutor.commandFunction('reloadGuideAction'));
  }
}

export function ensureResolveHooksOnActionKey(event: KeyboardEvent): void {
  if (
    event.key === 'Enter' ||
    event.key === ' ' ||
    event.keyCode === 13 ||
    event.keyCode === 23 ||
    event.keyCode === 32
  ) {
    patchResolveCommand();
  }
}

export function installUiHooks(): () => void {
  if (uiHooksInstalled || typeof document === 'undefined') return NOOP;
  uiHooksInstalled = true;
  registerCommandDispatcher(resolveCommand);

  const targetDocument = document;
  const targetWindow = typeof window !== 'undefined' ? window : undefined;

  whenYttvReady(() => {
    patchResolveCommand();
    initUi();
  });
  targetWindow?.addEventListener?.('hashchange', patchResolveCommand);
  targetDocument.addEventListener('keydown', ensureResolveHooksOnActionKey, true);
  targetDocument.addEventListener('click', patchResolveCommand, true);

  return () => {
    targetWindow?.removeEventListener?.('hashchange', patchResolveCommand);
    targetDocument.removeEventListener?.('keydown', ensureResolveHooksOnActionKey, true);
    targetDocument.removeEventListener?.('click', patchResolveCommand, true);
    uiHooksInstalled = false;
    uiInitialized = false;
  };
}
