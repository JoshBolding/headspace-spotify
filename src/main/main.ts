import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  screen,
  session,
  shell,
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
  components?: { whenReady: () => Promise<void>; status: () => unknown };
};
import { join, basename } from "path";
import { pathToFileURL } from "url";

import { loadConfig, REDIRECT_PORT } from "./spotify-config";
import {
  buildAuthorizeUrl,
  exchangeCode,
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
  refreshAccessToken,
} from "./auth-pkce";
import { startCallbackServer } from "./oauth-server";
import {
  clearTokens,
  loadTokens,
  saveTokens,
  type StoredTokens,
} from "./token-store";
import * as Sp from "./spotify-api";
import { getLyrics, type LyricsRequest } from "./lyrics";

// music-metadata is ESM-only since v9; dynamic import keeps the main process CJS.
type MMod = typeof import("music-metadata");
let mmModule: Promise<MMod> | null = null;
function getMM(): Promise<MMod> {
  if (!mmModule) mmModule = import("music-metadata");
  return mmModule;
}

interface TrackRecord {
  path: string;
  url: string;
  name: string;
  title?: string;
  artist?: string;
  album?: string;
  durationSec?: number;
}

// Per-path cover-art cache populated on enrichment so subsequent getArt
// calls are instant. Memory cost is bounded by playlist size.
const artCache = new Map<string, string | null>();

function pictureToDataUrl(pic: { format?: string; data: Buffer | Uint8Array }): string {
  const mime = pic.format || "image/jpeg";
  const buf = Buffer.isBuffer(pic.data) ? pic.data : Buffer.from(pic.data);
  return `data:${mime};base64,${buf.toString("base64")}`;
}

async function readTrackMeta(path: string): Promise<TrackRecord> {
  const url = pathToFileURL(path).href;
  const name = basename(path);
  try {
    const mm = await getMM();
    // Single pass: read tags + cover so getArt later is a cache hit.
    const meta = await mm.parseFile(path);
    const pic = meta.common.picture?.[0];
    artCache.set(path, pic ? pictureToDataUrl(pic) : null);
    return {
      path,
      url,
      name,
      title: meta.common.title?.trim() || undefined,
      artist: meta.common.artist?.trim() || meta.common.albumartist?.trim() || undefined,
      album: meta.common.album?.trim() || undefined,
      durationSec: meta.format.duration ?? undefined,
    };
  } catch {
    return { path, url, name };
  }
}

async function readCoverArt(path: string): Promise<string | null> {
  if (artCache.has(path)) return artCache.get(path) ?? null;
  // Fallback path: track wasn't enriched (e.g. restored from localStorage).
  try {
    const mm = await getMM();
    const meta = await mm.parseFile(path);
    const pic = meta.common.picture?.[0];
    const url = pic ? pictureToDataUrl(pic) : null;
    artCache.set(path, url);
    return url;
  } catch {
    artCache.set(path, null);
    return null;
  }
}

// Native skin geometry. Closed = ears tucked. We start in closed mode.
const VIEW_W_CLOSED = 549;
const VIEW_W_OPENED = 760;
const VIEW_H = 394;

let win: BrowserWindow | null = null;

