/**
 * Fetch time-synced lyrics from lrclib.net (free, no auth, large coverage).
 *
 * Returns the raw `syncedLyrics` string in LRC format (parsed in renderer)
 * and a `plainLyrics` fallback for tracks lrclib only has unsynced text for.
 *
 * Cached in-memory by Spotify track ID for the session — restarts re-fetch.
 * Long-term we should persist to a SQLite/JSON cache under userData, but the
 * lrclib endpoint is fast enough that session-only is fine for now.
 */

interface LrclibResponse {
  id?: number;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

export interface LyricsResult {
  synced: string | null;
  plain: string | null;
  instrumental: boolean;
  source: "lrclib" | "cache" | "none";
}

const cache = new Map<string, LyricsResult>();

export interface LyricsRequest {
  trackId: string;
  artist: string;
  track: string;
  album?: string;
  durationSec?: number;
}

export async function getLyrics(req: LyricsRequest): Promise<LyricsResult> {
  const cached = cache.get(req.trackId);
  if (cached) return { ...cached, source: "cache" };

  const params = new URLSearchParams({
    artist_name: req.artist,
    track_name: req.track,
  });
  if (req.album) params.set("album_name", req.album);
  if (req.durationSec) params.set("duration", String(Math.round(req.durationSec)));

  const url = `https://lrclib.net/api/get?${params.toString()}`;
  let result: LyricsResult;
  try {
    const res = await fetch(url, {
      headers: {
        // lrclib.net asks API consumers to identify themselves (politely).
        "User-Agent": "Headspace-Spotify-Player/0.1 (https://github.com/JoshB)",
      },
    });
    if (!res.ok) {
      // 404 = no match, which is normal — don't log noisily.
      result = { synced: null, plain: null, instrumental: false, source: "none" };
    } else {
      const json = (await res.json()) as LrclibResponse;
      result = {
        synced: json.syncedLyrics?.trim() || null,
        plain: json.plainLyrics?.trim() || null,
        instrumental: !!json.instrumental,
        source: "lrclib",
      };
    }
  } catch (err) {
    console.warn("[lyrics] fetch failed:", err);
    result = { synced: null, plain: null, instrumental: false, source: "none" };
  }
  cache.set(req.trackId, result);
  return result;
}
