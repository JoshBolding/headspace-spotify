/**
 * Canonical Spotify shapes shared by main (Web API client) and renderer
 * (SDK wrapper, library, queue). One definition so a track doesn't grow a
 * fourth incompatible cousin the next time someone needs "just the name".
 *
 * Fields the Web Playback SDK omits (artist/album ids, image dimensions)
 * are optional so both the REST payload and the SDK state assign cleanly.
 */

export interface SpotifyImage {
  url: string;
  height?: number | null;
  width?: number | null;
}

export interface SpotifyArtist {
  id?: string;
  name: string;
  uri?: string;
}

export interface SpotifyAlbum {
  id?: string;
  name: string;
  uri?: string;
  images: SpotifyImage[];
  artists?: SpotifyArtist[];
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

export type QueueItem = SpotifyTrack | SpotifyEpisode;

export interface QueueResponse {
  currently_playing: QueueItem | null;
  queue: QueueItem[];
}

export interface SpotifyPlaylist {
  id: string;
  name: string;
  uri: string;
  description?: string;
  images: SpotifyImage[];
  owner: { display_name: string; id?: string };
  tracks?: { total?: number | null };
}

export interface SpotifyUser {
  id: string;
  display_name: string;
  images?: SpotifyImage[];
  product?: "premium" | "free" | "open";
  email?: string;
}

export type LibraryItem =
  | { kind: "track"; track: SpotifyTrack; addedAt?: string }
  | { kind: "playlist"; playlist: SpotifyPlaylist }
  | { kind: "album"; album: SpotifyAlbum };

export interface PlaybackDevice {
  id: string;
  name: string;
  type: string;
  is_active: boolean;
  is_restricted: boolean;
  volume_percent?: number;
}

export type RepeatState = "off" | "track" | "context";

export interface PlaybackState {
  is_playing: boolean;
  progress_ms: number;
  device?: PlaybackDevice;
  item?: SpotifyTrack;
  shuffle_state?: boolean;
  repeat_state?: RepeatState;
}

export interface AuthStatus {
  authenticated: boolean;
  expiresAt?: number;
  scope?: string;
}

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

/** IPC-friendly: the value, or a tagged error the wrap() helper returns. */
export type Result<T> = T | { error: string };

export function isErrorResult(value: unknown): value is { error: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof (value as { error: unknown }).error === "string"
  );
}
