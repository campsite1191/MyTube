# MyTube (`youtube/cobalt` `27.lts` + Lean Userscript) — TDD Reliability & Hardening Roadmap

## Target Environment & Engineering Constraints

- **Upstream Engine:** `youtube/cobalt` `27.lts` (Chromium 138 / V8 13.8 / Starboard 16)
- **Target Hardware:** Hisense Android TV (`android-arm` 32-bit, 4x ARM Cortex-A73, 3 GB RAM, Android 12 SDK 31)
- **Priorities:** Zero main-thread stalls or playback deadlocks, deterministic DOM/observer/listener/network cleanup under the 3 GB RAM ceiling, crash-free native C++/Java patches, and deterministic CI builds.
- **TDD Discipline:** Every finding starts with a realistic mock upgrade (`T1`–`T5`) and a failing `[TDD Red: <ID>]` regression test before any production fix (`[TDD Green: <ID>]`), maintaining `100.00%` line coverage across `mods/**/*.ts` and clean `biome`, `typecheck`, `knip`, and `build:js` gates.

---

## Phase 1 — Test Suite Harness Hardening, Mock Realism & 100% Baseline Coverage (`T1`–`T5`, `C1`)

- [x] **T1 — Real `MockMutationObserver` Lifecycle Tracking (`tests/e2e.test.ts`):** Track `observe(target, options)` and `disconnect()` state, propagate DOM `attributes` (`classList`, `setAttribute`, `removeAttribute`) and `childList` (`appendChild`, `replaceChildren`, `remove`) notifications, and assert Watch observers disconnect cleanly on navigation away.
- [x] **T2 — Full `MockResponse` Parity (`tests/e2e.test.ts`):** Implement `.text()` and `.clone()` alongside `.json()`, and verify the `fetch` -> `Response.text()` -> `_yttv` `JSON.parse()` single-transform path never double-prepends thumbnails or re-filters payloads.
- [x] **T3 — Real TV `WEB_PAGE_TYPE_SHORTS` Class-List Routing (`tests/e2e.test.ts`, `tests/return-youtube-dislike.test.ts`, `tests/shorts-metadata.test.ts`, `tests/thumbnails.test.ts`):** Exercise Shorts enter/exit via `document.body.classList` transitions while `location.hash` remains unchanged (`#/`), matching real Cobalt/YouTube TV behavior.
- [x] **T4 — TV CSS `background-image` Thumbnail Fixtures (`tests/thumbnails.test.ts`):** Test `<ytlr-thumbnail-details style="background-image: ...">` recovery without relying on HTML `<img>` DOM `error` events.
- [x] **T5 — Wrapped Focus Preview Fixtures (`tests/regression-fixes.test.ts`, `tests/previews.test.ts`):** Cover `{ innertubeCommand: { startInlinePlaybackCommand } }` and server-supplied `startInlinePlaybackCommand` payloads during Watch/Shorts playback and `addPreviews(items, false)`.
- [x] **C1 — `100.00%` Baseline Line Coverage (`mods/**/*.ts`):** Close all uncovered lines in `innertube-interceptor.ts` (`507`, `605-606`), `long-press.ts` (`177-179`), `resolve-command.ts` (`79`, `125-126`, `196`, `223-224`, `258`), `ui.ts` (`66-67`), and `trusted-types.ts` (`44-45`).

---

## Phase 2 — High Severity: Playback, AV-Sync & TV DOM Correctness (`H1`–`H3`)

### H1. Revert Incomplete `NdkAudioMode::kPullSink` Default (`patches/10-media-hdr-aaudio-cache-tuning.patch`)
- **Root Cause:** Upstream `AaudioAudioSink` (`starboard/android/shared/aaudio_audio_sink.cc`, `b/561166288`) reports frames consumed at ring-buffer copy time instead of `AAudioStream_getTimestamp()`, omits reroute resync when Android switches audio outputs without `AAUDIO_ERROR_DISCONNECTED`, and forces CPU Sonic resampling on `!= 1.0x` speeds (`AllowDirectPlaybackRateSetting() == false`).
- [x] `[TDD Red: H1]` Assert `patches/10-media-hdr-aaudio-cache-tuning.patch` keeps `NdkAudioMode::kDisabled` (`AudioTrackAudioSink`) as default (`tests/repo-invariants.test.ts`).
- [ ] `[TDD Green: H1]` Remove the `player_components_factory.cc` hunk from `patches/10-media-hdr-aaudio-cache-tuning.patch` and verify `verify_patches.py`.

