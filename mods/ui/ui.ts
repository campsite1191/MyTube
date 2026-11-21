import { onVideo } from '../core/player-observer.ts';
import resolveCommand, { patchResolveCommand } from '../core/resolve-command.ts';
import { getCommandExecutor, whenYttvReady } from '../core/yttv-bridge.ts';

const STARTUP_COMMAND = { browseEndpoint: { browseId: 'FEtopics' } } as const;

let uiInitialized = false;

function initUi(): void {
  if (uiInitialized) return;
  uiInitialized = true;

  const isWatchRoute = typeof location !== 'undefined' && location.hash.includes('watch');
  if (!isWatchRoute) {
    resolveCommand(STARTUP_COMMAND);
  }

  const commandExecutor = getCommandExecutor();
  if (commandExecutor?.commandFunction) {
    commandExecutor.executeFunction(new commandExecutor.commandFunction('reloadGuideAction'));
  }
}

function ensureResolveHooksOnActionKey(event: KeyboardEvent): void {
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

if (typeof document !== 'undefined') {
  whenYttvReady(() => {
    patchResolveCommand();
    initUi();
  });
  onVideo(() => {
    patchResolveCommand();
    initUi();
  });
  if (typeof window !== 'undefined') {
    window.addEventListener('hashchange', patchResolveCommand);
  }
  document.addEventListener('keydown', ensureResolveHooksOnActionKey, true);
  document.addEventListener('click', patchResolveCommand, true);
}
