/**
 * Spotify Web API client.
 *
 * Uses the access token from the encrypted token store. On 401, attempts a
 * single refresh + retry. Caller-friendly typed wrappers around the endpoints
 * we need for library browsing, playback control, and search.
 *
 * Reference: https://developer.spotify.com/documentation/web-api/reference/
 */

import type {
  AudioAnalysis,
  LibraryItem,
  PlaybackDevice,
  PlaybackState,
  QueueResponse,
  RepeatState,
  SpotifyPlaylist,
  SpotifyTrack,
  SpotifyUser,
} from "../shared/spotify-types";

export type {
  AudioAnalysis,
  LibraryItem,
  PlaybackDevice,
  PlaybackState,
  QueueItem,
  QueueResponse,
  SpotifyAlbum,
  SpotifyArtist,
  SpotifyEpisode,
  SpotifyImage,
  SpotifyPlaylist,
  SpotifyTrack,
  SpotifyUser,
} from "../shared/spotify-types";

const BASE = "https://api.spotify.com/v1";

type GetTokenFn = (opts?: { forceRefresh?: boolean }) => Promise<string | null>;

let getToken: GetTokenFn = async () => null;

export function configureSpotifyApi(fn: GetTokenFn) {
  getToken = fn;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Retry-After seconds, or an HTTP-date, or exponential backoff if absent. */
function retryAfterMs(res: Response, attempt: number): number {
  const raw = res.headers.get("retry-after");
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const when = Date.parse(raw);
    if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  }
  return 500 * 2 ** (attempt - 1);
}

async function call<T>(
  pathOrUrl: string,
  init: RequestInit = {},
  expectJson = true,
): Promise<T> {
  let token = await getToken();
  if (!token) throw new Error("not_authenticated");
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${BASE}${pathOrUrl}`;
  const MAX_ATTEMPTS = 3;
  let did401Retry = false;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers || {}),
      },
    });

    if (res.status === 401 && !did401Retry) {
      did401Retry = true;
      const fresh = await getToken({ forceRefresh: true });
      if (fresh) {
        token = fresh;
        continue;
      }
    }

    if (res.status === 429 && attempt < MAX_ATTEMPTS) {
      await sleep(retryAfterMs(res, attempt));
      continue;
    }

    if (res.status === 204) return undefined as T;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Spotify ${res.status}: ${text || res.statusText}`);
    }
    if (!expectJson) return undefined as T;
    return res.json() as Promise<T>;
  }

  throw new Error("Spotify request failed after retries");
}

interface Paged<T> {
  items: T[];
  total: number;
  next: string | null;
  offset: number;
  limit: number;
}

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
    `/me/playlists?offset=${offset}&limit=${limit}&fields=items(id,name,uri,images,owner(display_name,id)),total,next,offset,limit`,
  );
  return {
    items: res.items
      .filter((p): p is SpotifyPlaylist => !!p)
      .map((p) => ({ kind: "playlist", playlist: p })),
    total: res.total,
    next: !!res.next,
  };
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
  const safeLimit = Math.max(1, Math.min(20, Math.floor(Number(limit) || 20)));
  const q = encodeURIComponent(query.trim());
  const [trackRes, playlistRes] = await Promise.all([
    call<{ tracks?: Paged<SpotifyTrack> }>(`/search?q=${q}&type=track`),
    call<{ playlists?: Paged<SpotifyPlaylist | null> }>(
      `/search?q=${q}&type=playlist`,
    ).catch(() => ({ playlists: undefined })),
  ]);
  return {
    items: [
      ...(trackRes.tracks?.items ?? [])
        .slice(0, safeLimit)
        .map((t) => ({ kind: "track" as const, track: t })),
      ...(playlistRes.playlists?.items ?? [])
        .slice(0, Math.ceil(safeLimit / 2))
        .filter((p): p is SpotifyPlaylist => !!p)
        .map((p) => ({ kind: "playlist" as const, playlist: p })),
    ],
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

export async function getPlaybackState(): Promise<PlaybackState | null> {
  try {
    return await call<PlaybackState | null>("/me/player");
  } catch {
    return null;
  }
}

export async function getQueue(): Promise<QueueResponse> {
  return call<QueueResponse>("/me/player/queue");
}

export async function addToQueue(uri: string, deviceId?: string) {
  const params = new URLSearchParams({ uri });
  if (deviceId) params.set("device_id", deviceId);
  await call(`/me/player/queue?${params.toString()}`, { method: "POST" }, false);
}

// ---------------- audio analysis ----------------

export async function getAudioAnalysis(trackId: string): Promise<AudioAnalysis> {
  return call<AudioAnalysis>(`/audio-analysis/${trackId}`);
}

// ---------------- library extras ----------------

export async function getTopTracks(
  offset = 0,
  limit = 50,
  timeRange: "short_term" | "medium_term" | "long_term" = "medium_term",
): Promise<{ items: LibraryItem[]; total: number; next: boolean }> {
  const res = await call<Paged<SpotifyTrack>>(
    `/me/top/tracks?offset=${offset}&limit=${limit}&time_range=${timeRange}`,
  );
  return {
    items: res.items.map((track) => ({ kind: "track" as const, track })),
    total: res.total,
    next: !!res.next,
  };
}

export async function tracksAreSaved(ids: string[]): Promise<boolean[]> {
  if (!ids.length) return [];
  const safe = ids.filter(Boolean).slice(0, 50);
  return call<boolean[]>(`/me/tracks/contains?ids=${safe.join(",")}`);
}

export async function saveTracks(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await call(
    "/me/tracks",
    { method: "PUT", body: JSON.stringify({ ids: ids.slice(0, 50) }) },
    false,
  );
}

export async function removeSavedTracks(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await call(
    "/me/tracks",
    { method: "DELETE", body: JSON.stringify({ ids: ids.slice(0, 50) }) },
    false,
  );
}

export async function setShuffle(state: boolean, deviceId?: string): Promise<void> {
  const params = new URLSearchParams({ state: state ? "true" : "false" });
  if (deviceId) params.set("device_id", deviceId);
  await call(`/me/player/shuffle?${params.toString()}`, { method: "PUT" }, false);
}

export async function setRepeat(state: RepeatState, deviceId?: string): Promise<void> {
  const params = new URLSearchParams({ state });
  if (deviceId) params.set("device_id", deviceId);
  await call(`/me/player/repeat?${params.toString()}`, { method: "PUT" }, false);
}
