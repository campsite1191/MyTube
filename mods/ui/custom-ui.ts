import { configRead, whenConfigReady } from '../core/config.ts';
import { t } from '../core/i18n.ts';
import { whenYttvReady } from '../core/yttv-bridge.ts';
import { extractPlayerActionMethodNames } from '../utils/ast-parser.ts';
import { isRecord } from '../utils/type-guards.ts';
import { ButtonRenderer } from './yt-ui.ts';

let patchesApplied = false;

function applyPatches(): void {
  if (patchesApplied || typeof window === 'undefined' || !window._yttv) return;

  const methods = Object.keys(window._yttv).filter((key) => {
    const entry = window._yttv?.[key];
    return typeof entry === 'function' && entry.toString().includes('TRANSPORT_CONTROLS_BUTTON_TYPE_FEATURED_ACTION');
  });

  const targetKey = methods[0];
  if (!targetKey) return;
  patchesApplied = true;

  const origMethod = window._yttv?.[targetKey] as (new (
    ...args: unknown[]
  ) => Record<string, unknown>) &
    ((...args: unknown[]) => unknown);
  const { previousButtonMethod, nextButtonMethod, engagementActionsMethod } = extractPlayerActionMethodNames(
    origMethod.toString()
  );

  function YtlrPlayerActionsContainer(this: unknown, ...args: unknown[]): unknown {
    const isClass = /^class\s/.test(origMethod.toString());

    const constructAsNew = (ctor: new (...ctorArgs: unknown[]) => unknown, argsList: unknown[]): unknown => {
      if (typeof Reflect !== 'undefined' && typeof Reflect.construct === 'function') {
        return Reflect.construct(ctor, argsList, YtlrPlayerActionsContainer);
      }
      return new ctor(...argsList);
    };

    if (!(this instanceof YtlrPlayerActionsContainer)) {
      if (isClass) return constructAsNew(origMethod, args);
      return origMethod.apply(this, args);
    }

    let inst: Record<string, unknown>;
    if (isClass) {
      inst = constructAsNew(origMethod, args) as Record<string, unknown>;
    } else {
      origMethod.apply(this, args);
      inst = this as Record<string, unknown>;
    }

    if (engagementActionsMethod && typeof inst[engagementActionsMethod] === 'function') {
      const origEngagementActions = inst[engagementActionsMethod] as (...a: unknown[]) => unknown;
      inst[engagementActionsMethod] = function (this: unknown, ...callArgs: unknown[]) {
        const res = origEngagementActions.apply(this, callArgs);
        if (!Array.isArray(res)) return res;

        const filtered = res.filter((item) => {
          if (!isRecord(item)) return true;
          const itemType = String(item.type || '');
          if (/SUBSCRIBE/i.test(itemType)) return false;
          const btn = isRecord(item.button) ? item.button : undefined;
          if (item.subscribeButton || item.subscribeButtonRenderer || btn?.subscribeButtonRenderer) {
            return false;
          }
          if (
            !configRead('enableSuperThanksButton') &&
            (itemType === 'TRANSPORT_CONTROLS_BUTTON_TYPE_SUPER_THANKS' ||
              itemType === 'TRANSPORT_CONTROLS_BUTTON_TYPE_SHOPPING')
          ) {
            return false;
          }
          if (!configRead('enableAIAskButton') && itemType === 'TRANSPORT_CONTROLS_BUTTON_TYPE_YOUCHAT_BUTTON') {
            return false;
          }
          return true;
        });

        if (
          configRead('enableSpeedControlsButton') &&
          !filtered.some((item) => isRecord(item) && item.type === 'TRANSPORT_CONTROLS_BUTTON_TYPE_SPEED')
        ) {
          filtered.push({
            type: 'TRANSPORT_CONTROLS_BUTTON_TYPE_SPEED',
            button: {
              buttonRenderer: ButtonRenderer(false, t('player.playbackSpeed.button'), 'SPEEDOMETER', {
                customAction: { action: 'TT_SPEED_SETTINGS_SHOW' },
              }),
            },
          });
        }

        return filtered;
      };
    }

    if (configRead('enablePreviousNextButtons') && previousButtonMethod && nextButtonMethod) {
      inst[previousButtonMethod] = () =>
        ButtonRenderer(false, t('player.previous'), 'SKIP_PREVIOUS', {
          signalAction: { signal: 'PLAYER_PLAY_PREVIOUS' },
        });
      inst[nextButtonMethod] = () =>
        ButtonRenderer(false, t('player.next'), 'SKIP_NEXT', {
          signalAction: { signal: 'PLAYER_PLAY_NEXT' },
        });
    }

    return inst;
  }

  if (configRead('enablePatchingVideoPlayer') && window._yttv) {
    YtlrPlayerActionsContainer.prototype = origMethod.prototype;
    window._yttv[targetKey] = YtlrPlayerActionsContainer;
  }
}

if (typeof document !== 'undefined') {
  whenYttvReady(() => {
    void whenConfigReady().then(applyPatches);
  });
}
