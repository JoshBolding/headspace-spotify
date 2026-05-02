/**
 * Hook the renderer's MediaSession API to surface Spotify playback in the
 * Windows System Media Transport Controls (the popup that appears with media
 * keys, the volume flyout, and the lock screen).
 *
 * Chromium auto-bridges navigator.mediaSession to SMTC since v73, so as long
 * as we keep `metadata`, `playbackState`, and `positionState` in sync,
 * Windows treats Headspace like any first-class media player.
 *
 * Action handlers route back through the SpotifyController so media keys
 * (▶/⏸/⏭/⏮) drive Spotify directly.
 */

import type { SpotifyController, SpotifyState } from "./spotify-player";

interface BoundController {
  togglePlay(): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  seek(positionMs: number): Promise<void>;
}

export function attachMediaSession(controller: SpotifyController): void {
  if (!("mediaSession" in navigator)) {
    console.warn("[smtc] navigator.mediaSession unavailable");
    return;
  }
  const ms = navigator.mediaSession;

  const bound: BoundController = {
    togglePlay: () => controller.togglePlay(),
    next: () => controller.next(),
    previous: () => controller.previous(),
    seek: (ms) => controller.seek(ms),
  };

  // Action handlers — Chromium calls these when SMTC buttons / media keys are hit.
  ms.setActionHandler("play", () => void bound.togglePlay());
  ms.setActionHandler("pause", () => void bound.togglePlay());
  ms.setActionHandler("nexttrack", () => void bound.next());
  ms.setActionHandler("previoustrack", () => void bound.previous());
  ms.setActionHandler("seekto", (details) => {
    if (typeof details.seekTime === "number") {
      void bound.seek(details.seekTime * 1000);
    }
  });

  controller.on((s) => syncFromState(s));
}

let lastTrackId: string | null = null;

function syncFromState(s: SpotifyState): void {
  if (!("mediaSession" in navigator)) return;
  const ms = navigator.mediaSession;

  ms.playbackState = s.isPlaying ? "playing" : "paused";

  if (!s.track) {
    ms.metadata = null;
    lastTrackId = null;
    return;
  }

  // Only rebuild MediaMetadata on actual track change. Rebuilding every
  // state tick would re-fetch artwork unnecessarily.
  if (s.track.id !== lastTrackId) {
    lastTrackId = s.track.id;
    const artwork = s.track.album.images.map((img) => ({
      src: img.url,
      sizes: undefined, // Spotify image objects don't carry width/height in our slim type
      type: "image/jpeg",
    }));
    ms.metadata = new MediaMetadata({
      title: s.track.name,
      artist: s.track.artists.map((a) => a.name).join(", "),
      album: s.track.album.name,
      artwork,
    });
  }

  // positionState lets Windows render the scrubber accurately — without it,
  // the SMTC scrubber doesn't appear at all.
  if (
    s.durationMs > 0 &&
    typeof ms.setPositionState === "function" &&
    Number.isFinite(s.positionMs)
  ) {
    try {
      ms.setPositionState({
        duration: s.durationMs / 1000,
        position: Math.min(s.positionMs, s.durationMs) / 1000,
        playbackRate: 1,
      });
    } catch {
      // Some browsers throw if position > duration during a transition.
      // Safe to ignore — the next state tick will fix it.
    }
  }
}
