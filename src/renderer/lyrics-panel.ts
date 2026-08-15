/**
 * Synced-lyrics overlay on the face screen. The LRC parser lives in
 * lyrics.ts; this module owns fetch, toggle, and the three-line render.
 */

import {
  buildLyricsTrack,
  findActiveLineIndex,
  type LyricsTrack,
} from "./lyrics";
import type { SpotifyController } from "./spotify-player";
import { STORAGE_KEYS } from "./storage-keys";

export class LyricsPanel {
  private enabled = localStorage.getItem(STORAGE_KEYS.lyricsOn) === "1";
  private current: LyricsTrack | null = null;
  private trackId: string | null = null;
  private loading = false;
  private lastRenderedLineIdx = -2;
  private readonly btn = document.getElementById("btn-lyrics-toggle") as HTMLButtonElement;
  private readonly overlay = document.getElementById("lyrics-overlay")!;
  private readonly prev = document.getElementById("ly-prev")!;
  private readonly currentEl = document.getElementById("ly-current")!;
  private readonly next = document.getElementById("ly-next")!;

  constructor(private readonly controller: SpotifyController) {
    this.refreshButton();
    this.btn.addEventListener("click", () => {
      this.enabled = !this.enabled;
      localStorage.setItem(STORAGE_KEYS.lyricsOn, this.enabled ? "1" : "0");
      this.refreshButton();
      if (this.enabled && this.controller.state().track) {
        void this.loadForCurrentTrack();
      }
    });
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  resetForNewTrack(): void {
    this.current = null;
    this.trackId = null;
    this.lastRenderedLineIdx = -2;
    this.refreshButton();
  }

  async loadForCurrentTrack(): Promise<void> {
    const s = this.controller.state();
    if (!s.track) return;
    if (this.loading) return;
    if (s.track.id === this.trackId && this.current) return;
    this.loading = true;
    this.trackId = s.track.id;
    this.current = null;
    this.lastRenderedLineIdx = -2;
    this.showStatus("Loading lyrics...");
    try {
      const res = await window.headspace.getLyrics({
        trackId: s.track.id,
        artist: s.track.artists[0]?.name ?? "",
        track: s.track.name,
        album: s.track.album.name,
        durationSec: s.durationMs ? Math.round(s.durationMs / 1000) : undefined,
      });
      if (this.trackId !== s.track.id) return;
      this.current = buildLyricsTrack(res);
      if (this.current.instrumental) {
        this.showStatus("♪ instrumental");
      } else if (!this.current.hasSynced && this.current.plain.length === 0) {
        this.showStatus("No lyrics found");
      } else if (!this.current.hasSynced) {
        this.showPlain(this.current.plain);
      }
      this.refreshButton();
    } finally {
      this.loading = false;
    }
  }

  tick(positionMs: number): void {
    if (!this.enabled || !this.current || !this.current.hasSynced) return;
    const idx = findActiveLineIndex(this.current.lines, positionMs);
    if (idx === this.lastRenderedLineIdx) return;
    this.lastRenderedLineIdx = idx;
    const lines = this.current.lines;
    const cur = idx >= 0 ? lines[idx]?.text ?? "" : "";
    const prev = idx > 0 ? lines[idx - 1]?.text ?? "" : "";
    const next = idx + 1 < lines.length ? lines[idx + 1]?.text ?? "" : "";
    this.prev.textContent = prev;
    this.currentEl.textContent = cur || "♪";
    this.next.textContent = next;
  }

  private refreshButton(): void {
    this.btn.classList.toggle("active", this.enabled);
    this.overlay.classList.toggle("show", this.enabled && !!this.current);
  }

  private showStatus(text: string): void {
    this.prev.textContent = "";
    this.currentEl.innerHTML = `<span class="ly-status">${escapeHtml(text)}</span>`;
    this.next.textContent = "";
  }

  private showPlain(lines: string[]): void {
    const first = lines.filter((l) => l.length > 0).slice(0, 6);
    this.prev.textContent = "";
    this.currentEl.textContent = first.join("\n");
    this.next.innerHTML = `<span class="ly-status">(unsynced)</span>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
