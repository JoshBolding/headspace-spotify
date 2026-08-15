import {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  session,
  shell,
  Tray,
} from "electron";

// Allow audio playback without a user gesture per call. Spotify Web Playback
// SDK starts streams from async callbacks (post-OAuth, post-API), which fall
// outside Electron 41's default "user-gesture-required" autoplay policy.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
// `components` is the castlabs/electron-releases Widevine loader. Without
// loading it before window creation, the Spotify Web Playback SDK can't
// decrypt the audio stream and falls back to Connect mode.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { components } = require("electron") as {
  components?: {
    whenReady: (required?: string[]) => Promise<unknown>;
    status: () => unknown;
    updatesEnabled?: boolean;
    WIDEVINE_CDM_ID?: string;
    MEDIA_FOUNDATION_WIDEVINE_CDM_ID?: string;
  };
};
const DEBUG_BOOT_LOGS = process.env.HEADSPACE_DEBUG_BOOT === "1";
import { existsSync } from "node:fs";
import { join } from "path";

import {
  loadConfig,
  OAUTH_FALLBACK_PORTS,
  REDIRECT_PORT,
  redirectUriForPort,
} from "./spotify-config";
import {
  buildAuthorizeUrl,
  exchangeCode,
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
  refreshAccessToken,
} from "./auth-pkce";
import { startCallbackServerWithFallback } from "./oauth-server";
import {
  clearTokens,
  loadTokens,
  saveTokens,
  type StoredTokens,
} from "./token-store";
import * as Sp from "./spotify-api";
import { getLyrics, type LyricsRequest } from "./lyrics";

// Native skin geometry. Closed = ears tucked. We start in closed mode.
const VIEW_W_CLOSED = 549;
const VIEW_W_OPENED = 760;
const VIEW_H = 394;

let win: BrowserWindow | null = null;
let tray: Tray | null = null;

