import { configRead } from '../core/config.ts';
import { t } from '../core/i18n.ts';
import { onVideo } from '../core/player-observer.ts';
import { applyDislikeCountToActions } from '../features/return-youtube-dislike.ts';
import { extractPlayerActionMethodNames } from '../utils/ast-parser.ts';
import { isRecord } from '../utils/type-guards.ts';
import { ButtonRenderer } from './yt-ui.ts';

function applyPatches(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (!window._yttv) {
    if (typeof MutationObserver !== 'undefined') {
      const target = document.documentElement ?? document;
      const obs = new MutationObserver(() => {
        if (window._yttv) {
          obs.disconnect();
          applyPatches();
        }
      });
      obs.observe(target, { childList: true, subtree: true });
    }
    return;
  }

  const methods = Object.keys(window._yttv).filter((key) => {
    const entry = window._yttv?.[key];
    return typeof entry === 'function' && entry.toString().includes('TRANSPORT_CONTROLS_BUTTON_TYPE_FEATURED_ACTION');
  });

  const targetKey = methods[0];
  if (!targetKey) return;

  const origMethod = window._yttv?.[targetKey] as (new (...args: unknown[]) => Record<string, unknown>) &
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
      if (configRead('enableSpeedControlsButton')) {
        const origEngagementActionButton = inst[engagementActionsMethod] as (...a: unknown[]) => unknown[];
        inst[engagementActionsMethod] = function (this: unknown, ...callArgs: unknown[]) {
          const res = origEngagementActionButton.apply(this, callArgs);
          if (
            Array.isArray(res) &&
            !res.some((item) => isRecord(item) && item.type === 'TRANSPORT_CONTROLS_BUTTON_TYPE_SPEED')
          ) {
            res.push({
              type: 'TRANSPORT_CONTROLS_BUTTON_TYPE_SPEED',
              button: {
                buttonRenderer: ButtonRenderer(false, t('player.playbackSpeed.button'), 'SPEEDOMETER', {
                  customAction: { action: 'TT_SPEED_SETTINGS_SHOW' },
                }),
              },
            });
          }
          return res;
        };
      }

      const origSubFilter = inst[engagementActionsMethod] as (...a: unknown[]) => unknown;
      inst[engagementActionsMethod] = function (this: unknown, ...callArgs: unknown[]) {
        const res = origSubFilter.apply(this, callArgs);
        if (!Array.isArray(res)) return res;
        return applyDislikeCountToActions(
          res.filter((item) => {
            if (!isRecord(item)) return true;
            if (/SUBSCRIBE/i.test(String(item.type || ''))) return false;
            const btn = isRecord(item.button) ? item.button : undefined;
            return !item.subscribeButton && !item.subscribeButtonRenderer && !btn?.subscribeButtonRenderer;
          })
        );
      };

      if (!configRead('enableSuperThanksButton')) {
        const origEngagementActionButton = inst[engagementActionsMethod] as (...a: unknown[]) => unknown[];
        inst[engagementActionsMethod] = function (this: unknown, ...callArgs: unknown[]) {
          const res = origEngagementActionButton.apply(this, callArgs);
          return Array.isArray(res)
            ? res.filter(
                (item) =>
                  !isRecord(item) ||
                  (item.type !== 'TRANSPORT_CONTROLS_BUTTON_TYPE_SUPER_THANKS' &&
                    item.type !== 'TRANSPORT_CONTROLS_BUTTON_TYPE_SHOPPING')
              )
            : res;
        };
      }

      if (!configRead('enableAIAskButton')) {
        const origEngagementActionButton = inst[engagementActionsMethod] as (...a: unknown[]) => unknown[];
        inst[engagementActionsMethod] = function (this: unknown, ...callArgs: unknown[]) {
          const res = origEngagementActionButton.apply(this, callArgs);
          return Array.isArray(res)
            ? res.filter(
                (item) => !isRecord(item) || item.type !== 'TRANSPORT_CONTROLS_BUTTON_TYPE_YOUCHAT_BUTTON'
              )
            : res;
        };
      }
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
  onVideo(applyPatches);
}
