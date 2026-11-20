# Custom Cobalt APK Builder

Custom Cobalt APK builder targeting official upstream [`youtube/cobalt`](https://github.com/youtube/cobalt/tree/27.lts) (`27.lts`, currently `27.lts.20`) for `android-arm` (`armeabi-v7a`, MediaTek `mt5896`, 4× ARM Cortex-A73), combining a native Cobalt patch overlay (`patches/` + `assets/res/`) with an ES2022 userscript source tree (`mods/`) built with TypeScript and `esbuild`.

## Native & Java Patches (`patches/` & `assets/res/`)
- `01-gn-arm-cortex-a73-and-trim.patch`: Set `manifest_package=com.custom.cobalt`, release `debuggable=false` on `gold`, `version_code = "203"`, `version_name = "2.0.3"`, `arm_version = 8`, `arm_tune = "cortex-a73"`, `use_thin_lto = false`, `enable_vectorized_html_scanning = true`, `enable_printing = false`, `aapt_locale_allowlist = [ "en-US" ]`, and wire the bundled `assets/res/` launcher icons/TV banners into `cobalt/shell/android/BUILD.gn`.
- `02-disable-splash-and-telemetry.patch`: Enable `kDisableSplashScreen`, `kCobaltSkipTrustedHeaderClient` (eliminating per-request `CobaltTrustedURLLoaderHeaderClient` Mojo pipes), `kCobaltStartupPreconnect`, and `kCobaltFlushHttpServerPropertiesOnPause`, disable `kCobaltVirtualAddressSpaceMetrics` and `kHangWatchRendererThreadDump`, and set `UpdateUploadPermissions(false)` in `CobaltBrowserMainParts::StartMetricsRecording()`.
- `03-starboard-seek-and-avsync.patch`: Enable the Starboard seek and audio/video sync fixes.
- `04-bundle-local-userscript.patch`: Bundle `assets/userscript.js` into `coat_assets` and inject it locally on main YouTube frames in `Document::ImplicitClose()`.
- `05-android-hardening-and-activity-fixes.patch`: Bypass IME for hardware volume keys in `CobaltActivity`, set `android:allowBackup="false"`, `YouTube` app label, `smallestScreenSize|screenLayout` configChanges, and dark gray shell background (`#0f0f0f`).
- `06-java-switches-tuning.patch`: Tune Java/Chromium/C++ switches and network stack on `27.lts`: remove forced `--enable-low-end-device-mode` in `JavaSwitches.java`, remove `--disable-quic` default and set `128` MB GPU mem default, `--minor-ms`, `48` MB image decode cache cap, clipped image scaling, `EnableAv1StartupOptimization`, and `CobaltMmapFontCache` in `androidtv_flag_map.cc`, drop `--no-concurrent-marking` in `cobalt_switch_defaults_android.cc`, set `delay_main_job_with_available_spdy_session = true` in `NetworkContext`, and remove the startup `0ms` delay short-circuit in `QuicSessionPool::GetTimeDelayForWaitingJob`. Native change: requires a full APK build, not a JS hotswap.
- `07-allow-ryd-in-csp.patch`: Allow `sponsor.ajay.app`, `dearrow-thumb.ajay.app`, and `returnyoutubedislikeapi.com` in Blink's CSP allowlist.
- `08-enable-background-freeze.patch`: Enable `kCobaltFreezeOnBackground` to improve resource management when Cobalt is in the background.
- `09-integrity-check.patch`: Basic APK signature check in `CobaltActivity` using active signing certificates to discourage tampering.
- `10-media-hdr-aaudio-cache-tuning.patch`: Tune memory/HTTP/GPU caches for 3 GB TVs, enable area-based video buffer budgets, AAudio pull-sink default, and HDR10+ VP9/AV1 profiles.
- `11-manifest-hardening-and-mojo-sizing.patch`: Harden `AndroidManifest.xml.jinja2` (`debuggable=false`, `usesCleartextTraffic="false"`, `extractNativeLibs="false"`, strip unused permissions) and enable dynamic Mojo pipe sizing.
- `12-deeplink-url-allowlist.patch`: Validate `https://` scheme, host allowlist, userinfo, and port on deep-link intents in `CobaltActivity`, and skip empty blocked intents in `onNewIntent()`.
- `assets/res/`: Custom prism launcher icons (`mipmap-*/ic_app.png`) and Android TV banners (`drawable-*/app_banner.png`) copied into `src/cobalt/shell/android/java/res/` during `Build Cobalt APK`.

## Userscript Source (`mods/` & `tests/`)
- `mods/index.ts` & `tsconfig.json`: `esbuild` bundle entry targeting ES2022 (`npm run build:js` → `dist/userScript.js`).
- `mods/types/`: Shared TypeScript interfaces for InnerTube renderers/commands (`innertube.ts`), YouTube TV runtime globals (`yttv.ts`), and CSS module assets (`assets.d.ts`).
- `mods/core/`: Core runtime plumbing (`config.ts`, `i18n.ts`, `innertube-calls.ts`, `innertube-interceptor.ts`, `player-observer.ts`, `resolve-command.ts`, `trusted-types.ts`, `yttv-bridge.ts`).
- `mods/transforms/`: Pure typed InnerTube transforms (`chapters.ts`, `feed-filter.ts`, `innertube-player.ts`, `thumbnails.ts`).
- `mods/features/`:
  - `sponsorblock.ts`, `return-youtube-dislike.ts`, `remaining-time.ts`, `rewind-on-pause.ts`, `more-subtitles.ts`, `preferred-video-quality.ts`, `disable-whos-watching.ts`.
- `mods/ui/`: Clock + watch end-time (`clock.ts`), custom YT settings (`custom-yt-settings.ts`), speed UI (`speed-ui.ts`), sidebar customization (`custom-guide-action.ts`, `sidebar-modification.ts`), settings modal (`settings.ts`), player button tweaks (`custom-ui.ts`), and renderer builders (`yt-ui.ts`).
- `mods/utils/`: `feed-helpers.ts` (typed pure feed/formatting/long-press helpers), `ast-parser.ts` (zero-dependency constructor method extractor), and `type-guards.ts`.
- `tests/`: `node --experimental-strip-types --test` typed unit tests (`ast-parser.test.ts`, `chapters.test.ts`, `clock.test.ts`, `feed-filter.test.ts`, `feed-helpers.test.ts`, `i18n.test.ts`, `innertube-interceptor.test.ts`, `more-subtitles.test.ts`, `preferred-video-quality.test.ts`, `remaining-time.test.ts`, `return-youtube-dislike.test.ts`, `rewind-on-pause.test.ts`, `sponsorblock.test.ts`, `thumbnails.test.ts`).

## Usage & Retention
- Full APK build: Actions → Build Cobalt APK → Run workflow (`android-arm`, `gold`, dynamic 330m compile cap with min 300s and warm-ccache auto-retry; scheduled Friday 08:00 UTC when upstream `youtube/cobalt` (`27.lts`) or builder changes are detected).
- JS-only hotswap: Actions → Hotswap JS into Release APK → Run workflow.
- JS lint, typecheck & bundle check: Actions → Lint & Bundle JS (runs automatically on pushes touching `mods/**`, `tests/**`, `package.json`, `tsconfig.json`, or `lint_js.yml`). Note: Local builds now require `javascript-obfuscator` (`npm install --save-dev javascript-obfuscator`).
- ccache keepalive: Actions → Keep ccache Alive restores warm `ccache` entries every 5 days.
- Retention: workflow artifacts expire after 1 day; GitHub Releases under `custom-android-arm-gold*` keep the newest 7 releases and delete older ones.