function createWindow() {
  win = new BrowserWindow({
    width: VIEW_W_CLOSED,
    height: VIEW_H,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    title: "Headspace Spotify",
    backgroundColor: "#00000000",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Transparent always-on-top windows can spawn on a dead monitor. Park it
  // on the primary display so the user can actually find the head.
  const primary = screen.getPrimaryDisplay().workArea;
  win.setPosition(
    Math.round(primary.x + (primary.width - VIEW_W_CLOSED) / 2),
    Math.round(primary.y + (primary.height - VIEW_H) / 2),
  );
  win.setAlwaysOnTop(true, "screen-saver");
  win.show();
  win.focus();
  win.moveTop();

  // Load: dev server when running with vite, otherwise built renderer.
  // DevTools opens automatically only in dev (when HEADSPACE_DEV_URL is set);
  // production builds load the bundled renderer with no devtools.
  const devUrl = process.env.HEADSPACE_DEV_URL;
  if (devUrl) {
    win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadFile(join(__dirname, "..", "..", "dist-renderer", "index.html"));
  }

  let isDragging = false;
  let dragGrab: { dx: number; dy: number } | null = null;
  let dragTimer: NodeJS.Timeout | null = null;
  let lastDragPos: { x: number; y: number } | null = null;
  let aliveCursorTimer: NodeJS.Timeout | null = null;

  // Renderer still sends hit-test, but we must not call setIgnoreMouseEvents
  // on this transparent frameless window — that combination stops Chromium
  // compositing after the first event, so the head paints for 2–3s then vanishes.
  ipcMain.on("hit-test", (_evt, _isOverOpaque: boolean) => {
    /* keep the window fully interactive */
  });

  ipcMain.on("window:minimize", () => win?.minimize());
  ipcMain.on("window:close", () => win?.close());
  // Smooth custom drag for the transparent, click-through shaped window.
  // Native CSS drag regions don't behave reliably with setIgnoreMouseEvents,
  // so main owns the drag and samples the OS cursor directly.
  function stopDragTimer() {
    if (dragTimer) {
      clearInterval(dragTimer);
      dragTimer = null;
    }
  }

  ipcMain.on("drag:start", (_evt, dx: number, dy: number) => {
    if (!win) return;
    isDragging = true;
    dragGrab = { dx: Math.round(dx), dy: Math.round(dy) };
    lastDragPos = null;
    win.setIgnoreMouseEvents(false);
    stopDragTimer();
    dragTimer = setInterval(() => {
      if (!win || !dragGrab) return;
      const p = screen.getCursorScreenPoint();
      const x = p.x - dragGrab.dx;
      const y = p.y - dragGrab.dy;
      if (lastDragPos?.x === x && lastDragPos.y === y) return;
      lastDragPos = { x, y };
      win.setPosition(x, y, false);
    }, 8);
  });

  ipcMain.on("drag:end", () => {
    isDragging = false;
    dragGrab = null;
    lastDragPos = null;
    stopDragTimer();
  });

  // Global cursor tracking for the alive-mode eyes. The renderer only receives
  // pointermove events while the cursor is over the window, so on its own the
  // gaze can't follow the cursor out across the rest of the screen. While
  // alive mode is active we poll the OS cursor (same API the drag uses) and
  // stream it window-relative so the eyes can track it anywhere on the display.
  ipcMain.on("alive:set-cursor-tracking", (_evt, on: boolean) => {
    if (aliveCursorTimer) {
      clearInterval(aliveCursorTimer);
      aliveCursorTimer = null;
    }
    if (!on || !win) return;
    // The face test (and the capture script) drive a SYNTHETIC mouse via DOM
    // events, which doesn't move the OS cursor — polling the real cursor would
    // fight it. In those runs, leave the renderer's own pointermove in charge.
    if (process.env.HEADSPACE_FACE_TEST === "1") return;
    aliveCursorTimer = setInterval(() => {
      if (!win || win.isDestroyed()) return;
      const p = screen.getCursorScreenPoint();
      const b = win.getBounds();
      // Window-relative DIP == renderer CSS px, so this maps straight onto
      // clientX/clientY that the eye-tracking math already expects.
      win.webContents.send("alive:cursor", { x: p.x - b.x, y: p.y - b.y });
    }, 16);
  });

  ipcMain.on("window:toggle-on-top", () => {
    if (!win) return;
    win.setAlwaysOnTop(!win.isAlwaysOnTop());
  });

  ipcMain.on("window:set-size", (_evt, w: number, h: number) => {
    if (!win) return;
    win.setSize(Math.round(w), Math.round(h));
  });

  // === Spotify auth ============================================
  /** Coalesce concurrent refreshes so parallel API calls don't double-refresh. */
  let refreshInFlight: Promise<string | null> | null = null;

  /** Returns a valid access token, refreshing if near or past expiry. */
  async function getValidAccessToken(opts?: {
    forceRefresh?: boolean;
  }): Promise<string | null> {
    const tokens = await loadTokens();
    if (!tokens) return null;
    // Refresh if forced (401 retry) or within 60s of expiry.
    if (!opts?.forceRefresh && Date.now() < tokens.expiresAt - 60_000) {
      return tokens.accessToken;
    }
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      try {
        const config = loadConfig();
        const fresh = await refreshAccessToken({
          clientId: config.clientId,
          refreshToken: tokens.refreshToken,
        });
        const updated: StoredTokens = {
          accessToken: fresh.access_token,
          // Spotify may or may not rotate the refresh token; keep old if absent.
          refreshToken: fresh.refresh_token ?? tokens.refreshToken,
          expiresAt: Date.now() + fresh.expires_in * 1000,
          scope: fresh.scope,
        };
        await saveTokens(updated);
        return updated.accessToken;
      } catch {
        // Refresh failed — likely revoked. Clear and require re-auth.
        await clearTokens();
        win?.webContents.send("auth:changed", { authenticated: false });
        return null;
      } finally {
        refreshInFlight = null;
      }
    })();
    return refreshInFlight;
  }

  ipcMain.handle("auth:status", async () => {
    const tokens = await loadTokens();
    return {
      authenticated: !!tokens,
      expiresAt: tokens?.expiresAt,
      scope: tokens?.scope,
    };
  });

  ipcMain.handle("auth:get-token", async () => getValidAccessToken());

  // Provide the API client a way to get a valid access token transparently.
  Sp.configureSpotifyApi(getValidAccessToken);

  // === Spotify Web API IPC handlers ============================================
  const wrap = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (_evt: unknown, ...args: A): Promise<R | { error: string }> => {
      try {
        return await fn(...args);
      } catch (err) {
        return { error: (err as Error).message };
      }
    };

  ipcMain.handle("sp:user", wrap(Sp.getCurrentUser));
  ipcMain.handle("sp:liked", wrap(Sp.getLikedTracks));
  ipcMain.handle("sp:playlists", wrap(Sp.getMyPlaylists));
  ipcMain.handle("sp:recent", wrap(Sp.getRecentlyPlayed));
  ipcMain.handle("sp:top", wrap(Sp.getTopTracks));
  ipcMain.handle("sp:search", wrap(Sp.searchTracks));
  ipcMain.handle("sp:playlist-tracks", wrap(Sp.getPlaylistTracks));
  ipcMain.handle("sp:devices", wrap(Sp.getDevices));
  ipcMain.handle("sp:transfer", wrap(Sp.transferPlayback));
  ipcMain.handle("sp:play", wrap(Sp.play));
  ipcMain.handle("sp:pause", wrap(Sp.pause));
  ipcMain.handle("sp:next", wrap(Sp.nextTrack));
  ipcMain.handle("sp:previous", wrap(Sp.previousTrack));
  ipcMain.handle("sp:seek", wrap(Sp.seek));
  ipcMain.handle("sp:set-volume", wrap(Sp.setVolume));
  ipcMain.handle("sp:state", wrap(Sp.getPlaybackState));
  ipcMain.handle("sp:queue", wrap(Sp.getQueue));
  ipcMain.handle("sp:add-queue", wrap(Sp.addToQueue));
  ipcMain.handle("sp:analysis", wrap(Sp.getAudioAnalysis));
  ipcMain.handle("sp:liked-contains", wrap(Sp.tracksAreSaved));
  ipcMain.handle("sp:save-tracks", wrap(Sp.saveTracks));
  ipcMain.handle("sp:unsave-tracks", wrap(Sp.removeSavedTracks));
  ipcMain.handle("sp:shuffle", wrap(Sp.setShuffle));
  ipcMain.handle("sp:repeat", wrap(Sp.setRepeat));

  ipcMain.handle("lyrics:get", async (_evt, req: LyricsRequest) => {
    return getLyrics(req);
  });

  ipcMain.handle("system:loopback-source-id", async () => {
    const sources = await desktopCapturer.getSources({ types: ["screen"] });
    return sources[0]?.id ?? null;
  });

  ipcMain.handle("system:diag", () => ({
    electronVersion: process.versions.electron,
    chromeVersion: process.versions.chrome,
    nodeVersion: process.versions.node,
    platform: process.platform,
    userDataPath: app.getPath("userData"),
    components: lastComponentsStatus,
  }));

  /**
   * Wipes the Widevine component cache and re-runs `components.whenReady()`.
   * Useful when the first install was interrupted (AV / network / partial dl).
   */
  ipcMain.handle("system:reset-widevine", async () => {
    const fsx = await import("node:fs/promises");
    const path = await import("node:path");
    const cacheDirs = [
      // castlabs writes downloaded components under userData/component_crx_cache
      // and extracts Windows Widevine under MediaFoundationWidevineCdm. Older
      // experiments used Components/WidevineCdm, so keep those in the reset set.
      path.join(app.getPath("userData"), "Components"),
      path.join(app.getPath("userData"), "WidevineCdm"),
      path.join(app.getPath("userData"), "MediaFoundationWidevineCdm"),
      path.join(app.getPath("userData"), "component_crx_cache"),
    ];
    const removed: string[] = [];
    for (const dir of cacheDirs) {
      try {
        await fsx.rm(dir, { recursive: true, force: true });
        removed.push(dir);
      } catch {
        /* may not exist */
      }
    }
    await loadWidevine();
    return { removed, components: lastComponentsStatus };
  });

  let activeAuthFlow = false;
  ipcMain.handle("auth:sign-in", async (_evt, opts?: { showDialog?: boolean }) => {
    if (activeAuthFlow) return { success: false, error: "already_in_progress" };
    activeAuthFlow = true;
    let config;
    try {
      config = loadConfig();
    } catch (err) {
      activeAuthFlow = false;
      return { success: false, error: (err as Error).message };
    }

    const verifier = generateCodeVerifier();
    const challenge = generateCodeChallenge(verifier);
    const state = generateState();

    return new Promise<{ success: boolean; error?: string }>((resolve) => {
      let resolved = false;
      const finish = (result: { success: boolean; error?: string }) => {
        if (resolved) return;
        resolved = true;
        activeAuthFlow = false;
        resolve(result);
      };

      void (async () => {
        let server: { close: () => void };
        let port = REDIRECT_PORT;
        try {
          const started = await startCallbackServerWithFallback({
            ports: OAUTH_FALLBACK_PORTS,
            onResult: async (cb) => {
              const portHint =
                port !== REDIRECT_PORT
                  ? ` Callback was ${redirectUriForPort(port)} — register this Redirect URI in the Spotify dashboard if 8888 was taken.`
                  : "";
              if (cb.error) return finish({ success: false, error: cb.error + portHint });
              if (cb.state !== state)
                return finish({ success: false, error: "state_mismatch" + portHint });
              if (!cb.code)
                return finish({ success: false, error: "missing_code" + portHint });
              try {
                const tokens = await exchangeCode({
                  clientId: config.clientId,
                  code: cb.code,
                  codeVerifier: verifier,
                  redirectUri: redirectUriForPort(port),
                });
                await saveTokens({
                  accessToken: tokens.access_token,
                  refreshToken: tokens.refresh_token ?? "",
                  expiresAt: Date.now() + tokens.expires_in * 1000,
                  scope: tokens.scope,
                });
                win?.webContents.send("auth:changed", { authenticated: true });
                finish({ success: true });
              } catch (err) {
                finish({
                  success: false,
                  error: (err as Error).message + portHint,
                });
              }
            },
          });
          server = started.server;
          port = started.port;
        } catch (err) {
          const e = err as NodeJS.ErrnoException;
          if (e.code === "EADDRINUSE") {
            return finish({
              success: false,
              error:
                "Could not bind OAuth callback on ports 8888–8893 (all in use). Close the other listener, or register one of those ports as a Redirect URI.",
            });
          }
          return finish({ success: false, error: (err as Error).message });
        }

        const redirectUri = redirectUriForPort(port);
        const authorizeUrl = buildAuthorizeUrl({
          clientId: config.clientId,
          redirectUri,
          codeChallenge: challenge,
          scopes: config.scopes,
          state,
          showDialog: opts?.showDialog,
        });
        void shell.openExternal(authorizeUrl);

        setTimeout(() => {
          try {
            server.close();
          } catch {
            /* ignore */
          }
          const portHint =
            port !== REDIRECT_PORT
              ? ` Callback was ${redirectUri}.`
              : "";
          finish({ success: false, error: "timeout" + portHint });
        }, 5 * 60 * 1000);
      })();
    });
  });

  ipcMain.handle("auth:sign-out", async () => {
    await clearTokens();
    win?.webContents.send("auth:changed", { authenticated: false });
    return true;
  });

  win.on("closed", () => {
    win = null;
  });

  win.webContents.on("render-process-gone", (_e, details) => {
    console.error("[headspace] renderer gone:", details.reason, details.exitCode);
  });
  win.webContents.on("did-fail-load", (_e, code, desc) => {
    console.error("[headspace] load failed:", code, desc);
  });

  try {
    setupTrayAndHotkeys();
  } catch (err) {
    console.warn("[headspace] tray/hotkeys skipped:", err);
  }
}