### H2. CSS Multi-Background Fallback for DeArrow & `hq720.jpg` on TV Cards (`mods/transforms/thumbnails.ts`)
- **Root Cause:** `<ytlr-thumbnail-details>` renders CSS `background-image` (which never emits DOM `error` events), so `HTMLImageElement` error fallback cannot recover when `dearrow-thumb.ajay.app` or unadvertised `hq720.jpg` (`480p`/`360p` legacy uploads) returns `404`.
- [x] `[TDD Red: H2]` Assert `<ytlr-thumbnail-details>` stacks CSS multi-background fallback layers (`dearrow` -> `hq720.jpg` -> `hqdefault.jpg`, and `hq720.jpg` -> `hqdefault.jpg`) without needing DOM `error` events (`tests/thumbnails.test.ts`).
- [ ] `[TDD Green: H2]` Emit stacked `url(...)` fallback layers in `mods/transforms/thumbnails.ts` (and update the 2 legacy single-URL `backgroundImage` assertions in `tests/thumbnails.test.ts`).

### H3. Block `innertubeCommand`-Wrapped & Server-Supplied Inline Previews (`mods/core/resolve-command.ts`, `mods/transforms/previews.ts`)
- **Root Cause:** `needsCommandInterception()` and `wrappedResolve()` only check top-level `startInlinePlaybackCommand` and `commandExecutorCommand.commands`, missing `{ innertubeCommand: { startInlinePlaybackCommand } }` wrappers; meanwhile `addPreviews(items, false)` leaves server-supplied `startInlinePlaybackCommand` intact on Watch/Shorts shelves.
- [x] `[TDD Red: H3]` Assert `patchResolveCommand()` drops `{ innertubeCommand: { startInlinePlaybackCommand } }` on Watch/Shorts and `addPreviews(items, false)` strips server-supplied `startInlinePlaybackCommand` (`tests/regression-fixes.test.ts`, `tests/previews.test.ts`).
- [ ] `[TDD Green: H3]` Recursively unwrap `innertubeCommand` in `resolve-command.ts` and strip `startInlinePlaybackCommand` when `allowInject === false` in `previews.ts`.

---

## Phase 3 — Medium Severity: Lifecycle Hygiene, Async Races, Main-Thread Cost & CI Hardening (`M1`–`M6`)

### M1. Shorts `WEB_PAGE_TYPE_SHORTS` Enter/Exit Cleanup Without `hashchange` (`mods/core/lifecycle.ts`, `mods/features/return-youtube-dislike.ts`, `mods/transforms/shorts-metadata.ts`, `mods/transforms/thumbnails.ts`)
- **Root Cause:** Opening or exiting Shorts on `youtube.com/tv` toggles `body.WEB_PAGE_TYPE_SHORTS` without changing `location.hash`, leaving Shorts RYD fetches/observers alive on Back-to-Home and Home shelf queues un-aborted on Shorts entry.
- [x] `[TDD Red: M1]` Assert `WEB_PAGE_TYPE_SHORTS` exit aborts RYD fetches & disconnects observers (unit + E2E) and `WEB_PAGE_TYPE_SHORTS` entry aborts Home `shorts-metadata` and `thumbnails` fetch queues (`tests/return-youtube-dislike.test.ts`, `tests/shorts-metadata.test.ts`, `tests/thumbnails.test.ts`, `tests/e2e.test.ts`).
- [ ] `[TDD Green: M1]` Observe `document.body` `class` transitions in `mods/core/lifecycle.ts` and wire Shorts enter/exit callbacks in `return-youtube-dislike.ts`, `shorts-metadata.ts`, and `thumbnails.ts`.

