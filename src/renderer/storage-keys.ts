/**
 * Centralized localStorage keys.
 *
 * Single source of truth so renaming, listing, or wiping settings later (e.g.
 * for an "Export/Reset preferences" UI or a future settings.json migration)
 * doesn't require grep-and-replace across half the renderer.
 */
export const STORAGE_KEYS = {
  theme: "headspace.spotify.theme",
  lyricsOn: "headspace.spotify.lyrics-on",
  volume: "headspace.spotify.volume",
  balance: "headspace.spotify.balance",
  vizMode: "headspace.spotify.viz-mode",
} as const;

export type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];