function createWindow() {
  win = new BrowserWindow({
    width: VIEW_W_CLOSED,
    height: VIEW_H,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    alwaysOnTop: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Load: dev server when running with vite, otherwise built renderer.
  // DevTools opens automatically only in dev (when HEADSPACE_DEV_URL is set);
  // production builds load the bundled renderer with no devtools.
  const devUrl = process.env.HEADSPACE_DEV_URL;
  if (devUrl) {
    win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadFile(join(__dirname, "..", "dist-renderer", "index.html"));
  }

  let isDragging = false;
  let dragGrab: { dx: number; dy: number } | null = null;
  let dragTimer: NodeJS.Timeout | null = null;
  let lastDragPos: { x: number; y: number } | null = null;

  // Alpha-aware click-through: renderer sends us hit-test results per pointer move.
  // True = forward clicks to whatever is behind; false = window receives clicks normally.
  ipcMain.on("hit-test", (_evt, isOverOpaque: boolean) => {
    if (!win) return;
    if (isDragging) return;
    win.setIgnoreMouseEvents(!isOverOpaque, { forward: true });
  });

  ipcMain.on("window:minimize", () => win?.minimize());
  ipcMain.on("window:close", () => win?.close());
  ipcMain.on("window:set-width", (_evt, width: number) => {
    if (!win) return;
    const [, h] = win.getSize();
    win.setSize(Math.round(width), h);
  });

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

  ipcMain.on("window:toggle-on-top", () => {
    if (!win) return;
    win.setAlwaysOnTop(!win.isAlwaysOnTop());
  });

  ipcMain.on("window:set-size", (_evt, w: number, h: number) => {
    if (!win) return;
    win.setSize(Math.round(w), Math.round(h));
  });

  ipcMain.handle("files:pick", async () => {
    if (!win) return [];
    const result = await dialog.showOpenDialog(win, {
      title: "Select audio files",
      filters: [
        {
          name: "Audio",
          extensions: ["mp3", "wav", "m4a", "aac", "ogg", "flac", "opus"],
        },
      ],
      properties: ["openFile", "multiSelections"],
    });
    if (result.canceled) return [];
    return Promise.all(result.filePaths.map(readTrackMeta));
  });

  ipcMain.handle("files:enrich", async (_evt, paths: string[]) => {
    return Promise.all(paths.map(readTrackMeta));
  });

  ipcMain.handle("files:art", async (_evt, path: string) => {
    return readCoverArt(path);
  });

  // === Spotify auth ============================================
  /** Returns a valid access token, refreshing if near or past expiry. */
  async function getValidAccessToken(): Promise<string | null> {
    const tokens = await loadTokens();
    if (!tokens) return null;
    // Refresh if within 60s of expiry to avoid race during first API call.
    if (Date.now() < tokens.expiresAt - 60_000) return tokens.accessToken;
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
    }
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
      // castlabs writes downloaded components under userData/Components/...
      path.join(app.getPath("userData"), "Components"),
      path.join(app.getPath("userData"), "WidevineCdm"),
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

      const server = startCallbackServer({
        port: REDIRECT_PORT,
        onResult: async (cb) => {
          if (cb.error) return finish({ success: false, error: cb.error });
          if (cb.state !== state)
            return finish({ success: false, error: "state_mismatch" });
          if (!cb.code) return finish({ success: false, error: "missing_code" });
          try {
            const tokens = await exchangeCode({
              clientId: config.clientId,
              code: cb.code,
              codeVerifier: verifier,
              redirectUri: config.redirectUri,
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
            finish({ success: false, error: (err as Error).message });
          }
        },
      });

      const authorizeUrl = buildAuthorizeUrl({
        clientId: config.clientId,
        redirectUri: config.redirectUri,
        codeChallenge: challenge,
        scopes: config.scopes,
        state,
        showDialog: opts?.showDialog,
      });
      void shell.openExternal(authorizeUrl);

      // Hard timeout: if the user abandons the browser tab, don't leak the server.
      setTimeout(() => {
        try {
          server.close();
        } catch {
          /* ignore */
        }
        finish({ success: false, error: "timeout" });
      }, 5 * 60 * 1000);
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
}

async function loadWidevine(): Promise<void> {
  if (!components?.whenReady) {
    console.warn("[headspace] No components API — using stock Electron.");
    lastComponentsStatus = { error: "components_api_unavailable" };
    return;
  }
  try {
    console.log("[headspace] waiting for Widevine components…");
    const t0 = Date.now();
    await components.whenReady();
    const elapsed = Date.now() - t0;
    const status = components.status?.();
    console.log(
      `[headspace] Widevine components ready in ${elapsed}ms`,
      JSON.stringify(status, null, 2),
    );
    lastComponentsStatus = status;
  } catch (err) {
    console.warn("[headspace] Widevine components failed:", err);
    const e = err as Error;
    lastComponentsStatus = {
      error: String(err),
      name: e?.name,
      stack: e?.stack?.split("\n").slice(0, 5).join("\n"),
    };
  }
}

app.whenReady().then(async () => {
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

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
