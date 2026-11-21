import { isRecord } from '../utils/type-guards.ts';

type AnyRecord = Record<string, unknown>;
type AnyFn = (...args: unknown[]) => unknown;

const wrappedSetFns = new WeakSet<AnyFn>();
let installed = false;

function patchExperimentFlags(flags: unknown): void {
  if (!isRecord(flags)) return;
  flags.web_l3_storyboard = true;
  flags.force_full_animation = true;
  flags.force_memory_saving_mode = false;
}

function patchEnvironmentObject(env: unknown): void {
  if (!isRecord(env)) return;
  env.enable_animation = true;
  env.enable_memory_saving_mode = false;
}

function patchTectonicFeatureSwitches(switches: unknown): void {
  if (!isRecord(switches)) return;
  switches.enableHdStoryboardThumbnails = true;
}

function patchYtConfigData(configData: unknown): void {
  if (!isRecord(configData)) return;
  if (!isRecord(configData.EXPERIMENT_FLAGS)) {
    configData.EXPERIMENT_FLAGS = {};
  }
  patchExperimentFlags(configData.EXPERIMENT_FLAGS);
}

function wrapYtcfg(ytcfgObj: unknown): unknown {
  if (!isRecord(ytcfgObj)) return ytcfgObj;

  patchYtConfigData(ytcfgObj.data_);
  if (typeof ytcfgObj.d === 'function') {
    try {
      patchYtConfigData((ytcfgObj.d as () => unknown)());
    } catch {
      // Ignore pre-init config reader errors.
    }
  }

  if (typeof ytcfgObj.set === 'function' && !wrappedSetFns.has(ytcfgObj.set as AnyFn)) {
    const origSet = ytcfgObj.set as AnyFn;
    const wrappedSet: AnyFn = function (this: unknown, ...args: unknown[]): unknown {
      if (args.length === 1 && isRecord(args[0])) {
        if (isRecord(args[0].EXPERIMENT_FLAGS)) {
          patchExperimentFlags(args[0].EXPERIMENT_FLAGS);
        }
        if ('web_l3_storyboard' in args[0]) args[0].web_l3_storyboard = true;
        if ('force_full_animation' in args[0]) args[0].force_full_animation = true;
        if ('force_memory_saving_mode' in args[0]) args[0].force_memory_saving_mode = false;
      } else if (args[0] === 'EXPERIMENT_FLAGS' && isRecord(args[1])) {
        patchExperimentFlags(args[1]);
      }

      const result = origSet.apply(this, args);
      patchYtConfigData(ytcfgObj.data_);
      if (typeof ytcfgObj.d === 'function') {
        try {
          patchYtConfigData((ytcfgObj.d as () => unknown)());
        } catch {
          // Ignore config reader errors.
        }
      }
      return result;
    };
    wrappedSetFns.add(origSet);
    wrappedSetFns.add(wrappedSet);
    ytcfgObj.set = wrappedSet;
  }

  return ytcfgObj;
}

function installPropertyTrap(target: AnyRecord, prop: string, onAssign: (value: unknown) => void): void {
  const existing = target[prop];
  if (existing !== undefined) {
    onAssign(existing);
  }

  const desc = Object.getOwnPropertyDescriptor(target, prop);
  if (desc && !desc.configurable) return;

  // Preserve any pre-existing getter/setter when trapping (not expected at document-start, but safe).
  let currentValue = existing;
  Object.defineProperty(target, prop, {
    configurable: true,
    enumerable: desc?.enumerable ?? true,
    get() {
      return desc?.get ? desc.get.call(this) : currentValue;
    },
    set(nextValue: unknown) {
      if (desc?.set) {
        desc.set.call(this, nextValue);
      } else {
        currentValue = nextValue;
      }
      onAssign(nextValue);
    },
  });
}

function patchTectonicConfig(config: unknown): void {
  if (!isRecord(config)) return;
  installPropertyTrap(config, 'featureSwitches', patchTectonicFeatureSwitches);
}

function patchYtNamespace(ytObj: unknown): void {
  if (!isRecord(ytObj)) return;
  installPropertyTrap(ytObj, 'config_', patchYtConfigData);
}

/**
 * Forces YouTube TV's HD storyboard flags (`web_l3_storyboard`, `force_full_animation`, and
 * `enableHdStoryboardThumbnails`) at `document-start` so seek previews use high-res `320x180` (`L3`)
 * frames instead of dropping levels `>= 180px` or falling back to limited-memory low-res previews.
 */
export function installHdStoryboard(
  targetWindow: AnyRecord | undefined = typeof window !== 'undefined' ? (window as unknown as AnyRecord) : undefined
): void {
  if (!targetWindow) return;
  if (targetWindow === (typeof window !== 'undefined' ? (window as unknown) : undefined)) {
    if (installed) return;
    installed = true;
  }

  installPropertyTrap(targetWindow, 'environment', patchEnvironmentObject);
  installPropertyTrap(targetWindow, 'ytcfg', wrapYtcfg);
  installPropertyTrap(targetWindow, 'yt', patchYtNamespace);
  installPropertyTrap(targetWindow, 'tectonicConfig', patchTectonicConfig);
}
