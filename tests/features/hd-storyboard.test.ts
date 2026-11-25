import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { installHdStoryboard } from '../../mods/features/hd-storyboard.ts';

describe('installHdStoryboard', () => {
  test('forces L3 and full-animation storyboard flags across environment, ytcfg, yt.config_, and tectonicConfig', () => {
    const win: Record<string, unknown> = {};
    installHdStoryboard(win);

    // 1. Late inline <script>window.environment = ...</script>
    win.environment = { enable_animation: false, enable_memory_saving_mode: true };
    const env = win.environment as { enable_animation?: boolean; enable_memory_saving_mode?: boolean };
    assert.equal(env.enable_animation, true);
    assert.equal(env.enable_memory_saving_mode, false);

    // 2. Inline <script>var ytcfg = { ... }; ytcfg.set({ EXPERIMENT_FLAGS: ... });</script>
    const configData: Record<string, unknown> = {};
    win.ytcfg = {
      data_: configData,
      d: () => configData,
      set(arg: unknown, val?: unknown) {
        if (typeof arg === 'string') {
          configData[arg] = val;
        } else if (arg && typeof arg === 'object') {
          Object.assign(configData, arg);
        }
      },
    };
    const ytcfg = win.ytcfg as { set: (arg: unknown, val?: unknown) => void };
    ytcfg.set({
      EXPERIMENT_FLAGS: {
        web_l3_storyboard: false,
        force_memory_saving_mode: true,
        existing_flag: 42,
      },
    });
    const flags = configData.EXPERIMENT_FLAGS as Record<string, unknown>;
    assert.equal(flags.web_l3_storyboard, true);
    assert.equal(flags.force_full_animation, true);
    assert.equal(flags.force_memory_saving_mode, false);
    assert.equal(flags.existing_flag, 42);

    // 3. Direct key assignment via ytcfg.set('EXPERIMENT_FLAGS', ...) & window.yt.config_
    ytcfg.set('EXPERIMENT_FLAGS', { web_l3_storyboard: false });
    assert.equal((configData.EXPERIMENT_FLAGS as Record<string, unknown>).web_l3_storyboard, true);

    win.yt = {
      config_: {
        EXPERIMENT_FLAGS: { web_l3_storyboard: false },
      },
    };
    assert.equal(
      (win.yt as { config_: { EXPERIMENT_FLAGS: Record<string, unknown> } }).config_.EXPERIMENT_FLAGS.web_l3_storyboard,
      true
    );

    // 4. Late assignment to tectonicConfig and tectonicConfig.featureSwitches
    const tectonicConfig: Record<string, unknown> = {};
    win.tectonicConfig = tectonicConfig;
    tectonicConfig.featureSwitches = { enableHdStoryboardThumbnails: false, enableAnimations: false };
    assert.equal((tectonicConfig.featureSwitches as Record<string, unknown>).enableHdStoryboardThumbnails, true);
  });

  test('patches already-present globals when installed after page scripts initialize', () => {
    const win: Record<string, unknown> = {
      environment: { enable_memory_saving_mode: true },
      tectonicConfig: { featureSwitches: { enableHdStoryboardThumbnails: false } },
      ytcfg: {
        data_: { EXPERIMENT_FLAGS: { force_full_animation: false } },
      },
    };

    installHdStoryboard(win);

    assert.equal((win.environment as Record<string, unknown>).enable_animation, true);
    assert.equal((win.environment as Record<string, unknown>).enable_memory_saving_mode, false);
    assert.equal(
      (win.ytcfg as { data_: { EXPERIMENT_FLAGS: Record<string, unknown> } }).data_.EXPERIMENT_FLAGS.web_l3_storyboard,
      true
    );
    assert.equal(
      (win.tectonicConfig as { featureSwitches: Record<string, unknown> }).featureSwitches.enableHdStoryboardThumbnails,
      true
    );
  });

  test('ignores throwing ytcfg.d(), non-configurable props, preserves descriptors, and guards global window', (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    t.after(() => {
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
    });

    const win: Record<string, unknown> = {};
    Object.defineProperty(win, 'environment', {
      configurable: false,
      writable: true,
      value: { enable_animation: false },
    });

    let getterVal: unknown;
    let setterCalls = 0;
    Object.defineProperty(win, 'tectonicConfig', {
      configurable: true,
      get() {
        return getterVal;
      },
      set(v: unknown) {
        setterCalls++;
        getterVal = v;
      },
    });

    installHdStoryboard(win);
    assert.equal((win.environment as Record<string, unknown>).enable_animation, true);

    win.tectonicConfig = { featureSwitches: { enableHdStoryboardThumbnails: false } };
    assert.equal(setterCalls, 1);
    assert.equal(
      (win.tectonicConfig as { featureSwitches: Record<string, unknown> }).featureSwitches.enableHdStoryboardThumbnails,
      true
    );

    win.ytcfg = {
      data_: {},
      d: () => {
        throw new Error('pre-init');
      },
      set: () => {},
    };
    assert.doesNotThrow(() =>
      (win.ytcfg as { set: (k: string, v: unknown) => void }).set('EXPERIMENT_FLAGS', { web_l3_storyboard: false })
    );

    const globalWin: Record<string, unknown> = {};
    globals.window = globalWin;
    installHdStoryboard();
    installHdStoryboard(); // Idempotent second call on global window.
    globalWin.environment = {};
    assert.equal((globalWin.environment as Record<string, unknown>).enable_animation, true);

    // Exercise non-record defensive guards and partial/missing EXPERIMENT_FLAGS / set() payloads.
    const edgeWin: Record<string, unknown> = {};
    installHdStoryboard(edgeWin);
    edgeWin.environment = null;
    edgeWin.yt = null;
    edgeWin.yt = { config_: null };
    edgeWin.tectonicConfig = null;
    edgeWin.tectonicConfig = { featureSwitches: null };
    edgeWin.ytcfg = null;
    edgeWin.ytcfg = {
      d: () => null,
      set: () => {},
    };
    (edgeWin.ytcfg as { set: (arg1: unknown, arg2?: unknown) => void }).set('OTHER_KEY', {});
    (edgeWin.ytcfg as { set: (arg1: unknown, arg2?: unknown) => void }).set({ unrelated: true });
    const directFlags = {
      web_l3_storyboard: false,
      force_full_animation: false,
      force_memory_saving_mode: true,
    };
    (edgeWin.ytcfg as { set: (arg1: unknown, arg2?: unknown) => void }).set(directFlags);
    assert.equal(directFlags.web_l3_storyboard, true);
    assert.equal(directFlags.force_full_animation, true);
    assert.equal(directFlags.force_memory_saving_mode, false);

    const keyValFlags = { web_l3_storyboard: false, force_memory_saving_mode: true };
    (edgeWin.ytcfg as { set: (arg1: unknown, arg2?: unknown) => void }).set('EXPERIMENT_FLAGS', keyValFlags);
    assert.equal(keyValFlags.web_l3_storyboard, true);
    (edgeWin.ytcfg as { set: (arg1: unknown, arg2?: unknown) => void }).set('EXPERIMENT_FLAGS', null);

    delete globals.window;
    assert.doesNotThrow(() => installHdStoryboard());
  });
});
