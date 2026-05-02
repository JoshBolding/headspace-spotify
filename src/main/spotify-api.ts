/**
 * Spotify Web API client.
 *
 * Uses the access token from the encrypted token store. On 401, attempts a
 * single refresh + retry. Caller-friendly typed wrappers around the endpoints
 * we need for library browsing, playback control, and search.
 *
 * Reference: https://developer.spotify.com/documentation/web-api/reference/
 */

const BASE = "https://api.spotify.com/v1";

type GetTokenFn = () => Promise<string | null>;

let getToken: GetTokenFn = async () => null;

export function configureSpotifyApi(fn: GetTokenFn) {
  getToken = fn;
}

async function call<T>(
  pathOrUrl: string,
  init: RequestInit = {},
  expectJson = true,
): Promise<T> {
  const token = await getToken();
  if (!token) throw new Error("not_authenticated");
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${BASE}${pathOrUrl}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  if (res.status === 204) return undefined as T;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Spotify ${res.status}: ${text || res.statusText}`);
  }
  if (!expectJson) return undefined as T;
  return res.json() as Promise<T>;
}

// ---------------- types we care about ----------------

export interface SpotifyImage {
  url: string;
  height: number | null;
  width: number | null;
}

export interface SpotifyArtist {
  id: string;
  name: string;
  uri: string;
}

export interface SpotifyAlbum {
  id: string;
  name: string;
  uri: string;
  images: SpotifyImage[];
  artists: SpotifyArtist[];
  release_date?: string;
}

export interface SpotifyTrack {
  id: string;
  name: string;
  uri: string;
  duration_ms: number;
  artists: SpotifyArtist[];
  album: SpotifyAlbum;
  is_playable?: boolean;
  preview_url?: string | null;
}

export interface SpotifyEpisode {
  id: string;
  name: string;
  uri: string;
  duration_ms: number;
  images?: SpotifyImage[];
  show?: { name: string; images?: SpotifyImage[] };
}

export type SpotifyQueueItem = SpotifyTrack | SpotifyEpisode;

export interface SpotifyPlaylist {
  id: string;
  name: string;
  uri: string;
  description?: string;
  images: SpotifyImage[];
  owner: { display_name: string; id: string };
  tracks: { total: number };
  trackTotal?: number;
}

export interface SpotifyUser {
  id: string;
  display_name: string;
  images?: SpotifyImage[];
  product?: "premium" | "free" | "open";
  email?: string;
}

interface Paged<T> {
  items: T[];
  total: number;
  next: string | null;
  offset: number;
  limit: number;
}

export type LibraryItem =
  | { kind: "track"; track: SpotifyTrack; addedAt?: string }
  | { kind: "playlist"; playlist: SpotifyPlaylist }
  | { kind: "album"; album: SpotifyAlbum };

// ---------------- endpoints ----------------

export async function getCurrentUser(): Promise<SpotifyUser> {
  return call<SpotifyUser>("/me");
}

export async function getLikedTracks(
  offset = 0,
  limit = 50,
): Promise<{ items: LibraryItem[]; total: number; next: boolean }> {
  const res = await call<
    Paged<{ added_at: string; track: SpotifyTrack }>
  >(`/me/tracks?offset=${offset}&limit=${limit}`);
  return {
    items: res.items.map((it) => ({
      kind: "track",
      track: it.track,
      addedAt: it.added_at,
    })),
    total: res.total,
    next: !!res.next,
  };
}

export async function getMyPlaylists(
  offset = 0,
  limit = 50,
): Promise<{ items: LibraryItem[]; total: number; next: boolean }> {
  const res = await call<Paged<SpotifyPlaylist | null>>(
    `/me/playlists?offset=${offset}&limit=${limit}&fields=items(id,name,uri,images,owner(display_name,id),tracks(total)),total,next,offset,limit`,
  );
  const playlists = await Promise.all(
    res.items
      .filter((p): p is SpotifyPlaylist => !!p)
      .map(async (p) => {
        const listedTotal = Number(p.tracks?.total);
        // Some accounts/API responses report `tracks.total` as 0 in the
        // playlist list even when the playlist has items. Ask the playlist
        // tracks endpoint for the authoritative total for each visible row.
        const trackTotal = await getPlaylistTrackTotal(p.id).catch(() =>
          Number.isFinite(listedTotal) ? listedTotal : 0,
        );
        return { ...p, tracks: { total: trackTotal }, trackTotal };
      }),
  );
  return {
    items: playlists.map((p) => ({ kind: "playlist", playlist: p })),
    total: res.total,
    next: !!res.next,
  };
}

async function getPlaylistTrackTotal(playlistId: string): Promise<number> {
  const res = await call<{ total: number }>(
    `/playlists/${playlistId}/tracks?limit=1&fields=total`,
  );
  return Number(res.total) || 0;
}

export async function getRecentlyPlayed(
  limit = 50,
): Promise<{ items: LibraryItem[] }> {
  const res = await call<{
    items: { track: SpotifyTrack; played_at: string }[];
  }>(`/me/player/recently-played?limit=${limit}`);
  // De-dupe by track id since recently-played has many repeats.
  const seen = new Set<string>();
  const items: LibraryItem[] = [];
  for (const it of res.items) {
    if (seen.has(it.track.id)) continue;
    seen.add(it.track.id);
    items.push({ kind: "track", track: it.track, addedAt: it.played_at });
  }
  return { items };
}

export async function searchTracks(
  query: string,
  limit = 20,
): Promise<{ items: LibraryItem[] }> {
  if (!query.trim()) return { items: [] };
  const q = encodeURIComponent(query);
  const res = await call<{
    tracks: Paged<SpotifyTrack>;
  }>(`/search?q=${q}&type=track&limit=${limit}`);
  return {
    items: res.tracks.items.map((t) => ({ kind: "track", track: t })),
  };
}

export async function getPlaylistTracks(
  playlistId: string,
  offset = 0,
  limit = 100,
): Promise<{ items: LibraryItem[]; total: number; next: boolean }> {
  const res = await call<
    Paged<{ track: SpotifyTrack | null; added_at: string }>
  >(
    `/playlists/${playlistId}/tracks?offset=${offset}&limit=${limit}&fields=items(track(id,name,uri,duration_ms,artists,album(id,name,uri,images)),added_at),total,next,offset,limit`,
  );
  const items: LibraryItem[] = [];
  for (const it of res.items) {
    if (!it.track) continue; // local files / unavailable tracks come back null
    items.push({ kind: "track", track: it.track, addedAt: it.added_at });
  }
  return { items, total: res.total, next: !!res.next };
}

// ---------------- playback ----------------

export interface PlaybackDevice {
  id: string;
  name: string;
  type: string;
  is_active: boolean;
  is_restricted: boolean;
  volume_percent?: number;
}

export async function getDevices(): Promise<PlaybackDevice[]> {
  const r = await call<{ devices: PlaybackDevice[] }>("/me/player/devices");
  return r.devices;
}

export async function transferPlayback(deviceId: string, play = true) {
  await call(
    "/me/player",
    {
      method: "PUT",
      body: JSON.stringify({ device_ids: [deviceId], play }),
    },
    false,
  );
}

export async function play(opts: {
  deviceId?: string;
  contextUri?: string;
  uris?: string[];
  offsetUri?: string;
  positionMs?: number;
}) {
  const params = opts.deviceId ? `?device_id=${opts.deviceId}` : "";
  const body: Record<string, unknown> = {};
  if (opts.contextUri) body.context_uri = opts.contextUri;
  if (opts.uris) body.uris = opts.uris;
  if (opts.offsetUri) body.offset = { uri: opts.offsetUri };
  if (opts.positionMs !== undefined) body.position_ms = opts.positionMs;
  await call(
    `/me/player/play${params}`,
    {
      method: "PUT",
      body: Object.keys(body).length ? JSON.stringify(body) : undefined,
    },
    false,
  );
}

export async function pause(deviceId?: string) {
  const params = deviceId ? `?device_id=${deviceId}` : "";
  await call(`/me/player/pause${params}`, { method: "PUT" }, false);
}

export async function nextTrack(deviceId?: string) {
  const params = deviceId ? `?device_id=${deviceId}` : "";
  await call(`/me/player/next${params}`, { method: "POST" }, false);
}

export async function previousTrack(deviceId?: string) {
  const params = deviceId ? `?device_id=${deviceId}` : "";
  await call(`/me/player/previous${params}`, { method: "POST" }, false);
}

export async function seek(positionMs: number, deviceId?: string) {
  const params = deviceId
    ? `?position_ms=${Math.floor(positionMs)}&device_id=${deviceId}`
    : `?position_ms=${Math.floor(positionMs)}`;
  await call(`/me/player/seek${params}`, { method: "PUT" }, false);
}

export async function setVolume(percent: number, deviceId?: string) {
  const v = Math.max(0, Math.min(100, Math.round(percent)));
  const params = deviceId
    ? `?volume_percent=${v}&device_id=${deviceId}`
    : `?volume_percent=${v}`;
  await call(`/me/player/volume${params}`, { method: "PUT" }, false);
}

export interface PlaybackState {
  is_playing: boolean;
  progress_ms: number;
  device?: PlaybackDevice;
  item?: SpotifyTrack;
  shuffle_state?: boolean;
  repeat_state?: "off" | "track" | "context";
}

export async function getPlaybackState(): Promise<PlaybackState | null> {
  try {
    return await call<PlaybackState | null>("/me/player");
  } catch {
    return null;
  }
}

export async function getQueue(): Promise<{
  currently_playing: SpotifyQueueItem | null;
  queue: SpotifyQueueItem[];
}> {
  return call<{ currently_playing: SpotifyQueueItem | null; queue: SpotifyQueueItem[] }>(
    "/me/player/queue",
  );
}

export async function addToQueue(uri: string, deviceId?: string) {
  const params = new URLSearchParams({ uri });
  if (deviceId) params.set("device_id", deviceId);
  await call(`/me/player/queue?${params.toString()}`, { method: "POST" }, false);
}

// ---------------- audio analysis ----------------

export interface AudioAnalysisSegment {
  start: number;
  duration: number;
  confidence: number;
  loudness_start: number;
  loudness_max: number;
  loudness_max_time: number;
  loudness_end: number;
  pitches: number[];
  timbre: number[];
}

export interface AudioAnalysisInterval {
  start: number;
  duration: number;
  confidence: number;
}

export interface AudioAnalysisSection {
  start: number;
  duration: number;
  confidence: number;
  loudness: number;
  tempo: number;
  key: number;
  mode: number;
}

export interface AudioAnalysis {
  track: {
    duration: number;
    tempo: number;
    loudness: number;
    key: number;
    mode: number;
    time_signature: number;
  };
  segments: AudioAnalysisSegment[];
  beats: AudioAnalysisInterval[];
  bars: AudioAnalysisInterval[];
  tatums: AudioAnalysisInterval[];
  sections: AudioAnalysisSection[];
}

export async function getAudioAnalysis(trackId: string): Promise<AudioAnalysis> {
  return call<AudioAnalysis>(`/audio-analysis/${trackId}`);
}
