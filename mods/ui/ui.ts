import { waitForDomReady } from '../core/idle-scheduler.ts';
import { onVideo } from '../core/player-observer.ts';
import resolveCommand, { patchResolveCommand } from '../core/resolve-command.ts';
import { injectCss } from '../core/styles.ts';
import { getCommandExecutor, whenYttvReady } from '../core/yttv-bridge.ts';
import css from './ui.min.css';

const STARTUP_COMMAND = { browseEndpoint: { browseId: 'FEtopics' } } as const;

let stylesInstalled = false;
let uiInitialized = false;

function installGlobalStyles(): void {
  if (stylesInstalled || typeof document === 'undefined') return;
  const targetRoot = document.head ?? document.documentElement;
  if (!targetRoot) return;
  stylesInstalled = true;
  injectCss(css, true);
}

function initUi(): void {
  installGlobalStyles();
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
  void waitForDomReady().then(installGlobalStyles);
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
