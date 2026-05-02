import { contextBridge, ipcRenderer } from "electron";

interface TrackRecord {
  path: string;
  url: string;
  name: string;
  title?: string;
  artist?: string;
  album?: string;
  durationSec?: number;
}

interface AuthStatus {
  authenticated: boolean;
  expiresAt?: number;
  scope?: string;
}

contextBridge.exposeInMainWorld("headspace", {
  hitTest: (isOverOpaque: boolean) => ipcRenderer.send("hit-test", isOverOpaque),
  minimize: () => ipcRenderer.send("window:minimize"),
  close: () => ipcRenderer.send("window:close"),
  setWidth: (w: number) => ipcRenderer.send("window:set-width", w),
  setSize: (w: number, h: number) => ipcRenderer.send("window:set-size", w, h),
  dragStart: (dx: number, dy: number) => ipcRenderer.send("drag:start", dx, dy),
  dragEnd: () => ipcRenderer.send("drag:end"),
  toggleOnTop: () => ipcRenderer.send("window:toggle-on-top"),

  // Returns a desktopCapturer screen source ID. Renderer feeds this into
  // getUserMedia({ chromeMediaSource: 'desktop', chromeMediaSourceId }) to
  // capture system-audio loopback without a user-gesture requirement.
  getLoopbackSourceId: (): Promise<string | null> =>
    ipcRenderer.invoke("system:loopback-source-id"),

  // Lyrics fetcher (lrclib.net) — returns synced LRC text + plain fallback.
  getLyrics: (req: {
    trackId: string;
    artist: string;
    track: string;
    album?: string;
    durationSec?: number;
  }): Promise<{
    synced: string | null;
    plain: string | null;
    instrumental: boolean;
    source: string;
  }> => ipcRenderer.invoke("lyrics:get", req),

  // Local-files API (kept for the file-picker code path; Spotify is the
  // primary playback source but pickFiles still works for quick previews)
  pickFiles: (): Promise<TrackRecord[]> => ipcRenderer.invoke("files:pick"),
  enrichPaths: (paths: string[]): Promise<TrackRecord[]> =>
    ipcRenderer.invoke("files:enrich", paths),
  getArt: (path: string): Promise<string | null> =>
    ipcRenderer.invoke("files:art", path),

  // Spotify OAuth
  authStatus: (): Promise<AuthStatus> => ipcRenderer.invoke("auth:status"),
  authSignIn: (opts?: { showDialog?: boolean }): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("auth:sign-in", opts),
  authSignOut: (): Promise<boolean> => ipcRenderer.invoke("auth:sign-out"),
  authGetToken: (): Promise<string | null> => ipcRenderer.invoke("auth:get-token"),
  onAuthChanged: (cb: (status: AuthStatus) => void) => {
    const listener = (_evt: unknown, status: AuthStatus) => cb(status);
    ipcRenderer.on("auth:changed", listener);
    return () => ipcRenderer.removeListener("auth:changed", listener);
  },

  // Spotify Web API (results may be { error } on failure)
  spUser: () => ipcRenderer.invoke("sp:user"),
  spLiked: (offset: number, limit: number) =>
    ipcRenderer.invoke("sp:liked", offset, limit),
  spPlaylists: (offset: number, limit: number) =>
    ipcRenderer.invoke("sp:playlists", offset, limit),
  spPlaylistCount: (playlistId: string) =>
    ipcRenderer.invoke("sp:playlist-count", playlistId),
  spRecent: (limit: number) => ipcRenderer.invoke("sp:recent", limit),
  spSearch: (query: string, limit: number) =>
    ipcRenderer.invoke("sp:search", query, limit),
  spPlaylistTracks: (playlistId: string, offset: number, limit: number) =>
    ipcRenderer.invoke("sp:playlist-tracks", playlistId, offset, limit),
  spDevices: () => ipcRenderer.invoke("sp:devices"),
  spTransfer: (deviceId: string, play: boolean) =>
    ipcRenderer.invoke("sp:transfer", deviceId, play),
  spPlay: (opts: object) => ipcRenderer.invoke("sp:play", opts),
  spPause: (deviceId?: string) => ipcRenderer.invoke("sp:pause", deviceId),
  spNext: (deviceId?: string) => ipcRenderer.invoke("sp:next", deviceId),
  spPrevious: (deviceId?: string) => ipcRenderer.invoke("sp:previous", deviceId),
  spSeek: (positionMs: number, deviceId?: string) =>
    ipcRenderer.invoke("sp:seek", positionMs, deviceId),
  spSetVolume: (percent: number, deviceId?: string) =>
    ipcRenderer.invoke("sp:set-volume", percent, deviceId),
  spState: () => ipcRenderer.invoke("sp:state"),
  spQueue: () => ipcRenderer.invoke("sp:queue"),
  spAddQueue: (uri: string, deviceId?: string) =>
    ipcRenderer.invoke("sp:add-queue", uri, deviceId),
  spAnalysis: (trackId: string) => ipcRenderer.invoke("sp:analysis", trackId),
  systemDiag: () => ipcRenderer.invoke("system:diag"),
  systemResetWidevine: () => ipcRenderer.invoke("system:reset-widevine"),
});
