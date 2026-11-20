import { configRead, whenConfigReady } from '../core/config.ts';
import { waitForDomReady } from '../core/idle-scheduler.ts';
import { onVideo } from '../core/player-observer.ts';
import { getCommandExecutor, whenYttvReady } from '../core/yttv-bridge.ts';
import resolveCommand, { patchResolveCommand } from '../core/resolve-command.ts';
import css from './ui.min.css';

let stylesInstalled = false;
let uiInitialized = false;

function installGlobalStyles(): void {
  if (stylesInstalled || typeof document === 'undefined') return;
  const targetRoot = document.head ?? document.documentElement;
  if (!targetRoot) return;
  stylesInstalled = true;

  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    return;
  } catch {
    // Fallback to an existing nonce-authorized style tag if constructable stylesheets are unavailable.
  }

  const existingStyle = document.querySelector('style[nonce]');
  if (existingStyle) {
    existingStyle.textContent = `${existingStyle.textContent ?? ''}${css}`;
    return;
  }
  const style = document.createElement('style');
  style.textContent = css;
  targetRoot.appendChild(style);
}

function initUi(): void {
  installGlobalStyles();
  if (uiInitialized) return;
  uiInitialized = true;

  const isWatchRoute = typeof location !== 'undefined' && location.hash.includes('watch');
  if (configRead('reloadHomeOnStartup') && !isWatchRoute) {
    const launchTo = configRead('launchToOnStartup');
    if (launchTo) {
      try {
        const parsed = JSON.parse(launchTo);
        if (typeof parsed === 'object' && parsed !== null) {
          resolveCommand(parsed);
        } else {
          throw new Error('Invalid JSON');
        }
      } catch {
        resolveCommand({ signalAction: { signal: 'SOFT_RELOAD_PAGE' } });
      }
    } else {
      resolveCommand({ signalAction: { signal: 'SOFT_RELOAD_PAGE' } });
    }
  }

  const commandExecutor = getCommandExecutor();
  if (commandExecutor?.commandFunction) {
    commandExecutor.executeFunction(new commandExecutor.commandFunction('reloadGuideAction'));
  }
}

if (typeof document !== 'undefined') {
  void waitForDomReady().then(installGlobalStyles);
  whenYttvReady(() => {
    patchResolveCommand();
    void whenConfigReady().then(initUi);
  });
  onVideo(() => {
    patchResolveCommand();
    void whenConfigReady().then(initUi);
  });
}
