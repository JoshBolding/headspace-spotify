import { STORAGE_KEYS } from "./storage-keys";

/** Spotify-only (in-app tap) vs the full Windows mix (YouTube, Discord, …). */
export type VizAudioMode = "spotify" | "system";

export function getVizAudioMode(): VizAudioMode {
  return localStorage.getItem(STORAGE_KEYS.vizAudio) === "system" ? "system" : "spotify";
}

export function setVizAudioMode(mode: VizAudioMode): void {
  localStorage.setItem(STORAGE_KEYS.vizAudio, mode);
}

export function vizAudioLabel(mode: VizAudioMode = getVizAudioMode()): string {
  return mode === "system" ? "All system audio" : "Spotify only";
}