### M2. SponsorBlock Async `/next` Update, `null` Video-ID Guard & Slider Layout Resync (`mods/features/sponsorblock.ts`, `mods/transforms/player-overlays.ts`)
- **Root Cause:** Late SponsorBlock resolution mutates detached `/next` arrays in place after store consumption without dispatching a command update, `getActiveSponsorBlockSegments(null)` returns stale segments instead of `[]`, and `mountOverlay()` misses inner `ytlr-progress-bar` `childList` rebuilds (e.g. synthetic chapters).
- [x] `[TDD Red: M2]` Assert `getActiveSponsorBlockSegments(null)` returns `[]`, late cold resolution dispatches a live overlay update, and `ytlr-progress-bar` observes `childList: true` (`tests/sponsorblock.test.ts`).
- [ ] `[TDD Green: M2]` Guard `null`/empty video IDs in `getActiveSponsorBlockSegments`, dispatch live update commands on cold late resolution, and include `childList: true` on progress bar observation.

### M3. Isolate Late-Join Exceptions in `onWatchSession()` (`mods/core/lifecycle.ts`)
- **Root Cause:** `syncWatchSession()` isolates handlers in `try/catch`, but `onWatchSession()` calls `handler(...)` unprotected when joining an already-active Watch session (e.g. cold deep-link into `#/watch?v=...`).
- [x] `[TDD Red: M3]` Assert throwing inside a late-join `onWatchSession()` callback logs via `console.error` without aborting caller registration or subsequent listeners (`tests/lifecycle.test.ts`).
- [ ] `[TDD Green: M3]` Wrap late-join invocation in `try/catch` inside `mods/core/lifecycle.ts`.

### M4. Negative-Cache Empty `200 OK` Shorts Metadata & Clear Placeholder (`mods/transforms/shorts-metadata.ts`)
- **Root Cause:** When `reel_item_watch` returns HTTP `200` with no extractable views/date (`null`), nothing is cached and `\u00A0` remains in the DOM, causing every subsequent D-pad `focusin` to re-POST.
- [x] `[TDD Red: M4]` Assert empty `200 OK` `reel_item_watch` responses are negative-cached and clear `\u00A0` from the mounted DOM so repeated `focusin` does not re-fetch (`tests/shorts-metadata.test.ts`).
- [ ] `[TDD Green: M4]` Cache a negative sentinel in `shortsMetadataCache` and clear placeholder text in `mods/transforms/shorts-metadata.ts`.

### M5. Eliminate Double Badge Filtering & Retained `guide.originalItems` (`mods/core/innertube-interceptor.ts`, `mods/transforms/guide.ts`)
- **Root Cause:** `processShelvesSync()` runs `filterShelvesInPlaceSync()` then re-runs `filterFeedItemsSync()` on surviving `directItems`; `guide.ts` stores unused `section.originalItems = section.items.slice()`.
- [x] `[TDD Red: M5]` Assert direct browse cards scan `badges` once (not twice) and guide sections do not retain `originalItems` (`tests/innertube-interceptor.test.ts`, `tests/guide.test.ts`).
- [ ] `[TDD Green: M5]` Avoid redundant filtering of `directItems` in `innertube-interceptor.ts` and remove `section.originalItems` in `guide.ts` (updating legacy `originalItems` assertions in `tests/guide.test.ts` and `tests/e2e.test.ts`).

### M6. CI Supply-Chain Pinning, Retry SHA Pinning & Monotonic `versionCode` (`.github/workflows/*.yml`, `patches/01-gn-arm-cortex-a73-and-trim.patch`, `mods/package.json`)
- **Root Cause:** Privileged workflows use mutable action tags/branches (`@master`, `@v2`, `@v3`), invoke unpinned `npx --yes`, interpolate `${{ inputs.* }}` in shell blocks, omit `-f cobalt_sha=` on timeout retries, and ship static `version_code = "1"`.
- [x] `[TDD Red: M6]` Assert SHA-pinned third-party actions, zero `npx --yes`, env-bound inputs, retry `cobalt_sha` pinning, and non-static `version_code` (`tests/repo-invariants.test.ts`).
- [ ] `[TDD Green: M6]` Harden `.github/workflows/*.yml`, add `@biomejs/biome` & `knip` to `mods/package.json` `devDependencies`, and wire monotonic `version_code` from `GITHUB_RUN_NUMBER`.

