/**
 * Heart on the face screen. Toggles the current track in Liked Songs and
 * pokes the alien when it lands.
 */

import type { FaceAlive } from "./face-alive";
import type { SpotifyController, SpotifyState } from "./spotify-player";
import type { StatusOverlay } from "./status-overlay";

export function wireLikeButton(
  controller: SpotifyController,
  status: StatusOverlay,
  faceAlive: FaceAlive,
): void {
  const btn = document.getElementById("btn-like") as HTMLButtonElement | null;
  if (!btn) return;

  const paint = (s: SpotifyState) => {
    const hasTrack = !!s.track;
    btn.disabled = !hasTrack;
    btn.classList.toggle("active", hasTrack && controller.isLiked());
    btn.title = !hasTrack
      ? "Like"
      : controller.isLiked()
        ? "Unlike this track"
        : "Like this track";
    btn.textContent = controller.isLiked() ? "♥" : "♡";
  };

  let lastId: string | null = null;
  controller.on((s) => {
    const id = s.track?.id ?? null;
    if (id !== lastId) {
      lastId = id;
      if (id) void controller.refreshLiked(id);
    }
    paint(s);
  });
  paint(controller.state());

  btn.addEventListener("click", async () => {
    const wasLiked = controller.isLiked();
    const r = await controller.toggleLike();
    if (!r.ok) {
      status.showPlaybackError(r.error);
      return;
    }
    paint(controller.state());
    if (!wasLiked) faceAlive.notifyLiked();
  });
}
