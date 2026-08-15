# Handoff Prompt — Headspace Spotify Phase 1 Refactor

Paste everything below the line into the agent (Grok) with the repo open at the project root.

---

# Task: Phase 1 architectural refactor of "headspace-spotify"

You are working in an existing repo: **headspace-spotify**, an Electron + Vite + TypeScript desktop app that recreates the classic Headspace alien-head Windows Media Player skin as a Spotify client. A full audit has already been done. Your job is **Phase 1 only: restructure and harden — do not add features, do not change visual design, do not change behavior the tests rely on.**

## Repo orientation (verified facts, trust these)

- `src/main/` — Electron main process, compiled to CJS via `tsconfig.main.json` → `dist-main/`. Entry: `main.ts` (window creation, drag, IPC handlers, OAuth PKCE flow, Widevine/castlabs setup).
- `src/main/preload.ts` — contextBridge exposing `window.headspace` (all IPC).
- `src/renderer/` — bundled by Vite (`vite.config.mts`, `root: src/renderer`, `publicDir: assets/converted`) → `dist-renderer/`. Entry `renderer.ts` (**1447 lines, the god-file to split**), `index.html` (**2013 lines: ~1878 lines of inline CSS + ~124 lines of DOM**).
- Build: `npm run build` (= `build:main` + `build:renderer`). Run: `npm start`. Test: `npm test` (Playwright launches real Electron; `tests/face_alive_motion.test.ts`).
- Skin geometry constants (DO NOT CHANGE): head 234×394 at x=261; closed width 549, playlist-open width 760, height 394; ear slide deltas PL=211px / EQ=-207px.
- `.env` holds `SPOTIFY_CLIENT_ID` (gitignored). OAuth redirect: `http://127.0.0.1:8888/callback`.

## Hard constraints (breaking these = broken app or broken tests)

1. **The Playwright test must keep passing.** It depends on: `#nose-hitbox` existing and toggling alive mode after 5 clicks in <2s; `window.__faceAlive` debug API (`getEyeState/activate/deactivate/forceBlink/setDebugOverlay`); `document.body.classList` gaining `face-alive`; the `HEADSPACE_FACE_TEST=1` env behavior in `main.ts` (suppresses OS-cursor polling); eye motion constants in `face-alive.ts` (`SOCKET_RADIUS_X=20.5`, `EYE_MAX_UP_Y=4.2`, `EYE_MAX_DOWN_Y=7.0`). Do not touch `face-alive.ts` / `face-alive-eyes.ts` / `speaker-cones.ts` logic at all in this phase.
2. **No visual changes.** Same bitmaps, same CSS output, same DOM ids/classes. You may move CSS to a file but every rule must be preserved verbatim.
3. **Keep all working IPC channel names** (`hit-test`, `window:*`, `drag:*`, `alive:*`, `sp:*`, `auth:*`, `lyrics:get`, `system:*`). You may delete channels listed as dead below, but never rename live ones.
4. Stay with vanilla TypeScript — no framework, no new runtime dependencies.
5. Keep code comments that explain *why* (the file headers are good); delete comments only with the dead code they describe.

## Work items (do all, in this order)

### 1. Shared Spotify types — kill the 4 duplicate definitions

Spotify types are currently defined separately in `src/main/spotify-api.ts`, `src/renderer/spotify-player.ts`, `src/renderer/library-browser.ts` (as `SpotifyTrackLite`/`SpotifyPlaylistLite`), and `src/renderer/queue-view.ts` (as `QueueTrack`). Create `src/shared/spotify-types.ts` with the canonical set (SpotifyImage, SpotifyArtist, SpotifyAlbum, SpotifyTrack, SpotifyEpisode, SpotifyPlaylist, SpotifyUser, LibraryItem, PlaybackDevice, PlaybackState, QueueItem/QueueResponse, AuthStatus) and a `Result<T> = T | { error: string }` helper type. Make all four files import from it.

**Build gotcha — solve it explicitly:** `tsconfig.main.json` has `"rootDir": "src/main"`, so importing `../shared/...` from main will fail. Fix by setting `rootDir: "src"`, `include: ["src/main/**/*.ts", "src/shared/**/*.ts"]` — then the output layout shifts to `dist-main/main/*.js`, so you MUST also update:
- `package.json` → `"main": "dist-main/main/main.js"`
- `src/main/main.ts` → `win.loadFile(join(__dirname, "..", "..", "dist-renderer", "index.html"))`
- preload path `join(__dirname, "preload.js")` still works (same dir).

Vite (renderer) handles `../shared` imports fine with `moduleResolution: Bundler`; add `"src/shared/**/*.ts"` to `tsconfig.json` include.

### 2. Typed IPC layer

