/**
 * Long-form status overlay. Transport errors, SDK fallbacks, and settings
 * actions all go through here so messages aren't truncated in the ticker.
 */

import type { SpotifyController } from "./spotify-player";

export interface StatusAction {
  label: string;
  primary?: boolean;
  onClick: () => void | Promise<void>;
}

export class StatusOverlay {
  private readonly overlay = document.getElementById("status-overlay")!;
  private readonly title = document.getElementById("so-title")!;
  private readonly body = document.getElementById("so-body")!;
  private readonly actions = document.getElementById("so-actions")!;
  private hideTimer: number | null = null;

  show(
    title: string,
    body: string,
    opts: { durationMs?: number; actions?: StatusAction[] } = {},
  ): void {
    this.title.textContent = title;
    this.body.textContent = body;
    this.actions.innerHTML = "";
    for (const a of opts.actions ?? []) {
      const b = document.createElement("button");
      if (a.primary) b.className = "primary";
      b.textContent = a.label;
      b.addEventListener("click", () => void a.onClick());
      this.actions.appendChild(b);
    }
    if (!opts.actions?.length) {
      const dismiss = document.createElement("button");
      dismiss.textContent = "Dismiss";
      dismiss.addEventListener("click", () => this.hide());
      this.actions.appendChild(dismiss);
    }
    this.overlay.classList.add("show");
    if (this.hideTimer) window.clearTimeout(this.hideTimer);
    const ms = opts.durationMs;
    if (ms !== undefined && ms > 0) {
      this.hideTimer = window.setTimeout(() => this.hide(), ms);
    }
  }

  hide(): void {
    if (this.hideTimer) window.clearTimeout(this.hideTimer);
    this.overlay.classList.remove("show");
  }

  showPlaybackError(err: string): void {
    this.show("Playback error", playbackErrorText(err), { durationMs: 7000 });
  }

  async runPlaybackCommand(
    controller: SpotifyController,
    label: string,
    command: () => Promise<void>,
  ): Promise<void> {
    const startedAt = Date.now();
    await command();
    const diag = controller.getDiagnostics();
    if (diag.lastError && diag.lastCommandAt && diag.lastCommandAt >= startedAt - 50) {
      this.show(`${label} failed`, playbackErrorText(diag.lastError), {
        durationMs: 7000,
      });
    }
  }
}

export function playbackErrorText(err: string): string {
  if (err === "no_device") {
    return "Open Spotify on your phone, desktop, or web player, then try again.";
  }
  if (err.includes("no active unrestricted Spotify device")) {
    return "Spotify is signed in, but no active playback device is available. Open Spotify somewhere and start/transfer playback once.";
  }
  return err;
}