let allowQuit = false;

async function runMediaCommand(cmd: "toggle" | "next" | "prev"): Promise<void> {
  try {
    if (cmd === "next") {
      await Sp.nextTrack();
      return;
    }
    if (cmd === "prev") {
      await Sp.previousTrack();
      return;
    }
    const state = await Sp.getPlaybackState();
    if (state?.is_playing) await Sp.pause();
    else await Sp.play({});
  } catch (err) {
    console.warn("[headspace] media command failed:", cmd, err);
  }
}

function setupTrayAndHotkeys(): void {
  if (process.env.HEADSPACE_FACE_TEST === "1") return;
  if (tray) return;

  const iconPath = [
    join(app.getAppPath(), "dist-renderer", "head.png"),
    join(process.resourcesPath ?? "", "head.png"),
    join(app.getAppPath(), "assets", "converted", "head.png"),
  ].find((p) => existsSync(p)) ?? join(app.getAppPath(), "assets", "converted", "head.png");
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    console.warn("[headspace] tray icon missing, skipping tray");
    return;
  }
  image = image.resize({ width: 16, height: 16 });
  tray = new Tray(image);
  tray.setToolTip("Headspace");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Show",
        click: () => {
          win?.show();
          win?.focus();
        },
      },
      { type: "separator" },
      { label: "Play / Pause", click: () => void runMediaCommand("toggle") },
      { label: "Next", click: () => void runMediaCommand("next") },
      { label: "Previous", click: () => void runMediaCommand("prev") },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
  tray.on("double-click", () => {
    win?.show();
    win?.focus();
  });

  const bind = (accel: string, cmd: "toggle" | "next" | "prev") => {
    try {
      globalShortcut.register(accel, () => void runMediaCommand(cmd));
    } catch {
      /* already claimed by another app */
    }
  };
  bind("MediaPlayPause", "toggle");
  bind("MediaNextTrack", "next");
  bind("MediaPreviousTrack", "prev");
  bind("CommandOrControl+Alt+P", "toggle");
  bind("CommandOrControl+Alt+Right", "next");
  bind("CommandOrControl+Alt+Left", "prev");
}

