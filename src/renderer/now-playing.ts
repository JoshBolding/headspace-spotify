/**
 * Now-playing strip, left-ear card, seek fill, and per-track orchestration
 * (palette, lyrics reset, audio-analysis latch).
 */

import { extractPalette, DEFAULT_PALETTE } from "./palette";
import { isErrorResult } from "../shared/spotify-types";
import { buildSyntheticAnalysis } from "./visualizer";
import type { FaceAlive } from "./face-alive";
import type { LyricsPanel } from "./lyrics-panel";
import type { QueueView } from "./queue-view";
import type { SpotifyController, SpotifyState } from "./spotify-player";
import type { ThemeCycler } from "./theme-cycler";
import type { Visualizer } from "./visualizer";

export function wireNowPlaying(opts: {
  controller: SpotifyController;
  viz: Visualizer;
  faceAlive: FaceAlive;
  queueView: QueueView;
  lyrics: LyricsPanel;
  theme: ThemeCycler;
  isScrubbing?: () => boolean;
}): void {
  const { controller, viz, faceAlive, queueView, lyrics, theme, isScrubbing } = opts;
  const nowPlaying = document.getElementById("now-playing")!;
  const leftNowView = document.getElementById("left-now-view")!;
  const pauseOverlay = document.getElementById("pause-overlay")!;
  const seekFill = document.getElementById("seek-fill") as HTMLDivElement;

  let lastTrackId: string | null = null;
  let trackChangeToken = 0;
  let audioAnalysisUnavailable = false;
  let lastIsPlaying: boolean | null = null;
  let leftNowRenderedId: string | null = null;

  function renderLeftNow(track: SpotifyState["track"], artistNames = "") {
    leftNowView.innerHTML = "";
    const artUrl = track?.album.images.at(-1)?.url ?? track?.album.images[0]?.url ?? "";
    if (artUrl) {
      const img = document.createElement("img");
      img.className = "qd-now-art";
      img.src = artUrl;
      img.alt = "";
      leftNowView.appendChild(img);
    } else {
      const art = document.createElement("div");
      art.className = "qd-now-art";
      leftNowView.appendChild(art);
    }
    const text = document.createElement("div");
    text.className = "qd-now-text";
    const title = document.createElement("div");
    title.className = "qd-now-title";
    const sub = document.createElement("div");
    sub.className = "qd-now-sub";
    title.textContent = track?.name ?? "Awaiting playback";
    sub.textContent = track ? artistNames || "Spotify" : "Pick a track from the right ear";
    text.append(title, sub);
    leftNowView.appendChild(text);
  }

  controller.on((s: SpotifyState) => {
    queueView.handleState(s);
    if (s.track) {
      const artistNames = s.track.artists.map((a) => a.name).join(", ");
      nowPlaying.textContent = `${artistNames} — ${s.track.name}`;
      if (leftNowRenderedId !== s.track.id) {
        leftNowRenderedId = s.track.id;
        renderLeftNow(s.track, artistNames);
      }
      if (s.track.id !== lastTrackId) {
        lastTrackId = s.track.id;
        faceAlive.notifyTrackChange();
        const token = ++trackChangeToken;
        const url = s.track.album.images[0]?.url ?? null;
        viz.setCoverArt(url);
        if (url) {
          void extractPalette(url).then((p) => {
            if (token !== trackChangeToken) return;
            viz.setPalette(p);
            theme.setAutoHue(p.primaryHueDeg);
          });
        } else {
          viz.setPalette(DEFAULT_PALETTE);
          theme.setAutoHue(95);
        }
        lyrics.resetForNewTrack();
        if (lyrics.isEnabled) void lyrics.loadForCurrentTrack();
        viz.setAnalysis(null);
        const trackDuration = s.track.duration_ms;
        if (audioAnalysisUnavailable) {
          viz.setAnalysis(buildSyntheticAnalysis(trackDuration) as never);
        } else {
          void window.headspace.spAnalysis(s.track.id).then((res) => {
            if (token !== trackChangeToken) return;
            if (res && !isErrorResult(res)) {
              viz.setAnalysis(res as never);
            } else {
              audioAnalysisUnavailable = true;
              viz.setAnalysis(buildSyntheticAnalysis(trackDuration) as never);
            }
          });
        }
      }
    } else {
      nowPlaying.textContent = "— signed in, awaiting playback —";
      if (leftNowRenderedId !== null) {
        leftNowRenderedId = null;
        renderLeftNow(null);
      }
    }
    viz.setPlaying(s.isPlaying);
    faceAlive.setPlaying(s.isPlaying);
    viz.setPosition(s.positionMs);
    lyrics.tick(s.positionMs);
    if (s.isPlaying !== lastIsPlaying) {
      lastIsPlaying = s.isPlaying;
      if (s.isPlaying) pauseOverlay.removeAttribute("hidden");
      else pauseOverlay.setAttribute("hidden", "");
    }
    if (isScrubbing?.()) return;
    if (s.durationMs > 0) {
      seekFill.style.width = `${Math.min(100, (s.positionMs / s.durationMs) * 100)}%`;
    } else {
      seekFill.style.width = "0%";
    }
  });
}
