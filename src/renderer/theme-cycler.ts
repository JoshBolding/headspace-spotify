/**
 * Theme button + Auto-from-album-art hue. The button cycles the saved
 * palette; `setAutoHue` is what now-playing calls after a cover extract.
 */

import { THEMES, getTheme, applyTheme, autoThemeFromHue } from "./themes";
import { STORAGE_KEYS } from "./storage-keys";

const THEME_BUTTON_LABELS: Record<string, string> = {
  crimson: "CRIMS",
  magenta: "MAGEN",
  cobalt: "COB",
  auto: "AUTO",
};

export class ThemeCycler {
  private currentId = localStorage.getItem(STORAGE_KEYS.theme) ?? "lime";
  private lastAutoHue: number | null = null;
  private readonly btn = document.getElementById("btn-theme-toggle") as HTMLButtonElement;

  constructor(private readonly onFlash: (text: string) => void) {
    this.applyCurrent();
    this.btn.addEventListener("click", () => {
      const idx = THEMES.findIndex((t) => t.id === this.currentId);
      const next = THEMES[(idx + 1) % THEMES.length];
      this.currentId = next.id;
      localStorage.setItem(STORAGE_KEYS.theme, this.currentId);
      this.applyCurrent();
      this.onFlash(`Theme: ${next.name}`);
    });
  }

  setAutoHue(hueDeg: number): void {
    this.lastAutoHue = hueDeg;
    if (this.currentId === "auto") this.applyCurrent();
  }

  private applyCurrent(): void {
    const base = getTheme(this.currentId);
    if (base.id === "auto" && this.lastAutoHue !== null) {
      applyTheme(autoThemeFromHue(this.lastAutoHue));
    } else {
      applyTheme(base);
    }
    this.btn.textContent = THEME_BUTTON_LABELS[base.id] ?? base.name.toUpperCase();
    this.btn.title = `Theme: ${base.name}`;
  }
}