async function loadWidevine(): Promise<void> {
  if (!components?.whenReady) {
    console.warn("[headspace] No components API - using stock Electron.");
    lastComponentsStatus = { error: "components_api_unavailable" };
    return;
  }
  // Don't hard-require WIDEVINE_CDM_ID. On Windows the Media Foundation
  // CDM is the one that actually installs; requiring the classic id throws
  // "Failed to install required components" even when MF Widevine is fine.
  // Castlabs' own sample just calls whenReady() with no filter.
  const attempts: Array<string[] | undefined> = [undefined];
  if (components.MEDIA_FOUNDATION_WIDEVINE_CDM_ID) {
    attempts.push([components.MEDIA_FOUNDATION_WIDEVINE_CDM_ID]);
  }
  if (components.WIDEVINE_CDM_ID) {
    attempts.push([components.WIDEVINE_CDM_ID]);
  }

  let lastErr: unknown;
  for (const required of attempts) {
    try {
      if (DEBUG_BOOT_LOGS) {
        console.log("[headspace] waiting for Widevine...", required ?? "(any)");
      }
      const t0 = Date.now();
      const result = await components.whenReady(required);
      const diag = {
        ready: true,
        elapsedMs: Date.now() - t0,
        updatesEnabled: components.updatesEnabled,
        widevineId: components.WIDEVINE_CDM_ID,
        mediaFoundationWidevineId: components.MEDIA_FOUNDATION_WIDEVINE_CDM_ID,
        required: required ?? null,
        result,
        status: components.status?.(),
      };
      if (DEBUG_BOOT_LOGS) {
        console.log("[headspace] Widevine ready", JSON.stringify(diag, null, 2));
      }
      lastComponentsStatus = diag;
      return;
    } catch (err) {
      lastErr = err;
      console.warn(
        "[headspace] Widevine whenReady failed",
        required ?? "(any)",
        err,
      );
    }
  }

  const e = lastErr as Error;
  lastComponentsStatus = {
    ready: false,
    error: String(lastErr),
    name: e?.name,
    errors: (lastErr as { errors?: unknown })?.errors,
    stack: e?.stack?.split("\n").slice(0, 5).join("\n"),
  };
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

app.whenReady().then(async () => {
  if (!gotTheLock) return;
  await loadWidevine();

  // Register a getDisplayMedia handler so the renderer can grab system-audio
  // loopback for the visualizer. Without this, Electron returns
  // NotSupportedError. We auto-grant the first screen + 'loopback' audio (a
  // Windows-only Electron feature that captures system audio directly without
  // a screen picker). Since this is the user's own app, no consent prompt
  // is shown. The video track is discarded immediately in the renderer.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ["screen"] })
        .then((sources) => {
          callback({ video: sources[0], audio: "loopback" });
        })
        .catch((err) => {
          console.warn("[main] desktopCapturer failed:", err);
          callback({});
        });
    },
    { useSystemPicker: false },
  );

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

let lastComponentsStatus: unknown = null;

app.on("before-quit", () => {
  allowQuit = true;
  globalShortcut.unregisterAll();
  tray?.destroy();
  tray = null;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