---

## Phase 4 — Low Severity: Dead Code Removal, Native Trim & Defensive Guards (`L1`–`L5`)

### L1. Remove Dead `trusted-types.ts` Wrapper & `<style>` Fallback (`mods/core/trusted-types.ts`, `mods/core/styles.ts`, `mods/index.ts`)
- **Root Cause:** All production callers use `adoptedStyleSheets` exclusively, making `<style>` fallback unreachable and forcing `Document.prototype.createElement` interception across all DOM allocations unnecessarily.
- [x] `[TDD Red: L1]` Assert `mods/core/trusted-types.ts` is removed, `mods/index.ts` does not import it, and `injectCss` takes only `cssText` (`tests/styles.test.ts`).
- [ ] `[TDD Green: L1]` Simplify `mods/core/styles.ts`, remove `mods/core/trusted-types.ts` + import in `mods/index.ts`, and prune legacy `trusted-types.test.ts` / `<style>` fallback test branches.

### L2. Single UTF-16 Static Cache in `Shell::RegisterInjectedJavaScript()` (`patches/04-bundle-local-userscript.patch`)
- **Root Cause:** `patches/04` retains a permanent `std::string` copy and re-converts UTF-8 -> UTF-16 per `Shell`.
- [x] `[TDD Red: L2]` Assert `patches/04-bundle-local-userscript.patch` caches `base::NoDestructor<std::u16string>` directly (`tests/repo-invariants.test.ts`).
- [ ] `[TDD Green: L2]` Update `patches/04-bundle-local-userscript.patch` and verify `verify_patches.py`.

### L3. Signature Check Ordering & `super.onNewIntent` (`patches/09-integrity-check.patch`, `patches/12-deeplink-url-allowlist.patch`)
- **Root Cause:** `verifyApkSignature()` executes after `super.onCreate(savedInstanceState)` (`BaseCobaltActivity.onCreate`), and `onNewIntent` omits `super.onNewIntent(intent)`.
- [x] `[TDD Red: L3]` Assert `verifyApkSignature()` runs before `super.onCreate` in `patches/09` and `super.onNewIntent(intent)` is called in `patches/12` (`tests/repo-invariants.test.ts`).
- [ ] `[TDD Green: L3]` Update `patches/09-integrity-check.patch` and `patches/12-deeplink-url-allowlist.patch`, and verify `verify_patches.py`.

### L4. Remove Duplicate Root Lockfile (`package-lock.json`)
- **Root Cause:** Both root `package-lock.json` and `mods/package-lock.json` exist while CI only installs `mods/`.
- [x] `[TDD Red: L4]` Assert only `mods/package-lock.json` exists (`tests/repo-invariants.test.ts`).
- [ ] `[TDD Green: L4]` Remove root `package-lock.json`.

### L5. Defensive Guards in `player-bar-info.ts` & `innertube-calls.ts`
- **Root Cause:** `mods/features/player-bar-info.ts` calls `requestAnimationFrame` without a timer fallback guard, and `mods/core/innertube-calls.ts` `getFeedbackPanelTokens` / `sendFeedbackToken` hang if the Observable completes empty without emitting `next`.
- [x] `[TDD Red: L5]` Assert `scheduleRender` falls back cleanly without `requestAnimationFrame` (`tests/player-bar-info.test.ts`) and feedback calls settle when `subscribe` completes empty (`tests/innertube-calls.test.ts`).
- [ ] `[TDD Green: L5]` Add fallback scheduling in `player-bar-info.ts` and `complete`/timeout settlement in `innertube-calls.ts`.
