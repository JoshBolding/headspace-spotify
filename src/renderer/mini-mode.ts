/**
 * Desk-buddy mode: half-size window, drawers forced closed. Opening a
 * drawer kicks us back to full size so the ear panels have room to slide.
 */

import { HEAD_H, MINI_SCALE, VIEW_W_CLOSED } from "./hit-test";
import type { SkinState } from "./skin-state";

export class MiniMode {
  private enabled = localStorage.getItem("headspaceMiniMode") === "1";
  private readonly btn = document.getElementById("btn-mini-mode")!;

  constructor(private readonly skin: SkinState) {
    this.btn.addEventListener("click", () => this.apply(!this.enabled));
    this.apply(this.enabled);
  }

  apply(enabled: boolean): void {
    this.enabled = enabled;
    localStorage.setItem("headspaceMiniMode", enabled ? "1" : "0");
    if (enabled) this.skin.closeAll();
    document.body.classList.toggle("mini", enabled);
    this.btn.classList.toggle("active", enabled);
    this.btn.title = enabled ? "Exit desk buddy mode" : "Desk buddy mode";
    window.headspace.setSize(
      Math.round(VIEW_W_CLOSED * (enabled ? MINI_SCALE : 1)),
      Math.round(HEAD_H * (enabled ? MINI_SCALE : 1)),
    );
  }

  exitForDrawer(): void {
    if (this.enabled) this.apply(false);
  }
}