Create `src/shared/ipc-api.ts` exporting a single `HeadspaceApi` interface describing every `window.headspace` method with real parameter and return types (replace today's `Promise<unknown>` soup). Make `preload.ts` `satisfies HeadspaceApi`. Add `src/renderer/global.d.ts` (or extend the existing declare-global in one place) so `window.headspace: HeadspaceApi` — then delete the giant `declare global` block in `renderer.ts` and every `as unknown`/`"error" in res` cast that the types make redundant.

### 3. Delete dead code

- **Local-files path (fully dead):** remove from `main.ts` — `TrackRecord`, `artCache`, `pictureToDataUrl`, `readTrackMeta`, `readCoverArt`, `getMM`, and the `files:pick` / `files:enrich` / `files:art` handlers. Remove `pickFiles`/`enrichPaths`/`getArt` from `preload.ts`. Remove `music-metadata` from `package.json` dependencies and run `npm install` to update the lockfile.
- **`window:set-width` handler in `main.ts` + `setWidth` in preload** — unused (SkinState uses `setSize`).
- **Dead markup in `index.html`:** `#slot-balance`, `#slot-volume`, `#eq-bands`, `#eq-reset` inside `#eq-panel` — `setupQueueDrawerStub()` overwrites `#eq-panel.innerHTML` at boot. Delete the stale children, keep `#eq-panel` itself.
- **Audio-analysis probe:** Spotify killed `/audio-analysis` for new apps (Nov 2024), so `spAnalysis` currently wastes one doomed request per track. Keep the endpoint but add a session-level latch in the renderer: after the first `{ error }` response, stop calling it and go straight to `buildSyntheticAnalysis`.
- Remove `void transport; void VIS_MODES; void library;` no-op statements and the unused `BUTTONS` constant in `transport.ts` (keep behavior identical).

### 4. Extract CSS + harden the window

- Move the entire `<style>` block of `src/renderer/index.html` (roughly lines 6–1884) verbatim into `src/renderer/skin.css` and reference it with `<link rel="stylesheet" href="./skin.css">`. Vite bundles it; the built app loads from file:// — keep `base: "./"` working.
- Add a CSP meta tag to `index.html`. It must allow: scripts from `'self'` and `https://sdk.scdn.co` (Spotify Web Playback SDK); styles `'self'`; images `'self'`, `data:`, `https://i.scdn.co` (album art); media `blob:`; connect to `'self'`, `https://*.spotify.com`, `https://*.scdn.co`, `wss://*.spotify.com`, `wss://*.scdn.co`; frames from `https://sdk.scdn.co`. Verify the SDK still initializes after adding it (this is the risk item — if connect-src misses a Spotify websocket host, playback silently falls back to Connect mode; check the diagnostics panel in Settings).
- Add `sandbox: true` to `webPreferences` in `main.ts` (preload only uses `contextBridge` + `ipcRenderer`, so it's compatible) and confirm the app boots.

### 5. Split `renderer.ts` (1447 lines) into modules

Keep `renderer.ts` as a thin bootstrap that imports and wires modules. Suggested split (adjust names if you see a cleaner cut, but each concern must leave renderer.ts):

- `hit-test.ts` — head-mask building, `isOpaqueAt`, pointer hit-test wiring, drag wiring, `drawDebugMask`
- `auth-flow.ts` — auth overlay wiring + sign-in button flow
- `status-overlay.ts` — `showStatus`/`hideStatus`/`StatusAction` + `playbackErrorText`/`showPlaybackError`/`runPlaybackCommand`
- `lyrics-panel.ts` — all lyrics state, fetch, tick, and overlay rendering (the parser stays in `lyrics.ts`)
- `vis-menu.ts` — right-click visualizer context menu
- `milkdrop-driver.ts` — butterchurn lazy-init, preset cycling/lock, drop-driven preset switching, `applyVisModeUI`
- `now-playing.ts` — `renderLeftNow`, seek-fill updates, per-track-change orchestration (palette, lyrics reset, analysis latch)
- `settings-panel.ts` — `renderSpotifySettings`, runtime diagnostics rendering + the `summarizeWidevineDiag`/`formatDeviceDiag`/`formatLastCommandDiag` helpers
- `theme-cycler.ts` — theme state, button, auto-hue application
- `mini-mode.ts` — desk-buddy mode + drawer/mini interplay, if it separates cleanly from `SkinState` wiring

Cross-module communication: pass explicit dependencies via constructor/options (the codebase already does this — e.g. `LibraryBrowser(container, controller, opts)`). Do NOT introduce an event-bus library or a DI framework.

### 6. Spotify API resilience (`src/main/spotify-api.ts`)

- **429 handling:** on HTTP 429, read `Retry-After`, wait, retry (max 3 attempts, exponential fallback if header absent).
- **401 retry:** on 401, re-invoke the configured token getter once (it refreshes transparently) and retry the request once before throwing.
- **Refresh mutex in `main.ts` `getValidAccessToken`:** coalesce concurrent refreshes into one in-flight promise so parallel API calls can't double-refresh.
- **OAuth port fallback:** if port 8888 is occupied (`EADDRINUSE`), retry on the next ports (8889–8893) and surface which port was used in the sign-in error/status text so the user can register it. Keep 8888 the default.

## Verify before declaring done

1. `npm run build` — both bundles compile with zero TS errors.
2. `npm test` — the Playwright face-alive suite passes (it launches the real app; on Windows just run it, don't use headless flags).
3. `npm start` boots; with a valid `.env` smoke-test: sign-in overlay → SDK or Connect mode → transport buttons → both drawers → right-click vis menu → 5-click nose toggle → Ctrl+Shift+A HUD → theme cycle → mini mode.
4. `git diff --stat` sanity: no changes to `face-alive.ts`, `face-alive-eyes.ts`, `speaker-cones.ts`, `assets/`, `tests/`.
5. Confirm `music-metadata` is gone from `package.json` + lockfile.

## Explicitly out of scope (later phases — don't do these)

- Like button, shuffle/repeat, device picker, drag-scrubbing, Top tab, tray/global hotkeys (Phase 2)
- Alive-mode emotional reactions, persistence, yawn/sleep (Phase 3)
- Visualizer perf passes, rAF gating, spectrogram ImageData, beat-index seek fix (Phase 4)
- electron-builder packaging, CI (Phase 5)

## Style notes

- Match the existing code style: header comment per file explaining the *why*, strict TS, no `any` unless casting across an untyped external boundary (Spotify SDK, butterchurn).
- The repo's voice in comments is precise and a little playful — keep it.
- Commit logically: one commit per work item above, messages in the repo's existing imperative style (see `git log --oneline`).
