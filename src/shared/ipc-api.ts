/**
 * The contextBridge surface. Preload `satisfies` this; the renderer reads
 * `window.headspace` as this. One interface so a new IPC method can't land
 * as `Promise<unknown>` and a pile of `as` casts on the other side.
 */

import type {
  AudioAnalysis,
  AuthStatus,
  LibraryItem,
  PlaybackDevice,
  PlaybackState,
  QueueResponse,
  Result,
  SpotifyUser,
} from "./spotify-types";

export type { AuthStatus, Result } from "./spotify-types";

export interface SpotifyPlayOpts {
  deviceId?: string;
  contextUri?: string;
  uris?: string[];
  offsetUri?: string;
  positionMs?: number;
}

export interface LyricsRequest {
  trackId: string;
  artist: string;
  track: string;
  album?: string;
  durationSec?: number;
}

export interface LyricsResult {
  synced: string | null;
  plain: string | null;
  instrumental: boolean;
  source: "lrclib" | "cache" | "none" | string;
}

export interface ComponentStatus {
  status?: string;
  title?: string | null;
  version?: string | null;
}

export interface WidevineDiag {
  ready?: boolean;
  error?: string;
  name?: string;
  errors?: unknown;
  widevineId?: string;
  result?: ComponentStatus[];
  status?: Record<string, ComponentStatus>;
}

export interface SystemDiag {
  electronVersion: string;
  chromeVersion: string;
  nodeVersion?: string;
  platform?: string;
  userDataPath?: string;
  components?: WidevineDiag;
}

export interface WidevineResetResult {
  removed: string[];
  components: unknown;
}

export interface PagedLibrary {
  items: LibraryItem[];
  total?: number;
  next?: boolean;
}

export interface HeadspaceApi {
  hitTest: (isOverOpaque: boolean) => void;
  minimize: () => void;
  close: () => void;
  setSize: (w: number, h: number) => void;
  dragStart: (dx: number, dy: number) => void;
  dragEnd: () => void;
  toggleOnTop: () => void;

  setAliveCursorTracking: (on: boolean) => void;
  onAliveCursor: (cb: (pos: { x: number; y: number }) => void) => () => void;

  getLoopbackSourceId: () => Promise<string | null>;
  getLyrics: (req: LyricsRequest) => Promise<LyricsResult>;

  authStatus: () => Promise<AuthStatus>;
  authSignIn: (opts?: {
    showDialog?: boolean;
  }) => Promise<{ success: boolean; error?: string }>;
  authSignOut: () => Promise<boolean>;
  authGetToken: () => Promise<string | null>;
  onAuthChanged: (cb: (status: AuthStatus) => void) => () => void;

  spUser: () => Promise<Result<SpotifyUser>>;
  spLiked: (offset: number, limit: number) => Promise<Result<PagedLibrary>>;
  spPlaylists: (offset: number, limit: number) => Promise<Result<PagedLibrary>>;
  spRecent: (limit: number) => Promise<Result<PagedLibrary>>;
  spSearch: (query: string, limit: number) => Promise<Result<PagedLibrary>>;
  spPlaylistTracks: (
    playlistId: string,
    offset: number,
    limit: number,
  ) => Promise<Result<PagedLibrary>>;
  spDevices: () => Promise<Result<PlaybackDevice[]>>;
  spTransfer: (deviceId: string, play: boolean) => Promise<Result<void>>;
  spPlay: (opts: SpotifyPlayOpts) => Promise<Result<void>>;
  spPause: (deviceId?: string) => Promise<Result<void>>;
  spNext: (deviceId?: string) => Promise<Result<void>>;
  spPrevious: (deviceId?: string) => Promise<Result<void>>;
  spSeek: (positionMs: number, deviceId?: string) => Promise<Result<void>>;
  spSetVolume: (percent: number, deviceId?: string) => Promise<Result<void>>;
  spState: () => Promise<Result<PlaybackState | null>>;
  spQueue: () => Promise<Result<QueueResponse>>;
  spAddQueue: (uri: string, deviceId?: string) => Promise<Result<void>>;
  spAnalysis: (trackId: string) => Promise<Result<AudioAnalysis>>;

  systemDiag: () => Promise<SystemDiag>;
  systemResetWidevine: () => Promise<WidevineResetResult>;
}
